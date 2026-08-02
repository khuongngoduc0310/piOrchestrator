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
import { buildTranscriptArtifact } from "../orchestration/orchestrator-agent-step.js";
import { openBrowser as defaultOpenBrowser } from "./open-browser.js";
import { loadConfig as defaultLoadConfig } from "../config/config.js";
import { RequirementsStore, REQUIREMENTS_JSON, REQUIREMENTS_MARKDOWN, renderRequirementsMarkdown } from "../persistence/requirements-store.js";
import { DashboardServer } from "../ui/dashboard.js";
import { beginDecisionRace, type RaceWinner } from "../ui/decision-race.js";
import { buildRequirementsViewModel, interviewQaToDashboard } from "../ui/ui-model.js";
import { selectWorkflowRoute } from "./route-selection.js";
import { RequirementsArrowTranslator } from "./requirements-keys.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";
import type {
  AgentHistoryInvocation,
  AgentHistoryResponse,
  AgentInspection,
  AgentUsageSummary,
  PendingQuestionInfo,
  RequirementsSummary
} from "../dashboard-types.js";
import {
  AGENT_TASK_SCHEMA_VERSION,
  MAX_INTERVIEW_ROUNDS,
  type AgentInvocationRecord,
  type AgentName,
  type AgentTaskEnvelope,
  type AgentTranscript,
  type AgentTranscriptArtifact,
  type AgentUsage,
  type AgentUsageSnapshot,
  type DashboardDecisionAction,
  type DashboardDecisionQuestion,
  type InterviewAnswer,
  type InterviewQAndA,
  type InterviewQuestion,
  type InterviewerAssessment,
  type InterviewerOutput,
  type InterviewerReport,
  type InterviewerTask,
  type OrchestratorConfig,
  type RequirementsDocument,
  type Stage,
  type StepRecord,
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
const BACK_ACTION_LABEL = "← Back to questions";
const CANCEL_ACTION_LABEL = "Cancel interview";
const REVIEW_QUESTION: InterviewQuestion = {
  id: "review",
  kind: "single",
  text: "Was the goal clear?",
  options: [
    { id: "yes", text: "Yes — the goal is clear, proceed", recommended: true },
    { id: "no", text: "No — I still have doubts" }
  ]
};
const REVIEW_YES_OPTION_ID = "yes";

/**
 * The commit question appended to every set: answering Finish round ends the
 * set and lets the interviewer assess. It is not an interviewer question; it
 * never reaches the round history.
 */
const COMMIT_QUESTION: InterviewQuestion = {
  id: "commit",
  kind: "single",
  text: "All questions are answered. Finish this round?",
  options: [
    { id: "finish-round", text: "Finish round", recommended: true },
    { id: "keep-working", text: "Keep working" }
  ]
};
const COMMIT_FINISH_ACTION = `opt:${COMMIT_QUESTION.id}:finish-round`;
const COMMIT_KEEP_ACTION = `opt:${COMMIT_QUESTION.id}:keep-working`;

/**
 * The interviewer is read-only, so a failed output is cheap to retry: schema
 * failures get up to two `correct_output` attempts before the session fails.
 */
const MAX_INTERVIEWER_CORRECTIONS = 2;
/** Byte cap for `correction.validationError`, which is embedded in the retry envelope. */
const MAX_CORRECTION_ERROR_BYTES = 500;

interface InterviewActionResult {
  action: string;
  feedback?: string;
}

interface InterviewInteraction {
  label: string;
  content: string;
  actions: readonly DashboardDecisionAction[];
  question: DashboardDecisionQuestion;
  prompt: (signal: AbortSignal) => Promise<InterviewActionResult | undefined>;
}

interface SetQuestionState {
  question: InterviewQuestion;
  picked: string[];
  customText?: string;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** The TUI answer prompt the hub opens for a question's current presentation. */
interface TuiPrompt {
  /** Gate signal of the presentation's decision race; aborts when the dashboard wins. */
  signal: AbortSignal;
  promise: Promise<InterviewActionResult | undefined>;
  resolve: (result: InterviewActionResult | undefined) => void;
}

/** Mutable per-question state shared between the question's driver and the TUI hub. */
export interface QuestionChannel {
  question: InterviewQuestion;
  picked: string[];
  customText?: string;
  /** True once the question has an answer; the hub renders a ✓ label. */
  completed: boolean;
  /** Presentation counter, bumped on every re-presentation. */
  generation: number;
  /** Decision id of the current presentation; undefined while the driver cycles. */
  decisionId?: string;
  label?: string;
  presentation?: InterviewPresentation;
  /** The parked TUI prompt of the current presentation; undefined while the driver cycles. */
  prompt?: TuiPrompt;
  /** Resolved by the driver once it consumed a TUI answer and re-presented or completed. */
  wake?: Deferred<void>;
  /** True once the driver ended (set closed); the hub stops waiting on the channel. */
  driverEnded: boolean;
  /** True for the round's commit question, which ends the set when answered. */
  isCommit: boolean;
  /** True once every real question is answered; gates the commit question's presentation. */
  armed: boolean;
  /** True while the custom-answer input is open; the TUI translator leaves arrows native then. */
  customInputOpen?: boolean;
  /** Arrow-key switch request from the TUI translator. */
  switchTarget?: "next" | "previous";
  /** Aborted by the TUI translator to close the answer dialog softly on a switch request. */
  dialogAbort?: AbortController;
}

function hubQuestionLabel(channel: QuestionChannel, index: number): string {
  const marker = channel.completed ? "✓" : "○";
  if (!channel.completed) return `${marker} ${index + 1}. ${channel.question.text}`;
  const detail = channel.customText !== undefined
    ? "custom answer"
    : channel.picked
      .map(id => channel.question.options.find(option => option.id === id)?.text ?? id)
      .join(", ");
  return `${marker} ${index + 1}. ${channel.question.text} — ${detail}`;
}

interface InterviewerCallRecord {
  sequence: number;
  round: number;
  action: "ask_questions" | "assess" | "finalize";
  mode: "execute" | "correct_output";
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  messageCount: number;
  truncated: boolean;
  transcript?: AgentTranscript;
  transcriptArtifact?: string;
  outputArtifact?: string;
  taskArtifact?: string;
  taskText?: string;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  toolName?: string;
  toolArgs?: string;
  error?: string;
}

const INTERVIEWER_STAGE: Stage = "exploring";

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
  pendingQuestions: PendingQuestionInfo[] = [];
  dashboardUrl?: string;
  message?: string;
  artifactPath?: string;
  interviewerStatus: "idle" | "running" | "succeeded" | "failed" | "cancelled" = "idle";
  history: InterviewQAndA[] = [];
  insights: string[] = [];
  artifactNames: string[] = [];
  requirement?: RequirementsSummary;
  lastAssessmentNote?: string;
  interviewerModel = "";
  transcriptRevision = 0;
  interviewerCalls: InterviewerCallRecord[] = [];

  constructor(
    readonly cwd: string,
    readonly deps: RequirementsCommandDependencies
  ) {
    this.sessionId = deps.id?.() ?? randomUUID();
    this.startedAt = deps.now?.() ?? new Date();
    this.store = deps.storeFactory?.(cwd, this.sessionId) ?? new RequirementsStore(cwd, this.sessionId);
    this.dashboard = new DashboardServer({
      getViewModel: () => this.getViewModel(),
      getAgentInspection: name => this.inspectAgent(name),
      getRunAgentInspection: async (runId, name) => runId === this.sessionId ? this.inspectAgent(name) : undefined,
      getAgentTranscript: (stepId, invocation) => this.agentTranscript(stepId, invocation),
      getRunAgentTranscript: async (runId, stepId, invocation) => runId === this.sessionId ? this.agentTranscript(stepId, invocation) : undefined,
      getRunAgentHistory: async runId => runId === this.sessionId ? this.agentHistory() : undefined,
      readArtifact: name => this.store.readArtifact(name),
      readRunArtifact: async (runId, name) => runId === this.sessionId ? this.store.readArtifact(name) : undefined
    });
  }

  timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  recordCall(round: number, action: InterviewerCallRecord["action"], mode: InterviewerCallRecord["mode"]): InterviewerCallRecord {
    const call: InterviewerCallRecord = {
      sequence: this.interviewerCalls.length + 1,
      round,
      action,
      mode,
      startedAt: this.timestamp(),
      status: "running",
      messageCount: 0,
      truncated: false
    };
    this.interviewerCalls.push(call);
    this.transcriptRevision++;
    this.publish();
    return call;
  }

  updateCall(call: InterviewerCallRecord, patch: Partial<InterviewerCallRecord>): void {
    Object.assign(call, patch);
    this.transcriptRevision++;
    this.publish();
  }

  async finishCall(
    call: InterviewerCallRecord,
    status: InterviewerCallRecord["status"],
    options: {
      outputText?: string;
      error?: string;
      usage?: AgentUsage;
      provider?: string;
      model?: string;
      api?: string;
      stopReason?: string;
    } = {}
  ): Promise<void> {
    call.status = status;
    call.completedAt = this.timestamp();
    if (options.error !== undefined) call.error = options.error;
    if (options.usage) call.usage = options.usage;
    if (options.provider) call.provider = options.provider;
    if (options.model) call.model = options.model;
    if (options.api) call.api = options.api;
    if (options.stopReason) call.stopReason = options.stopReason;
    const prefix = `step-${call.sequence}-interviewer-${call.action}-invocation-1`;
    await this.persistCallArtifacts(call, prefix, options.outputText);
    this.transcriptRevision++;
    this.publish();
  }

  private async persistCallArtifacts(call: InterviewerCallRecord, prefix: string, outputText: string | undefined): Promise<void> {
    if (call.transcript) {
      const artifact: AgentTranscriptArtifact = buildTranscriptArtifact({
        transcript: call.transcript,
        stepId: `step-${call.sequence}`,
        agent: "interviewer",
        invocation: 1,
        mode: call.mode,
        status: call.status,
        model: this.interviewerModel,
        startedAt: call.startedAt,
        completedAt: call.completedAt ?? this.timestamp()
      });
      try {
        call.transcriptArtifact = await this.store.saveRaw(`${prefix}-transcript.json`, JSON.stringify(artifact, null, 2));
      } catch {
        // Transcript persistence must not fail the interview.
      }
    }
    if (outputText !== undefined) {
      try {
        call.outputArtifact = await this.store.saveRaw(`${prefix}-output.json`, outputText);
      } catch {
        // Output persistence must not fail the interview.
      }
    }
    if (call.mode === "correct_output" && call.taskText !== undefined) {
      try {
        call.taskArtifact = await this.store.saveRaw(`${prefix}-task.json`, call.taskText);
      } catch {
        // Task persistence must not fail the interview.
      }
    }
  }

  private stepRecordFor(call: InterviewerCallRecord): StepRecord {
    const invocation: AgentInvocationRecord = {
      sequence: 1,
      mode: call.mode,
      status: call.status,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      transcriptArtifact: call.transcriptArtifact,
      messageCount: call.messageCount,
      truncated: call.truncated,
      usage: call.usage,
      provider: call.provider,
      model: call.model,
      api: call.api,
      stopReason: call.stopReason
    };
    return {
      id: `step-${call.sequence}`,
      sequence: call.sequence,
      stage: INTERVIEWER_STAGE,
      label: `${call.action} · round ${call.round}${call.mode === "correct_output" ? " (correction)" : ""}`,
      status: call.status,
      agent: "interviewer",
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      invocations: [invocation]
    };
  }

  async inspectAgent(name: AgentName): Promise<AgentInspection | undefined> {
    if (name !== "interviewer") return undefined;
    const calls = this.interviewerCalls;
    const first = calls[0];
    const last = calls[calls.length - 1];
    const running = this.interviewerStatus === "running";
    return {
      name,
      status: this.interviewerStatus,
      model: this.interviewerModel,
      summary: this.lastAssessmentNote,
      error: this.status === "failed" ? this.message : undefined,
      startedAt: first?.startedAt,
      completedAt: last?.completedAt,
      currentTool: running ? last?.toolName : undefined,
      currentToolArgs: running ? last?.toolArgs : undefined,
      steps: calls.map(call => this.stepRecordFor(call)),
      toolEvents: [],
      hasArtifact: false,
      hasRawArtifact: false,
      transcriptRevision: this.transcriptRevision
    };
  }

  async agentTranscript(stepId: string, invocation: number): Promise<AgentTranscriptArtifact | undefined> {
    if (invocation !== 1) return undefined;
    const match = /^step-(\d+)$/.exec(stepId);
    if (!match) return undefined;
    const call = this.interviewerCalls.find(candidate => candidate.sequence === Number(match[1]));
    if (!call) return undefined;
    if (call.transcript) {
      return buildTranscriptArtifact({
        transcript: call.transcript,
        stepId,
        agent: "interviewer",
        invocation: 1,
        mode: call.mode,
        status: call.status,
        model: this.interviewerModel,
        startedAt: call.startedAt,
        completedAt: call.completedAt ?? this.timestamp()
      });
    }
    if (!call.transcriptArtifact) return undefined;
    const artifact = await this.store.readArtifact(call.transcriptArtifact);
    if (!artifact) return undefined;
    try {
      return JSON.parse(artifact.text) as AgentTranscriptArtifact;
    } catch {
      return undefined;
    }
  }

  async agentHistory(): Promise<AgentHistoryResponse | undefined> {
    const summary: AgentUsageSummary = {
      invocationCount: this.interviewerCalls.length,
      measuredInvocationCount: this.interviewerCalls.length
    };
    const invocations: AgentHistoryInvocation[] = this.interviewerCalls.map(call => {
      const stepId = `step-${call.sequence}`;
      return {
        key: `${stepId}:1`,
        stepId,
        stepLabel: `${call.action} · round ${call.round}`,
        sequence: 1,
        agent: "interviewer",
        mode: call.mode,
        status: call.status,
        startedAt: call.startedAt,
        completedAt: call.completedAt,
        durationMs: call.completedAt ? Date.parse(call.completedAt) - Date.parse(call.startedAt) : undefined,
        usage: call.usage,
        provider: call.provider,
        model: call.model,
        api: call.api,
        stopReason: call.stopReason,
        changedFileCount: 0,
        hasTranscript: call.transcriptArtifact !== undefined,
        hasDiff: false
      };
    });
    return {
      runId: this.sessionId,
      total: summary,
      agents: [{ ...summary, name: "interviewer" }],
      invocations
    };
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
      pendingQuestions: this.pendingQuestions,
      dashboardUrl: this.dashboardUrl,
      message: this.message,
      artifactPath: this.artifactPath,
      interviewerStatus: this.interviewerStatus,
      interviewerModel: this.interviewerModel,
      transcriptRevision: this.transcriptRevision,
      qa: interviewQaToDashboard(this.history),
      artifactNames: this.artifactNames,
      requirement: this.requirement
    });
  }

  publish(): void {
    this.dashboard.publish(this.getViewModel());
  }

  /** Upserts a round's answer, replacing any prior answer for the same question in that round. */
  recordAnswer(round: number, entry: InterviewQAndA): void {
    const index = this.history.findIndex(
      existing => existing.round === round && existing.question.id === entry.question.id
    );
    if (index === -1) this.history.push(entry);
    else this.history[index] = entry;
  }

  /** Replaces a round's history entries with a set-ordered answer list. */
  replaceRound(round: number, entries: InterviewQAndA[]): void {
    this.history = this.history
      .filter(existing => existing.round !== round)
      .concat(entries);
  }
}

