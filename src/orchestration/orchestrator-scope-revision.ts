import type { AgentResolutionRequest, CheckResult, DebuggerOutput, DocumenterOutput, HumanPlanReviewResult, PlannerOutput, ReviewOutput, TesterOutput } from "../types.js";
import type { ImplementationPlanningResult, ImplementationResult, WorkflowContext } from "./orchestrator-context.js";
import type { SerializedLessonPreparation } from "./orchestrator-lessons.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { decisionAction, promptHumanPlanReview, runDurableHumanGate } from "./orchestrator-human-gates.js";
import { parsePlannerOutput, parseReviewOutput } from "../validation.js";
import { filesOutsidePlan, validateFailureScopeRevision } from "./plan-revision.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { formatScopeRevision } from "../ui/session-messages.js";
import { formatPlanForReview } from "./plan-review.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";

export type DocumentationScopePhase =
  | { phase: "initial_documentation"; blockedDocumentation: DocumenterOutput; changeRound: number }
  | { phase: "repair_checks"; blockedDocumentation: DocumenterOutput; preparation: SerializedLessonPreparation; failedChecks: CheckResult[]; diagnosis: DebuggerOutput; attempt: number; changeRound: number };

export type DocumentationScopeAfter = {
  mode: "finalization";
  scopeRevisionCount: number;
  documentation: DocumentationScopePhase;
};

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
    }
  | DocumentationScopeAfter;

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
  blocker?: AgentResolutionRequest;
}

export async function reviseImplementationScope<T extends ImplementationPlanningResult>(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: T,
  requiredFiles: readonly string[],
  evidence: ScopeRevisionEvidence,
  scopeRevision: number,
  after: ScopeRevisionAfter
): Promise<T> {
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

export async function continueScopeRevisionDecision<T extends ImplementationPlanningResult>(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  context: ScopeRevisionDecisionContext,
  recordedDecision?: HumanPlanReviewResult
): Promise<T> {
  const { planning, additions, evidence, scopeRevision, after } = context;
  let revised = context.revised;
  let feedback: { source: "human"; text: string } | { source: "reviewer"; review: ReviewOutput } | undefined;
  let approved = false;

  for (let reviewIndex = context.reviewIndex; reviewIndex <= workflow.config.limits.planRevisions; reviewIndex++) {
    const policy = resolveParticipationPolicy(workflow.config);
    if (requiresHumanDecision(policy, "scope_expansion")) {
      const decision = recordedDecision ?? await runDurableHumanGate(
        runtime,
        workflow,
        "scope_expansion",
        after.mode === "finalization" ? "Documentation scope expansion approval" : "Failure scope expansion approval",
        { point: "scope_revision_decision", additions, scopeRevision, reviewIndex },
        {
          exploration: planning.exploration,
          plan: planning.plan,
          proposedPlan: revised,
          baselineChecks: planning.baseline,
          diagnosis: evidence.diagnosis,
          decisionContext: { planning, revised, additions, evidence, scopeRevision, reviewIndex, after } satisfies ScopeRevisionDecisionContext
        },
        async signal => {
          const label = after.mode === "finalization" ? "Review documentation scope expansion" : "Review failure scope expansion";
          const result = await promptHumanPlanReview(runtime, revised, label, workflow.ctx, signal);
          if (!result) return undefined;
          if (result.cancelled) return { action: "cancel" as const };
          return result.approved
            ? { action: "approve" as const }
            : { action: "revise" as const, feedback: result.feedback };
        },
        result => ({ approved: result.action === "approve", feedback: result.feedback }),
        {
          format: "markdown",
          content: formatPlanForReview(revised),
          actions: [
            decisionAction("approve", "Approve expanded scope"),
            decisionAction("revise", "Request changes", true),
            decisionAction("cancel", "Cancel workflow"),
          ],
        }
      );
      recordedDecision = undefined;
      if (decision.approved) {
        approved = true;
        break;
      }
      feedback = { source: "human", text: decision.feedback ?? "" };
    } else {
      const reviewLabel = after.mode === "finalization" ? "Review documentation scope revision" : "Review failure scope revision";
      const review = await runAgentStep(runtime, "reviewer", "reviewing_plan", reviewLabel, {
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
  return { ...planning, plan: revised, scopeRevisionCount: after.scopeRevisionCount } as T;
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
  return runAgentStep(runtime, "planner", "planning", "Expand plan for diagnosed failure", {
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
  }, workflow.mutationCwd, workflow.ctx, text => validateFailureScopeRevision(
    planning.plan,
    parsePlannerOutput(text),
    requiredFiles
  ), { revision: scopeRevision });
}
