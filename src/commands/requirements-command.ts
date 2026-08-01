import { randomUUID } from "node:crypto";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AgentCancelledError,
  AgentIncompleteResponseError,
  PiSdkAgentExecutor,
  type AgentExecutor,
  type AgentRunOptions
} from "../agents/agent-runner.js";
import type { SpawnExplorerResult } from "../agents/agent-runner-contracts.js";
import { agentRemainingTimeoutMs, spawnExplorerRunOptions } from "../agents/explorer-spawn.js";
import { openBrowser as defaultOpenBrowser } from "./open-browser.js";
import { loadConfig as defaultLoadConfig } from "../config/config.js";
import { RequirementsStore, renderRequirementsMarkdown } from "../persistence/requirements-store.js";
import { DashboardServer } from "../ui/dashboard.js";
import { beginDecisionRace, type RaceWinner } from "../ui/decision-race.js";
import { buildRequirementsViewModel } from "../ui/ui-model.js";
import { selectWorkflowRoute } from "./route-selection.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";
import {
  AGENT_TASK_SCHEMA_VERSION,
  MAX_INTERVIEW_ROUNDS,
  type AgentTaskEnvelope,
  type DashboardDecisionAction,
  type InterviewAnswer,
  type InterviewQAndA,
  type InterviewQuestion,
  type InterviewerOutput,
  type InterviewerReport,
  type InterviewerTask,
  type OrchestratorConfig,
  type RequirementsDocument,
  type WorkflowRequest
} from "../types.js";
import { parseInterviewerOutput, ValidationError } from "../validation.js";

export interface RequirementsCommandDependencies {
  extensionRoot: string;
  executor?: AgentExecutor;
  loadConfig?: (cwd: string) => Promise<OrchestratorConfig>;
  storeFactory?: (cwd: string, sessionId: string) => RequirementsStore;
  now?: () => Date;
  id?: () => string;
  openBrowser?: (url: string) => void;
  /** When provided, the completed interview offers to start a workflow. */
  startWorkflow?: (request: WorkflowRequest) => Promise<void>;
}

export class RequirementsCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementsCancelledError";
  }
}

class RequirementsDeferredError extends Error {
  constructor(label: string) {
    super(`${label} was dismissed; no requirements artifact was written`);
    this.name = "RequirementsDeferredError";
  }
}

let decisionCounter = 0;

function nextDecisionId(): string {
  decisionCounter++;
  return `requirements-decision-${Date.now()}-${decisionCounter}`;
}

const CUSTOM_ACTION_LABEL = "✏️ Type my own answer";
const DONE_ACTION_LABEL = "Done";
const CANCEL_ACTION_LABEL = "Cancel interview";

interface InterviewActionResult {
  action: string;
  feedback?: string;
}

interface InterviewInteraction {
  label: string;
  content: string;
  actions: readonly DashboardDecisionAction[];
  prompt: (signal: AbortSignal) => Promise<InterviewActionResult | undefined>;
}

export class RequirementsSession {
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly store: RequirementsStore;
  readonly dashboard: DashboardServer;
  readonly controller = new AbortController();
  goal = "";
  status: "running" | "waiting" | "completed" | "failed" | "cancelled" = "running";
  round = 0;
  waitingFor?: string;
  pendingDecision?: { id: string; kind: string; label: string; requestedAt: string; dashboardAvailable: boolean };
  dashboardUrl?: string;
  message?: string;
  artifactPath?: string;
  interviewerStatus: "idle" | "running" | "succeeded" | "failed" | "cancelled" = "idle";
  history: InterviewQAndA[] = [];
  insights: string[] = [];

  constructor(
    readonly cwd: string,
    readonly deps: RequirementsCommandDependencies
  ) {
    this.sessionId = deps.id?.() ?? randomUUID();
    this.startedAt = deps.now?.() ?? new Date();
    this.store = deps.storeFactory?.(cwd, this.sessionId) ?? new RequirementsStore(cwd, this.sessionId);
    this.dashboard = new DashboardServer({
      getViewModel: () => this.getViewModel(),
      getAgentInspection: async () => undefined,
      readArtifact: name => this.store.readArtifact(name)
    });
  }

  timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  getViewModel() {
    return buildRequirementsViewModel({
      sessionId: this.sessionId,
      cwd: this.cwd,
      goal: this.goal,
      status: this.status,
      round: this.round,
      maxRounds: MAX_INTERVIEW_ROUNDS,
      waitingFor: this.waitingFor,
      pendingDecision: this.pendingDecision,
      dashboardUrl: this.dashboardUrl,
      message: this.message,
      artifactPath: this.artifactPath,
      interviewerStatus: this.interviewerStatus
    });
  }

  publish(): void {
    this.dashboard.publish(this.getViewModel());
  }
}

export async function runRequirementsCommand(
  cwd: string,
  ctx: ExtensionCommandContext,
  deps: RequirementsCommandDependencies
): Promise<void> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The requirements command requires an interactive UI.", "error");
    return;
  }
  const goal = await ctx.ui.input("What goal should the requirements describe?");
  if (goal === undefined || !goal.trim()) {
    ctx.ui.notify("No goal entered; requirements session cancelled.", "warning");
    return;
  }
  const session = new RequirementsSession(cwd, deps);
  session.goal = goal.trim();
  const executor = deps.executor ?? new PiSdkAgentExecutor();
  const startedAt = deps.now?.() ?? new Date();
  const deadlineStartedAt = Date.now();
  try {
    const config = await (deps.loadConfig ?? defaultLoadConfig)(cwd);
    await executor.preflight(config, cwd, deps.extensionRoot, session.controller.signal, config.limits.agentTimeoutMs, ["interviewer", "explorer"]);
    if (config.dashboard.enabled) {
      try {
        const url = await session.dashboard.start(0);
        session.dashboardUrl = url;
        (deps.openBrowser ?? defaultOpenBrowser)(url);
      } catch (error) {
        ctx.ui.notify(`Interview dashboard unavailable; answers are TUI-only: ${messageOf(error)}`, "warning");
      }
    }
    session.publish();

    const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
    if (!canPrompt && !session.dashboard.isListening) {
      throw new Error("The requirements interview requires a TUI dialog or the interview dashboard");
    }

    for (let round = 1; round <= MAX_INTERVIEW_ROUNDS; round++) {
      session.round = round;
      session.waitingFor = "Interviewer is preparing questions";
      session.interviewerStatus = "running";
      session.publish();
      const asked = await interviewerCall(session, executor, config, deadlineStartedAt, {
        action: "ask_questions",
        goal: session.goal,
        round,
        history: session.history,
        insights: session.insights
      });
      if (asked.action !== "ask_questions") throw new Error(`Interviewer returned ${asked.action} when asked for questions`);
      const answered: InterviewQAndA[] = [];
      for (const question of asked.questions) {
        const answer = await askQuestion(session, ctx, question);
        answered.push({ question, answer });
      }
      session.history.push(...answered);

      session.waitingFor = "Interviewer is assessing goal clarity";
      session.interviewerStatus = "running";
      session.publish();
      const assessed = await interviewerCall(session, executor, config, deadlineStartedAt, {
        action: "assess",
        goal: session.goal,
        round,
        history: session.history,
        insights: session.insights
      });
      if (assessed.action !== "assess") throw new Error(`Interviewer returned ${assessed.action} when asked to assess`);
      if (assessed.assessment.clarity === "clear") break;
      session.insights.push(assessed.assessment.summary, ...(assessed.assessment.openQuestions ?? []));
      if (round === MAX_INTERVIEW_ROUNDS) {
        session.insights.push("Final round reached; finalize the report with the information gathered.");
      }
    }

    session.waitingFor = "Interviewer is finalizing the requirements report";
    session.interviewerStatus = "running";
    session.publish();
    const finalized = await interviewerCall(session, executor, config, deadlineStartedAt, {
      action: "finalize",
      goal: session.goal,
      history: session.history,
      insights: session.insights
    });
    if (finalized.action !== "finalize") throw new Error(`Interviewer returned ${finalized.action} when asked to finalize`);
    const document = buildRequirementsDocument(finalized.report, startedAt.toISOString());
    await session.store.saveDocument(document);
    await session.store.saveMarkdown(renderRequirementsMarkdown(document));
    session.interviewerStatus = "succeeded";
    session.status = "completed";
    session.waitingFor = undefined;
    session.message = `Requirements saved to ${session.store.sessionDir}`;
    session.artifactPath = session.store.sessionDir;
    session.publish();
    ctx.ui.notify(`Requirements saved to ${session.store.sessionDir}`, "info");
    await offerHandoff(ctx, deps, document);
  } catch (error) {
    const cancelled = error instanceof RequirementsCancelledError
      || error instanceof AgentCancelledError
      || session.controller.signal.aborted
      || (error instanceof Error && error.name === "AbortError");
    if (cancelled) {
      session.status = "cancelled";
      session.message = messageOf(error);
      session.interviewerStatus = "cancelled";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.publish();
      ctx.ui.notify(`Requirements interview cancelled: ${messageOf(error)}`, "warning");
    } else if (error instanceof RequirementsDeferredError) {
      session.status = "cancelled";
      session.message = error.message;
      session.interviewerStatus = "cancelled";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.publish();
      ctx.ui.notify(error.message, "warning");
    } else {
      session.status = "failed";
      session.message = messageOf(error);
      session.interviewerStatus = "failed";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.publish();
      ctx.ui.notify(`Requirements interview failed: ${messageOf(error)}`, "error");
    }
  } finally {
    session.controller.abort(new Error("Requirements session ended"));
    await session.dashboard.stop().catch(() => undefined);
  }
}

