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