export async function runRequirementsCommand(
  cwd: string,
  ctx: ExtensionCommandContext,
  deps: RequirementsCommandDependencies
): Promise<RequirementsSession | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The requirements command requires an interactive UI.", "error");
    return undefined;
  }
  const goal = await ctx.ui.input("What goal should the requirements describe?");
  if (goal === undefined || !goal.trim()) {
    ctx.ui.notify("No goal entered; requirements session cancelled.", "warning");
    return undefined;
  }
  const session = new RequirementsSession(cwd, deps);
  session.goal = goal.trim();
  const executor = deps.executor ?? new PiSdkAgentExecutor();
  const startedAt = deps.now?.() ?? new Date();
  const deadlineStartedAt = Date.now();
  try {
    const config = await (deps.loadConfig ?? defaultLoadConfig)(cwd);
    session.interviewerModel = config.agents.interviewer?.model ?? "";
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
      await askSet(session, ctx, asked.questions, round);

      session.waitingFor = "Interviewer is summarizing what it learned";
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
      session.waitingFor = "Reviewing the requirements with you";
      session.publish();
      let review: { clear: boolean; feedback?: string } | undefined;
      while (review === undefined) {
        review = await askReview(session, ctx, assessed.assessment, round);
      }
      if (review.clear) break;
      session.lastAssessmentNote = [
        assessed.assessment.summary,
        ...(assessed.assessment.openQuestions ?? []),
        ...(review.feedback ? [review.feedback] : [])
      ].join("; ");
      session.insights.push(
        assessed.assessment.summary,
        ...(assessed.assessment.openQuestions ?? []),
        ...(review.feedback ? [review.feedback] : [])
      );
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
    session.requirement = {
      goal: finalized.report.goal,
      summary: finalized.report.summary,
      scope: finalized.report.scope,
      constraints: finalized.report.constraints,
      acceptanceCriteria: finalized.report.acceptanceCriteria,
      openQuestions: finalized.report.openQuestions
    };
    session.interviewerStatus = "succeeded";
    session.status = "completed";
    session.waitingFor = undefined;
    session.message = `Requirements saved to ${session.store.sessionDir}`;
    session.artifactPath = session.store.sessionDir;
    session.artifactNames = [REQUIREMENTS_MARKDOWN, REQUIREMENTS_JSON];
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
      session.pendingQuestions = [];
      session.publish();
      ctx.ui.notify(`Requirements interview cancelled: ${messageOf(error)}`, "warning");
    } else if (error instanceof RequirementsDeferredError) {
      session.status = "cancelled";
      session.message = error.message;
      session.interviewerStatus = "cancelled";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.pendingQuestions = [];
      session.publish();
      ctx.ui.notify(error.message, "warning");
    } else {
      session.status = "failed";
      session.message = messageOf(error);
      session.interviewerStatus = "failed";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.pendingQuestions = [];
      session.publish();
      ctx.ui.notify(`Requirements interview failed: ${messageOf(error)}`, "error");
    }
  } finally {
    session.controller.abort(new Error("Requirements session ended"));
    await session.dashboard.stop().catch(() => undefined);
  }
  return session;
}

