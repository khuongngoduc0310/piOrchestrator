import { collectWorktreeChanges, removeWorktree, syncWorktreeChanges, verifySynchronizedSource } from "../workspace/worktree.js";
import { computeFinalChecksDigest } from "../memory/memory-validation.js";
import { formatCompletedRun } from "../ui/session-messages.js";
import type { CompletionSummary, PlannerOutput, ReviewOutput } from "../types.js";
import type { CheckResult, DebuggerOutput, DocumenterOutput } from "../types.js";
import type { ImplementationPlanningResult, InvestigationResult, PlanningResult, ReadOnlyReviewResult, ReviewResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen, EXTENSION_VERSION, messageOf } from "./orchestrator-helpers.js";
import { runCheckStep, validateFinalDirectWorkspace, validateFinalWorktreeChanges } from "./orchestrator-workspace.js";
import { hydrateLessonPreparation, persistAndPromoteLessons, prepareLessons, serializeLessonPreparation, type LessonPreparation, type SerializedLessonPreparation } from "./orchestrator-lessons.js";
import { persist, publishSessionMessage, throwIfAborted, transition } from "./orchestrator-state.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { parseDebuggerOutput, parseDocumenterOutput, parsePlannerOutput } from "../validation.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { assertDocumenterComplete } from "./mutation-completion.js";
import { deriveRoleMutationPaths, isDocumentationPath } from "../workspace/workspace-guard.js";
import { CheckFailureError } from "./workflow-errors.js";
import { runDurableHumanGate } from "./orchestrator-human-gates.js";
import { runReviewPhase } from "./orchestrator-review.js";
import { runImplementationPhase } from "./orchestrator-implementation.js";
import { filesOutsidePlan, validateFailureScopeRevision, validateFinalPlanRevision } from "./plan-revision.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";
import { reviseImplementationScope, type DocumentationScopePhase } from "./orchestrator-scope-revision.js";
import { consumeScopeRevision } from "./scope-revision-budget.js";
import { resolveAgentBlocker } from "./orchestrator-resolution.js";
import { runAgentStepWithResolution } from "./orchestrator-resolution-coordinator.js";

export type FinalizationContinuation =
  | { point: "documenter_completed"; documentation: DocumenterOutput; review: ReviewResult }
  | { point: "lessons_screened"; preparation: SerializedLessonPreparation; review: ReviewResult }
  | { point: "final_checks_passed"; preparation: SerializedLessonPreparation; finalChecks: CheckResult[]; review: ReviewResult }
  | {
      point: "final_delivery";
      preparation: SerializedLessonPreparation;
      finalChecks: CheckResult[];
      changeRound: number;
      review: ReviewResult;
      decision?: { action: "finish" | "request_changes"; feedback?: string };
    };

async function runDocumenterWithScopeExpansion(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  restoredDocumentation?: DocumenterOutput
): Promise<{ review: ReviewResult; documentation: DocumenterOutput }> {
  let currentReview = review;
  const { request, ctx, config } = workflow;
  const { plan, baseline, codeReview, reviewApprovalSource, finalImplChecks, tester } = currentReview;
  for (let attempts = 0; attempts <= config.limits.planRevisions; attempts++) {
    let documentation: DocumenterOutput;
    if (restoredDocumentation) {
      documentation = restoredDocumentation;
      restoredDocumentation = undefined;
    } else {
      const coordResult = await runAgentStepWithResolution(
        runtime, workflow, currentReview,
        "documenter", "documenting", "Update documentation and propose lessons",
        {
          action: "document",
          request,
          plan: currentReview.plan,
          baselineChecks: currentReview.baseline,
          codeReview,
          approvalSource: reviewApprovalSource,
          implementationChecks: currentReview.finalImplChecks,
          builderOutputs: runtime.builderSessionOutputs,
          tester
        },
        workflow.mutationCwd, ctx,
        parseDocumenterOutput,
        { mutationPlan: currentReview.plan },
        { scopeOwner: "finalization_initial_documentation" }
      );
      documentation = coordResult.output as DocumenterOutput;
      if (coordResult.resolutionRecord?.status === "resolved") {
        currentReview = { ...coordResult.planning, codeReview, reviewApprovalSource, priorCodeReviews: currentReview.priorCodeReviews, finalImplChecks: currentReview.finalImplChecks, tester: currentReview.tester };
      }
    }
    if (!documentation.blocker) {
      assertDocumenterComplete(documentation);
      await saveWorkflowCheckpoint(runtime, workflow, "documenter_completed", { review: currentReview, documentation }, {
        exploration: currentReview.exploration,
        plan: currentReview.plan,
        baselineChecks: currentReview.baseline,
        tester: currentReview.tester,
        builderOutputs: runtime.builderSessionOutputs,
        implementationChecks: currentReview.finalImplChecks,
        codeReview,
        priorCodeReviews: currentReview.priorCodeReviews,
        reviewApprovalSource
      });
      return { review: currentReview, documentation };
    }
    if (documentation.blocker.kind !== "scope") {
      continue;
    }
    currentReview = await resolveInitialDocumenterScopeBlock(runtime, workflow, currentReview, documentation);
  }
  throw new Error("Documenter scope revision was not approved within the plan revision limit");
}