async function interviewerCall(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  deadlineStartedAt: number,
  task: InterviewerTask
): Promise<InterviewerOutput> {
  const first = await runInterviewer(session, executor, config, deadlineStartedAt, "execute", task, undefined);
  const expectedAction = task.action;
  let output: InterviewerOutput;
  try {
    const parsed = parseInterviewerOutput(first.text);
    assertRequestedAction(parsed, expectedAction);
    output = parsed;
  } catch (error) {
    const fieldPath = error instanceof ValidationError && /^[a-zA-Z0-9_.\[\]-]+$/.test(error.path) ? error.path : undefined;
    const corrected = await runInterviewer(session, executor, config, deadlineStartedAt, "correct_output", task, fieldPath);
    try {
      const parsed = parseInterviewerOutput(corrected.text);
      assertRequestedAction(parsed, expectedAction);
      output = parsed;
    } catch (retryError) {
      throw new Error(`Interviewer returned invalid output: ${messageOf(retryError)}`);
    }
  }
  return output;
}

function assertRequestedAction(output: InterviewerOutput, expected: InterviewerTask["action"]): void {
  if (output.action !== expected) {
    throw new ValidationError("action", `expected ${expected} but interviewer returned ${output.action}`);
  }
}

async function runInterviewer(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  deadlineStartedAt: number,
  mode: "execute" | "correct_output",
  task: InterviewerTask,
  fieldPath: string | undefined
) {
  const remaining = agentRemainingTimeoutMs(config.limits.agentTimeoutMs, deadlineStartedAt);
  const envelope: AgentTaskEnvelope<InterviewerTask> = mode === "correct_output"
    ? {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode,
        task,
        memoryContext: null,
        correction: {
          attempt: 1,
          reason: "schema_validation_failed",
          ...(fieldPath ? { fieldPath } : {})
        }
      }
    : {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode,
        task,
        memoryContext: null
      };
  const run: AgentRunOptions = {
    name: "interviewer",
    task: JSON.stringify(envelope, null, 2),
    cwd: session.cwd,
    extensionRoot: session.deps.extensionRoot,
    config: config.agents.interviewer,
    timeoutMs: remaining,
    signal: session.controller.signal,
    allowedWritePaths: [],
    spawnExplorer: question => runSpawnedExplorer(session, executor, config, deadlineStartedAt, question)
  };
  return executor.run(run);
}

