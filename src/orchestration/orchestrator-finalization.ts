import { collectWorktreeChanges, removeWorktree, syncWorktreeChanges, verifySynchronizedSource } from "../workspace/worktree.js";
import { computeFinalChecksDigest } from "../memory/memory-validation.js";
import { formatCompletedRun } from "../ui/session-messages.js";
import type { CompletionSummary } from "../types.js";
import type { PlanningResult, ReadOnlyReviewResult, ReviewResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen, EXTENSION_VERSION, messageOf } from "./orchestrator-helpers.js";
import { runCheckStep, validateFinalWorktreeChanges } from "./orchestrator-workspace.js";
import { hydrateLessonPreparation, persistAndPromoteLessons, prepareLessons, type SerializedLessonPreparation } from "./orchestrator-lessons.js";
import { persist, publishSessionMessage, throwIfAborted, transition } from "./orchestrator-state.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import type { CheckResult, DocumenterOutput, ReviewOutput } from "../types.js";
import { parseBuilderOutput, parseDebuggerOutput, parseDocumenterOutput, parsePlannerOutput } from "../validation.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { assertBuilderComplete, assertDocumenterComplete } from "./mutation-completion.js";
import { deriveRoleMutationPaths } from "../workspace/workspace-guard.js";
import { CheckFailureError } from "./workflow-errors.js";
import { runDurableHumanGate } from "./orchestrator-human-gates.js";
import { runReviewPhase } from "./orchestrator-review.js";

export type FinalizationContinuation =
  | { point: "documenter_completed"; documentation: DocumenterOutput }
  | { point: "lessons_screened"; preparation: SerializedLessonPreparation }
  | { point: "final_checks_passed"; preparation: SerializedLessonPreparation; finalChecks: CheckResult[] }
  | {
      point: "final_delivery";
      preparation: SerializedLessonPreparation;
      finalChecks: CheckResult[];
      changeRound: number;
      decision?: { action: "finish" | "request_changes"; feedback?: string };
    };

