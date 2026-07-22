import { formatApprovedReview } from "./session-messages.js";
import { parseBuilderOutput, parseReviewOutput } from "./validation.js";
import type { ReviewApprovalSource, ReviewOutput } from "./types.js";
import type { ImplementationResult, ReviewResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { promptHumanReviewDecision, runRequiredHumanGate } from "./orchestrator-human-gates.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { WorkflowCancelledError } from "./workflow-errors.js";

export async function runReviewPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  implementation: ImplementationResult
): Promise<ReviewResult> {
  const { request, ctx, config } = workflow;
  const { plan, exploration, tester } = implementation;
  let finalImplChecks = implementation.finalImplChecks;
  let codeReview: ReviewOutput | undefined;
  let reviewApproved = false;
  let reviewApprovalSource: ReviewApprovalSource = "reviewer";
  const priorCodeReviews: ReviewOutput[] = [];
  let allowedReviewFixes = config.limits.reviewRevisions;
  for (let fixes = 0; fixes <= allowedReviewFixes; fixes++) {
    codeReview = await runAgentStep(
      runtime,
      "reviewer",
      "reviewing_code",
      "Review implementation",
      {
        reviewType: "code",
        request,
        plan,
        baseline: runtime.requireBaselineReviewContext(),
        exploration,
        implementationChecks: finalImplChecks,
        tester,
        builderOutputs: runtime.builderSessionOutputs,
        priorReviews: priorCodeReviews
      },
      workflow.mutationCwd,
      ctx,
      parseReviewOutput,
      { revision: fixes }
    );
    if (codeReview.decision === "approved") {
      reviewApproved = true;
      publishSessionMessage(runtime, formatApprovedReview(codeReview, finalImplChecks, fixes, "reviewer"), { kind: "review_approved" });
      break;
    }
    priorCodeReviews.push(codeReview);
    if (fixes === allowedReviewFixes) {
      const decision = await runRequiredHumanGate(
        runtime,
        "code_review_decision",
        "Code review decision",
        ctx,
        () => promptHumanReviewDecision(runtime, codeReview!, fixes, ctx)
      );
      if (decision.action === "accept") {
        reviewApproved = true;
        reviewApprovalSource = "user_override";
        publishSessionMessage(runtime, formatApprovedReview(codeReview, finalImplChecks, fixes, "user_override"), { kind: "review_approved" });
        break;
      }
      if (decision.action === "fix_again") allowedReviewFixes++;
      else throw new WorkflowCancelledError("Workflow cancelled after code review", "human_gate");
    }
    const reviewOut = await runAgentStep(
      runtime,
      "builder",
      "implementing",
      "Address code review",
      { action: "address_review", request, plan, baseline: runtime.requireBaselineReviewContext(), review: codeReview, priorReviews: priorCodeReviews.slice(0, -1), revision: fixes + 1 },
      workflow.mutationCwd,
      ctx,
      parseBuilderOutput,
      { revision: fixes + 1, mutationPlan: plan }
    );
    runtime.builderSessionOutputs.push(reviewOut);
    finalImplChecks = await runCheckStep(runtime, "testing", `Run checks after review fix ${fixes + 1}`, workflow.mutationCwd, ctx, {
      requireGreen: true,
      revision: fixes + 1,
      kind: "review-fix"
    });
  }
  if (!reviewApproved || !codeReview) throw new Error("Code review was not approved within the revision limit");
  return { ...implementation, finalImplChecks, codeReview, reviewApprovalSource, priorCodeReviews };
}
