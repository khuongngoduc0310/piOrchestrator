import type { BuilderBlocker, CheckResult, DebuggerOutput, HumanPlanReviewResult, PlannerOutput, ReviewOutput, TesterOutput } from "../types.js";
import type { ImplementationPlanningResult, ImplementationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { promptHumanPlanReview, runDurableHumanGate } from "./orchestrator-human-gates.js";
import { parsePlannerOutput, parseReviewOutput } from "../validation.js";
import { filesOutsidePlan, validateFailureScopeRevision } from "./plan-revision.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { formatScopeRevision } from "../ui/session-messages.js";

export type ScopeRevisionAfter =
  | {
      mode: "implementation";
      tester?: TesterOutput;
      checksAfterTests: CheckResult[];
      previousChecks?: CheckResult[];
      diagnosis?: DebuggerOutput;
      attempt: number;
      scopeRevisionCount: number;
    }
  | {
      mode: "review";
      finalImplChecks: CheckResult[];
      codeReview: ReviewOutput;
      priorCodeReviews: ReviewOutput[];
      pendingFix: number;
      allowedReviewFixes: number;
      scopeRevisionCount: number;
      failureChecks?: CheckResult[];
      failureDiagnosis?: DebuggerOutput;
    }
  | {
      mode: "bug_diagnosed";
      diagnosis: DebuggerOutput;
      scopeRevisionCount: number;
    };

export interface ScopeRevisionDecisionContext {
  planning: ImplementationPlanningResult | ImplementationResult;
  revised: PlannerOutput;
  additions: string[];
  evidence: ScopeRevisionEvidence;
  scopeRevision: number;
  reviewIndex: number;
  after: ScopeRevisionAfter;
}

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
  scopeRevision: number,
  after: ScopeRevisionAfter
): Promise<ImplementationPlanningResult> {
  const additions = filesOutsidePlan(planning.plan, requiredFiles);
  if (additions.length === 0) throw new Error("Scope revision requested no files outside the approved plan");

  const revised = await createRevision(runtime, workflow, planning, additions, evidence, scopeRevision, undefined);
  return continueScopeRevisionDecision(runtime, workflow, {
    planning,
    revised,
    additions,
    evidence,
    scopeRevision,
    reviewIndex: 0,
    after
  });
}

export async function continueScopeRevisionDecision(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  context: ScopeRevisionDecisionContext,
  recordedDecision?: HumanPlanReviewResult
): Promise<ImplementationPlanningResult> {
  const { planning, additions, evidence, scopeRevision, after } = context;
  let revised = context.revised;
  let feedback: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput } | undefined;
  let approved = false;

  for (let reviewIndex = context.reviewIndex; reviewIndex <= workflow.config.limits.planRevisions; reviewIndex++) {
    if (workflow.config.humanInTheLoop.importantDecisions || workflow.config.humanInTheLoop.planRevisionApproval) {
      const decision = recordedDecision ?? await runDurableHumanGate(
        runtime,
        workflow,
        "scope_expansion",
        "Failure scope expansion approval",
        { point: "scope_revision_decision", additions, scopeRevision, reviewIndex },
        {
          exploration: planning.exploration,
          plan: planning.plan,
          proposedPlan: revised,
          baselineChecks: planning.baseline,
          diagnosis: evidence.diagnosis,
          decisionContext: { planning, revised, additions, evidence, scopeRevision, reviewIndex, after } satisfies ScopeRevisionDecisionContext
        },
        async () => {
          const result = await promptHumanPlanReview(runtime, revised, "Review failure scope expansion", workflow.ctx);
          if (!result) return undefined;
          return result.approved
            ? { action: "approve" as const }
            : { action: "revise" as const, feedback: result.feedback };
        },
        result => ({ approved: result.action === "approve", feedback: result.feedback })
      );
      recordedDecision = undefined;
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