export async function runFinalizationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  continuation?: FinalizationContinuation,
  inheritedChangeRound = 0
): Promise<void> {
  const { request, ctx, config, store } = workflow;
  const { plan, tester, codeReview, reviewApprovalSource, priorCodeReviews } = review;
  let lessonPreparation = continuation?.point === "lessons_screened" || continuation?.point === "final_checks_passed" || continuation?.point === "final_delivery"
    ? hydrateLessonPreparation(continuation.preparation)
    : await prepareLessons(runtime, workflow, review, continuation?.point === "documenter_completed" ? continuation.documentation : undefined);
  let finalChecks = continuation?.point === "final_checks_passed" || continuation?.point === "final_delivery" ? continuation.finalChecks : undefined;
  if (!finalChecks) {
    const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      finalChecks = await runCheckStep(runtime, "testing", "Run final checks after all agent sessions", workflow.mutationCwd, ctx, {
        requireGreen: false,
        attempt,
        kind: "final"
      });
      if (allGreen(finalChecks, config.checks.length)) break;
      const diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Diagnose final check failures", {
        action: "diagnose_verification",
        request,
        plan,
        checks: finalChecks,
        phase: "final",
        attempt
      }, workflow.mutationCwd, ctx, parseDebuggerOutput, { attempt });
      const authorized = new Set(deriveRoleMutationPaths("documenter", plan));
      const repairable = diagnosis.affectedFiles.length > 0
        && diagnosis.affectedFiles.every(file => authorized.has(file))
        && !["environment_error", "tooling_error", "unknown"].includes(diagnosis.category);
      if (!repairable || attempt === maxAttempts) {
        throw new CheckFailureError("Final checks", finalChecks.filter(check => !check.passed).map(check => check.command), diagnosis);
      }
      const documentation = await runAgentStep(runtime, "documenter", "documenting", "Repair documentation check failures", {
        action: "repair_checks",
        request,
        plan,
        checks: finalChecks,
        diagnosis,
        previous: lessonPreparation.documentation,
        attempt
      }, workflow.mutationCwd, ctx, parseDocumenterOutput, { attempt, mutationPlan: plan });
      assertDocumenterComplete(documentation);
      lessonPreparation = await prepareLessons(runtime, workflow, review, documentation);
    }
  }
  if (!finalChecks || !allGreen(finalChecks, config.checks.length)) throw new Error("Final checks did not reach a verified state");
  if (continuation?.point !== "final_checks_passed" && continuation?.point !== "final_delivery") {
    await saveWorkflowCheckpoint(runtime, workflow, "final_checks_passed", {
      review,
      preparation: { ...lessonPreparation, duplicateCandidateIds: [...lessonPreparation.duplicateCandidateIds] },
      finalChecks
    }, {
      exploration: review.exploration,
      plan,
      baselineChecks: review.baseline,
      tester,
      builderOutputs: runtime.builderSessionOutputs,
      implementationChecks: review.finalImplChecks,
      codeReview,
      priorCodeReviews,
      reviewApprovalSource
    });
  }
  if (config.humanInTheLoop.importantDecisions) {
    const changeRound = continuation?.point === "final_delivery" ? continuation.changeRound : inheritedChangeRound;
    const decision = continuation?.point === "final_delivery" && continuation.decision
      ? continuation.decision
      : await runDurableHumanGate(
          runtime,
          workflow,
          "final_delivery",
          "Final delivery approval",
          { point: "final_delivery", mode: "review", changeRound },
          {
            exploration: review.exploration,
            plan,
            baselineChecks: review.baseline,
            tester,
            builderOutputs: runtime.builderSessionOutputs,
            implementationChecks: review.finalImplChecks,
            documentation: lessonPreparation.documentation,
            codeReview,
            priorCodeReviews,
            reviewApprovalSource,
            decisionContext: {
              mode: "review",
              review,
              preparation: { ...lessonPreparation, duplicateCandidateIds: [...lessonPreparation.duplicateCandidateIds] },
              finalChecks,
              changeRound
            }
          },
          async signal => {
            const answer = await ctx.ui.select(
              `Final checks are green. Deliver ${plan.summary}?`,
              ["Finish delivery", "Request changes", "Cancel workflow"],
              { signal }
            );
            if (!answer) return undefined;
            if (answer === "Cancel workflow") return { action: "cancel" as const };
            if (answer === "Finish delivery") return { action: "finish" as const };
            const feedback = await ctx.ui.input("Describe the required final changes:", "Be specific about behavior and files", { signal });
            return feedback === undefined ? undefined : { action: "request_changes" as const, feedback };
          },
          result => ({ action: result.action === "finish" ? "finish" : "request_changes", feedback: result.feedback })
        );
    if (decision.action === "request_changes") {
      await applyFinalChangeRequest(runtime, workflow, review, decision.feedback ?? "", changeRound + 1);
      return;
    }
  }
  const { synchronizedFiles, finalChecksDigest } = await synchronizeFinalizedMutation(runtime, workflow, finalChecks, "promote");
  await store.saveJson("final-checks-digest.json", { digest: finalChecksDigest });
  let lessonCounts;
  try {
    lessonCounts = await persistAndPromoteLessons(runtime, workflow, lessonPreparation, finalChecksDigest);
  } catch (error) {
    const warning = `Repository changes were delivered, but lesson persistence failed: ${messageOf(error)}`;
    runtime.requireState().warning = warning;
    ctx.ui.notify(warning, "warning");
    await store.saveJson("lesson-persistence-error.json", {
      error: messageOf(error),
      finalChecksDigest,
      occurredAt: runtime.timestamp()
    }).catch(() => undefined);
    lessonCounts = {
      humanApprovedCount: 0,
      humanDeclinedCount: 0,
      promotedCount: 0,
      promotionFailedCount: lessonPreparation.proposedCandidates.length,
      pendingCount: 0
    };
  }
  const reportedChanged = [...new Set([
    ...(tester?.changedFiles ?? []),
    ...runtime.builderSessionOutputs.flatMap(output => output.changedFiles),
    ...lessonPreparation.documentation.changedFiles
  ])];
  const allChanged = synchronizedFiles ?? (runtime.enforceWorkspacePolicy ? [...runtime.validatedChangedFiles].sort() : reportedChanged);
  const completionSummary: CompletionSummary = {
    request,
    route: plan.route,
    planSummary: plan.summary,
    changedFiles: allChanged,
    testsAdded: tester?.testsAdded ?? [],
    checks: finalChecks,
    attempts: runtime.requireState().attempt,
    baselineRepaired: runtime.baselineRepaired,
    review: {
      outcome: reviewApprovalSource === "user_override" ? "accepted_by_user" : "reviewer_approved",
      evidenceCount: codeReview.evidence.length,
      suggestions: codeReview.suggestions,
      blockingIssues: codeReview.blockingIssues,
      revisions: priorCodeReviews.length
    },
    documentation: {
      changed: lessonPreparation.documentation.changedFiles.length > 0,
      summary: lessonPreparation.documentation.summary
    },
    lessons: {
      status: runtime.lessonStatus,
      count: lessonPreparation.documentation.proposedLessons.length
    },
    memory: {
      mode: runtime.memoryMode,
      loadedRevision: runtime.memoryRevision,
      selectedCount: runtime.selectedMemoryIds.size,
      candidates: {
        proposed: lessonPreparation.documentation.proposedLessons.length,
        machineEligible: lessonPreparation.machineEligibleCount,
        machineRejected: lessonPreparation.machineRejectedCount,
        duplicates: lessonPreparation.duplicateCount,
        humanApproved: lessonCounts.humanApprovedCount,
        humanDeclined: lessonCounts.humanDeclinedCount,
        pending: lessonCounts.pendingCount,
        promoted: lessonCounts.promotedCount,
        promotionFailed: lessonCounts.promotionFailedCount
      }
    }
  };
  await store.saveJson("completion-summary.json", completionSummary);
  await store.saveJson("finalization-complete.json", {
    runId: workflow.runId,
    checkpoint: runtime.requireState().latestCheckpoint,
    finalChecksDigest,
    completedAt: runtime.timestamp()
  });
  const state = runtime.requireState();
  state.status = "completed";
  state.completedAt = runtime.timestamp();
  await transition(runtime, "completed", undefined, "Workflow completed", ctx);
  publishSessionMessage(runtime, formatCompletedRun(completionSummary, state.dashboardUrl, state.runDir, state.warning, EXTENSION_VERSION), { kind: "completed" });
  await store.flush();
  ctx.ui.notify("piOrchestrator workflow completed", "info");
}

