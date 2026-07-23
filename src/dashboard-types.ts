import type { AgentInvocationMode, AgentName, AgentUsage } from "./agent-types.js";
import type { WorkflowRoute } from "./agent-task-types.js";
import type { Stage, StepRecord, WorkflowState } from "./workflow-types.js";
import type { InvocationFileDiff } from "./workspace/git-tree-diff.js";

export const UI_PHASE_LABELS = [
  "Setup / preflight",
  "Explore",
  "Plan",
  "Baseline",
  "Tests",
  "Implementation",
  "Review",
  "Finalize"
] as const;
export type UiPhase = (typeof UI_PHASE_LABELS)[number];

export interface ConfigSummary {
  status: "missing" | "valid" | "invalid";
  agentCount: number;
  checkCount: number;
  message?: string;
}

export interface RunSummary {
  id: string;
  request: string;
  route?: WorkflowRoute;
  runStatus: WorkflowState["status"];
  stage: Stage;
  phaseIndex: number;
  phaseCount: number;
  skippedPhaseIndexes?: number[];
  activeAgent?: AgentName;
  attempt: number;
  maxAttempts: number;
  elapsedMs: number;
  artifactPath: string;
  failedArtifact?: string;
  message?: string;
  warning?: string;
  waitingFor?: string;
  currentTool?: string;
  currentToolArgs?: string;
  agentOutput?: string[];
  toolStatus?: string;
  dashboardUrl?: string;
  extensionVersion?: string;
  transcriptRevision?: number;
  checkpoint?: { number: number; cursor: string; createdAt: string };
  resumeCommand?: string;
  resumeCount?: number;
  resumeBlockedReason?: string;
}

export interface AgentSummary {
  name: AgentName;
  model: string;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  invocationCount?: number;
}

export interface OrchestratorViewModel {
  mode: "idle" | "running" | "paused" | "completed" | "failed" | "cancelled" | "config_error" | "waiting";
  cwd: string;
  config: ConfigSummary;
  run?: RunSummary;
  agents: AgentSummary[];
  recentSteps: StepRecord[];
  commands: string[];
}

export interface AgentToolEvent {
  toolName?: string;
  args?: string;
  isError?: boolean;
  text?: string;
  startedAt?: string;
}

export interface AgentInspection {
  name: AgentName;
  status: string;
  model: string;
  summary?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  currentTool?: string;
  currentToolArgs?: string;
  toolStatus?: string;
  agentOutput?: string[];
  steps: StepRecord[];
  toolEvents: AgentToolEvent[];
  hasArtifact: boolean;
  hasRawArtifact: boolean;
  transcriptRevision?: number;
}

export interface ArtifactContent {
  name: string;
  text: string;
  truncated: boolean;
  isJson: boolean;
  size: number;
}

export interface DashboardRunHistoryItem {
  id: string;
  request: string;
  route?: WorkflowRoute;
  status: WorkflowState["status"];
  stage: Stage;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  active: boolean;
}

export interface InvocationDiffView {
  metadata: InvocationFileDiff;
  patch: string;
  patchTruncated: boolean;
}

export interface AgentUsageSummary {
  invocationCount: number;
  measuredInvocationCount: number;
  usage?: AgentUsage;
}

export interface AgentHistoryInvocation {
  key: string;
  stepId: string;
  stepLabel: string;
  sequence: number;
  agent: AgentName;
  mode: AgentInvocationMode;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  durationMs?: number;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  changedFileCount?: number;
  hasTranscript: boolean;
  hasDiff: boolean;
}

export interface AgentHistoryResponse {
  runId: string;
  total: AgentUsageSummary;
  agents: Array<AgentUsageSummary & { name: AgentName }>;
  invocations: AgentHistoryInvocation[];
}
