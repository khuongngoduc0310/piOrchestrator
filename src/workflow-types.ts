import type { AgentInvocationRecord, AgentName, AgentStatus } from "./agent-types.js";
import type { WorkflowTermination } from "./workflow-errors.js";

export const SCHEMA_VERSION = 1;

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
  | "completed"
  | "failed"
  | "cancelled";

export interface HumanGateState {
  kind: "plan_approval" | "plan_revision_approval" | "baseline_repair_approval" | "mutation_confirmation" | "code_review_decision";
  label: string;
  startedAt: string;
}

export interface HumanPlanReviewResult {
  approved: boolean;
  feedback?: string;
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

export interface WorkflowState {
  schemaVersion: number;
  extensionVersion: string;
  runId: string;
  request: string;
  route?: import("./agent-task-types.js").WorkflowRoute;
  cwd: string;
  runDir: string;
  stage: Stage;
  failedStage?: Stage;
  stoppedStage?: Stage;
  status: "running" | "completed" | "failed" | "cancelled";
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
  termination?: WorkflowTermination;
  memoryMode?: "untrusted" | "disabled" | "empty" | "valid" | "invalid" | "scope_mismatch" | "unsupported";
  memoryRevision?: number;
  latestCheckpoint?: {
    number: number;
    cursor: import("./checkpoint-types.js").CheckpointCursorKind;
    createdAt: string;
  };
  resumeCount?: number;
  resumedAt?: string;
  resumedFromCheckpoint?: import("./checkpoint-types.js").CheckpointCursorKind;
  resumeBlockedReason?: string;
  currentTool?: string;
  currentToolArgs?: string;
  agentOutput?: string[];
  toolStatus?: "ok" | "error" | "retrying";
  agents: Record<AgentName, AgentStatus>;
  steps: StepRecord[];
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
  route: import("./agent-task-types.js").WorkflowRoute;
  planSummary: string;
  changedFiles: string[];
  testsAdded: string[];
  checks: CheckResult[];
  attempts: number;
  baselineRepaired: boolean;
  review: {
    outcome: "reviewer_approved" | "accepted_by_user" | "no_findings" | "findings_reported" | "not_run";
    evidenceCount: number;
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
