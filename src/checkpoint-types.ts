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
} from "./types.js";
import type { WorktreeHandle } from "./worktree.js";

export const CHECKPOINT_SCHEMA_VERSION = 3 as const;

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
  "repository_reviewed",
  "route_agent_completed",
  "route_final_checks_passed"
] as const;

export type CheckpointCursorKind = (typeof CHECKPOINT_CURSOR_KINDS)[number];

export type CheckpointCursor = {
  [Kind in CheckpointCursorKind]: {
    readonly kind: Kind;
    /** Phase-owned, schema-validated by that phase before it is used. */
    readonly continuation: unknown;
  }
}[CheckpointCursorKind];

/** Values shared across phase boundaries and useful when reconstructing a workflow context. */
export interface CheckpointBindings {
  readonly exploration?: ExplorerOutput;
  readonly plan?: PlannerOutput;
  readonly baselineChecks?: readonly CheckResult[];
  readonly tester?: TesterOutput;
  readonly builderOutputs?: readonly BuilderOutput[];
  readonly implementationChecks?: readonly CheckResult[];
  readonly diagnosis?: DebuggerOutput;
  readonly documentation?: DocumenterOutput;
  readonly codeReview?: ReviewOutput;
  readonly priorCodeReviews?: readonly ReviewOutput[];
  readonly reviewApprovalSource?: ReviewApprovalSource;
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
