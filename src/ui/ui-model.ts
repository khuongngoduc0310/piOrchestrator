import type {
  AgentName,
  AgentStatus,
  AgentSummary,
  ConfigSummary,
  DashboardInterviewQAndA,
  InterviewQAndA,
  OrchestratorViewModel,
  PendingQuestionInfo,
  RequirementsSummary,
  RunSummary,
  Stage,
  StepRecord,
  WorkflowState
} from "../types.js";
import { AGENT_NAMES, UI_PHASE_LABELS } from "../types.js";

const COMMANDS = [
  "/orchestrate",
  "/orchestrator-settings"
];

export function buildIdleViewModel(
  cwd: string,
  config: ConfigSummary
): OrchestratorViewModel {
  const agents: AgentSummary[] = AGENT_NAMES.map(name => ({
    name,
    model: "",
    status: "idle"
  }));

  if (config.status === "invalid") {
    return {
      mode: "config_error",
      cwd,
      config,
      agents,
      recentSteps: [],
      timelineSteps: [],
      milestones: [],
      commands: COMMANDS
    };
  }

  return {
    mode: "idle",
    cwd,
    config,
    agents,
    recentSteps: [],
    timelineSteps: [],
    milestones: [],
    commands: COMMANDS
  };
}

export interface RequirementsViewModelInput {
  sessionId: string;
  cwd: string;
  goal: string;
  status: "running" | "waiting" | "completed" | "failed" | "cancelled";
  round: number;
  maxRounds: number;
  waitingFor?: string;
  pendingDecision?: { id: string; kind: string; label: string; requestedAt: string; dashboardAvailable: boolean };
  pendingQuestions?: PendingQuestionInfo[];
  dashboardUrl?: string;
  message?: string;
  artifactPath?: string;
  interviewerStatus: AgentStatus["status"];
  interviewerModel?: string;
  transcriptRevision?: number;
  qa?: DashboardInterviewQAndA[];
  artifactNames?: string[];
  requirement?: RequirementsSummary;
}

/** Maps the interview Q&A history to the dashboard shape, resolving option ids to labels. */
export function interviewQaToDashboard(history: readonly InterviewQAndA[]): DashboardInterviewQAndA[] {
  return history.map(entry => {
    const picks = entry.answer.selectedOptionIds
      .map(id => entry.question.options.find(option => option.id === id)?.text ?? id)
      .join(", ");
    return {
      questionText: entry.question.text,
      kind: entry.question.kind,
      round: entry.round ?? 1,
      options: entry.question.options.map(option => ({
        id: option.id,
        text: option.text,
        recommended: option.recommended ?? false,
        picked: entry.answer.selectedOptionIds.includes(option.id)
      })),
      answerText: picks,
      ...(entry.answer.customText !== undefined ? { customText: entry.answer.customText } : {})
    };
  });
}

/** Mission Control view model for an in-memory requirements-builder session. */
export function buildRequirementsViewModel(input: RequirementsViewModelInput): OrchestratorViewModel {
  const agents: AgentSummary[] = AGENT_NAMES.map(name => ({
    name,
    model: name === "interviewer" ? (input.interviewerModel ?? "") : "",
    status: name === "interviewer" ? input.interviewerStatus : "idle"
  }));
  const runStatus: RunSummary["runStatus"] = input.status === "waiting" ? "paused" : input.status;
  const stage: Stage = input.status === "waiting" ? "paused" : input.status === "running" ? "exploring" : input.status;
  const terminal = input.status === "completed" || input.status === "failed" || input.status === "cancelled";
  const run: RunSummary = {
    id: input.sessionId,
    request: input.goal,
    runStatus,
    stage,
    phaseIndex: 0,
    phaseCount: 1,
    attempt: input.round,
    maxAttempts: Math.max(1, input.maxRounds),
    elapsedMs: 0,
    artifactPath: input.artifactPath ?? "",
    message: input.message,
    waitingFor: input.waitingFor,
    dashboardUrl: input.dashboardUrl,
    pendingDecision: input.pendingDecision,
    ...(input.pendingQuestions && input.pendingQuestions.length > 0 ? { pendingQuestions: input.pendingQuestions } : {}),
    transcriptRevision: input.transcriptRevision ?? 0,
    activeAgent: input.status === "running" ? "interviewer" : undefined,
    qa: input.qa ?? [],
    ...(input.artifactNames && input.artifactNames.length > 0 ? { artifactNames: input.artifactNames } : {}),
    ...(input.requirement ? { requirement: input.requirement } : {})
  };
  return {
    mode: input.status,
    cwd: input.cwd,
    config: { status: "valid", agentCount: AGENT_NAMES.length, checkCount: 0 },
    run,
    agents,
    recentSteps: [],
    milestones: [],
    commands: terminal ? [] : ["/orchestrator-cancel"]
  };
}