async function applyFinalChangeRequest(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  feedback: string,
  changeRound: number
): Promise<void> {
  if (changeRound > workflow.config.limits.planRevisions + 1) throw new Error("Final change request limit was exhausted");
  const plan = await runAgentStep(runtime, "planner", "planning", "Plan requested final changes", {
    action: "revise_plan",
    route: workflow.route,
    request: workflow.request,
    exploration: review.exploration,
    previousPlan: review.plan,
    feedback: { source: "human", text: feedback }
  }, workflow.mutationCwd, workflow.ctx, parsePlannerOutput, { revision: changeRound });
  if (plan.route !== workflow.route) throw new Error(`Planner returned route ${plan.route}; user selected ${workflow.route}`);
  const requestedReview: ReviewOutput = {
    decision: "changes_requested",
    blockingIssues: [feedback],
    suggestions: [],
    evidence: review.codeReview.evidence
  };
  const output = await runAgentStep(runtime, "builder", "implementing", "Apply requested final changes", {
    action: "address_review",
    request: workflow.request,
    plan,
    baseline: runtime.requireBaselineReviewContext(),
    review: requestedReview,
    priorReviews: review.priorCodeReviews,
    revision: changeRound,
    checks: review.finalImplChecks
  }, workflow.mutationCwd, workflow.ctx, parseBuilderOutput, { revision: changeRound, mutationPlan: plan });
  assertBuilderComplete(output, "the requested final changes");
  runtime.builderSessionOutputs.push(output);
  const checks = await runCheckStep(runtime, "testing", `Verify requested final changes ${changeRound}`, workflow.mutationCwd, workflow.ctx, {
    requireGreen: true,
    revision: changeRound,
    kind: "review-fix"
  });
  const implementation = { ...review, plan, finalImplChecks: checks };
  const revisedReview = await runReviewPhase(runtime, workflow, implementation);
  await runFinalizationPhase(runtime, workflow, revisedReview, undefined, changeRound);
}

