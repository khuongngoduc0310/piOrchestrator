import type { AgentName, SupportedHandoffRole } from "./agent-types.js";
import type { MemoryContext } from "./memory/memory-types.js";
import type { BaselineReviewContext, CheckResult } from "./workflow-types.js";

export const AGENT_TASK_SCHEMA_VERSION = 4 as const;

export const MAX_INTERVIEW_ROUNDS = 6 as const;
export const MIN_INTERVIEW_QUESTIONS = 5 as const;
export const MAX_INTERVIEW_QUESTIONS = 7 as const;
export const MIN_INTERVIEW_OPTIONS = 2 as const;
export const MAX_INTERVIEW_OPTIONS = 6 as const;
export const MAX_INTERVIEW_QUESTION_BYTES = 500 as const;
export const MAX_INTERVIEW_OPTION_BYTES = 120 as const;
export const MAX_INTERVIEW_CUSTOM_BYTES = 2000 as const;

export const INTERVIEW_QUESTION_KINDS = ["single", "multiple"] as const;
export type InterviewQuestionKind = (typeof INTERVIEW_QUESTION_KINDS)[number];

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
export const WORKFLOW_ROUTES = [
  "implementation",
  "review_only",
  "documentation_only",
  "tests_only",
  "investigation_only",
  "bug_fix",
  "quick_implementation",
  "planning_only"
] as const;
export type WorkflowRoute = (typeof WORKFLOW_ROUTES)[number];

export interface WorkflowRequest {
  route: WorkflowRoute;
  request: string;
}

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
      correction:
        | {
            attempt: 1 | 2;
            reason: "schema_validation_failed";
            fieldPath?: string;
            validationError?: string;
            expectedChangedFiles?: string[];
          }
        | {
            attempt: 1;
            reason: "reported_changed_files_mismatch";
            fieldPath: "changedFiles";
            expectedChangedFiles: string[];
          }
        | {
            attempt: 1;
            reason: "incomplete_response";
            validationError?: string;
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
  /** Exact classifier-approved fixture, mock, snapshot, setup, or test-config paths. */
  testSupportFiles?: string[];
  dependencies: string[];
  verification: string[];
}

export interface IndexedAcceptanceCriterion {
  readonly index: number;
  readonly text: string;
}

export interface PlannerOutput {
  route: WorkflowRoute;
  summary: string;
  assumptions: string[];
  acceptanceCriteria: string[];
  automatedAcceptanceCriteria: number[];
  tasks: PlanTask[];
  risks: string[];
}

export interface ExplorerTask {
  route: WorkflowRoute;
  request: string;
}

export type PlannerTask =
  | { action: "create_plan"; route: WorkflowRoute; request: string; exploration: ExplorerOutput }
  | {
      action: "revise_plan";
      route: WorkflowRoute;
      request: string;
      exploration: ExplorerOutput;
      previousPlan: PlannerOutput;
      feedback: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput };
    }
  | {
      action: "revise_for_failure";
      route: WorkflowRoute;
      request: string;
      exploration: ExplorerOutput;
      previousPlan: PlannerOutput;
      checks: CheckResult[];
      requiredFiles: string[];
      diagnosis?: DebuggerOutput;
      blocker?: AgentResolutionRequest;
      feedback?: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput };
    }
  | { action: "repair_baseline"; route: "implementation"; request: string; diagnosis: DebuggerOutput; checkFailures: CheckResult[] };

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
      reviewType: "scope_revision";
      request: string;
      exploration: ExplorerOutput;
      previousPlan: PlannerOutput;
      plan: PlannerOutput;
      checks: CheckResult[];
      requiredFiles: string[];
      diagnosis?: DebuggerOutput;
      blocker?: AgentResolutionRequest;
    }
  | {
      reviewType: "repository";
      request: string;
      exploration: ExplorerOutput;
      plan: PlannerOutput;
      baseline: BaselineReviewContext;
    }
  | {
      reviewType: "code";
      request: string;
      exploration: ExplorerOutput;
      plan: PlannerOutput;
      baseline: BaselineReviewContext;
      implementationChecks: CheckResult[];
      tester?: TesterOutput;
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
  blocker?: AgentResolutionRequest;
}

export type TesterTask =
  | {
      action: "create_tests";
      request: string;
      plan: PlannerOutput;
      acceptanceCriteria: Array<{ index: number; text: string }>;
      baselineChecks: CheckResult[];
      diagnosis?: DebuggerOutput;
    }
  | {
      action: "repair_checks";
      request: string;
      plan: PlannerOutput;
      acceptanceCriteria: Array<{ index: number; text: string }>;
      checks: CheckResult[];
      diagnosis: DebuggerOutput;
      previous: TesterOutput;
      attempt: number;
    };

export type AgentResolutionRequest =
  | { kind: "scope"; reason: string; requiredFiles: string[] }
  | { kind: "baseline_repair"; reason: string; failedCheckCommands: string[]; evidence: RepositoryEvidence[] }
  | { kind: "prerequisite_repair"; reason: string; affectedFiles: string[]; evidence: RepositoryEvidence[]; verification: string[] }
  | { kind: "role_handoff"; reason: string; requestedRole: SupportedHandoffRole; requestedCapability: string; question: string; evidence: RepositoryEvidence[] }
  | { kind: "insufficient_evidence"; reason: string; questions: string[]; suggestedRoles: AgentName[]; inspectedEvidence: RepositoryEvidence[] }
  | { kind: "environment"; reason: string; diagnostics: string[]; retryCondition: string; affectedCommands: string[] }
  | { kind: "tooling"; reason: string; diagnostics: string[]; retryCondition: string; affectedCommands: string[] };

