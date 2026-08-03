import { collectWorktreeChanges, preflightWorktreeChanges, applyWorktreeChanges, removeWorktree, verifySynchronizedSource } from "../workspace/worktree.js";
import { computeFinalChecksDigest } from "../memory/memory-validation.js";
import { canonicalSha256 } from "../workspace/workspace-guard.js";
import { formatCompletedRun } from "../ui/session-messages.js";
import type { CompletionSummary, CheckResult } from "../workflow-types.js";
import type { InvestigationResult, PlanningResult, ReadOnlyReviewResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { EXTENSION_VERSION, messageOf } from "./orchestrator-helpers.js";
import { validateFinalDirectWorkspace, validateFinalWorktreeChanges } from "./orchestrator-workspace.js";
import { persist, publishMilestone, publishPersistedState, recordMarkdownMilestone, throwIfAborted, transition } from "./orchestrator-state.js";
import { isReadOnlyRoute } from "./route-manifest.js";
import {
  computePreparationDigest,
  type DirectDelivery,
  type FinalizationOperation,
  type FinalizationPreparedV1,
  type WorktreeDelivery
} from "../persistence/finalization-artifacts.js";

export async function runReadOnlyFinalizationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReadOnlyReviewResult | InvestigationResult | PlanningResult
): Promise<void> {
  const { request, store } = workflow;
  if (!isReadOnlyRoute(workflow.route)) {
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
    ...(workflow.route === "investigation_only" && "diagnosis" in review ? { diagnosis: review.diagnosis } : {}),
    review: {
      outcome: "codeReview" in review ? (review.codeReview.decision === "approved" ? "no_findings" : "findings_reported") : "not_run",
      evidenceCount: "codeReview" in review ? review.codeReview.evidence.length : 0,
      evidence: "codeReview" in review ? review.codeReview.evidence : [],
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
  await commitCompletedRun(
    runtime,
    workflow,
    completionSummary,
    workflow.route === "investigation_only" ? "Investigation completed" : `${workflow.route} workflow completed`,
    workflow.route === "investigation_only" ? "piOrchestrator investigation completed" : "piOrchestrator review completed"
  );
}

async function prepareFinalizedMutation(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  finalChecksDigest: string,
  operation: FinalizationOperation
): Promise<{ synchronizedFiles?: string[]; preparationDigest: string }> {
  const { store } = workflow;
  let synchronizedFiles: string[] | undefined;
  let delivery: WorktreeDelivery | DirectDelivery;

  if (workflow.worktreeHandle) {
    const activeWorktree = workflow.worktreeHandle;
    const pendingChanges = await collectWorktreeChanges(activeWorktree);
    const patchBytes = pendingChanges.patch.toString("utf8");
    const patchDigest = canonicalSha256(patchBytes);
    await store.saveRaw("worktree-final.patch", patchBytes);
    throwIfAborted(runtime);
    if (runtime.enforceWorkspacePolicy) await validateFinalWorktreeChanges(runtime, activeWorktree, pendingChanges.changedFiles);
    await preflightWorktreeChanges(activeWorktree, pendingChanges);
    delivery = {
      kind: "worktree",
      patchArtifact: "worktree-final.patch",
      patchDigest,
      baselineCommit: activeWorktree.baselineCommit,
      finalCommit: pendingChanges.finalCommit,
      changedFiles: [...pendingChanges.changedFiles].sort()
    };
    synchronizedFiles = pendingChanges.changedFiles;
  } else {
    if (runtime.enforceWorkspacePolicy) await validateFinalDirectWorkspace(runtime, workflow.mutationCwd);
    delivery = {
      kind: "direct",
      workspaceDigest: canonicalSha256(runtime.requireState().runDir),
      changedFiles: [...runtime.validatedChangedFiles].sort()
    };
  }

  const prepared: Omit<FinalizationPreparedV1, "preparedAt"> = {
    schemaVersion: 1,
    runId: workflow.runId,
    checkpoint: runtime.requireState().latestCheckpoint!,
    operation,
    finalChecksDigest,
    delivery
  };
  const preparationDigest = computePreparationDigest(prepared);
  const preparedArtifact: FinalizationPreparedV1 = {
    ...prepared,
    preparedAt: runtime.timestamp()
  };
  await store.saveJson("finalization-prepared.json", preparedArtifact);
  await store.flush();
  return { synchronizedFiles, preparationDigest };
}

async function commitFinalizationIntent(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  finalChecksDigest: string,
  preparationDigest: string,
  operation: "synchronize_and_promote" | "synchronize_and_complete" | "promote"
): Promise<void> {
  const { ctx, store } = workflow;
  throwIfAborted(runtime);
  runtime.finalizationStarted = true;
  try {
    await store.saveJson("finalization-intent.json", {
      schemaVersion: 1,
      runId: workflow.runId,
      checkpoint: runtime.requireState().latestCheckpoint,
      operation,
      finalChecksDigest,
      preparationDigest,
      createdAt: runtime.timestamp()
    });
    await store.flush();
  } catch (error) {
    runtime.finalizationStarted = false;
    throw error;
  }
  runtime.requireState().resumeBlockedReason = "Finalization has started; uncertain side effects are never replayed";
  await persist(runtime, ctx);
  await store.flush();
}

export async function synchronizeFinalizedMutation(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  finalChecks: CheckResult[],
  operation: "promote" | "complete"
): Promise<{ synchronizedFiles?: string[]; finalChecksDigest: string }> {
  const { ctx, store } = workflow;
  const finalChecksDigest = computeFinalChecksDigest(finalChecks);
  const needsIntent = operation === "promote" || workflow.worktreeHandle !== undefined;

  if (!needsIntent && operation === "complete") {
    const prepare = await prepareFinalizedMutation(runtime, workflow, finalChecksDigest, "complete");
    return { synchronizedFiles: prepare.synchronizedFiles, finalChecksDigest };
  }

  const syncOp = workflow.worktreeHandle ? `synchronize_and_${operation}` : operation;
  let synchronizedFiles: string[] | undefined;
  const activeWorktree = workflow.worktreeHandle;

  try {
    const prepare = await prepareFinalizedMutation(runtime, workflow, finalChecksDigest, syncOp as FinalizationOperation);
    if (needsIntent) {
      await commitFinalizationIntent(runtime, workflow, finalChecksDigest, prepare.preparationDigest, syncOp as "synchronize_and_promote" | "synchronize_and_complete" | "promote");
    }
    synchronizedFiles = prepare.synchronizedFiles;

    if (activeWorktree) {
      await applyWorktreeChanges(activeWorktree, await collectWorktreeChanges(activeWorktree));
      await verifySynchronizedSource(activeWorktree, await collectWorktreeChanges(activeWorktree));
      synchronizedFiles = [...runtime.validatedChangedFiles].sort();
      for (const file of synchronizedFiles) runtime.validatedChangedFiles.add(file);
      workflow.worktreeSynced = true;
      await store.saveJson("worktree-sync-complete.json", {
        schemaVersion: 1,
        runId: workflow.runId,
        checkpoint: runtime.requireState().latestCheckpoint,
        preparationDigest: prepare.preparationDigest,
        changedFiles: synchronizedFiles,
        completedAt: runtime.timestamp()
      });
      await store.flush();
    }
  } catch (error) {
    if (activeWorktree) {
      workflow.retainWorktree = true;
      runtime.requireState().warning = `Worktree synchronization failed; recovery worktree retained at ${activeWorktree.worktreeRoot}`;
    }
    throw error;
  }

  if (activeWorktree) {
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

export async function completeRun(
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
  await commitCompletedRun(runtime, workflow, summary, message, "piOrchestrator workflow completed");
}

export async function commitCompletedRun(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  summary: CompletionSummary,
  message: string,
  notification: string
): Promise<void> {
  const state = runtime.requireState();
  state.status = "completed";
  state.completedAt = runtime.timestamp();
  const completionReport = formatCompletedRun(summary, state.runDir, state.warning, EXTENSION_VERSION)
    + (state.dashboardUrl ? `\n\n**Dashboard:** \`${state.dashboardUrl}\`` : "");
  const milestoneId = "workflow-completed";
  const milestoneExisted = state.milestones?.some(entry => entry.id === milestoneId) === true;
  const milestone = recordMarkdownMilestone(runtime, milestoneId, "completed", completionReport);
  try {
    await transition(runtime, "completed", undefined, message, workflow.ctx, { publish: false });
    await workflow.store.flush();
  } catch (error) {
    if (!milestoneExisted) state.milestones = state.milestones?.filter(entry => entry.id !== milestoneId);
    throw error;
  }
  publishPersistedState(runtime, workflow.ctx);
  publishMilestone(runtime, milestone);
  workflow.ctx.ui.notify(notification, "info");
}

export function emptyMemorySummary(runtime: OrchestratorRuntime): CompletionSummary["memory"] {
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
