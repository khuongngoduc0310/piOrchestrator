import type { AgentInvocationRecord, AgentName, AgentStatus } from "./agent-types.js";
import type { WorkflowTermination } from "./orchestration/workflow-errors.js";
import type { HumanDecisionKind, PendingHumanDecision } from "./orchestration/human-decision-types.js";
import type { CheckpointCursorKind, DebuggerOutput, WorkflowRoute } from "./workflow-shared.js";

export const SCHEMA_VERSION = 2;

export type Stage =
  | "idle"
  | "preflight"
  | "exploring"
  | "planning"
  | "reviewing_plan"
  | "human_review_plan"
  | "human_review_revision"
  | "human_confirm_mutation"
  | "baseline"
  | "creating_tests"
  | "implementing"
  | "testing"
  | "debugging"
  | "reviewing_code"
  | "reviewing_repository"
  | "documenting"
  | "screening_lessons"
  | "human_review_lessons"
  | "promoting_memory"
  | "reviewing_lessons"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowStateStatus = "running" | "paused" | "completed" | "failed" | "cancelled";

export interface HumanGateState {
  kind: HumanDecisionKind;
  label: string;
  startedAt: string;
}

export interface HumanPlanReviewResult {
  approved: boolean;
  feedback?: string;
  cancelled?: boolean;
}

export interface StepRecord {
  id: string;
  sequence: number;
  stage: Stage;
  label: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  agent?: AgentName;
  attempt?: number;
  revision?: number;
  startedAt: string;
  completedAt?: string;
  artifact?: string;
  rawArtifact?: string;
  mutationArtifact?: string;
  message?: string;
  invocations?: AgentInvocationRecord[];
}

export interface WorkflowMilestone {
  id: string;
  sequence: number;
  kind: string;
  title: string;
  details: string;
  occurredAt: string;
  decisionId?: string;
}

export interface WorkflowState {
  schemaVersion: number;
  extensionVersion: string;
  runId: string;
  request: string;
  route?: WorkflowRoute;
  cwd: string;
  runDir: string;
  stage: Stage;
  failedStage?: Stage;
  stoppedStage?: Stage;
  status: WorkflowStateStatus;
  activeAgent?: AgentName;
  attempt: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  message?: string;
  warning?: string;
  dashboardUrl?: string;
  waitingFor?: string;
  humanGate?: HumanGateState;
  pendingDecision?: PendingHumanDecision;
  termination?: WorkflowTermination;
  memoryMode?: "untrusted" | "disabled" | "empty" | "valid" | "invalid" | "scope_mismatch" | "unsupported";
  memoryRevision?: number;
  latestCheckpoint?: {
    number: number;
    cursor: CheckpointCursorKind;
    createdAt: string;
  };
  resumeCount?: number;
  resumedAt?: string;
  resumedFromCheckpoint?: CheckpointCursorKind;
  resumeBlockedReason?: string;
  currentTool?: string;
  currentToolArgs?: string;
  agentOutput?: string[];
  toolStatus?: "ok" | "error" | "retrying";
  agents: Record<AgentName, AgentStatus>;
  steps: StepRecord[];
  milestones?: WorkflowMilestone[];
}

export interface CheckResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  passed: boolean;
  timedOut: boolean;
  cancelled: boolean;
  executionError?: string;
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface BaselineContext {
  gitHead?: string;
  hasUncommittedChanges: boolean;
  hasStagedChanges: boolean;
  diffVsHead?: string;
  stagedDiff?: string;
  untrackedFiles: string[];
  diffArtifact?: string;
  stagedArtifact?: string;
  statusPorcelain?: string;
  collectionError?: string;
}

export interface BaselineReviewContext {
  summary: BaselineContext;
  artifacts: {
    baselineJson: string;
    headDiffPatch?: string;
    stagedDiffPatch?: string;
  };
}

export type HumanReviewAction = "accept" | "fix_again" | "replan" | "abort";

export interface HumanReviewDecision {
  action: HumanReviewAction;
  feedback?: string;
}

export interface CompletionSummary {
  request: string;
  route: WorkflowRoute;
  planSummary: string;
  changedFiles: string[];
  testsAdded: string[];
  checks: CheckResult[];
  attempts: number;
  baselineRepaired: boolean;
  diagnosis?: DebuggerOutput;
  review: {
    outcome: "reviewer_approved" | "accepted_by_user" | "no_findings" | "findings_reported" | "not_run";
    evidenceCount: number;
    evidence: Array<{ path: string; detail: string }>;
    suggestions: string[];
    blockingIssues: string[];
    revisions: number;
  };
  documentation: {
    changed: boolean;
    summary: string;
  };
  lessons: {
    status: "approved" | "rejected" | "skipped";
    count: number;
  };
  memory: {
    mode: "untrusted" | "disabled" | "empty" | "valid" | "invalid" | "scope_mismatch" | "unsupported";
    loadedRevision: number;
    selectedCount: number;
    candidates: {
      proposed: number;
      machineEligible: number;
      machineRejected: number;
      duplicates: number;
      humanApproved: number;
      humanDeclined: number;
      pending: number;
      promoted: number;
      promotionFailed: number;
    };
  };
}
