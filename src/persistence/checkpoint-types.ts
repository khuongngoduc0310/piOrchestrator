import type {
  BuilderOutput,
  BaselineContext,
  BaselineReviewContext,
  CheckResult,
  DebuggerOutput,
  DocumenterOutput,
  ExplorerOutput,
  PlannerOutput,
  ReviewApprovalSource,
  ReviewOutput,
  TesterOutput,
  WorkflowState,
  OrchestratorConfig
} from "../types.js";
import type { WorktreeHandle } from "../workspace/worktree.js";
import type { PendingHumanDecision, RecordedHumanDecision } from "../orchestration/human-decision-types.js";

export const CHECKPOINT_SCHEMA_VERSION = 4 as const;

export const CHECKPOINT_CURSOR_KINDS = [
  "plan_approved",
  "checks_configured",
  "mutation_ready",
  "bug_diagnosed",
  "tester_completed",
  "builder_completed",
  "scope_revision_approved",
  "implementation_verified",
  "review_fix_completed",
  "review_approved",
  "documenter_completed",
  "lessons_screened",
  "final_checks_passed",
  "human_decision_pending",
  "human_decision_recorded",
  "repository_reviewed",
  "route_agent_completed",
  "route_final_checks_passed"
] as const;

export type CheckpointCursorKind = (typeof CHECKPOINT_CURSOR_KINDS)[number];

export interface CheckpointContinuationMap {
  plan_approved: unknown;
  checks_configured: unknown;
  mutation_ready: unknown;
  bug_diagnosed: unknown;
  tester_completed: unknown;
  builder_completed: unknown;
  scope_revision_approved: unknown;
  implementation_verified: unknown;
  review_fix_completed: unknown;
  review_approved: unknown;
  documenter_completed: unknown;
  lessons_screened: unknown;
  final_checks_passed: unknown;
  human_decision_pending: { request: PendingHumanDecision };
  human_decision_recorded: { request: PendingHumanDecision; recorded: RecordedHumanDecision };
  repository_reviewed: unknown;
  route_agent_completed: unknown;
  route_final_checks_passed: unknown;
}

export type CheckpointCursor = {
  [K in keyof CheckpointContinuationMap]: {
    readonly kind: K;
    readonly continuation: CheckpointContinuationMap[K];
  }
}[keyof CheckpointContinuationMap];

/** Values shared across phase boundaries and useful when reconstructing a workflow context. */
export interface CheckpointBindings {
  readonly exploration?: ExplorerOutput;
  readonly plan?: PlannerOutput;
  readonly proposedPlan?: PlannerOutput;
  readonly baselineChecks?: readonly CheckResult[];
  readonly tester?: TesterOutput;
  readonly builderOutputs?: readonly BuilderOutput[];
  readonly implementationChecks?: readonly CheckResult[];
  readonly diagnosis?: DebuggerOutput;
  readonly documentation?: DocumenterOutput;
  readonly codeReview?: ReviewOutput;
  readonly priorCodeReviews?: readonly ReviewOutput[];
  readonly reviewApprovalSource?: ReviewApprovalSource;
  /** Phase-owned context validated before a durable human decision is resumed. */
  readonly decisionContext?: unknown;
}

export interface WorkflowCheckpoint {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly checkpointNumber: number;
  readonly runId: string;
  readonly createdAt: string;
  readonly workspaceDigest: string;
  readonly workspaceRoot: string;
  readonly config: OrchestratorConfig;
  readonly configDigest: string;
  readonly memoryMode: WorkflowState["memoryMode"];
  readonly memoryRevision: number;
  readonly memoryDigest: string;
  readonly selectedMemoryIds: readonly string[];
  readonly validatedChangedFiles: readonly string[];
  readonly baselineRepaired: boolean;
  readonly baselineContext: BaselineContext;
  readonly baselineReviewContext: BaselineReviewContext;
  readonly lessonStatus: "approved" | "rejected" | "skipped";
  readonly mutationConfirmed: boolean;
  readonly worktreeHandle?: WorktreeHandle;
  readonly state: WorkflowState;
  readonly cursor: CheckpointCursor;
  readonly bindings: CheckpointBindings;
}

export interface CheckpointPointer {
  readonly schemaVersion: typeof CHECKPOINT_SCHEMA_VERSION;
  readonly runId: string;
  readonly checkpointNumber: number;
  readonly fileName: string;
  readonly digest: string;
}

export type CheckpointWrite = Omit<WorkflowCheckpoint, "schemaVersion" | "checkpointNumber">;
