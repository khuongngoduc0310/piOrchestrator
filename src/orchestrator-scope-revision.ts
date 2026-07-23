import type { BuilderBlocker, CheckResult, DebuggerOutput, PlannerOutput, ReviewOutput } from "./types.js";
import type { ImplementationPlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { promptHumanPlanReview, runRequiredHumanGate } from "./orchestrator-human-gates.js";
import { parsePlannerOutput, parseReviewOutput } from "./validation.js";
import { filesOutsidePlan, validateFailureScopeRevision } from "./plan-revision.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { formatScopeRevision } from "./session-messages.js";
import { WorkflowCancelledError } from "./workflow-errors.js";

export interface ScopeRevisionEvidence {
  checks: CheckResult[];
  diagnosis?: DebuggerOutput;
  blocker?: BuilderBlocker;
}

export async function reviseImplementationScope(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  requiredFiles: readonly string[],
  evidence: ScopeRevisionEvidence,
  scopeRevision: number
): Promise<ImplementationPlanningResult> {
  const additions = filesOutsidePlan(planning.plan, requiredFiles);
  if (additions.length === 0) throw new Error("Scope revision requested no files outside the approved plan");

  let feedback: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput } | undefined;
  let revised = await createRevision(runtime, workflow, planning, additions, evidence, scopeRevision, feedback);
  let approved = false;

  for (let reviewIndex = 0; reviewIndex <= workflow.config.limits.planRevisions; reviewIndex++) {
    if (workflow.config.humanInTheLoop.planRevisionApproval) {
      const decision = await runRequiredHumanGate(runtime, "plan_revision_approval", "Failure scope revision approval", workflow.ctx, async () => {
        const result = await promptHumanPlanReview(runtime, revised, "Review failure scope revision", workflow.ctx);
        if (!result) throw new WorkflowCancelledError("Workflow cancelled during failure scope review", "human_gate");
        return result;
      });
      if (decision.approved) {
        approved = true;
        break;
      }
      feedback = { source: "human", text: decision.feedback ?? "" };
    } else {
      const review = await runAgentStep(runtime, "reviewer", "reviewing_plan", "Review failure scope revision", {
        reviewType: "scope_revision",
        request: workflow.request,
        exploration: planning.exploration,
        previousPlan: planning.plan,
        plan: revised,
        checks: evidence.checks,
        requiredFiles: additions,
        diagnosis: evidence.diagnosis,
        blocker: evidence.blocker
      }, workflow.mutationCwd, workflow.ctx, parseReviewOutput, { revision: scopeRevision });
      if (review.decision === "approved") {
        approved = true;
        break;
      }
      feedback = { source: "reviewer", review };
    }

    if (reviewIndex === workflow.config.limits.planRevisions) break;
    revised = await createRevision(runtime, workflow, planning, additions, evidence, scopeRevision, feedback);
  }

  if (!approved) throw new Error("Failure scope revision was not approved within the plan revision limit");
  const stepSequence = runtime.requireState().steps.length;
  const artifact = `plan-scope-revision-${String(scopeRevision).padStart(3, "0")}-step-${String(stepSequence).padStart(3, "0")}.json`;
  await workflow.store.saveJson(artifact, revised);
  await workflow.store.saveJson("plan.json", revised);
  publishSessionMessage(runtime, formatScopeRevision(revised, additions), {
    kind: "plan_scope_revised",
    addedFiles: additions,
    artifact
  });
  return { ...planning, plan: revised };
}

async function createRevision(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  requiredFiles: string[],
  evidence: ScopeRevisionEvidence,
  scopeRevision: number,
  feedback: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput } | undefined
): Promise<PlannerOutput> {
  const revised = await runAgentStep(runtime, "planner", "planning", "Expand plan for diagnosed failure", {
    action: "revise_for_failure",
    route: workflow.route,
    request: workflow.request,
    exploration: planning.exploration,
    previousPlan: planning.plan,
    checks: evidence.checks,
    requiredFiles,
    diagnosis: evidence.diagnosis,
    blocker: evidence.blocker,
    feedback
  }, workflow.mutationCwd, workflow.ctx, parsePlannerOutput, { revision: scopeRevision });
  return validateFailureScopeRevision(planning.plan, revised, requiredFiles);
}
