import type {
  AgentName,
  AgentStatus,
  AgentSummary,
  ConfigSummary,
  OrchestratorViewModel,
  RunSummary,
  Stage,
  StepRecord,
  WorkflowState
} from "./types.js";
import { AGENT_NAMES, UI_PHASE_LABELS } from "./types.js";

const COMMANDS = [
  "/orchestrate --route <route> <request>",
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
      commands: COMMANDS
    };
  }

  return {
    mode: "idle",
    cwd,
    config,
    agents,
    recentSteps: [],
    commands: COMMANDS
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

  const phaseIndex = stageToPhaseIndex(state.stage, state.steps, stoppedStage);
  const phaseCount = UI_PHASE_LABELS.length;

  const lastFailed = [...state.steps].reverse().find(
    step => step.status === "failed" || step.status === "cancelled"
  );
  const failedArtifact = lastFailed?.rawArtifact ?? lastFailed?.artifact;

  const isWaiting = state.waitingFor !== undefined && state.waitingFor.length > 0;

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
    maxAttempts,
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
    checkpoint: state.latestCheckpoint,
    resumeCommand: (state.status === "failed" || state.status === "cancelled") && state.latestCheckpoint && !state.resumeBlockedReason ? `/orchestrator-resume ${state.runId}` : undefined,
    resumeCount: state.resumeCount,
    resumeBlockedReason: state.resumeBlockedReason,
  };

  const visibleSteps = state.steps.slice(-12);

  const completedOrFailed = state.status === "completed" || state.status === "failed" || state.status === "cancelled";
  const runMode: OrchestratorViewModel["mode"] = completedOrFailed ? state.status : isWaiting ? "waiting" : "running";

  return {
    mode: runMode,
    cwd,
    config,
    run: runSummary,
    agents,
    recentSteps: visibleSteps,
    commands: state.status === "completed"
      ? COMMANDS
      : state.status === "running"
        ? ["/orchestrator-status", "/orchestrator-cancel"]
        : state.latestCheckpoint
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

function stageToPhaseIndex(stage: Stage, steps: StepRecord[], failedStage?: Stage): number {
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
    case "implementing":
    case "debugging": return 5;
    case "testing": return testingPhaseIndex(steps);
    case "reviewing_code":
    case "reviewing_repository": return 6;
    case "documenting":
    case "screening_lessons":
    case "human_review_lessons":
    case "promoting_memory":
    case "reviewing_lessons": return 7;
    default: return stageToPhaseIndexDefault(stage, steps, failedStage);
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

function stageToPhaseIndexDefault(stage: Stage, steps: StepRecord[], failedStage?: Stage): number {
  if (stage === "completed") return UI_PHASE_LABELS.length - 1;
  if (stage === "idle") return 0;
  if ((stage === "failed" || stage === "cancelled") && failedStage) {
    return stageToPhaseIndex(failedStage, steps);
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