async function runSpawnedExplorer(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  deadlineStartedAt: number,
  question: string
): Promise<SpawnExplorerResult> {
  const child = spawnExplorerRunOptions({
    question,
    cwd: session.cwd,
    extensionRoot: session.deps.extensionRoot,
    explorerConfig: config.agents.explorer,
    timeoutMs: agentRemainingTimeoutMs(config.limits.agentTimeoutMs, deadlineStartedAt),
    signal: session.controller.signal
  });
  try {
    const result = await executor.run(child);
    return { text: result.text, usage: result.usage, transcript: result.transcript };
  } catch (error) {
    if (error instanceof AgentCancelledError) throw error;
    const usage = error instanceof AgentIncompleteResponseError ? error.usage : undefined;
    return { text: `Explorer sub-agent failed: ${messageOf(error)}`, usage };
  }
}

function questionPresentation(question: InterviewQuestion, picked: readonly string[]): { content: string; actions: DashboardDecisionAction[] } {
  const lines = [`## ${question.text}`, ""];
  if (question.kind === "multiple" && picked.length > 0) {
    lines.push(`Selected so far: ${picked.map(id => optionText(question, id)).join(", ")}`, "");
  }
  lines.push("Options:", ...question.options.map(option => `- ${option.text}${option.recommended ? " (recommended)" : ""}`));
  const actions: DashboardDecisionAction[] = question.options.map(option => ({
    value: `opt:${question.id}:${option.id}` as HumanDecisionAction,
    label: option.text,
    requiresFeedback: false
  }));
  if (question.kind === "multiple") {
    actions.push({ value: `done:${question.id}` as HumanDecisionAction, label: DONE_ACTION_LABEL, requiresFeedback: false });
  }
  actions.push({ value: `custom:${question.id}` as HumanDecisionAction, label: CUSTOM_ACTION_LABEL, requiresFeedback: true });
  actions.push({ value: "cancel" as HumanDecisionAction, label: CANCEL_ACTION_LABEL, requiresFeedback: false });
  return { content: lines.join("\n"), actions };
}

function tuiQuestionLabels(question: InterviewQuestion): string[] {
  return [
    ...question.options.map(option => `${option.text}${option.recommended ? " (recommended)" : ""}`),
    ...(question.kind === "multiple" ? [DONE_ACTION_LABEL] : []),
    CUSTOM_ACTION_LABEL,
    CANCEL_ACTION_LABEL
  ];
}

function optionText(question: InterviewQuestion, optionId: string): string {
  return question.options.find(option => option.id === optionId)?.text ?? optionId;
}