export async function runReadOnlyFinalizationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReadOnlyReviewResult | PlanningResult
): Promise<void> {
  const { request, ctx, store } = workflow;
  if (!["review_only", "investigation_only", "planning_only"].includes(workflow.route)) {
    throw new Error(`Route ${workflow.route} cannot use read-only finalization`);
  }
  throwIfAborted(runtime);
  const completionSummary: CompletionSummary = {
    request,
    route: workflow.route,
    planSummary: review.plan.summary,
    changedFiles: [],
    testsAdded: [],
    checks: [],
    attempts: 0,
    baselineRepaired: false,
    review: {
      outcome: "codeReview" in review ? (review.codeReview.decision === "approved" ? "no_findings" : "findings_reported") : "not_run",
      evidenceCount: "codeReview" in review ? review.codeReview.evidence.length : 0,
      suggestions: "codeReview" in review ? review.codeReview.suggestions : [],
      blockingIssues: "codeReview" in review ? review.codeReview.blockingIssues : [],
      revisions: 0
    },
    documentation: { changed: false, summary: `Skipped for ${workflow.route} route` },
    lessons: { status: "skipped", count: 0 },
    memory: {
      mode: runtime.memoryMode,
      loadedRevision: runtime.memoryRevision,
      selectedCount: runtime.selectedMemoryIds.size,
      candidates: {
        proposed: 0,
        machineEligible: 0,
        machineRejected: 0,
        duplicates: 0,
        humanApproved: 0,
        humanDeclined: 0,
        pending: 0,
        promoted: 0,
        promotionFailed: 0
      }
    }
  };
  await store.saveJson("completion-summary.json", completionSummary);
  throwIfAborted(runtime);
  const state = runtime.requireState();
  state.status = "completed";
  state.completedAt = runtime.timestamp();
  await transition(runtime, "completed", undefined, `${workflow.route} workflow completed`, ctx);
  publishSessionMessage(runtime, formatCompletedRun(completionSummary, state.dashboardUrl, state.runDir, state.warning, EXTENSION_VERSION), { kind: "completed" });
  await store.flush();
  ctx.ui.notify("piOrchestrator review completed", "info");
}

export async function runSpecializedMutationFinalization(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  result: SpecializedMutationResult,
  finalChecks: CheckResult[]
): Promise<void> {
  const { synchronizedFiles, finalChecksDigest } = await synchronizeFinalizedMutation(runtime, workflow, finalChecks, "complete");
  const output = result.route === "tests_only" ? result.tester : result.documentation;
  const reportedChanged = output.changedFiles;
  const changedFiles = synchronizedFiles ?? (runtime.enforceWorkspacePolicy ? [...runtime.validatedChangedFiles].sort() : reportedChanged);
  const completionSummary: CompletionSummary = {
    request: workflow.request,
    route: workflow.route,
    planSummary: result.plan.summary,
    changedFiles,
    testsAdded: result.route === "tests_only" ? result.tester.testsAdded : [],
    checks: finalChecks,
    attempts: 0,
    baselineRepaired: false,
    review: { outcome: "not_run", evidenceCount: 0, suggestions: [], blockingIssues: [], revisions: 0 },
    documentation: result.route === "documentation_only"
      ? { changed: result.documentation.changedFiles.length > 0, summary: result.documentation.summary }
      : { changed: false, summary: "Skipped for tests_only route" },
    lessons: { status: "skipped", count: 0 },
    memory: emptyMemorySummary(runtime)
  };
  await completeRun(runtime, workflow, completionSummary, finalChecksDigest, `${workflow.route} workflow completed`);
}

