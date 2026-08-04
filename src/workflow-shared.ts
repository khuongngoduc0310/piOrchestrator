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

export const DEBUGGER_CATEGORIES = [
  "implementation_defect",
  "test_defect",
  "configuration_error",
  "environment_error",
  "tooling_error",
  "unknown"
] as const;
export type DebuggerCategory = (typeof DEBUGGER_CATEGORIES)[number];

export interface RepositoryEvidence {
  path: string;
  detail: string;
}

export interface DebuggerOutput {
  category: DebuggerCategory;
  rootCause: string;
  evidence: RepositoryEvidence[];
  recommendedFix: string;
  affectedFiles: string[];
  confidence: "low" | "medium" | "high";
}

export const CHECKPOINT_CURSOR_KINDS = [
  "plan_approved",
  "checks_configured",
  "mutation_ready",
  "baseline_repair_ready",
  "bug_diagnosis_ready",
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
  "investigation_completed",
  "route_agent_completed",
  "route_final_checks_passed",
  "resolution_pending",
  "resolution_resolved",
  "environment_retry_pending"
] as const;
export type CheckpointCursorKind = (typeof CHECKPOINT_CURSOR_KINDS)[number];