export async function resolveInitialDocumenterScopeBlock(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  documentation: DocumenterOutput
): Promise<ReviewResult> {
  if (!documentation.blocker || documentation.blocker.kind !== "scope") {
    throw new Error("resolveInitialDocumenterScopeBlock called without a scope blocker");
  }
  const additions = filesOutsidePlan(review.plan, documentation.blocker.requiredFiles);
  if (additions.length === 0) throw new Error("Documenter scope blocker requested no files outside the approved plan");
  validateDocumentationAdditions(additions);
  const newScope = consumeScopeRevision(review.scopeRevisionCount, workflow.config.limits.planRevisions, "during finalization");
  const after: DocumentationScopePhase = { phase: "initial_documentation", blockedDocumentation: documentation, changeRound: 0 };
  return reviseImplementationScope(
    runtime, workflow, review, additions,
    { checks: review.finalImplChecks, blocker: documentation.blocker },
    newScope,
    { mode: "finalization", scopeRevisionCount: newScope, documentation: after }
  );
}

function validateDocumentationAdditions(additions: readonly string[]): void {
  const nonDoc = additions.filter(file => !isDocumentationPath(file));
  if (nonDoc.length > 0) throw new Error(`Documenter scope blocker requested non-documentation files: ${nonDoc.join(", ")}`);
}

export async function resolveDocumenterScopeBlockOnRepair(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  documentation: DocumenterOutput,
  preparation: SerializedLessonPreparation,
  failedChecks: CheckResult[],
  diagnosis: DebuggerOutput,
  attempt: number
): Promise<ReviewResult> {
  if (!documentation.blocker || documentation.blocker.kind !== "scope") {
    throw new Error("resolveDocumenterScopeBlockOnRepair called without a scope blocker");
  }
  const { config } = workflow;
  const additions = filesOutsidePlan(review.plan, documentation.blocker.requiredFiles);
  if (additions.length === 0) throw new Error("Documenter repair scope blocker requested no files outside the approved plan");
  validateDocumentationAdditions(additions);
  const newScope = consumeScopeRevision(review.scopeRevisionCount, config.limits.planRevisions, "during finalization");
  const after: DocumentationScopePhase = { phase: "repair_checks", blockedDocumentation: documentation, preparation, failedChecks, diagnosis, attempt, changeRound: 0 };
  return reviseImplementationScope(
    runtime, workflow, review, additions,
    { checks: failedChecks, diagnosis, blocker: documentation.blocker },
    newScope,
    { mode: "finalization", scopeRevisionCount: newScope, documentation: after }
  );
}