/** Why a previous interviewer call failed; carried by the `correct_output` retry envelope. */
type InterviewerCorrectionInfo =
  | {
      attempt: 1 | 2;
      reason: "schema_validation_failed";
      fieldPath?: string;
      validationError?: string;
    }
  | {
      attempt: 1;
      reason: "incomplete_response";
      validationError?: string;
    };

function cappedCorrectionError(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_CORRECTION_ERROR_BYTES) return message;
  let truncated = message;
  while (Buffer.byteLength(truncated, "utf8") > MAX_CORRECTION_ERROR_BYTES - "… (truncated)".length) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}… (truncated)`;
}

async function interviewerCall(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  deadlineStartedAt: number,
  task: InterviewerTask
): Promise<InterviewerOutput> {
  const expectedAction = task.action;
  let attempt = 0;
  let text = (await runInterviewer(session, executor, config, deadlineStartedAt, "execute", task, undefined)).text;
  for (;;) {
    try {
      const parsed = parseInterviewerOutput(text);
      assertRequestedAction(parsed, expectedAction);
      return parsed;
    } catch (error) {
      if (attempt >= MAX_INTERVIEWER_CORRECTIONS) {
        throw new Error(`Interviewer returned invalid output: ${messageOf(error)}`);
      }
      attempt += 1;
      const fieldPath = error instanceof ValidationError && /^[a-zA-Z0-9_.\[\]-]+$/.test(error.path) ? error.path : undefined;
      const corrected = await runInterviewer(session, executor, config, deadlineStartedAt, "correct_output", task, {
        attempt: attempt as 1 | 2,
        reason: "schema_validation_failed",
        ...(fieldPath ? { fieldPath } : {}),
        validationError: cappedCorrectionError(messageOf(error))
      });
      text = corrected.text;
    }
  }
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
  correction: InterviewerCorrectionInfo | undefined
) {
  const remaining = agentRemainingTimeoutMs(config.limits.agentTimeoutMs, deadlineStartedAt);
  const envelope: AgentTaskEnvelope<InterviewerTask> = mode === "correct_output"
    ? {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode,
        task,
        memoryContext: null,
        correction: correction!
      }
    : {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode,
        task,
        memoryContext: null
      };
  const envelopeText = JSON.stringify(envelope, null, 2);
  const call = session.recordCall((task as { round?: number }).round ?? session.round, task.action, mode);
  if (mode === "correct_output") call.taskText = envelopeText;
  const run: AgentRunOptions = {
    name: "interviewer",
    task: envelopeText,
    cwd: session.cwd,
    extensionRoot: session.deps.extensionRoot,
    config: config.agents.interviewer,
    timeoutMs: remaining,
    signal: session.controller.signal,
    allowedWritePaths: [],
    onTranscript: next => session.updateCall(call, {
      transcript: next,
      messageCount: next.messages.length,
      truncated: next.truncated
    }),
    onEvent: event => {
      if (event.toolName !== undefined) {
        session.updateCall(call, { toolName: event.toolName, toolArgs: event.args });
      }
    },
    onUsage: snapshot => session.updateCall(call, usagePatch(snapshot)),
    spawnExplorer: question => runSpawnedExplorer(session, executor, config, deadlineStartedAt, question)
  };
  try {
    const result = await executor.run(run);
    await session.finishCall(call, "succeeded", {
      outputText: result.text,
      usage: result.usage,
      ...(result.response ? {
        provider: result.response.provider,
        model: result.response.model,
        api: result.response.api,
        stopReason: result.response.stopReason
      } : {})
    });
    return result;
  } catch (error) {
    const cancelled = error instanceof AgentCancelledError || session.controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    await session.finishCall(call, cancelled ? "cancelled" : "failed", {
      outputText: message,
      error: message,
      ...(error instanceof AgentIncompleteResponseError ? {
        usage: error.usage,
        provider: error.provider,
        model: error.model,
        stopReason: error.stopReason
      } : {})
    });
    if (error instanceof AgentIncompleteResponseError && mode === "execute") {
      // A truncated response is common for long JSON and cheap to retry
      // (read-only): ask once for the complete output. A truncated
      // correction run is not retried; the session fails closed.
      return runInterviewer(session, executor, config, deadlineStartedAt, "correct_output", task, {
        attempt: 1,
        reason: "incomplete_response",
        validationError: cappedCorrectionError(message)
      });
    }
    throw error;
  }
}

function usagePatch(snapshot: AgentUsageSnapshot): Partial<InterviewerCallRecord> {
  return {
    usage: snapshot.usage,
    provider: snapshot.provider,
    model: snapshot.model,
    api: snapshot.api,
    stopReason: snapshot.stopReason
  };
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

interface InterviewPresentation {
  content: string;
  actions: DashboardDecisionAction[];
  question: DashboardDecisionQuestion;
}

type InterviewPresent = (
  session: Pick<RequirementsSession, "goal">,
  question: InterviewQuestion,
  picked: readonly string[]
) => InterviewPresentation;

function presentationBody(
  question: InterviewQuestion,
  picked: readonly string[],
  options: { allowCustom?: boolean } = {}
): Pick<InterviewPresentation, "actions" | "question"> {
  const actions: DashboardDecisionAction[] = question.options.map(option => ({
    value: `opt:${question.id}:${option.id}` as HumanDecisionAction,
    label: option.text,
    requiresFeedback: false
  }));
  if (options.allowCustom !== false) {
    actions.push({ value: `custom:${question.id}` as HumanDecisionAction, label: CUSTOM_ACTION_LABEL, requiresFeedback: true });
  }
  actions.push({ value: "cancel" as HumanDecisionAction, label: CANCEL_ACTION_LABEL, requiresFeedback: false });
  return {
    actions,
    question: {
      id: question.id,
      kind: question.kind,
      options: question.options.map(option => ({
        id: option.id,
        text: option.text,
        recommended: option.recommended === true,
        picked: picked.includes(option.id)
      }))
    }
  };
}

export function questionPresentation(
  session: Pick<RequirementsSession, "goal">,
  question: InterviewQuestion,
  picked: readonly string[]
): InterviewPresentation {
  const lines: string[] = [`**Goal:** ${session.goal}`, "", `## ${question.text}`];
  return {
    content: lines.join("\n"),
    ...presentationBody(question, picked)
  };
}

