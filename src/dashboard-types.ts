import type { AgentInvocationMode, AgentName, AgentUsage } from "./agent-types.js";
import type { WorkflowRoute } from "./agent-task-types.js";
import type { Stage, StepRecord, WorkflowMilestone, WorkflowState } from "./workflow-types.js";
import type { InvocationFileDiff } from "./workspace/git-tree-diff.js";
import type { HumanDecisionAction } from "./orchestration/human-decision-types.js";

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

export interface DashboardDecisionAction {
  value: HumanDecisionAction;
  label: string;
  requiresFeedback: boolean;
}

export interface DashboardDecisionQuestionOption {
  id: string;
  text: string;
  recommended: boolean;
  picked: boolean;
}

export interface DashboardDecisionQuestion {
  id: string;
  kind: "single" | "multiple";
  options: DashboardDecisionQuestionOption[];
}

export interface DashboardDecisionPresentation {
  format: "markdown";
  content: string;
  actions: readonly DashboardDecisionAction[];
  /** Structured question surface for interview questions; gates omit it. */
  question?: DashboardDecisionQuestion;
}

/** One unanswered question of the round's question set, rendered as a dashboard hub entry. */
export interface PendingQuestionInfo {
  decisionId: string;
  questionId: string;
  kind: "single" | "multiple";
  label: string;
  content: string;
  actions: DashboardDecisionAction[];
  question: DashboardDecisionQuestion;
  answered: boolean;
}

/** One answered interview question, rendered on the dashboard. */
export interface DashboardInterviewQOption {
  id: string;
  text: string;
  recommended: boolean;
  picked: boolean;
}

/** One answered interview question, rendered on the dashboard. */
export interface DashboardInterviewQAndA {
  questionText: string;
  kind: "single" | "multiple";
  /** Interview round this question was answered in. */
  round: number;
  /** The question's options with their picked/recommended state. */
  options: DashboardInterviewQOption[];
  /** Picked option labels joined with ", "; empty when the user typed a custom answer. */
  answerText: string;
  /** Present only when the user typed a custom answer. */
  customText?: string;
}

/** Structured sections of the final requirements report. */
export interface RequirementsSummary {
  goal: string;
  summary: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
}

export interface ConfigSummary {
  status: "missing" | "valid" | "invalid";
  agentCount: number;
  checkCount: number;
  message?: string;
}

export interface PendingDecisionInfo {
  id: string;
  kind: string;
  label: string;
  requestedAt: string;
  dashboardAvailable: boolean;
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
  pendingDecision?: PendingDecisionInfo;
  /** Pending interview question set (all questions of the round at once) for requirements sessions. */
  pendingQuestions?: PendingQuestionInfo[];
  checkpoint?: { number: number; cursor: string; createdAt: string };
  resumeCommand?: string;
  resumeCount?: number;
  resumeBlockedReason?: string;
  /** Answered interview Q&A for requirements sessions; workflow runs omit it. */
  qa?: DashboardInterviewQAndA[];
  /** Structured final requirements report for completed requirements sessions. */
  requirement?: RequirementsSummary;
  /** Repository-relative artifact names openable for this run. */
  artifactNames?: string[];
}

export interface AgentSummary {
  name: AgentName;
  model: string;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  summary?: string;
  error?: string;
  invocationCount?: number;
}

export type TimelineStepSummary = Omit<StepRecord, "invocations">;

export interface OrchestratorViewModel {
  mode: "idle" | "running" | "paused" | "completed" | "failed" | "cancelled" | "config_error" | "waiting";
  cwd: string;
  config: ConfigSummary;
  run?: RunSummary;
  agents: AgentSummary[];
  recentSteps: StepRecord[];
  timelineSteps?: TimelineStepSummary[];
  milestones?: WorkflowMilestone[];
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
