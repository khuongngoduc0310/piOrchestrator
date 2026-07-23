export type WorkflowPauseReason =
  | "awaiting_human_decision"
  | "human_deferred"
  | "human_ui_unavailable"
  | "interaction_interrupted";

export type HumanDecisionKind =
  | "plan_approval"
  | "plan_revision_approval"
  | "baseline_repair_approval"
  | "mutation_confirmation"
  | "scope_expansion"
  | "code_review_rejection"
  | "repair_budget_exhausted"
  | "final_delivery";

export type HumanDecisionAction =
  | "approve"
  | "revise"
  | "cancel"
  | "proceed"
  | "accept_current"
  | "fix_again"
  | "finish"
  | "request_changes"
  | "defer";

export interface HumanChangeRequest {
  id: string;
  round: number;
  text: string;
}

export interface PendingHumanDecision {
  schemaVersion: 1;
  id: string;
  kind: HumanDecisionKind;
  label: string;
  requestedAt: string;
  resume: HumanDecisionResumePoint;
}

export interface RecordedHumanDecision {
  schemaVersion: 1;
  requestId: string;
  decidedAt: string;
  source: "tui" | "rpc";
  action: HumanDecisionAction;
  feedback?: string;
}

export type HumanDecisionResumePoint =
  | PlanDecisionResumePoint
  | BaselineRepairDecisionResumePoint
  | MutationConfirmationResumePoint
  | ScopeRevisionDecisionResumePoint
  | ReviewDecisionResumePoint
  | BudgetExhaustedResumePoint
  | FinalDeliveryResumePoint;

interface PlanDecisionResumePoint {
  point: "plan_decision";
  reviewIndex: number;
}

interface BaselineRepairDecisionResumePoint {
  point: "baseline_repair_decision";
}

interface MutationConfirmationResumePoint {
  point: "mutation_confirmation";
  mode: "prepared" | "baseline_repair" | "bug_diagnosed";
  scopeRevisionCount: number;
}

interface ScopeRevisionDecisionResumePoint {
  point: "scope_revision_decision";
  additions: string[];
  scopeRevision: number;
  reviewIndex: number;
}

interface ReviewDecisionResumePoint {
  point: "review_decision";
  completedFixes: number;
  allowedReviewFixes: number;
  scopeRevisionCount: number;
}

interface BudgetExhaustedResumePoint {
  point: "budget_exhausted";
  phase: "implementation";
  nextAttempt: number;
  allowedAttempts: number;
  scopeRevisionCount: number;
}

interface FinalDeliveryResumePoint {
  point: "final_delivery";
  mode: "review" | "specialized";
  changeRound: number;
}