export function reviewPresentation(
  assessment: InterviewerAssessment,
  session: Pick<RequirementsSession, "goal">,
  question: InterviewQuestion,
  picked: readonly string[]
): InterviewPresentation {
  const lines: string[] = [
    `**Goal:** ${session.goal}`,
    "",
    "**What the interviewer understands so far:**",
    assessment.summary
  ];
  if (assessment.openQuestions !== undefined && assessment.openQuestions.length > 0) {
    lines.push("", "**Still open:**", ...assessment.openQuestions.map(item => `- ${item}`));
  }
  lines.push("", `## ${question.text}`);
  return {
    content: lines.join("\n"),
    ...presentationBody(question, picked)
  };
}

/** Presentation for the round's commit question: Finish round / Keep working, no custom answer. */
export function commitPresentation(
  session: Pick<RequirementsSession, "goal">
): InterviewPresentation {
  const lines: string[] = [
    `**Goal:** ${session.goal}`,
    "",
    `## ${COMMIT_QUESTION.text}`
  ];
  return {
    content: lines.join("\n"),
    ...presentationBody(COMMIT_QUESTION, [], { allowCustom: false })
  };
}

function tuiQuestionLabels(question: InterviewQuestion, picked: readonly string[], allowCustom = true): string[] {
  return [
    ...question.options.map(option => {
      const base = `${option.text}${option.recommended ? " (recommended)" : ""}`;
      return picked.includes(option.id) ? `✓ ${base}` : base;
    }),
    ...(allowCustom ? [CUSTOM_ACTION_LABEL] : []),
    CANCEL_ACTION_LABEL
  ];
}

