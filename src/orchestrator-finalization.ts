import { collectWorktreeChanges, removeWorktree, syncWorktreeChanges } from "./worktree.js";
import { computeFinalChecksDigest } from "./memory-validation.js";
import { formatCompletedRun } from "./session-messages.js";
import type { CompletionSummary } from "./types.js";
import type { ReviewResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { EXTENSION_VERSION, messageOf } from "./orchestrator-helpers.js";
import { runCheckStep, validateFinalWorktreeChanges } from "./orchestrator-workspace.js";
import { persistAndPromoteLessons, prepareLessons } from "./orchestrator-lessons.js";
import { publishSessionMessage, throwIfAborted, transition } from "./orchestrator-state.js";

export async function runFinalizationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult
): Promise<void> {
  const { request, ctx, config, store } = workflow;
  const { plan, tester, codeReview, reviewApprovalSource, priorCodeReviews } = review;
  const lessonPreparation = await prepareLessons(runtime, workflow, review);
  const finalChecks = await runCheckStep(runtime, "testing", "Run final checks after all agent sessions", workflow.mutationCwd, ctx, { requireGreen: true, kind: "final" });
  throwIfAborted(runtime);

  let synchronizedFiles: string[] | undefined;
  if (workflow.worktreeHandle) {
    const activeWorktree = workflow.worktreeHandle;
    const pendingChanges = await collectWorktreeChanges(activeWorktree);
    await store.saveRaw("worktree-final.patch", pendingChanges.patch.toString("utf8"));
    throwIfAborted(runtime);
    if (runtime.enforceWorkspacePolicy) validateFinalWorktreeChanges(runtime, activeWorktree, pendingChanges.changedFiles);
    runtime.mutationCommitStarted = true;
    try {
      const synchronized = await syncWorktreeChanges(activeWorktree);
      synchronizedFiles = synchronized.changedFiles;
      for (const file of synchronized.changedFiles) runtime.validatedChangedFiles.add(file);
      workflow.worktreeSynced = true;
      runtime.requireState().message = `Synchronized ${synchronized.changedFiles.length} validated file(s) from the mutation worktree`;
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

  const finalChecksDigest = computeFinalChecksDigest(finalChecks);
  await store.saveJson("final-checks-digest.json", { digest: finalChecksDigest });
  const lessonCounts = await persistAndPromoteLessons(runtime, workflow, lessonPreparation, finalChecksDigest);
  const reportedChanged = [...new Set([
    ...(tester.changedFiles ?? []),
    ...runtime.builderSessionOutputs.flatMap(output => output.changedFiles),
    ...lessonPreparation.documentation.changedFiles
  ])];
  const allChanged = synchronizedFiles ?? (runtime.enforceWorkspacePolicy ? [...runtime.validatedChangedFiles].sort() : reportedChanged);
  const completionSummary: CompletionSummary = {
    request,
    planSummary: plan.summary,
    changedFiles: allChanged,
    testsAdded: tester.testsAdded ?? [],
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
  const state = runtime.requireState();
  state.status = "completed";
  state.completedAt = runtime.timestamp();
  await transition(runtime, "completed", undefined, "Workflow completed", ctx);
  publishSessionMessage(runtime, formatCompletedRun(completionSummary, state.dashboardUrl, state.runDir, state.warning, EXTENSION_VERSION), { kind: "completed" });
  await store.flush();
  ctx.ui.notify("piOrchestrator workflow completed", "info");
}