export function buildRunViewModel(
  state: WorkflowState,
  config: ConfigSummary,
  cwd: string,
  elapsedMs: number,
  maxAttempts: number
): OrchestratorViewModel {
  const structuredState = state as WorkflowState & {
    stoppedStage?: unknown;
    termination?: unknown;
  };
  const termination = recordOf(structuredState.termination);
  const stoppedStage = stageOf(structuredState.stoppedStage)
    ?? stageOf(termination?.stoppedStage)
    ?? state.failedStage;
  const terminationMessage = stringOf(termination?.message) ?? stringOf(termination?.reason);

  const agents: AgentSummary[] = AGENT_NAMES.map(name => {
    const agentStatus: AgentStatus = state.agents[name] ?? { status: "idle", model: "" };
    return {
      name,
      model: agentStatus.model,
      status: agentStatus.status,
      summary: agentStatus.summary,
      error: agentStatus.error,
      invocationCount: state.steps
        .filter(step => step.agent === name)
        .reduce((count, step) => count + (step.invocations?.length ?? 0), 0)
    };
  });

  const phaseIndex = stageToPhaseIndex(state.stage, state.steps, stoppedStage, state.route);
  const phaseCount = UI_PHASE_LABELS.length;

  const lastFailed = [...state.steps].reverse().find(
    step => step.status === "failed" || step.status === "cancelled"
  );
  const failedArtifact = lastFailed?.rawArtifact ?? lastFailed?.artifact;

  const hasLiveGate = state.humanGate !== undefined;
  const hasWaitingFor = state.waitingFor !== undefined && state.waitingFor.length > 0;

  const pendingDecision = state.pendingDecision
    ? { id: state.pendingDecision.id, kind: state.pendingDecision.kind, label: state.pendingDecision.label, requestedAt: state.pendingDecision.requestedAt, dashboardAvailable: false }
    : undefined;

  const runSummary: RunSummary = {
    id: state.runId,
    request: state.request,
    route: state.route,
    runStatus: state.status,
    stage: state.stage,
    phaseIndex,
    phaseCount,
    skippedPhaseIndexes: skippedPhaseIndexes(state.route),
    activeAgent: state.activeAgent,
    attempt: state.attempt,
    maxAttempts: Math.max(maxAttempts, state.attempt),
    elapsedMs,
    artifactPath: state.runDir,
    failedArtifact,
    message: terminationMessage ?? state.message,
    warning: state.warning,
    waitingFor: state.waitingFor,
    currentTool: state.currentTool,
    currentToolArgs: state.currentToolArgs,
    agentOutput: state.agentOutput,
    toolStatus: state.toolStatus,
    dashboardUrl: state.dashboardUrl,
    extensionVersion: state.extensionVersion,
    pendingDecision,
    checkpoint: state.latestCheckpoint,
    resumeCommand: (state.status === "paused" || state.status === "failed" || state.status === "cancelled") && state.latestCheckpoint && !state.resumeBlockedReason ? `/orchestrator-resume ${state.runId}` : undefined,
    resumeCount: state.resumeCount,
    resumeBlockedReason: state.resumeBlockedReason,
  };

  const visibleSteps = state.steps.slice(-12);
  const timelineSteps = state.steps.map(({ invocations: _invocations, ...step }) => step);

  const completedOrFailed = state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  const runMode: OrchestratorViewModel["mode"] = state.status === "paused" && hasLiveGate ? "waiting" : state.status === "paused" ? "paused" : completedOrFailed ? state.status : hasWaitingFor ? "waiting" : "running";

  return {
    mode: runMode,
    cwd,
    config,
    run: runSummary,
    agents,
    recentSteps: visibleSteps,
    timelineSteps,
    milestones: state.milestones ?? [],
    commands: state.status === "completed"
      ? COMMANDS
      : state.status === "running"
        ? ["/orchestrator-status", "/orchestrator-cancel"]
        : state.latestCheckpoint && !state.resumeBlockedReason
          ? [`/orchestrator-resume ${state.runId}`, `/orchestrator-inspect ${state.runId}`]
          : [`/orchestrator-inspect ${state.runId}`]
  };
}

function skippedPhaseIndexes(route: WorkflowState["route"]): number[] | undefined {
  if (route === "review_only" || route === "investigation_only") return [3, 4, 5];
  if (route === "planning_only") return [3, 4, 5, 6];
  if (route === "documentation_only") return [4, 5, 6];
  if (route === "tests_only") return [5, 6];
  return undefined;
}

export function phaseProgress(phaseIndex: number, attempts?: string): string {
  const label = UI_PHASE_LABELS[phaseIndex] ?? "Unknown";
  const suffix = attempts ? ` · ${attempts}` : "";
  return `${label}${suffix}`;
}

export function elapsedText(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
  }
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function stageToPhaseIndex(stage: Stage, steps: StepRecord[], failedStage?: Stage, route?: WorkflowState["route"]): number {
  switch (stage) {
    case "preflight": return 0;
    case "exploring": return 1;
    case "planning":
    case "reviewing_plan":
    case "human_review_plan":
    case "human_review_revision": return 2;
    case "baseline": return 3;
    case "creating_tests":
    case "human_confirm_mutation": return 4;
    case "implementing": return 5;
    case "debugging": return route === "investigation_only" ? 6 : 5;
    case "testing": return testingPhaseIndex(steps);
    case "reviewing_code":
    case "reviewing_repository": return 6;
    case "documenting":
    case "screening_lessons":
    case "human_review_lessons":
    case "promoting_memory":
    case "reviewing_lessons": return 7;
    default: return stageToPhaseIndexDefault(stage, steps, failedStage, route);
  }
}

function testingPhaseIndex(steps: StepRecord[]): number {
  const last = [...steps].reverse().find(s => s.stage === "testing");
  if (!last) return 4;
  const label = last.label ?? "";
  if (/final/i.test(label)) return 7;
  if (/review fix|after review/i.test(label)) return 6;
  if (/implementation|impl\b/i.test(label)) return 5;
  if (/after test/i.test(label)) return 4;
  return 4;
}

function stageToPhaseIndexDefault(stage: Stage, steps: StepRecord[], failedStage?: Stage, route?: WorkflowState["route"]): number {
  if (stage === "completed") return UI_PHASE_LABELS.length - 1;
  if (stage === "idle") return 0;
  if ((stage === "failed" || stage === "cancelled") && failedStage) {
    return stageToPhaseIndex(failedStage, steps, undefined, route);
  }
  return 0;
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stageOf(value: unknown): Stage | undefined {
  return typeof value === "string" ? value as Stage : undefined;
}