/** Maps a TUI answer-dialog choice to a dashboard decision action. */
export function mapTuiChoice(question: InterviewQuestion, choice: string): InterviewActionResult | undefined {
  if (choice === CUSTOM_ACTION_LABEL) return { action: `custom:${question.id}` };
  if (choice === CANCEL_ACTION_LABEL) return { action: "cancel" };
  const option = question.options.find(candidate => candidate.text === choice.replace(/^✓ /, "").replace(/ \(recommended\)$/, ""));
  if (!option) return undefined;
  return { action: `opt:${question.id}:${option.id}` };
}

/**
 * TUI arrow-key switch request: closes the answer dialog softly so the hub
 * loop can follow the target question. Called by the TUI arrow translator.
 */
export function requestSwitch(channel: QuestionChannel, target: "next" | "previous"): void {
  channel.switchTarget = target;
  channel.dialogAbort?.abort();
}

interface SetDriverContext {
  round: number;
  setController: AbortController;
  /** Re-evaluates the commit question's armed state after every action. */
  armCommit: () => void;
  /** Marks the set committed (Finish round) and ends it. */
  setCommitted: () => void;
}

/** Shared round-commit flag; the hub and the drivers read it to tell commit aborts from cancels. */
interface CommittedRef {
  value: boolean;
}

