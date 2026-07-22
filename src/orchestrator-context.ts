import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { WorktreeHandle } from "./worktree.js";
import type { RunStore } from "./store.js";
import type {
  CheckResult,
  DebuggerOutput,
  ExplorerOutput,
  OrchestratorConfig,
  PlannerOutput,
  ReviewApprovalSource,
  ReviewOutput,
  TesterOutput
} from "./types.js";

export interface WorkflowContext {
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
  baseline: CheckResult[];
}

export interface ImplementationResult extends PlanningResult {
  tester: TesterOutput;
  finalImplChecks: CheckResult[];
  diagnosis?: DebuggerOutput;
}

export interface ReviewResult extends ImplementationResult {
  codeReview: ReviewOutput;
  reviewApprovalSource: ReviewApprovalSource;
  priorCodeReviews: ReviewOutput[];
}