async function synchronizeFinalizedMutation(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  finalChecks: CheckResult[],
  operation: "promote" | "complete"
): Promise<{ synchronizedFiles?: string[]; finalChecksDigest: string }> {
  const { ctx, store } = workflow;
  throwIfAborted(runtime);
  runtime.requireState().resumeBlockedReason = "Finalization has started; uncertain side effects are never replayed";
  await persist(runtime, ctx);
  const finalChecksDigest = computeFinalChecksDigest(finalChecks);
  await store.saveJson("finalization-intent.json", {
    runId: workflow.runId,
    checkpoint: runtime.requireState().latestCheckpoint,
    operation: workflow.worktreeHandle ? `synchronize_and_${operation}` : `${operation}_and_complete`,
    createdAt: runtime.timestamp(),
    finalChecksDigest
  });
  await store.flush();
  let synchronizedFiles: string[] | undefined;
  if (workflow.worktreeHandle) {
    const activeWorktree = workflow.worktreeHandle;
    const pendingChanges = await collectWorktreeChanges(activeWorktree);
    await store.saveRaw("worktree-final.patch", pendingChanges.patch.toString("utf8"));
    throwIfAborted(runtime);
    if (runtime.enforceWorkspacePolicy) validateFinalWorktreeChanges(runtime, activeWorktree, pendingChanges.changedFiles);
    runtime.mutationCommitStarted = true;
    try {
      const synchronized = await syncWorktreeChanges(activeWorktree, pendingChanges);
      await verifySynchronizedSource(activeWorktree, synchronized);
      synchronizedFiles = synchronized.changedFiles;
      for (const file of synchronized.changedFiles) runtime.validatedChangedFiles.add(file);
      workflow.worktreeSynced = true;
      await store.saveJson("worktree-sync-complete.json", {
        runId: workflow.runId,
        checkpoint: runtime.requireState().latestCheckpoint,
        changedFiles: synchronized.changedFiles,
        completedAt: runtime.timestamp()
      });
    } catch (error) {
      workflow.retainWorktree = true;
      runtime.requireState().warning = `Worktree synchronization failed; recovery worktree retained at ${activeWorktree.worktreeRoot}`;
      throw error;
    }
    try {
      await removeWorktree(activeWorktree);
      workflow.worktreeHandle = undefined;
    } catch (error) {
      runtime.requireState().warning = `Validated changes were synchronized, but worktree cleanup failed: ${messageOf(error)}`;
      ctx.ui.notify(runtime.requireState().warning!, "warning");
    }
  }
  return { synchronizedFiles, finalChecksDigest };
}

async function completeRun(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  summary: CompletionSummary,
  finalChecksDigest: string,
  message: string
): Promise<void> {
  await workflow.store.saveJson("completion-summary.json", summary);
  await workflow.store.saveJson("final-checks-digest.json", { digest: finalChecksDigest });
  await workflow.store.saveJson("finalization-complete.json", {
    runId: workflow.runId,
    checkpoint: runtime.requireState().latestCheckpoint,
    finalChecksDigest,
    completedAt: runtime.timestamp()
  });
  const state = runtime.requireState();
  state.status = "completed";
  state.completedAt = runtime.timestamp();
  await transition(runtime, "completed", undefined, message, workflow.ctx);
  publishSessionMessage(runtime, formatCompletedRun(summary, state.dashboardUrl, state.runDir, state.warning, EXTENSION_VERSION), { kind: "completed" });
  await workflow.store.flush();
  workflow.ctx.ui.notify("piOrchestrator workflow completed", "info");
}

function emptyMemorySummary(runtime: OrchestratorRuntime): CompletionSummary["memory"] {
  return {
    mode: runtime.memoryMode,
    loadedRevision: runtime.memoryRevision,
    selectedCount: runtime.selectedMemoryIds.size,
    candidates: {
      proposed: 0, machineEligible: 0, machineRejected: 0, duplicates: 0,
      humanApproved: 0, humanDeclined: 0, pending: 0, promoted: 0, promotionFailed: 0
    }
  };
}