async function askSet(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  questions: InterviewQuestion[],
  round: number
): Promise<void> {
  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  const channels: QuestionChannel[] = [
    ...questions.map(question => ({
      question,
      picked: [],
      completed: false,
      generation: 0,
      isCommit: false,
      armed: false,
      driverEnded: false
    })),
    {
      question: COMMIT_QUESTION,
      picked: [],
      completed: false,
      generation: 0,
      isCommit: true,
      armed: false,
      driverEnded: false
    }
  ];
  const commitChannel = channels[channels.length - 1];
  const setController = new AbortController();
  const committedRef: CommittedRef = { value: false };
  const setCommitted = (): void => {
    if (committedRef.value) return;
    committedRef.value = true;
    if (!setController.signal.aborted) setController.abort(new Error("Round committed"));
  };
  const armCommit = (): void => {
    const allAnswered = channels.every(candidate => candidate.isCommit || candidate.completed);
    if (allAnswered === commitChannel.armed) return;
    commitChannel.armed = allAnswered;
    publishQuestionSet(session, channels, round);
  };
  const onSessionAbort = (): void => {
    setController.abort(new Error("Requirements session ended"));
  };
  session.controller.signal.addEventListener("abort", onSessionAbort, { once: true });
  const translator = new RequirementsArrowTranslator(ctx, requestSwitch);
  try {
    armCommit();
    const driver: SetDriverContext = { round, setController, armCommit, setCommitted };
    const drivers = channels.map(channel =>
      driveQuestion(session, ctx, channels, channel, driver).catch(error => {
        if (!setController.signal.aborted) setController.abort(error);
        throw error;
      })
    );
    translator.register();
    const hubTask = (canPrompt
      ? hubLoop(session, ctx, channels, round, setController.signal, translator, committedRef).catch(error => {
          if (!setController.signal.aborted) setController.abort(error);
          throw error;
        })
      : Promise.resolve()
    ).finally(() => translator.setHubOpen(false));
    const [driversResult, hubResult] = await Promise.allSettled([Promise.all(drivers), hubTask]);
    if (!channels.every(channel => channel.isCommit || channel.completed)) {
      if (driversResult.status === "rejected") throw driversResult.reason;
      if (hubResult.status === "rejected") throw hubResult.reason;
      throw new Error("The question set ended without completing every question");
    }
    session.replaceRound(round, channels
      .filter(channel => !channel.isCommit)
      .map(channel => ({
        question: channel.question,
        answer: {
          questionId: channel.question.id,
          selectedOptionIds: channel.picked,
          ...(channel.customText !== undefined ? { customText: channel.customText } : {})
        },
        round
      })));
    session.publish();
  } finally {
    session.controller.signal.removeEventListener("abort", onSessionAbort);
    translator.unregister();
    if (!setController.signal.aborted) setController.abort(new Error("Question set complete"));
    session.pendingQuestions = [];
    session.publish();
  }
}

/** Recomputes whether the channel currently holds an answer. */
function refreshCompleted(channel: QuestionChannel): void {
  channel.completed = channel.picked.length > 0 || channel.customText !== undefined;
}

