import type { MemoryContext } from "./memory-types.js";
import type { WorkflowTermination } from "./workflow-errors.js";

export const SCHEMA_VERSION = 1;
export const AGENT_TASK_SCHEMA_VERSION = 2 as const;

export const AGENT_NAMES = [
  "explorer",
  "planner",
  "reviewer",
  "tester",
  "builder",
  "debugger",
  "documenter"
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

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

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const BUILT_IN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;

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
}

export interface AgentSummary {
  name: AgentName;
  model: string;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  summary?: string;
  error?: string;
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
export type BuiltInToolName = (typeof BUILT_IN_TOOLS)[number];

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export interface CheckDiscoveryResult {
  packageManager?: PackageManager;
  commands: string[];
  scripts: string[];
  diagnostics: string[];
}

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
  | "documenting"
  | "screening_lessons"
  | "human_review_lessons"
  | "promoting_memory"
  | "reviewing_lessons"
  | "completed"
  | "failed"
  | "cancelled";

export interface AgentConfig {
  model: string;
  thinking?: ThinkingLevel;
  tools: BuiltInToolName[];
  promptFile: string;
}

export interface AgentModelSelection {
  model: string;
  thinking?: ThinkingLevel;
}

export type AgentModelUpdates = Partial<Record<AgentName, AgentModelSelection>>;

export interface HumanTouchpoints {
  planApproval: boolean;
  planRevisionApproval: boolean;
  confirmBeforeMutation: boolean;
}

export interface HumanGateState {
  kind: "plan_approval" | "plan_revision_approval" | "baseline_repair_approval" | "mutation_confirmation" | "code_review_decision";
  label: string;
  startedAt: string;
}

export interface HumanPlanReviewResult {
  approved: boolean;
  feedback?: string;
}

export interface OrchestratorConfig {
  schemaVersion: number;
  checks: string[];
  dashboard: { enabled: boolean; port: number };
  limits: {
    planRevisions: number;
    implementationRetries: number;
    reviewRevisions: number;
    agentTimeoutMs: number;
    checkTimeoutMs: number;
    maxOutputBytes: number;
    worktreeIsolation: boolean;
  };
  agents: Record<AgentName, AgentConfig>;
  humanInTheLoop: HumanTouchpoints;
}

export interface AgentStatus {
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  model: string;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
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
  message?: string;
}

export interface WorkflowState {
  schemaVersion: number;
  extensionVersion: string;
  runId: string;
  request: string;
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

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
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
}

export interface ArtifactContent {
  name: string;
  text: string;
  truncated: boolean;
  isJson: boolean;
  size: number;
}

export interface CompletionSummary {
  request: string;
  planSummary: string;
  changedFiles: string[];
  testsAdded: string[];
  checks: CheckResult[];
  attempts: number;
  baselineRepaired: boolean;
  review: {
    outcome: "reviewer_approved" | "accepted_by_user";
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

export interface AgentResult {
  text: string;
  usage?: AgentUsage;
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