export const RESOLUTION_STATUSES = ["pending", "in_progress", "resolved", "failed", "superseded"] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const RESOLUTION_OUTCOME_TYPES = ["retry", "scope_revision", "baseline_repair", "human_intervention", "abandoned"] as const;
export type ResolutionOutcomeType = (typeof RESOLUTION_OUTCOME_TYPES)[number];

export interface ResolutionOutcome {
  readonly type: ResolutionOutcomeType;
  readonly detail: string;
}

export interface ResolutionRecord {
  id: string;
  request: AgentResolutionRequest;
  agent: AgentName;
  status: ResolutionStatus;
  outcome?: ResolutionOutcome;
  createdAt: string;
  updatedAt: string;
}

export interface BuilderOutput {
  summary: string;
  changedFiles: string[];
  commands: CommandReport[];
  assumptions: string[];
  unresolvedIssues: string[];
  blocker?: AgentResolutionRequest;
}

export type BuilderTask =
  | { action: "repair_baseline"; request: string; fixPlan: PlannerOutput; attempt: number }
  | { action: "implement"; request: string; plan: PlannerOutput; tester?: TesterOutput; checks: CheckResult[]; diagnosis?: DebuggerOutput; attempt: number }
  | {
      action: "fix_failure";
      request: string;
      plan: PlannerOutput;
      tester?: TesterOutput;
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
      checks?: CheckResult[];
      diagnosis?: DebuggerOutput;
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
  | { action: "diagnose_bug"; request: string; plan: PlannerOutput; exploration: ExplorerOutput; checks: CheckResult[] }
  | { action: "diagnose_investigation"; request: string; plan: PlannerOutput; exploration: ExplorerOutput }
  | { action: "diagnose_implementation"; request: string; plan: PlannerOutput; checks: CheckResult[]; attempt: number }
  | { action: "diagnose_verification"; request: string; plan: PlannerOutput; checks: CheckResult[]; phase: "review_fix" | "final"; attempt: number };

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
  blocker?: AgentResolutionRequest;
}

export type DocumenterTask =
  | {
      action: "document";
      request: string;
      plan: PlannerOutput;
      baselineChecks: CheckResult[];
      implementationChecks: CheckResult[];
      codeReview: ReviewOutput;
      approvalSource: ReviewApprovalSource;
      builderOutputs: BuilderOutput[];
      tester?: TesterOutput;
    }
  | {
      action: "document_only";
      request: string;
      plan: PlannerOutput;
      baselineChecks: CheckResult[];
    }
  | {
      action: "repair_checks";
      request: string;
      plan: PlannerOutput;
      checks: CheckResult[];
      diagnosis: DebuggerOutput;
      previous: DocumenterOutput;
      attempt: number;
    };

export interface AgentTaskMap {
  explorer: ExplorerTask;
  planner: PlannerTask;
  reviewer: ReviewerTask;
  tester: TesterTask;
  builder: BuilderTask;
  debugger: DebuggerTask;
  documenter: DocumenterTask;
  interviewer: InterviewerTask;
}

export interface AgentOutputMap {
  explorer: ExplorerOutput;
  planner: PlannerOutput;
  reviewer: ReviewOutput;
  tester: TesterOutput;
  builder: BuilderOutput;
  debugger: DebuggerOutput;
  documenter: DocumenterOutput;
  interviewer: InterviewerOutput;
}

export interface InterviewOption {
  id: string;
  text: string;
  /** Exactly one option per question is the recommended default; the user may pick another or type a custom answer. */
  recommended?: boolean;
}

export interface InterviewQuestion {
  id: string;
  kind: InterviewQuestionKind;
  text: string;
  options: InterviewOption[];
}

export interface InterviewAnswer {
  questionId: string;
  selectedOptionIds: string[];
  customText?: string;
}

export interface InterviewQAndA {
  question: InterviewQuestion;
  answer: InterviewAnswer;
  /** Interview round this question was asked in; absent on model-echoed report qa. */
  round?: number;
}

export type InterviewerTask =
  | { action: "ask_questions"; goal: string; round: number; history: InterviewQAndA[]; insights: string[] }
  | { action: "assess"; goal: string; round: number; history: InterviewQAndA[]; insights: string[] }
  | { action: "finalize"; goal: string; history: InterviewQAndA[]; insights: string[] };

export type InterviewerOutput =
  | { action: "ask_questions"; questions: InterviewQuestion[] }
  | { action: "assess"; assessment: InterviewerAssessment }
  | { action: "finalize"; report: InterviewerReport };

export interface InterviewerAssessment {
  goal: string;
  /** Short synthesis of what is known so far; shown verbatim to the user, who decides whether the goal is clear. */
  summary: string;
  /** Specific gaps the interviewer still sees; shown as follow-up context. */
  openQuestions?: string[];
}

export interface InterviewerReport {
  goal: string;
  summary: string;
  openQuestions: string[];
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  qa: InterviewQAndA[];
}

export interface RequirementsDocument {
  schemaVersion: 1;
  goal: string;
  summary: string;
  scope: string[];
  constraints: string[];
  acceptanceCriteria: string[];
  openQuestions: string[];
  qa: InterviewQAndA[];
  handoffRequest: string;
  createdAt: string;
}