/** Waits until the channel is armed (commit question) or the set closes. */
async function waitForArmed(channel: QuestionChannel, setSignal: AbortSignal): Promise<void> {
  while (!channel.armed && !setSignal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Drives one question's presentations until the question is answered or the set closes. */
async function driveQuestion(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  channels: QuestionChannel[],
  channel: QuestionChannel,
  driver: SetDriverContext
): Promise<void> {
  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  const setSignal = driver.setController.signal;
  if (channel.isCommit) {
    await waitForArmed(channel, setSignal);
    if (setSignal.aborted) {
      channel.driverEnded = true;
      return;
    }
  }
  while (true) {
    if (setSignal.aborted) {
      channel.driverEnded = true;
      return;
    }
    if (channel.isCommit && !channel.armed) {
      await waitForArmed(channel, setSignal);
      if (setSignal.aborted) {
        channel.driverEnded = true;
        return;
      }
      continue;
    }
    const question = channel.question;
    const picked = [...channel.picked];
    const presented = channel.isCommit
      ? commitPresentation(session)
      : questionPresentation(session, question, picked);
    const label = question.kind === "multiple" && picked.length > 0
      ? `${question.text} (${picked.length} selected)`
      : question.text;
    const race = beginDecisionRace<InterviewActionResult | undefined>({
      decisionId: nextDecisionId(),
      label,
      dashboard: session.dashboard,
      presentation: {
        format: "markdown",
        content: presented.content,
        actions: presented.actions,
        question: presented.question
      },
      signal: setSignal
    });
    race.register();
    channel.generation++;
    channel.decisionId = race.decisionId;
    channel.label = label;
    channel.presentation = presented;
    channel.prompt = undefined;
    channel.wake = undefined;
    publishQuestionSet(session, channels, driver.round);
    let winner: RaceWinner<InterviewActionResult | undefined>;
    try {
      winner = await race.race(canPrompt, signal => parkTuiPrompt(channel, signal));
    } catch (error) {
      channel.prompt = undefined;
      channel.decisionId = undefined;
      channel.label = undefined;
      channel.presentation = undefined;
      if (setSignal.aborted) {
        channel.driverEnded = true;
        return;
      }
      throw error;
    }
    channel.prompt = undefined;
    channel.decisionId = undefined;
    channel.label = undefined;
    channel.presentation = undefined;
    winner.acknowledge?.();
    const result = winner.result;
    if (result === undefined) continue;
    if (result.action === "cancel") {
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    if (channel.isCommit) {
      if (result.action === COMMIT_FINISH_ACTION) {
        if (!channels.every(candidate => candidate.isCommit || candidate.completed)) {
          // The gate reopened (e.g. a pick was reverted elsewhere); a stale
          // Finish round must not commit an incomplete set.
          resolveWake(channel);
          publishQuestionSet(session, channels, driver.round);
          continue;
        }
        channel.completed = true;
        resolveWake(channel);
        publishQuestionSet(session, channels, driver.round);
        driver.setCommitted();
        channel.driverEnded = true;
        return;
      }
      if (result.action === COMMIT_KEEP_ACTION) {
        resolveWake(channel);
        publishQuestionSet(session, channels, driver.round);
        continue;
      }
      resolveWake(channel);
      continue;
    }
    if (result.action === `custom:${question.id}`) {
      if (question.kind === "single") channel.picked = [];
      channel.customText = result.feedback;
      refreshCompleted(channel);
      // Re-publish this channel with the race that just answered it so the set
      // never transiently drops a presented question (the shared clear below
      // the race already ran; the re-present publish in the same tick replaces
      // this pre-pick presentation).
      channel.decisionId = race.decisionId;
      channel.label = label;
      channel.presentation = presented;
      resolveWake(channel);
      publishQuestionSet(session, channels, driver.round);
      driver.armCommit();
      continue;
    }
    const prefix = `opt:${question.id}:`;
    if (result.action.startsWith(prefix)) {
      const optionId = result.action.slice(prefix.length);
      if (question.options.some(option => option.id === optionId)) {
        if (question.kind === "single") {
          channel.picked = [optionId];
          channel.customText = undefined;
        } else {
          const index = channel.picked.indexOf(optionId);
          if (index === -1) channel.picked.push(optionId);
          else channel.picked.splice(index, 1);
        }
      }
      refreshCompleted(channel);
      // See the custom-action handler above: re-set the answered race's fields
      // so this channel is never omitted from the published set.
      channel.decisionId = race.decisionId;
      channel.label = label;
      channel.presentation = presented;
      resolveWake(channel);
      publishQuestionSet(session, channels, driver.round);
      driver.armCommit();
      continue;
    }
    throw new Error(`Unexpected interview action: ${result.action}`);
  }
}

/** Parks the TUI answer prompt on the channel; the hub coroutine drives the dialog. */
function parkTuiPrompt(channel: QuestionChannel, signal: AbortSignal): Promise<InterviewActionResult | undefined> {
  let resolve!: (result: InterviewActionResult | undefined) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<InterviewActionResult | undefined>((res, rej) => { resolve = res; reject = rej; });
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  channel.prompt = { signal, resolve, promise };
  return promise;
}

/** Resolves the hub's pending wake, telling it the driver consumed the answer. */
function resolveWake(channel: QuestionChannel): void {
  const wake = channel.wake;
  channel.wake = undefined;
  if (wake !== undefined) wake.resolve();
}

/** Waits for the driver to park a prompt or end. */
async function waitForPrompt(channel: QuestionChannel): Promise<TuiPrompt | undefined> {
  while (true) {
    if (channel.driverEnded) return undefined;
    if (channel.prompt !== undefined) return channel.prompt;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Runs the TUI answer dialog for a parked prompt, returning the mapped action. */
async function tuiAnswerDialog(
  ctx: ExtensionCommandContext,
  channel: QuestionChannel,
  signal: AbortSignal
): Promise<InterviewActionResult | undefined> {
  const question = channel.question;
  const picked = [...channel.picked];
  const label = question.kind === "multiple" && picked.length > 0
    ? `${question.text} (${picked.length} selected)`
    : question.text;
  const dialogController = new AbortController();
  channel.dialogAbort = dialogController;
  try {
    const dialogSignal = AbortSignal.any([signal, dialogController.signal]);
    const labels = [
      ...tuiQuestionLabels(question, picked, question.id !== COMMIT_QUESTION.id),
      BACK_ACTION_LABEL
    ];
    const choice = await ctx.ui.select(label, labels, { signal: dialogSignal });
    if (choice === undefined) return undefined;
    const mapped = mapTuiChoice(question, choice);
    if (mapped?.action === `custom:${question.id}`) {
      channel.customInputOpen = true;
      try {
        const text = await ctx.ui.input(`Your own answer for: ${question.text}`, undefined, { signal: dialogSignal });
        if (text === undefined) return undefined;
        return { action: `custom:${question.id}`, feedback: text.trim() };
      } finally {
        channel.customInputOpen = false;
      }
    }
    return mapped;
  } catch (error) {
    if (channel.switchTarget !== undefined || (error instanceof Error && error.name === "AbortError")) return undefined;
    throw error;
  } finally {
    channel.dialogAbort = undefined;
  }
}

/**
 * Opens the question's TUI answer dialog on behalf of the hub, resolving the
 * parked prompt with the user's answer and awaiting the driver's consumption.
 * The dialog stays open after an answer so the user can revise it in place.
 */
async function answerQuestionViaTui(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  channel: QuestionChannel,
  round: number,
  translator?: RequirementsArrowTranslator
): Promise<void> {
  translator?.setDialogChannel(channel);
  try {
    while (true) {
      const prompt = await waitForPrompt(channel);
      if (prompt === undefined) return;
      const result = await tuiAnswerDialog(ctx, channel, prompt.signal);
      if (result === undefined) return;
      const wake = deferred<void>();
      channel.wake = wake;
      prompt.resolve(result);
      await wake.promise;
    }
  } finally {
    translator?.setDialogChannel(undefined);
  }
}

/** The round's question hub: pick a question to answer, finish the round, or cancel. */
async function hubLoop(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  channels: QuestionChannel[],
  round: number,
  setSignal: AbortSignal,
  translator?: RequirementsArrowTranslator,
  committedRef?: CommittedRef
): Promise<void> {
  translator?.setHubOpen(true);
  let hubPosition = 0;
  while (true) {
    const realChannels = channels.filter(channel => !channel.isCommit);
    const answeredCount = realChannels.filter(channel => channel.completed).length;
    const entries = channels
      .map((channel, index) => ({ channel, index, label: hubQuestionLabel(channel, index) }))
      .filter(entry => !entry.channel.isCommit || entry.channel.armed);
    translator?.setHubListCount(entries.length);
    translator?.setHubPosition(hubPosition);
    const hubChoices = [
      ...entries.map(entry => entry.label),
      CANCEL_ACTION_LABEL
    ];
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(`Questions (round ${round}) — ${answeredCount}/${realChannels.length} answered`, hubChoices, { signal: setSignal });
    } catch (error) {
      if (committedRef?.value === true) return;
      throw error;
    }
    if (choice === undefined || choice === CANCEL_ACTION_LABEL) {
      if (committedRef?.value === true) return;
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    const chosen = entries.find(entry => entry.label === choice);
    if (chosen === undefined) continue;
    hubPosition = chosen.index;
    const target = followSwitchTarget(channels, channels[chosen.index]);
    if (target === undefined) continue;
    await answerQuestionViaTui(session, ctx, target, round, translator);
    if (committedRef?.value === true) return;
  }
}

/** Follows chained arrow-key switch requests, clearing each consumed target. */
function followSwitchTarget(channels: QuestionChannel[], channel: QuestionChannel): QuestionChannel | undefined {
  let current = channel;
  while (current.switchTarget !== undefined) {
    const target = current.switchTarget;
    current.switchTarget = undefined;
    const index = channels.indexOf(current);
    const nextIndex = target === "next" ? index + 1 : index - 1;
    if (nextIndex < 0 || nextIndex >= channels.length) return undefined;
    current = channels[nextIndex];
  }
  if (current.isCommit && !current.armed) return undefined;
  return current;
}

/** Publishes the round's question set as dashboard-answerable pending questions. */
function publishQuestionSet(
  session: RequirementsSession,
  channels: QuestionChannel[],
  round: number
): void {
  session.status = "waiting";
  session.waitingFor = `Answering questions (round ${round})`;
  session.pendingDecision = undefined;
  session.pendingQuestions = [];
  for (const channel of channels) {
    const decisionId = channel.decisionId;
    const presentation = channel.presentation;
    const label = channel.label;
    if (decisionId === undefined || presentation === undefined || label === undefined) continue;
    session.pendingQuestions.push({
      decisionId,
      questionId: channel.question.id,
      kind: channel.question.kind,
      label,
      content: presentation.content,
      actions: presentation.actions,
      question: presentation.question,
      answered: channel.completed
    });
  }
  session.publish();
}

async function askQuestion(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  state: SetQuestionState,
  round: number,
  present: InterviewPresent = questionPresentation
): Promise<InterviewAnswer | undefined> {
  const question = state.question;
  const picked: string[] = [...state.picked];
  while (true) {
    const presented = present(session, question, picked);
    const label = question.kind === "multiple" && picked.length > 0
      ? `${question.text} (${picked.length} selected)`
      : question.text;
    const interaction: InterviewInteraction = {
      label,
      content: presented.content,
      actions: presented.actions,
      question: presented.question,
      prompt: async signal => {
        const choice = await ctx.ui.select(label, tuiQuestionLabels(question, picked), { signal });
        if (choice === undefined) return undefined;
        const mapped = mapTuiChoice(question, choice);
        if (mapped?.action === `custom:${question.id}`) {
          const text = await ctx.ui.input(`Your own answer for: ${question.text}`, undefined, { signal });
          if (text === undefined) return undefined;
          return { action: `custom:${question.id}`, feedback: text.trim() };
        }
        return mapped;
      }
    };
    const result = await raceDecision(session, ctx, interaction, session.controller.signal, { deferOnUndefined: false });
    if (result === undefined) return undefined;
    if (result.action === "cancel") {
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    if (result.action === `custom:${question.id}`) {
      if (question.kind === "single") {
        return { questionId: question.id, selectedOptionIds: [], customText: result.feedback };
      }
      return { questionId: question.id, selectedOptionIds: picked, customText: result.feedback };
    }
    const prefix = `opt:${question.id}:`;
    if (result.action.startsWith(prefix)) {
      const optionId = result.action.slice(prefix.length);
      if (question.options.some(option => option.id === optionId)) {
        if (question.kind === "single") {
          picked.length = 0;
          picked.push(optionId);
          return { questionId: question.id, selectedOptionIds: picked };
        }
        const index = picked.indexOf(optionId);
        if (index === -1) picked.push(optionId);
        else picked.splice(index, 1);
      }
      if (question.kind === "single") return { questionId: question.id, selectedOptionIds: picked };
      continue;
    }
    throw new Error(`Unexpected interview action: ${result.action}`);
  }
}

async function askReview(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  assessment: InterviewerAssessment,
  round: number
): Promise<{ clear: boolean; feedback?: string } | undefined> {
  const answer = await askQuestion(
    session,
    ctx,
    { question: REVIEW_QUESTION, picked: [] },
    round,
    (s, question, picked) => reviewPresentation(assessment, s, question, picked)
  );
  if (answer === undefined) return undefined;
  if (answer.selectedOptionIds.includes(REVIEW_YES_OPTION_ID)) return { clear: true };
  return {
    clear: false,
    ...(answer.customText !== undefined ? { feedback: answer.customText } : {})
  };
}

async function raceDecision(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  interaction: InterviewInteraction,
  signal: AbortSignal,
  options: { deferOnUndefined?: boolean } = {}
): Promise<InterviewActionResult | undefined> {
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
    presentation: {
      format: "markdown",
      content: interaction.content,
      actions: interaction.actions,
      question: interaction.question
    },
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
    if (options.deferOnUndefined === false) return undefined;
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