export async function runFinalizationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  continuation?: FinalizationContinuation,
  inheritedChangeRound = 0
): Promise<void> {
  const { request, ctx, config, store } = workflow;
  let currentReview = continuation?.review ?? review;
  let documentation: DocumenterOutput | undefined;
  let lessonPreparation: LessonPreparation | undefined;
  if (continuation?.point === "documenter_completed") {
    documentation = continuation.documentation;
  } else if (continuation?.point === "lessons_screened" || continuation?.point === "final_checks_passed" || continuation?.point === "final_delivery") {
    lessonPreparation = hydrateLessonPreparation(continuation.preparation);
    documentation = lessonPreparation.documentation;
  }
  if (!documentation) {
    const result = await runDocumenterWithScopeExpansion(runtime, workflow, currentReview, undefined);
    currentReview = result.review;
    documentation = result.documentation;
  }
  if (!lessonPreparation) {
    lessonPreparation = await prepareLessons(runtime, workflow, currentReview, documentation);
  }
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
        plan: currentReview.plan,
        checks: finalChecks,
        phase: "final",
        attempt
      }, workflow.mutationCwd, ctx, parseDebuggerOutput, { attempt });
      const authorized = new Set(deriveRoleMutationPaths("documenter", currentReview.plan));
      const repairable = diagnosis.affectedFiles.length > 0
        && diagnosis.affectedFiles.every(file => authorized.has(file))
        && !["environment_error", "tooling_error", "unknown"].includes(diagnosis.category);
      if (!repairable || attempt === maxAttempts) {
        throw new CheckFailureError("Final checks", finalChecks.filter(check => !check.passed).map(check => check.command), diagnosis);
      }
      const previousDocumentation = lessonPreparation.documentation;
      const repairResult = await runAgentStepWithResolution(
        runtime, workflow, currentReview,
        "documenter", "documenting", "Repair documentation check failures",
        {
          action: "repair_checks",
          request,
          plan: currentReview.plan,
          checks: finalChecks,
          diagnosis,
          previous: lessonPreparation.documentation,
          attempt
        },
        workflow.mutationCwd, ctx, parseDocumenterOutput,
        { attempt, mutationPlan: currentReview.plan },
        {
          scopeOwner: "finalization_repair_documentation",
          scopeContext: {
            preparation: serializeLessonPreparation(lessonPreparation),
            failedChecks: finalChecks,
            diagnosis,
            attempt
          }
        }
      );
      const repairOutput = repairResult.output as DocumenterOutput;
      if (repairResult.resolutionRecord?.status === "resolved") {
        currentReview = { ...repairResult.planning, codeReview: currentReview.codeReview, reviewApprovalSource: currentReview.reviewApprovalSource, priorCodeReviews: currentReview.priorCodeReviews, finalImplChecks: currentReview.finalImplChecks, tester: currentReview.tester };
        continue;
      }
      if (repairOutput.blocker) {
        if (repairOutput.blocker.kind === "scope") {
          currentReview = await resolveDocumenterScopeBlockOnRepair(
            runtime, workflow, currentReview, repairOutput,
            lessonPreparation ? serializeLessonPreparation(lessonPreparation) : { documentation: repairOutput, proposedCandidates: [], duplicateCandidateIds: [], machineEligibleCount: 0, machineRejectedCount: 0, duplicateCount: 0 },
            finalChecks, diagnosis, attempt
          );
          attempt--;
          continue;
        }
        continue;
      }
      assertDocumenterComplete(repairOutput);
      documentation = {
        ...repairOutput,
        changedFiles: [...new Set([...previousDocumentation.changedFiles, ...repairOutput.changedFiles])]
      };
      lessonPreparation = await prepareLessons(runtime, workflow, currentReview, documentation);
    }
  }
  if (!finalChecks || !allGreen(finalChecks, config.checks.length)) throw new Error("Final checks did not reach a verified state");
  if (continuation?.point !== "final_checks_passed" && continuation?.point !== "final_delivery") {
    await saveWorkflowCheckpoint(runtime, workflow, "final_checks_passed", {
      review: currentReview,
      preparation: { ...lessonPreparation, duplicateCandidateIds: [...lessonPreparation.duplicateCandidateIds] },
      finalChecks
    }, {
      exploration: currentReview.exploration,
      plan: currentReview.plan,
      baselineChecks: currentReview.baseline,
      tester: currentReview.tester,
      builderOutputs: runtime.builderSessionOutputs,
      implementationChecks: currentReview.finalImplChecks,
      codeReview: currentReview.codeReview,
      priorCodeReviews: currentReview.priorCodeReviews,
      reviewApprovalSource: currentReview.reviewApprovalSource
    });
  }
  const policy = resolveParticipationPolicy(config);
  if (requiresHumanDecision(policy, "final_delivery")) {
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
            exploration: currentReview.exploration,
            plan: currentReview.plan,
            baselineChecks: currentReview.baseline,
            tester: currentReview.tester,
            builderOutputs: runtime.builderSessionOutputs,
            implementationChecks: currentReview.finalImplChecks,
            documentation: lessonPreparation.documentation,
            codeReview: currentReview.codeReview,
            priorCodeReviews: currentReview.priorCodeReviews,
            reviewApprovalSource: currentReview.reviewApprovalSource,
            decisionContext: {
              mode: "review",
              review: currentReview,
              preparation: { ...lessonPreparation, duplicateCandidateIds: [...lessonPreparation.duplicateCandidateIds] },
              finalChecks,
              changeRound
            }
          },
          async signal => {
            const answer = await ctx.ui.select(
              `Final checks are green. Deliver ${currentReview.plan.summary}?`,
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
      await applyFinalChangeRequest(runtime, workflow, currentReview, decision.feedback ?? "", changeRound + 1);
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
    ...(currentReview.tester?.changedFiles ?? []),
    ...runtime.builderSessionOutputs.flatMap(output => output.changedFiles),
    ...lessonPreparation.documentation.changedFiles
  ])];
  const allChanged = synchronizedFiles ?? (runtime.enforceWorkspacePolicy ? [...runtime.validatedChangedFiles].sort() : reportedChanged);
  const completionSummary: CompletionSummary = {
    request,
    route: currentReview.plan.route,
    planSummary: currentReview.plan.summary,
    changedFiles: allChanged,
    testsAdded: currentReview.tester?.testsAdded ?? [],
    checks: finalChecks,
    attempts: runtime.requireState().attempt,
    baselineRepaired: runtime.baselineRepaired,
    review: {
      outcome: currentReview.reviewApprovalSource === "user_override" ? "accepted_by_user" : "reviewer_approved",
      evidenceCount: currentReview.codeReview.evidence.length,
      evidence: currentReview.codeReview.evidence,
      suggestions: currentReview.codeReview.suggestions,
      blockingIssues: currentReview.codeReview.blockingIssues,
      revisions: currentReview.priorCodeReviews.length
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

export async function applyFinalChangeRequest(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  feedback: string,
  changeRound: number,
  proposedPlan?: PlannerOutput,
  approved = false
): Promise<void> {
  if (review.scopeRevisionCount >= workflow.config.limits.planRevisions) {
    throw new Error("Final change request limit was exhausted");
  }
  const plan = proposedPlan ?? await runAgentStep(runtime, "planner", "planning", "Plan requested final changes", {
    action: "revise_plan",
    route: workflow.route,
    request: workflow.request,
    exploration: review.exploration,
    previousPlan: review.plan,
    feedback: { source: "human", text: feedback }
  }, workflow.mutationCwd, workflow.ctx, parsePlannerOutput, { revision: changeRound });
  validateFinalPlanRevision(review.plan, plan, {
    preserveAcceptanceCriteria: workflow.route === "quick_implementation"
  });
  if (!approved) {
    await runDurableHumanGate(
      runtime,
      workflow,
      "final_revision_approval",
      "Final revision plan approval",
      { point: "final_revision_decision", mode: "review", changeRound },
      {
        exploration: review.exploration,
        plan,
        baselineChecks: review.baseline,
        tester: review.tester,
        builderOutputs: runtime.builderSessionOutputs,
        implementationChecks: review.finalImplChecks,
        codeReview: review.codeReview,
        priorCodeReviews: review.priorCodeReviews,
        decisionContext: { mode: "review", review, plan, feedback, changeRound }
      },
      async signal => {
        const answer = await workflow.ctx.ui.select(
          `Approve final revision plan: ${plan.summary}?`,
          ["Approve revised plan", "Cancel workflow"],
          { signal }
        );
        return answer === undefined ? undefined : { action: answer === "Approve revised plan" ? "approve" as const : "cancel" as const };
      },
      () => ({ approved: true })
    );
  }
  const planning: ImplementationPlanningResult = {
    exploration: review.exploration,
    plan,
    baseline: review.baseline,
    baselineDiagnosis: review.baselineDiagnosis,
    scopeRevisionCount: review.scopeRevisionCount + 1
  };
  const implementation = await runImplementationPhase(runtime, workflow, planning, undefined, {
    skipTester: workflow.route === "quick_implementation"
  });
  const revisedReview = await runReviewPhase(runtime, workflow, implementation);
  await runFinalizationPhase(runtime, workflow, revisedReview, undefined, changeRound);
}

export async function runReadOnlyFinalizationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReadOnlyReviewResult | InvestigationResult | PlanningResult
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
  const state = runtime.requireState();
  state.status = "completed";
  state.completedAt = runtime.timestamp();
  await transition(runtime, "completed", undefined, workflow.route === "investigation_only" ? "Investigation completed" : `${workflow.route} workflow completed`, ctx);
  publishSessionMessage(runtime, formatCompletedRun(completionSummary, state.dashboardUrl, state.runDir, state.warning, EXTENSION_VERSION), { kind: "completed" });
  await store.flush();
  ctx.ui.notify(workflow.route === "investigation_only" ? "piOrchestrator investigation completed" : "piOrchestrator review completed", "info");
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
    review: { outcome: "not_run", evidenceCount: 0, evidence: [], suggestions: [], blockingIssues: [], revisions: 0 },
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
  runtime.finalizationStarted = true;
  const finalChecksDigest = computeFinalChecksDigest(finalChecks);
  await store.saveJson("finalization-intent.json", {
    runId: workflow.runId,
    checkpoint: runtime.requireState().latestCheckpoint,
    operation: workflow.worktreeHandle ? `synchronize_and_${operation}` : `${operation}_and_complete`,
    createdAt: runtime.timestamp(),
    finalChecksDigest
  });
  await store.flush();
  runtime.requireState().resumeBlockedReason = "Finalization has started; uncertain side effects are never replayed";
  await persist(runtime, ctx);
  await store.flush();
  let synchronizedFiles: string[] | undefined;
  if (workflow.worktreeHandle) {
    const activeWorktree = workflow.worktreeHandle;
    const pendingChanges = await collectWorktreeChanges(activeWorktree);
    await store.saveRaw("worktree-final.patch", pendingChanges.patch.toString("utf8"));
    throwIfAborted(runtime);
    if (runtime.enforceWorkspacePolicy) await validateFinalWorktreeChanges(runtime, activeWorktree, pendingChanges.changedFiles);
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
  } else if (runtime.enforceWorkspacePolicy) {
    await validateFinalDirectWorkspace(runtime, workflow.mutationCwd);
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
