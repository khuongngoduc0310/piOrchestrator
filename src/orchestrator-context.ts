import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorktreeHandle } from "./worktree.js";
import type { RunStore } from "./store.js";
import type {
  CheckResult,
  DebuggerOutput,
  DocumenterOutput,
  ExplorerOutput,
  OrchestratorConfig,
  PlannerOutput,
  ReviewApprovalSource,
  ReviewOutput,
  TesterOutput
} from "./types.js";
import type { WorkflowRoute } from "./agent-task-types.js";

export interface WorkflowContext {
  route: WorkflowRoute;
  request: string;
  ctx: ExtensionCommandContext;
  cwd: string;
  mutationCwd: string;
  runId: string;
  store: RunStore;
  config: OrchestratorConfig;
  controller: AbortController;
  worktreeHandle?: WorktreeHandle;
  worktreeSynced: boolean;
  retainWorktree: boolean;
  mutationConfirmed: boolean;
}

export interface PlanningResult {
  exploration: ExplorerOutput;
  plan: PlannerOutput;
}

export interface ImplementationPlanningResult extends PlanningResult {
  baseline: CheckResult[];
  scopeRevisionCount: number;
  baselineDiagnosis?: DebuggerOutput;
}

export interface ImplementationResult extends ImplementationPlanningResult {
  tester?: TesterOutput;
  finalImplChecks: CheckResult[];
  diagnosis?: DebuggerOutput;
}

export interface ReviewResult extends ImplementationResult {
  codeReview: ReviewOutput;
  reviewApprovalSource: ReviewApprovalSource;
  priorCodeReviews: ReviewOutput[];
}

export interface ReadOnlyReviewResult extends PlanningResult {
  codeReview: ReviewOutput;
}

export type SpecializedMutationResult =
  | (ImplementationPlanningResult & { route: "tests_only"; tester: TesterOutput })
  | (ImplementationPlanningResult & { route: "documentation_only"; documentation: DocumenterOutput });
