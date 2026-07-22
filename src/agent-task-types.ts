import type { AgentName } from "./agent-types.js";
import type { MemoryContext } from "./memory-types.js";
import type { BaselineReviewContext, CheckResult } from "./workflow-types.js";

export const AGENT_TASK_SCHEMA_VERSION = 2 as const;

export const COMMAND_STATUSES = ["passed", "failed", "timed_out", "cancelled"] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const DEBUGGER_CATEGORIES = [
  "implementation_defect",
  "test_defect",
  "configuration_error",
  "environment_error",
  "tooling_error",
  "unknown"
] as const;
export type DebuggerCategory = (typeof DEBUGGER_CATEGORIES)[number];

export const ACCEPTANCE_COVERAGE_STATUSES = ["covered", "partially_covered", "not_covered"] as const;
export type AcceptanceCoverageStatus = (typeof ACCEPTANCE_COVERAGE_STATUSES)[number];

export const PRE_IMPLEMENTATION_RESULTS = ["failed_as_expected", "already_passed", "failed_unexpectedly", "not_run"] as const;
export type PreImplementationResult = (typeof PRE_IMPLEMENTATION_RESULTS)[number];

export const LESSON_CATEGORIES = [
  "architecture",
  "correctness",
  "documentation",
  "performance",
  "security",
  "testing",
  "tooling",
  "workflow"
] as const;
export type LessonCategory = (typeof LESSON_CATEGORIES)[number];

export type ReviewApprovalSource = "reviewer" | "user_override";

export interface RepositoryEvidence {
  path: string;
  detail: string;
}

export type AgentTaskEnvelope<T> =
  | {
      taskSchemaVersion: typeof AGENT_TASK_SCHEMA_VERSION;
      mode: "execute";
      task: T;
      memoryContext: MemoryContext | null;
    }
  | {
      taskSchemaVersion: typeof AGENT_TASK_SCHEMA_VERSION;
      mode: "correct_output";
      task: T;
      memoryContext: MemoryContext | null;
      correction: {
        attempt: 1;
        reason: "schema_validation_failed";
        fieldPath?: string;
      };
    };

export interface ExplorerOutput {
  architecture: string;
  relevantFiles: string[];
  conventions: string[];
  similarImplementations: string[];
  commands: string[];
  risks: string[];
  knownLessons: string[];
  evidence: RepositoryEvidence[];
}

export interface PlanTask {
  id: string;
  description: string;
  files: string[];
  dependencies: string[];
  verification: string[];
}

export interface PlannerOutput {
  summary: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  tasks: PlanTask[];
  risks: string[];
}

export interface ExplorerTask {
  request: string;
}

export type PlannerTask =
  | { action: "create_plan"; request: string; exploration: ExplorerOutput }
  | {
      action: "revise_plan";
      request: string;
      exploration: ExplorerOutput;
      previousPlan: PlannerOutput;
      feedback: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput };
    }
  | { action: "repair_baseline"; request: string; diagnosis: DebuggerOutput; checkFailures: CheckResult[] };

export type ReviewDecision = "approved" | "changes_requested";

export interface ReviewOutput {
  decision: ReviewDecision;
  blockingIssues: string[];
  suggestions: string[];
  evidence: RepositoryEvidence[];
}

export type ReviewerTask =
  | { reviewType: "plan"; request: string; exploration: ExplorerOutput; plan: PlannerOutput }
  | {
      reviewType: "code";
      request: string;
      exploration: ExplorerOutput;
      plan: PlannerOutput;
      baseline: BaselineReviewContext;
      implementationChecks: CheckResult[];
      tester: TesterOutput;
      builderOutputs: BuilderOutput[];
      priorReviews: ReviewOutput[];
    }
  | { reviewType: "lessons"; request: string; lessons: ProposedLesson[] };

export interface CommandReport {
  command: string;
  status: CommandStatus;
  evidence: string;
}

export interface AcceptanceCoverage {
  criterionIndex: number;
  criterion: string;
  status: AcceptanceCoverageStatus;
  tests: string[];
  preImplementationResult: PreImplementationResult;
  evidence: string;
}

export interface TesterOutput {
  summary: string;
  changedFiles: string[];
  testsAdded: string[];
  acceptanceCoverage: AcceptanceCoverage[];
  commands: CommandReport[];
  assumptions: string[];
  unresolvedIssues: string[];
}

export interface TesterTask {
  action: "create_tests";
  request: string;
  plan: PlannerOutput;
  acceptanceCriteria: Array<{ index: number; text: string }>;
  baselineChecks: CheckResult[];
}

export interface BuilderOutput {
  summary: string;
  changedFiles: string[];
  commands: CommandReport[];
  assumptions: string[];
  unresolvedIssues: string[];
}

export type BuilderTask =
  | { action: "repair_baseline"; request: string; fixPlan: PlannerOutput; attempt: number }
  | { action: "implement"; request: string; plan: PlannerOutput; tester: TesterOutput; checks: CheckResult[]; attempt: number }
  | {
      action: "fix_failure";
      request: string;
      plan: PlannerOutput;
      tester: TesterOutput;
      checks: CheckResult[];
      diagnosis: DebuggerOutput;
      attempt: number;
    }
  | {
      action: "address_review";
      request: string;
      plan: PlannerOutput;
      baseline: BaselineReviewContext;
      review: ReviewOutput;
      priorReviews: ReviewOutput[];
      revision: number;
    };

export interface DebuggerOutput {
  category: DebuggerCategory;
  rootCause: string;
  evidence: RepositoryEvidence[];
  recommendedFix: string;
  affectedFiles: string[];
  confidence: "low" | "medium" | "high";
}

export type DebuggerTask =
  | { action: "diagnose_baseline"; request: string; checks: CheckResult[] }
  | { action: "diagnose_implementation"; request: string; plan: PlannerOutput; checks: CheckResult[]; attempt: number };

export interface ProposedLesson {
  title: string;
  lesson: string;
  scope: {
    roles: AgentName[];
    paths: string[];
    categories: LessonCategory[];
    keywords: string[];
  };
  evidence: RepositoryEvidence[];
}

export interface DocumenterOutput {
  summary: string;
  changedFiles: string[];
  documentationChanges: string[];
  proposedLessons: ProposedLesson[];
  commands: CommandReport[];
  unresolvedIssues: string[];
}

export interface DocumenterTask {
  action: "document";
  request: string;
  plan: PlannerOutput;
  baselineChecks: CheckResult[];
  implementationChecks: CheckResult[];
  codeReview: ReviewOutput;
  approvalSource: ReviewApprovalSource;
  builderOutputs: BuilderOutput[];
  tester: TesterOutput;
}

export interface AgentTaskMap {
  explorer: ExplorerTask;
  planner: PlannerTask;
  reviewer: ReviewerTask;
  tester: TesterTask;
  builder: BuilderTask;
  debugger: DebuggerTask;
  documenter: DocumenterTask;
}

export interface AgentOutputMap {
  explorer: ExplorerOutput;
  planner: PlannerOutput;
  reviewer: ReviewOutput;
  tester: TesterOutput;
  builder: BuilderOutput;
  debugger: DebuggerOutput;
  documenter: DocumenterOutput;
}
