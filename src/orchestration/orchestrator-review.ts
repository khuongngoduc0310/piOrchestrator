import { formatApprovedReview } from "../ui/session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseReviewOutput } from "../validation.js";
import type { ReviewApprovalSource, ReviewOutput } from "../types.js";
import type { ImplementationResult, ReviewResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { promptHumanReviewDecision, runDurableHumanGate } from "./orchestrator-human-gates.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { CheckFailureError, WorkflowCancelledError } from "./workflow-errors.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { filesOutsidePlan } from "./plan-revision.js";
import { reviseImplementationScope } from "./orchestrator-scope-revision.js";
import { consumeScopeRevision } from "./scope-revision-budget.js";
import { allGreen } from "./orchestrator-helpers.js";
import type { CheckResult, DebuggerOutput, HumanReviewDecision } from "../types.js";

export type ReviewContinuation =
  | {
      point: "review_fix_completed";
      finalImplChecks: ImplementationResult["finalImplChecks"];
      codeReview: ReviewOutput;
      priorCodeReviews: ReviewOutput[];
      completedFix: number;
      allowedReviewFixes: number;
      scopeRevisionCount: number;
      failureChecks?: CheckResult[];
      failureDiagnosis?: DebuggerOutput;
    }
  | {
      point: "scope_revision_approved";
      finalImplChecks: ImplementationResult["finalImplChecks"];
      codeReview: ReviewOutput;
      priorCodeReviews: ReviewOutput[];
      pendingFix: number;
      allowedReviewFixes: number;
      scopeRevisionCount: number;
      failureChecks?: CheckResult[];
      failureDiagnosis?: DebuggerOutput;
    }
  | {
      point: "review_decision";
      finalImplChecks: ImplementationResult["finalImplChecks"];
      codeReview: ReviewOutput;
      priorCodeReviews: ReviewOutput[];
      completedFixes: number;
      allowedReviewFixes: number;
      scopeRevisionCount: number;
      decision?: HumanReviewDecision;
    };

export async function runReviewPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  implementation: ImplementationResult,
  continuation?: ReviewContinuation
): Promise<ReviewResult> {
  const { request, ctx, config } = workflow;
  let currentImplementation = implementation;
  let { plan } = currentImplementation;
  const { exploration, tester } = currentImplementation;
  let scopeRevisionCount = continuation?.scopeRevisionCount ?? implementation.scopeRevisionCount;
  let finalImplChecks = continuation?.finalImplChecks ?? implementation.finalImplChecks;
  let codeReview: ReviewOutput | undefined = continuation?.codeReview;
  let reviewApproved = false;
  let reviewApprovalSource: ReviewApprovalSource = "reviewer";
  const priorCodeReviews: ReviewOutput[] = continuation?.priorCodeReviews.slice() ?? [];
  let allowedReviewFixes = continuation?.allowedReviewFixes ?? config.limits.reviewRevisions;
  let firstReview = 0;
  let pendingReviewFix = continuation?.point === "scope_revision_approved";
  let pendingReviewDecision = continuation?.point === "review_decision";
  let recordedReviewDecision = continuation?.point === "review_decision" ? continuation.decision : undefined;
  let failureChecks = continuation?.point === "scope_revision_approved" ? continuation.failureChecks : undefined;
  let failureDiagnosis = continuation?.point === "scope_revision_approved" ? continuation.failureDiagnosis : undefined;
  const handleFailedReviewChecks = async (checks: CheckResult[], completedFix: number): Promise<void> => {
    const diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Diagnose review-fix check failures", {
      action: "diagnose_verification",
      request,
      plan,
      checks,
      phase: "review_fix",
      attempt: completedFix
    }, workflow.mutationCwd, ctx, parseDebuggerOutput, { revision: completedFix });
    if (completedFix >= allowedReviewFixes || (["environment_error", "tooling_error", "unknown"].includes(diagnosis.category) && diagnosis.affectedFiles.length === 0)) {
      throw new CheckFailureError("Review-fix checks", checks.filter(check => !check.passed).map(check => check.command), diagnosis);
    }
    const additions = filesOutsidePlan(plan, diagnosis.affectedFiles);
    if (additions.length > 0) {
      scopeRevisionCount = consumeScopeRevision(scopeRevisionCount, config.limits.planRevisions, "during code review");
      const revised = await reviseImplementationScope(runtime, workflow, currentImplementation, additions, { checks, diagnosis }, scopeRevisionCount, {
        mode: "review",
        finalImplChecks,
        codeReview: codeReview!,
        priorCodeReviews,
        pendingFix: completedFix + 1,
        allowedReviewFixes,
        scopeRevisionCount,
        failureChecks: checks,
        failureDiagnosis: diagnosis
      });
      currentImplementation = { ...currentImplementation, plan: revised.plan, scopeRevisionCount };
      plan = revised.plan;
      await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
        mode: "review",
        implementation: currentImplementation,
        finalImplChecks,
        codeReview,
        priorCodeReviews,
        pendingFix: completedFix + 1,
        allowedReviewFixes,
        scopeRevisionCount,
        failureChecks: checks,
        failureDiagnosis: diagnosis
      }, {
        exploration,
        plan,
        baselineChecks: currentImplementation.baseline,
        tester,
        builderOutputs: runtime.builderSessionOutputs,
        implementationChecks: finalImplChecks,
        codeReview,
        priorCodeReviews,
        diagnosis
      });
    }
    failureChecks = checks;
    failureDiagnosis = diagnosis;
    pendingReviewFix = true;
  };
  if (continuation?.point === "review_fix_completed") {
    finalImplChecks = await runCheckStep(runtime, "testing", `Run checks after review fix ${continuation.completedFix}`, workflow.mutationCwd, ctx, {
      requireGreen: false,
      revision: continuation.completedFix,
      kind: "review-fix"
    });
    if (!allGreen(finalImplChecks, config.checks.length)) await handleFailedReviewChecks(finalImplChecks, continuation.completedFix);
    firstReview = continuation.completedFix;
  } else if (continuation?.point === "scope_revision_approved") {
    firstReview = continuation.pendingFix - 1;
  } else if (continuation?.point === "review_decision") {
    firstReview = continuation.completedFixes;
  }
  for (let fixes = firstReview; fixes <= allowedReviewFixes; fixes++) {
    if (!pendingReviewFix) {
      if (!pendingReviewDecision) codeReview = await runAgentStep(
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
      if (!codeReview) throw new Error("Code review output is unavailable for the decision");
      const currentCodeReview = codeReview;
      if (currentCodeReview.decision === "approved") {
        reviewApproved = true;
        publishSessionMessage(runtime, formatApprovedReview(currentCodeReview, finalImplChecks, fixes, "reviewer"), { kind: "review_approved" });
        break;
      }
      if (!pendingReviewDecision) priorCodeReviews.push(currentCodeReview);
      pendingReviewDecision = false;
      if (fixes === allowedReviewFixes) {
        if (!config.humanInTheLoop.importantDecisions) {
          throw new Error("Code review was not approved within the revision limit");
        }
        const decision = recordedReviewDecision
          ? recordedReviewDecision
          : await runDurableHumanGate(
              runtime,
              workflow,
              "code_review_rejection",
              "Code review decision",
              { point: "review_decision", completedFixes: fixes, allowedReviewFixes, scopeRevisionCount },
              {
                exploration,
                plan,
                baselineChecks: currentImplementation.baseline,
                tester,
                builderOutputs: runtime.builderSessionOutputs,
                implementationChecks: finalImplChecks,
                diagnosis: currentImplementation.diagnosis,
                codeReview: currentCodeReview,
                priorCodeReviews
              },
              async () => {
                const answer = await promptHumanReviewDecision(runtime, currentCodeReview, fixes, ctx);
                if (answer.action === "accept") return { action: "accept_current" as const };
                if (answer.action === "fix_again") return { action: "fix_again" as const };
                return { action: "cancel" as const };
              },
              result => ({ action: result.action === "accept_current" ? "accept" : "fix_again" })
            );
        recordedReviewDecision = undefined;
        if (decision.action === "accept") {
          reviewApproved = true;
          reviewApprovalSource = "user_override";
          publishSessionMessage(runtime, formatApprovedReview(currentCodeReview, finalImplChecks, fixes, "user_override"), { kind: "review_approved" });
          break;
        }
        if (decision.action === "fix_again") allowedReviewFixes++;
        else throw new WorkflowCancelledError("Workflow cancelled after code review", "human_gate");
      }
    }
    pendingReviewFix = false;
    if (!codeReview) throw new Error("Code review output is unavailable for the requested fix");
    while (true) {
      const reviewOut = await runAgentStep(
        runtime,
        "builder",
        "implementing",
        "Address code review",
        { action: "address_review", request, plan, baseline: runtime.requireBaselineReviewContext(), review: codeReview, priorReviews: priorCodeReviews.slice(0, -1), revision: fixes + 1, checks: failureChecks, diagnosis: failureDiagnosis },
        workflow.mutationCwd,
        ctx,
        parseBuilderOutput,
        { revision: fixes + 1, mutationPlan: plan }
      );
      runtime.builderSessionOutputs.push(reviewOut);
      if (!reviewOut.blocker) {
        if (reviewOut.unresolvedIssues.length > 0) {
          throw new Error(`Builder did not complete the code review fix: ${reviewOut.unresolvedIssues.join("; ")}`);
        }
        break;
      }
      if (reviewOut.blocker.kind !== "scope") {
        throw new Error(`Builder blocked during code review (${reviewOut.blocker.kind}): ${reviewOut.blocker.reason}`);
      }
      const additions = filesOutsidePlan(plan, reviewOut.blocker.requiredFiles);
      if (additions.length === 0) throw new Error(`Builder reported an invalid review scope blocker: ${reviewOut.blocker.reason}`);
      scopeRevisionCount = consumeScopeRevision(scopeRevisionCount, config.limits.planRevisions, "during code review");
      const revised = await reviseImplementationScope(
        runtime,
        workflow,
        currentImplementation,
        additions,
        { checks: finalImplChecks, blocker: reviewOut.blocker },
        scopeRevisionCount,
        {
          mode: "review",
          finalImplChecks,
          codeReview,
          priorCodeReviews,
          pendingFix: fixes + 1,
          allowedReviewFixes,
          scopeRevisionCount
        }
      );
      currentImplementation = { ...currentImplementation, plan: revised.plan };
      plan = revised.plan;
      await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
        mode: "review",
        implementation: currentImplementation,
        finalImplChecks,
        codeReview,
        priorCodeReviews,
        pendingFix: fixes + 1,
        allowedReviewFixes,
        scopeRevisionCount
      }, {
        exploration,
        plan,
        baselineChecks: currentImplementation.baseline,
        tester,
        builderOutputs: runtime.builderSessionOutputs,
        implementationChecks: finalImplChecks,
        codeReview,
        priorCodeReviews
      });
    }
    failureChecks = undefined;
    failureDiagnosis = undefined;
    await saveWorkflowCheckpoint(runtime, workflow, "review_fix_completed", {
      implementation: currentImplementation,
      finalImplChecks,
      codeReview,
      priorCodeReviews,
      completedFix: fixes + 1,
      allowedReviewFixes,
      scopeRevisionCount
    }, {
      exploration,
      plan,
      baselineChecks: currentImplementation.baseline,
      tester,
      builderOutputs: runtime.builderSessionOutputs,
      implementationChecks: finalImplChecks,
      codeReview,
      priorCodeReviews
    });
    finalImplChecks = await runCheckStep(runtime, "testing", `Run checks after review fix ${fixes + 1}`, workflow.mutationCwd, ctx, {
      requireGreen: false,
      revision: fixes + 1,
      kind: "review-fix"
    });
    if (!allGreen(finalImplChecks, config.checks.length)) await handleFailedReviewChecks(finalImplChecks, fixes + 1);
  }
  if (!reviewApproved || !codeReview) throw new Error("Code review was not approved within the revision limit");
  const result = { ...currentImplementation, scopeRevisionCount, finalImplChecks, codeReview, reviewApprovalSource, priorCodeReviews };
  await saveWorkflowCheckpoint(runtime, workflow, "review_approved", result, {
    exploration,
    plan,
    baselineChecks: currentImplementation.baseline,
    tester,
    builderOutputs: runtime.builderSessionOutputs,
    implementationChecks: finalImplChecks,
    codeReview,
    priorCodeReviews,
    reviewApprovalSource
  });
  return result;
}