async function askQuestion(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  question: InterviewQuestion
): Promise<InterviewAnswer> {
  const picked: string[] = [];
  while (true) {
    const { content, actions } = questionPresentation(question, picked);
    const label = question.kind === "multiple" && picked.length > 0
      ? `${question.text} (${picked.length} selected)`
      : question.text;
    const interaction: InterviewInteraction = {
      label,
      content,
      actions,
      prompt: async signal => {
        const choice = await ctx.ui.select(label, tuiQuestionLabels(question), { signal });
        if (choice === undefined) return undefined;
        if (choice === CUSTOM_ACTION_LABEL) {
          const text = await ctx.ui.input(`Your own answer for: ${question.text}`, undefined, { signal });
          if (text === undefined) return undefined;
          return { action: `custom:${question.id}`, feedback: text.trim() };
        }
        if (choice === CANCEL_ACTION_LABEL) return { action: "cancel" };
        if (choice === DONE_ACTION_LABEL) return { action: `done:${question.id}` };
        const option = question.options.find(candidate => candidate.text === choice.replace(/ \(recommended\)$/, ""));
        if (!option) return undefined;
        return { action: `opt:${question.id}:${option.id}` };
      }
    };
    const result = await raceDecision(session, ctx, interaction, session.controller.signal);
    if (result.action === "cancel") {
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    if (result.action === `custom:${question.id}`) {
      return { questionId: question.id, selectedOptionIds: picked, customText: result.feedback };
    }
    if (result.action === `done:${question.id}`) {
      return { questionId: question.id, selectedOptionIds: picked };
    }
    const prefix = `opt:${question.id}:`;
    if (result.action.startsWith(prefix)) {
      const optionId = result.action.slice(prefix.length);
      if (question.options.some(option => option.id === optionId) && !picked.includes(optionId)) {
        picked.push(optionId);
      }
      if (question.kind === "single") return { questionId: question.id, selectedOptionIds: picked };
      continue;
    }
    throw new Error(`Unexpected interview action: ${result.action}`);
  }
}

async function raceDecision(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  interaction: InterviewInteraction,
  signal: AbortSignal
): Promise<InterviewActionResult> {
  if (signal.aborted) throw new RequirementsCancelledError("Requirements interview cancelled");
  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  if (!canPrompt && !session.dashboard.isListening) {
    throw new RequirementsDeferredError(interaction.label);
  }
  const decisionId = nextDecisionId();
  const race = beginDecisionRace<InterviewActionResult | undefined>({
    decisionId,
    label: interaction.label,
    dashboard: session.dashboard,
    presentation: { format: "markdown", content: interaction.content, actions: interaction.actions },
    signal
  });
  race.register();
  session.pendingDecision = {
    id: decisionId,
    kind: "requirements_question",
    label: interaction.label,
    requestedAt: session.timestamp(),
    dashboardAvailable: true
  };
  session.status = "waiting";
  session.waitingFor = interaction.label;
  session.publish();

  let winner: RaceWinner<InterviewActionResult | undefined>;
  try {
    winner = await race.race(canPrompt, interaction.prompt);
  } catch (error) {
    session.status = "running";
    session.waitingFor = undefined;
    session.pendingDecision = undefined;
    session.publish();
    throw error;
  }

  session.status = "running";
  session.waitingFor = undefined;
  session.pendingDecision = undefined;
  session.publish();
  winner.acknowledge?.();

  if (winner.result === undefined) {
    throw new RequirementsDeferredError(interaction.label);
  }
  return winner.result;
}

async function offerHandoff(
  ctx: ExtensionCommandContext,
  deps: RequirementsCommandDependencies,
  document: RequirementsDocument
): Promise<void> {
  if (!deps.startWorkflow || !ctx.hasUI) return;
  const choice = await ctx.ui.select("Requirements are ready. What next?", [
    "Start a workflow with these requirements",
    "Done"
  ]);
  if (choice !== "Start a workflow with these requirements") return;
  const route = await selectWorkflowRoute(ctx);
  if (!route) return;
  await deps.startWorkflow({ route, request: document.handoffRequest });
}

function buildRequirementsDocument(report: InterviewerReport, createdAt: string): RequirementsDocument {
  const handoffRequest = [
    `Goal: ${report.goal}`,
    report.summary,
    `Scope: ${report.scope.join("; ")}`,
    `Constraints: ${report.constraints.join("; ")}`,
    `Acceptance criteria: ${report.acceptanceCriteria.join("; ")}`
  ].join("\n");
  return {
    schemaVersion: 1,
    goal: report.goal,
    summary: report.summary,
    scope: report.scope,
    constraints: report.constraints,
    acceptanceCriteria: report.acceptanceCriteria,
    openQuestions: report.openQuestions,
    qa: report.qa,
    handoffRequest,
    createdAt
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
