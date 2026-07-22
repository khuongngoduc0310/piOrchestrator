import type { AgentName } from "./agent-types.js";
import type { Stage, StepRecord, WorkflowState } from "./workflow-types.js";

export const UI_PHASE_LABELS = [
  "Setup / preflight",
  "Explore",
  "Plan",
  "Baseline",
  "Tests",
  "Implementation",
  "Code review",
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
  runStatus: WorkflowState["status"];
  stage: Stage;
  phaseIndex: number;
  phaseCount: number;
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
  mode: "idle" | "running" | "completed" | "failed" | "cancelled" | "config_error" | "waiting";
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
