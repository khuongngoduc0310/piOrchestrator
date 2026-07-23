import { realpath } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CheckpointStore, readSafeArtifact } from "../persistence/checkpoint-store.js";
import { validateCheckResults, validateCheckResultsAgainstCommands, validateWorkflowStateForResume } from "../persistence/checkpoint-validation.js";
import type { WorkflowCheckpoint } from "../persistence/checkpoint-types.js";
import { loadConfig } from "../config/config.js";
import type { ImplementationPlanningResult, ImplementationResult, PlanningResult, ReadOnlyReviewResult, ReviewResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import { runFinalizationPhase, runReadOnlyFinalizationPhase, type FinalizationContinuation } from "./orchestrator-finalization.js";
import { requestImplementationBudgetExtension, runImplementationPhase, type ImplementationContinuation } from "./orchestrator-implementation.js";
import { hydrateLessonPreparation, type SerializedLessonPreparation } from "./orchestrator-lessons.js";
import { continueBaselineRepair, continuePlanningDecision, enterMutationPhase, prepareImplementationPhase } from "./orchestrator-planning.js";
import { runReadOnlyReviewPhase } from "./orchestrator-read-only-review.js";
import { runReviewPhase, type ReviewContinuation } from "./orchestrator-review.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { fail, persist } from "./orchestrator-state.js";
import { WorkflowPausedError } from "./workflow-errors.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { runSelectedRoute } from "./orchestrator-routes.js";
import { runSpecializedMutationRoute } from "./orchestrator-specialized-routes.js";
import { RunStore, type RunLease } from "../persistence/store.js";
import type { BuilderOutput, DocumenterOutput, ReviewApprovalSource, ReviewOutput, WorkflowState } from "../types.js";
import {
  validateBuilderOutput,
  validateDebuggerOutput,
  validateDocumenterOutput,
  validateExplorerOutput,
  validatePlannerOutput,
  validateReviewOutput,
  validateTesterOutput
} from "../validation.js";
import { attachWorktree, removeWorktree } from "../workspace/worktree.js";
import { canonicalSha256 } from "../workspace/workspace-guard.js";
import { currentWorkspaceDigest, saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { EXTENSION_VERSION } from "./orchestrator-helpers.js";
import { allGreen } from "./orchestrator-helpers.js";
import { computeFinalChecksDigest, validateCandidates } from "../memory/memory-validation.js";
import { assertBuilderComplete, assertDocumenterComplete, assertTesterComplete } from "./mutation-completion.js";
import type { HumanDecisionAction, PendingHumanDecision, RecordedHumanDecision } from "./human-decision-types.js";
import { continueScopeRevisionDecision, type ScopeRevisionDecisionContext } from "./orchestrator-scope-revision.js";
import { validateFailureScopeRevision } from "./plan-revision.js";

const MAX_STATE_BYTES = 16 * 1024 * 1024;

export async function resumeWorkflow(
  runtime: OrchestratorRuntime,
  runId: string,
  ctx: ExtensionCommandContext,
  controller: AbortController
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const store = await RunStore.open(cwd, runId);
  let lease: RunLease | undefined;
  try {
    lease = await store.acquireLease({ recoverStale: true });
    const checkpoint = await new CheckpointStore(store.runDir, runId).loadLatest();
    if (!checkpoint) throw new Error(`Run ${runId} has no resumable checkpoint`);
    const currentState = validateWorkflowStateForResume(JSON.parse(await readSafeArtifact(store.runDir, "state.json", MAX_STATE_BYTES)));
    runtime.controller = controller;
    runtime.store = store;
    runtime.state = currentState;
    runtime.config = checkpoint.config;
    try {
      await validateResumeBindings(runtime, cwd, store, checkpoint, currentState, ctx);
    } catch (error) {
      if (isPermanentResumeFailure(error)) {
        currentState.resumeBlockedReason = error.message;
        await store.saveJson("resume-precondition-error.json", {
          checkpointNumber: checkpoint.checkpointNumber,
          cursor: checkpoint.cursor.kind,
          error: error.message,
          blockedAt: runtime.timestamp()
        }).catch(() => undefined);
        await store.event("resume_blocked", { checkpointNumber: checkpoint.checkpointNumber, error: error.message }).catch(() => undefined);
        await persist(runtime, ctx).catch(() => undefined);
      }
      throw error;
    }

    runtime.baselineContext = checkpoint.baselineContext;
    runtime.baselineReviewContext = checkpoint.baselineReviewContext;
    runtime.baselineRepaired = checkpoint.baselineRepaired;
    runtime.lessonStatus = checkpoint.lessonStatus;
    runtime.builderSessionOutputs = (checkpoint.bindings.builderOutputs ?? []).map((value, index) => validateBuilderOutput(value, `checkpoint.bindings.builderOutputs[${index}]`));
    runtime.validatedChangedFiles = new Set(checkpoint.validatedChangedFiles);
    runtime.selectedMemoryIds = new Set(checkpoint.selectedMemoryIds);
    runtime.explorerRelevantFiles = checkpoint.bindings.exploration?.relevantFiles.slice() ?? [];
    runtime.mutationCommitStarted = false;

    const workflow: WorkflowContext = {
      route: checkpoint.state.route!,
      request: checkpoint.state.request,
      ctx,
      cwd,
      mutationCwd: cwd,
      runId,
      store,
      config: checkpoint.config,
      controller,
      worktreeSynced: false,
      retainWorktree: false,
      mutationConfirmed: checkpoint.mutationConfirmed
    };
    if (checkpoint.worktreeHandle) {
      workflow.worktreeHandle = await attachWorktree(checkpoint.worktreeHandle, {
        expectedWorkspaceSnapshotDigest: checkpoint.workspaceDigest,
        workspaceSnapshotDigest: root => currentWorkspaceDigest(runtime, root)
      });
      workflow.mutationCwd = workflow.worktreeHandle.effectiveCwd;
    }

    resetStateForResume(currentState, checkpoint);
    await store.event("resumed", { checkpointNumber: checkpoint.checkpointNumber, cursor: checkpoint.cursor.kind });
    await persist(runtime, ctx);

    try {
      await continueFromCheckpoint(runtime, workflow, checkpoint);
    } catch (error) {
      if (error instanceof WorkflowPausedError) {
        const s = runtime.state;
        if (s) {
          s.status = "paused";
          await persist(runtime, ctx).catch(() => undefined);
        }
      } else {
        await fail(runtime, error, ctx);
      }
    } finally {
      if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
      runtime.persistTimer = undefined;
      if (workflow.worktreeHandle && !workflow.worktreeSynced && !workflow.retainWorktree) {
        try {
          const latest = await new CheckpointStore(store.runDir, runId).loadLatest();
          workflow.retainWorktree = !!latest && latest.workspaceDigest === await currentWorkspaceDigest(runtime, workflow.worktreeHandle.effectiveCwd);
        } catch {
          workflow.retainWorktree = false;
        }
      }
      if (workflow.worktreeHandle && !workflow.worktreeSynced && !workflow.retainWorktree) {
        await removeWorktree(workflow.worktreeHandle).catch(() => undefined);
      }
      await store.flush();
    }
  } finally {
    await lease?.release().catch(() => false);
  }
}

function isPermanentResumeFailure(error: unknown): error is Error {
  if (!(error instanceof Error)) return false;
  return [
    "cannot be resumed",
    "identity does not match",
    "route does not match",
    "was created by extension",
    "different project path",
    "Run directory does not match",
    "configuration changed",
    "Project memory changed",
    "memory content changed",
    "memory lessons are missing",
    "Finalization already completed",
    "Finalization outcome is uncertain",
    "worktree belongs to a different project",
    "workspace root does not match",
    "Workspace differs",
    "checkpoint"
  ].some(fragment => error.message.includes(fragment));
}

async function validateResumeBindings(
  runtime: OrchestratorRuntime,
  cwd: string,
  store: RunStore,
  checkpoint: WorkflowCheckpoint,
  state: WorkflowState,
  ctx: ExtensionCommandContext
): Promise<void> {
  if (state.status === "completed") throw new Error("Completed workflows cannot be resumed");
  if (state.runId !== checkpoint.runId || state.runId !== store.runId) throw new Error("Run identity does not match its checkpoint");
  if (!state.route || checkpoint.state.route !== state.route) throw new Error("Workflow route does not match its checkpoint");
  if (state.extensionVersion !== EXTENSION_VERSION || checkpoint.state.extensionVersion !== EXTENSION_VERSION) {
    throw new Error(`Run ${state.runId} was created by extension ${state.extensionVersion}; current version is ${EXTENSION_VERSION}`);
  }
  if (!samePath(await realpath(cwd), await realpath(state.cwd))) throw new Error("Run belongs to a different project path");
  if (!samePath(await realpath(store.runDir), await realpath(state.runDir))) throw new Error("Run directory does not match persisted state");
  const currentConfig = await loadConfig(cwd);
  if (canonicalSha256(currentConfig) !== checkpoint.configDigest || canonicalSha256(checkpoint.config) !== checkpoint.configDigest) {
    throw new Error("Orchestrator configuration changed since the checkpoint");
  }
  await runtime.loadProjectMemory(cwd, ctx);
  if (runtime.memoryMode !== checkpoint.memoryMode || runtime.memoryRevision !== checkpoint.memoryRevision) {
    throw new Error("Project memory changed since the checkpoint");
  }
  if (canonicalSha256(runtime.loadedMemoryDoc) !== checkpoint.memoryDigest) throw new Error("Project memory content changed since the checkpoint");
  if (runtime.loadedMemoryDoc) {
    const ids = new Set(runtime.loadedMemoryDoc.lessons.map(lesson => lesson.id));
    const missing = checkpoint.selectedMemoryIds.filter(id => !ids.has(id));
    if (missing.length) throw new Error(`Checkpoint memory lessons are missing: ${missing.join(", ")}`);
  }
  const finalizationComplete = await readFinalizationMarker(store.runDir, "finalization-complete.json", checkpoint);
  if (finalizationComplete) throw new Error("Finalization already completed; automatic replay is disabled");
  if (await readFinalizationMarker(store.runDir, "finalization-intent.json", checkpoint)) {
    throw new Error("Finalization outcome is uncertain; automatic resume is disabled");
  }
  if (checkpoint.worktreeHandle) {
    if (!samePath(await realpath(checkpoint.worktreeHandle.sourceCwd), await realpath(cwd))) {
      throw new Error("Checkpoint worktree belongs to a different project");
    }
    if (!samePath(await realpath(checkpoint.workspaceRoot), await realpath(checkpoint.worktreeHandle.effectiveCwd))) {
      throw new Error("Checkpoint workspace root does not match its worktree");
    }
  }
  if (!checkpoint.worktreeHandle) {
    if (!samePath(await realpath(checkpoint.workspaceRoot), await realpath(cwd))) throw new Error("Checkpoint workspace root does not match the project");
    runtime.store = store;
    if (await currentWorkspaceDigest(runtime, cwd) !== checkpoint.workspaceDigest) {
      throw new Error("Workspace differs from the latest safe checkpoint");
    }
  }
  validateBindings(checkpoint);
  validateContinuation(checkpoint);
}

function validateContinuation(checkpoint: WorkflowCheckpoint): void {
  const value = checkpoint.cursor.continuation;
  switch (checkpoint.cursor.kind) {
    case "plan_approved": planningResult(value); return;
    case "checks_configured": planningResult(value); return;
    case "mutation_ready": implementationPlanningResult(value); return;
    case "bug_diagnosed": {
      const item = objectValue(value, "bug diagnosis checkpoint");
      implementationPlanningResult(item.planning);
      validateDebuggerOutput(item.diagnosis);
      return;
    }
    case "tester_completed": {
      const item = objectValue(value, "tester checkpoint");
      const planning = implementationPlanningResult(item.planning);
      assertTesterComplete(validateTesterOutput(item.tester, planning.plan.acceptanceCriteria), planning.plan.route);
      if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
      return;
    }
    case "builder_completed": {
      const item = objectValue(value, "builder checkpoint");
      if (item.mode === "baseline_repair") {
        planningResult(item.planning);
        validateCheckResults(item.failedBaseline);
        validateDebuggerOutput(item.baselineDiagnosis);
        validatePlannerOutput(item.baselineFixPlan);
        assertBuilderComplete(validateBuilderOutput(item.repairOutput), "the approved baseline repair");
        return;
      }
      const planning = implementationPlanningResult(item.planning);
      if (item.tester === undefined) {
        if (planning.plan.route !== "quick_implementation") throw new Error("Builder checkpoint is missing Tester output");
      } else {
        validateTesterOutput(item.tester, planning.plan.acceptanceCriteria);
      }
      validateCheckResults(item.checksAfterTests);
      if (item.previousChecks !== undefined) validateCheckResults(item.previousChecks);
      if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
      positiveInteger(item.completedAttempt, "completedAttempt");
      if (item.scopeRevisionCount !== undefined) nonNegativeInteger(item.scopeRevisionCount, "scopeRevisionCount");
      return;
    }
    case "scope_revision_approved": {
      const item = objectValue(value, "scope revision checkpoint");
      if (item.mode === "implementation") {
        const planning = implementationPlanningResult(item.planning);
        if (item.tester === undefined) {
          if (planning.plan.route !== "quick_implementation") throw new Error("Scope revision checkpoint is missing Tester output");
        } else {
          validateTesterOutput(item.tester, planning.plan.acceptanceCriteria);
        }
        validateCheckResults(item.checksAfterTests);
        if (item.previousChecks !== undefined) validateCheckResults(item.previousChecks);
        if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
        positiveInteger(item.attempt, "attempt");
      } else if (item.mode === "review") {
        implementationResult(item.implementation);
        validateCheckResults(item.finalImplChecks);
        validateReviewOutput(item.codeReview);
        arrayValue(item.priorCodeReviews, "priorCodeReviews").forEach((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`));
        positiveInteger(item.pendingFix, "pendingFix");
        nonNegativeInteger(item.allowedReviewFixes, "allowedReviewFixes");
        if (item.failureChecks !== undefined) validateCheckResults(item.failureChecks);
        if (item.failureDiagnosis !== undefined) validateDebuggerOutput(item.failureDiagnosis);
      } else {
        throw new Error("Unsupported scope revision checkpoint mode");
      }
      positiveInteger(item.scopeRevisionCount, "scopeRevisionCount");
      return;
    }
    case "implementation_verified": implementationResult(value); return;
    case "review_fix_completed": {
      const item = objectValue(value, "review-fix checkpoint");
      implementationResult(item.implementation);
      validateCheckResults(item.finalImplChecks);
      validateReviewOutput(item.codeReview);
      arrayValue(item.priorCodeReviews, "priorCodeReviews").forEach((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`));
      positiveInteger(item.completedFix, "completedFix");
      nonNegativeInteger(item.allowedReviewFixes, "allowedReviewFixes");
      nonNegativeInteger(item.scopeRevisionCount, "scopeRevisionCount");
      return;
    }
    case "review_approved": reviewResult(value); return;
    case "documenter_completed": {
      const item = objectValue(value, "documenter checkpoint");
      reviewResult(item.review);
      assertDocumenterComplete(validateDocumenterOutput(item.documentation));
      return;
    }
    case "lessons_screened": {
      const item = objectValue(value, "lessons checkpoint");
      reviewResult(item.review);
      serializedLessonPreparation(item.preparation);
      return;
    }
    case "final_checks_passed": {
      const item = objectValue(value, "final-check checkpoint");
      reviewResult(item.review);
      serializedLessonPreparation(item.preparation);
      const checks = validateCheckResultsAgainstCommands(item.finalChecks, checkpoint.config.checks, "finalChecks");
      if (!allGreen(checks, checkpoint.config.checks.length)) throw new Error("Checkpoint final checks are not green");
      return;
    }
    case "repository_reviewed": readOnlyReviewResult(value); return;
    case "route_agent_completed": specializedMutationResult(value); return;
    case "route_final_checks_passed": {
      const item = objectValue(value, "specialized final-check checkpoint");
      specializedMutationResult(item.result);
      const checks = validateCheckResultsAgainstCommands(item.finalChecks, checkpoint.config.checks, "finalChecks");
      if (!allGreen(checks, checkpoint.config.checks.length)) throw new Error("Checkpoint final checks are not green");
      return;
    }
    case "human_decision_pending": humanDecisionContinuation(value, false); return;
    case "human_decision_recorded": humanDecisionContinuation(value, true); return;
  }
}

function validateBindings(checkpoint: WorkflowCheckpoint): void {
  const bindings = checkpoint.bindings;
  if (!bindings.exploration || !bindings.plan) throw new Error("Checkpoint is missing approved planning bindings");
  if (bindings.exploration) validateExplorerOutput(bindings.exploration, "checkpoint.bindings.exploration");
  if (bindings.plan) validatePlannerOutput(bindings.plan, "checkpoint.bindings.plan");
  if (bindings.proposedPlan) validatePlannerOutput(bindings.proposedPlan, "checkpoint.bindings.proposedPlan");
  if (bindings.plan && bindings.plan.route !== checkpoint.state.route) throw new Error("Checkpoint plan route does not match workflow route");
  if (bindings.baselineChecks) validateCheckResults(bindings.baselineChecks, "checkpoint.bindings.baselineChecks");
  if (bindings.tester) {
    if (!bindings.plan) throw new Error("Checkpoint Tester output has no plan");
    validateTesterOutput(bindings.tester, bindings.plan.acceptanceCriteria, "checkpoint.bindings.tester");
  }
  bindings.builderOutputs?.forEach((value, index) => validateBuilderOutput(value, `checkpoint.bindings.builderOutputs[${index}]`));
  if (bindings.implementationChecks) validateCheckResults(bindings.implementationChecks, "checkpoint.bindings.implementationChecks");
  if (bindings.diagnosis) validateDebuggerOutput(bindings.diagnosis, "checkpoint.bindings.diagnosis");
  if (bindings.codeReview) validateReviewOutput(bindings.codeReview, "checkpoint.bindings.codeReview");
  bindings.priorCodeReviews?.forEach((value, index) => validateReviewOutput(value, `checkpoint.bindings.priorCodeReviews[${index}]`));
}

async function continueFromCheckpoint(runtime: OrchestratorRuntime, workflow: WorkflowContext, checkpoint: WorkflowCheckpoint): Promise<void> {
  const continuation = checkpoint.cursor.continuation;
  switch (checkpoint.cursor.kind) {
    case "plan_approved": {
      const planning = planningResult(continuation);
      await runSelectedRoute(runtime, workflow, planning);
      return;
    }
    case "checks_configured": {
      const planning = planningResult(continuation);
      await runSelectedRoute(runtime, workflow, planning);
      return;
    }
    case "mutation_ready": {
      const planning = implementationPlanningResult(continuation);
      await runSelectedRoute(runtime, workflow, planning, { prepared: true });
      return;
    }
    case "bug_diagnosed": {
      const value = objectValue(continuation, "bug diagnosis checkpoint");
      await runSelectedRoute(runtime, workflow, implementationPlanningResult(value.planning), {
        prepared: true,
        bugDiagnosis: validateDebuggerOutput(value.diagnosis)
      });
      return;
    }
    case "tester_completed": {
      const value = objectValue(continuation, "tester checkpoint");
      const planning = implementationPlanningResult(value.planning);
      const tester = validateTesterOutput(value.tester, planning.plan.acceptanceCriteria);
      const diagnosis = value.diagnosis === undefined ? undefined : validateDebuggerOutput(value.diagnosis);
      const implementation = await runImplementationPhase(runtime, workflow, planning, { point: "tester_completed", tester, diagnosis }, {
        initialDiagnosis: diagnosis
      });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "builder_completed": {
      const value = objectValue(continuation, "builder checkpoint");
      if (value.mode === "baseline_repair") {
        const planning = planningResult(value.planning);
        const baseline = await runCheckStep(runtime, "baseline", "Verify baseline after repair", workflow.mutationCwd, workflow.ctx, { requireGreen: true, kind: "baseline-verify" });
        runtime.baselineRepaired = true;
        const prepared = { ...planning, baseline, scopeRevisionCount: 0 };
        await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", prepared, { exploration: planning.exploration, plan: planning.plan, baselineChecks: baseline });
        const implementation = await runImplementationPhase(runtime, workflow, prepared);
        const review = await runReviewPhase(runtime, workflow, implementation);
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      const planning = implementationPlanningResult(value.planning);
      const tester = value.tester === undefined ? undefined : validateTesterOutput(value.tester, planning.plan.acceptanceCriteria);
      const implementationContinuation: ImplementationContinuation = {
        point: "builder_completed",
        tester,
        checksAfterTests: validateCheckResults(value.checksAfterTests),
        previousChecks: value.previousChecks === undefined ? undefined : validateCheckResults(value.previousChecks),
        diagnosis: value.diagnosis === undefined ? undefined : validateDebuggerOutput(value.diagnosis),
        completedAttempt: positiveInteger(value.completedAttempt, "completedAttempt"),
        scopeRevisionCount: value.scopeRevisionCount === undefined ? undefined : nonNegativeInteger(value.scopeRevisionCount, "scopeRevisionCount")
      };
      const implementation = await runImplementationPhase(runtime, workflow, planning, implementationContinuation, {
        skipTester: workflow.route === "quick_implementation"
      });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "scope_revision_approved": {
      const value = objectValue(continuation, "scope revision checkpoint");
      let review;
      if (value.mode === "implementation") {
        const planning = implementationPlanningResult(value.planning);
        const tester = value.tester === undefined ? undefined : validateTesterOutput(value.tester, planning.plan.acceptanceCriteria);
        const implementation = await runImplementationPhase(runtime, workflow, planning, {
          point: "scope_revision_approved",
          tester,
          checksAfterTests: validateCheckResults(value.checksAfterTests),
          previousChecks: value.previousChecks === undefined ? undefined : validateCheckResults(value.previousChecks),
          diagnosis: value.diagnosis === undefined ? undefined : validateDebuggerOutput(value.diagnosis),
          attempt: positiveInteger(value.attempt, "attempt"),
          scopeRevisionCount: positiveInteger(value.scopeRevisionCount, "scopeRevisionCount")
        }, { skipTester: workflow.route === "quick_implementation" });
        review = await runReviewPhase(runtime, workflow, implementation);
      } else if (value.mode === "review") {
        const implementation = implementationResult(value.implementation);
        review = await runReviewPhase(runtime, workflow, implementation, {
          point: "scope_revision_approved",
          finalImplChecks: validateCheckResults(value.finalImplChecks),
          codeReview: validateReviewOutput(value.codeReview),
          priorCodeReviews: arrayValue(value.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`)),
          pendingFix: positiveInteger(value.pendingFix, "pendingFix"),
          allowedReviewFixes: nonNegativeInteger(value.allowedReviewFixes, "allowedReviewFixes"),
          scopeRevisionCount: positiveInteger(value.scopeRevisionCount, "scopeRevisionCount")
          , failureChecks: value.failureChecks === undefined ? undefined : validateCheckResults(value.failureChecks)
          , failureDiagnosis: value.failureDiagnosis === undefined ? undefined : validateDebuggerOutput(value.failureDiagnosis)
        });
      } else {
        throw new Error("Unsupported scope revision checkpoint mode");
      }
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "implementation_verified": {
      const implementation = implementationResult(continuation);
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "review_fix_completed": {
      const value = objectValue(continuation, "review-fix checkpoint");
      const implementation = implementationResult(value.implementation);
      const reviewContinuation: ReviewContinuation = {
        point: "review_fix_completed",
        finalImplChecks: validateCheckResults(value.finalImplChecks),
        codeReview: validateReviewOutput(value.codeReview),
        priorCodeReviews: arrayValue(value.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`)),
        completedFix: positiveInteger(value.completedFix, "completedFix"),
        allowedReviewFixes: nonNegativeInteger(value.allowedReviewFixes, "allowedReviewFixes"),
        scopeRevisionCount: nonNegativeInteger(value.scopeRevisionCount, "scopeRevisionCount")
      };
      const review = await runReviewPhase(runtime, workflow, implementation, reviewContinuation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "review_approved":
      await runFinalizationPhase(runtime, workflow, reviewResult(continuation));
      return;
    case "documenter_completed": {
      const value = objectValue(continuation, "documenter checkpoint");
      const review = reviewResult(value.review);
      const next: FinalizationContinuation = { point: "documenter_completed", documentation: validateDocumenterOutput(value.documentation) };
      await runFinalizationPhase(runtime, workflow, review, next);
      return;
    }
    case "lessons_screened": {
      const value = objectValue(continuation, "lessons checkpoint");
      const review = reviewResult(value.review);
      const preparation = serializedLessonPreparation(value.preparation);
      runtime.candidateLessons = hydrateLessonPreparation(preparation).proposedCandidates;
      await runFinalizationPhase(runtime, workflow, review, { point: "lessons_screened", preparation });
      return;
    }
    case "final_checks_passed": {
      const value = objectValue(continuation, "final-check checkpoint");
      const review = reviewResult(value.review);
      const preparation = serializedLessonPreparation(value.preparation);
      runtime.candidateLessons = hydrateLessonPreparation(preparation).proposedCandidates;
      await runFinalizationPhase(runtime, workflow, review, { point: "final_checks_passed", preparation, finalChecks: validateCheckResults(value.finalChecks) });
      return;
    }
    case "human_decision_pending": {
      const { request } = humanDecisionContinuation(continuation, false);
      await continueHumanDecision(runtime, workflow, checkpoint, request);
      return;
    }
    case "human_decision_recorded": {
      const { request, recorded } = humanDecisionContinuation(continuation, true);
      await continueHumanDecision(runtime, workflow, checkpoint, request, recorded);
      return;
    }
    case "repository_reviewed":
      await runReadOnlyFinalizationPhase(runtime, workflow, readOnlyReviewResult(continuation));
      return;
    case "route_agent_completed":
      await runSpecializedMutationRoute(runtime, workflow, implementationPlanningResult(continuation), specializedMutationResult(continuation));
      return;
    case "route_final_checks_passed": {
      const value = objectValue(continuation, "specialized final-check checkpoint");
      const result = specializedMutationResult(value.result);
      await runSpecializedMutationRoute(runtime, workflow, result, result, validateCheckResults(value.finalChecks));
      return;
    }
  }
}

async function continueHumanDecision(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  checkpoint: WorkflowCheckpoint,
  request: PendingHumanDecision,
  recorded?: RecordedHumanDecision
): Promise<void> {
  if (request.resume.point !== "plan_decision") {
    if (request.resume.point === "baseline_repair_decision") {
      const { exploration, plan, proposedPlan, baselineChecks, diagnosis } = checkpoint.bindings;
      if (!exploration || !plan || !proposedPlan || !baselineChecks || !diagnosis) {
        throw new Error("Baseline repair decision checkpoint is missing repair bindings");
      }
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const prepared = await continueBaselineRepair(
        runtime,
        workflow,
        { exploration: validateExplorerOutput(exploration), plan: validatePlannerOutput(plan) },
        validateCheckResults(baselineChecks),
        validateDebuggerOutput(diagnosis),
        validatePlannerOutput(proposedPlan),
        recorded ? planReviewDecision(recorded) : undefined
      );
      await runSelectedRoute(runtime, workflow, prepared, { prepared: true });
      return;
    }
    if (request.resume.point === "mutation_confirmation") {
      const { exploration, plan, proposedPlan, baselineChecks, diagnosis } = checkpoint.bindings;
      if (!exploration || !plan || !baselineChecks) throw new Error("Mutation confirmation checkpoint is missing planning bindings");
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const confirmed = recorded ? mutationConfirmation(recorded) : false;
      if (request.resume.mode === "baseline_repair") {
        if (!proposedPlan || !diagnosis) throw new Error("Baseline repair mutation confirmation is missing repair bindings");
        const prepared = await continueBaselineRepair(
          runtime,
          workflow,
          { exploration: validateExplorerOutput(exploration), plan: validatePlannerOutput(plan) },
          validateCheckResults(baselineChecks),
          validateDebuggerOutput(diagnosis),
          validatePlannerOutput(proposedPlan),
          { approved: true },
          confirmed
        );
        await runSelectedRoute(runtime, workflow, prepared, { prepared: true });
        return;
      }
      const prepared: ImplementationPlanningResult = {
        exploration: validateExplorerOutput(exploration),
        plan: validatePlannerOutput(plan),
        baseline: validateCheckResults(baselineChecks),
        scopeRevisionCount: request.resume.scopeRevisionCount,
        ...(request.resume.mode === "prepared" && diagnosis ? { baselineDiagnosis: validateDebuggerOutput(diagnosis) } : {})
      };
      await enterMutationPhase(runtime, workflow, { resume: request.resume, bindings: checkpoint.bindings }, confirmed);
      if (request.resume.mode === "bug_diagnosed") {
        if (!diagnosis) throw new Error("Bug diagnosis mutation confirmation is missing diagnosis bindings");
        const bugDiagnosis = validateDebuggerOutput(diagnosis);
        await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosed", { planning: prepared, diagnosis: bugDiagnosis }, checkpoint.bindings);
        await runSelectedRoute(runtime, workflow, prepared, { prepared: true, bugDiagnosis });
      } else {
        await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", prepared, checkpoint.bindings);
        await runSelectedRoute(runtime, workflow, prepared, { prepared: true });
      }
      return;
    }
    if (request.resume.point === "scope_revision_decision") {
      const context = scopeRevisionDecisionContext(checkpoint.bindings.decisionContext, request.resume);
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const revised = await continueScopeRevisionDecision(
        runtime,
        workflow,
        context,
        recorded ? planReviewDecision(recorded) : undefined
      );
      const after = context.after;
      if (after.mode === "implementation") {
        const planning = revised as ImplementationPlanningResult;
        await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
          mode: "implementation",
          planning,
          tester: after.tester,
          checksAfterTests: after.checksAfterTests,
          previousChecks: after.previousChecks,
          diagnosis: after.diagnosis,
          attempt: after.attempt,
          scopeRevisionCount: after.scopeRevisionCount
        }, {
          exploration: planning.exploration,
          plan: planning.plan,
          baselineChecks: planning.baseline,
          tester: after.tester,
          builderOutputs: runtime.builderSessionOutputs,
          implementationChecks: after.previousChecks,
          diagnosis: after.diagnosis
        });
        const implementation = await runImplementationPhase(runtime, workflow, planning, {
          point: "scope_revision_approved",
          tester: after.tester,
          checksAfterTests: after.checksAfterTests,
          previousChecks: after.previousChecks,
          diagnosis: after.diagnosis,
          attempt: after.attempt,
          scopeRevisionCount: after.scopeRevisionCount
        }, { skipTester: workflow.route === "quick_implementation" });
        const review = await runReviewPhase(runtime, workflow, implementation);
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      if (after.mode === "review") {
        const implementation = { ...(context.planning as ImplementationResult), plan: revised.plan, scopeRevisionCount: after.scopeRevisionCount };
        await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
          mode: "review",
          implementation,
          finalImplChecks: after.finalImplChecks,
          codeReview: after.codeReview,
          priorCodeReviews: after.priorCodeReviews,
          pendingFix: after.pendingFix,
          allowedReviewFixes: after.allowedReviewFixes,
          scopeRevisionCount: after.scopeRevisionCount,
          failureChecks: after.failureChecks,
          failureDiagnosis: after.failureDiagnosis
        }, {
          exploration: implementation.exploration,
          plan: implementation.plan,
          baselineChecks: implementation.baseline,
          tester: implementation.tester,
          builderOutputs: runtime.builderSessionOutputs,
          implementationChecks: after.finalImplChecks,
          codeReview: after.codeReview,
          priorCodeReviews: after.priorCodeReviews,
          diagnosis: after.failureDiagnosis
        });
        const review = await runReviewPhase(runtime, workflow, implementation, {
          point: "scope_revision_approved",
          finalImplChecks: after.finalImplChecks,
          codeReview: after.codeReview,
          priorCodeReviews: after.priorCodeReviews,
          pendingFix: after.pendingFix,
          allowedReviewFixes: after.allowedReviewFixes,
          scopeRevisionCount: after.scopeRevisionCount,
          failureChecks: after.failureChecks,
          failureDiagnosis: after.failureDiagnosis
        });
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      const planning = { ...(revised as ImplementationPlanningResult), scopeRevisionCount: after.scopeRevisionCount };
      await enterMutationPhase(runtime, workflow, {
        resume: { point: "mutation_confirmation", mode: "bug_diagnosed", scopeRevisionCount: after.scopeRevisionCount },
        bindings: {
          exploration: planning.exploration,
          plan: planning.plan,
          baselineChecks: planning.baseline,
          diagnosis: after.diagnosis
        }
      });
      await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosed", { planning, diagnosis: after.diagnosis }, {
        exploration: planning.exploration,
        plan: planning.plan,
        baselineChecks: planning.baseline,
        diagnosis: after.diagnosis
      });
      await runSelectedRoute(runtime, workflow, planning, { prepared: true, bugDiagnosis: after.diagnosis });
      return;
    }
    if (request.resume.point === "budget_exhausted") {
      const { exploration, plan, baselineChecks, tester, implementationChecks, diagnosis, decisionContext } = checkpoint.bindings;
      if (!exploration || !plan || !baselineChecks || !implementationChecks || !diagnosis) {
        throw new Error("Repair budget decision checkpoint is missing implementation bindings");
      }
      const context = objectValue(decisionContext, "repair budget decision context");
      const checksAfterTests = validateCheckResults(context.checksAfterTests);
      const validatedTester = tester === undefined ? undefined : validateTesterOutput(tester, plan.acceptanceCriteria);
      const failedChecks = validateCheckResults(implementationChecks);
      const validatedDiagnosis = validateDebuggerOutput(diagnosis);
      const planning: ImplementationPlanningResult = {
        exploration: validateExplorerOutput(exploration),
        plan: validatePlannerOutput(plan),
        baseline: validateCheckResults(baselineChecks),
        scopeRevisionCount: request.resume.scopeRevisionCount
      };
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      if (recorded) repairBudgetDecision(recorded);
      else await requestImplementationBudgetExtension(
        runtime,
        workflow,
        planning,
        validatedTester,
        checksAfterTests,
        failedChecks,
        validatedDiagnosis,
        request.resume.nextAttempt - 1,
        request.resume.allowedAttempts - 1,
        request.resume.scopeRevisionCount
      );
      const implementation = await runImplementationPhase(runtime, workflow, planning, {
        point: "budget_extended",
        tester: validatedTester,
        checksAfterTests,
        failedChecks,
        diagnosis: validatedDiagnosis,
        attempt: request.resume.nextAttempt,
        allowedAttempts: request.resume.allowedAttempts,
        scopeRevisionCount: request.resume.scopeRevisionCount
      }, { skipTester: workflow.route === "quick_implementation" });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    if (request.resume.point === "final_delivery") {
      const context = objectValue(checkpoint.bindings.decisionContext, "final delivery decision context");
      const mode = stringValue(context.mode, "final delivery decision mode");
      if (mode !== request.resume.mode) throw new Error("Final delivery mode does not match its decision context");
      const changeRound = nonNegativeInteger(context.changeRound, "changeRound");
      if (changeRound !== request.resume.changeRound) throw new Error("Final delivery change round does not match its decision context");
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      if (mode === "specialized") {
        const result = specializedMutationResult(context.result);
        const finalChecks = validateCheckResultsAgainstCommands(context.finalChecks, checkpoint.config.checks, "finalChecks");
        if (!allGreen(finalChecks, checkpoint.config.checks.length)) throw new Error("Final delivery decision checks are not green");
        await runSpecializedMutationRoute(
          runtime,
          workflow,
          result,
          result,
          finalChecks,
          recorded ? finalDeliveryDecision(recorded) : undefined,
          changeRound
        );
        return;
      }
      const review = reviewResult(context.review);
      const preparation = serializedLessonPreparation(context.preparation);
      const finalChecks = validateCheckResultsAgainstCommands(context.finalChecks, checkpoint.config.checks, "finalChecks");
      if (!allGreen(finalChecks, checkpoint.config.checks.length)) throw new Error("Final delivery decision checks are not green");
      runtime.candidateLessons = hydrateLessonPreparation(preparation).proposedCandidates;
      await runFinalizationPhase(runtime, workflow, review, {
        point: "final_delivery",
        preparation,
        finalChecks,
        changeRound,
        decision: recorded ? finalDeliveryDecision(recorded) : undefined
      });
      return;
    }
    if (request.resume.point === "review_decision") {
      const implementation = implementationResultFromDecisionBindings(checkpoint, request.resume.scopeRevisionCount);
      const codeReview = checkpoint.bindings.codeReview;
      if (!codeReview) throw new Error("Review decision checkpoint is missing code review bindings");
      const decision = recorded ? reviewDecision(recorded) : undefined;
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const review = await runReviewPhase(runtime, workflow, implementation, {
        point: "review_decision",
        finalImplChecks: implementation.finalImplChecks,
        codeReview,
        priorCodeReviews: (checkpoint.bindings.priorCodeReviews ?? []).slice(),
        completedFixes: request.resume.completedFixes,
        allowedReviewFixes: request.resume.allowedReviewFixes,
        scopeRevisionCount: request.resume.scopeRevisionCount,
        decision
      });
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    throw new WorkflowPausedError(request.id, `${request.label} cannot yet be resumed automatically`);
  }
  const exploration = checkpoint.bindings.exploration;
  const plan = checkpoint.bindings.plan;
  if (!exploration || !plan) throw new Error("Plan decision checkpoint is missing planning bindings");
  runtime.requireState().pendingDecision = recorded ? undefined : request;
  const decision = recorded ? planReviewDecision(recorded) : undefined;
  const planning = await continuePlanningDecision(runtime, workflow, exploration, plan, request.resume.reviewIndex, decision);
  await runSelectedRoute(runtime, workflow, planning);
}

function implementationResultFromDecisionBindings(checkpoint: WorkflowCheckpoint, scopeRevisionCount: number): ImplementationResult {
  const { exploration, plan, baselineChecks, tester, implementationChecks, diagnosis } = checkpoint.bindings;
  if (!exploration || !plan || !baselineChecks || !implementationChecks) {
    throw new Error("Review decision checkpoint is missing implementation bindings");
  }
  if (!tester && plan.route !== "quick_implementation") throw new Error("Review decision checkpoint is missing Tester output");
  return {
    exploration: validateExplorerOutput(exploration),
    plan: validatePlannerOutput(plan),
    baseline: validateCheckResults(baselineChecks),
    scopeRevisionCount,
    tester: tester ? validateTesterOutput(tester, plan.acceptanceCriteria) : undefined,
    finalImplChecks: validateCheckResults(implementationChecks),
    diagnosis: diagnosis ? validateDebuggerOutput(diagnosis) : undefined
  };
}

function scopeRevisionDecisionContext(
  value: unknown,
  resume: Extract<PendingHumanDecision["resume"], { point: "scope_revision_decision" }>
): ScopeRevisionDecisionContext {
  const item = objectValue(value, "scope revision decision context");
  const afterValue = objectValue(item.after, "scope revision continuation");
  const mode = stringValue(afterValue.mode, "scope revision continuation mode");
  const planning = mode === "review" ? implementationResult(item.planning) : implementationPlanningResult(item.planning);
  const additions = arrayValue(item.additions, "scope revision additions").map((entry, index) => stringValue(entry, `scope revision additions[${index}]`));
  if (canonicalSha256(additions) !== canonicalSha256(resume.additions)) throw new Error("Scope revision additions do not match the pending decision");
  const scopeRevision = positiveInteger(item.scopeRevision, "scopeRevision");
  const reviewIndex = nonNegativeInteger(item.reviewIndex, "reviewIndex");
  if (scopeRevision !== resume.scopeRevision || reviewIndex !== resume.reviewIndex) throw new Error("Scope revision cursor does not match its decision context");
  const revised = validateFailureScopeRevision(planning.plan, validatePlannerOutput(item.revised), additions);
  const evidenceValue = objectValue(item.evidence, "scope revision evidence");
  const evidence: ScopeRevisionDecisionContext["evidence"] = {
    checks: validateCheckResults(evidenceValue.checks),
    diagnosis: evidenceValue.diagnosis === undefined ? undefined : validateDebuggerOutput(evidenceValue.diagnosis),
    blocker: evidenceValue.blocker === undefined ? undefined : builderBlocker(evidenceValue.blocker)
  };
  let after: ScopeRevisionDecisionContext["after"];
  if (mode === "implementation") {
    const tester = afterValue.tester === undefined ? undefined : validateTesterOutput(afterValue.tester, planning.plan.acceptanceCriteria);
    after = {
      mode,
      tester,
      checksAfterTests: validateCheckResults(afterValue.checksAfterTests),
      previousChecks: afterValue.previousChecks === undefined ? undefined : validateCheckResults(afterValue.previousChecks),
      diagnosis: afterValue.diagnosis === undefined ? undefined : validateDebuggerOutput(afterValue.diagnosis),
      attempt: positiveInteger(afterValue.attempt, "attempt"),
      scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (mode === "review") {
    after = {
      mode,
      finalImplChecks: validateCheckResults(afterValue.finalImplChecks),
      codeReview: validateReviewOutput(afterValue.codeReview),
      priorCodeReviews: arrayValue(afterValue.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`)),
      pendingFix: positiveInteger(afterValue.pendingFix, "pendingFix"),
      allowedReviewFixes: nonNegativeInteger(afterValue.allowedReviewFixes, "allowedReviewFixes"),
      scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount"),
      failureChecks: afterValue.failureChecks === undefined ? undefined : validateCheckResults(afterValue.failureChecks),
      failureDiagnosis: afterValue.failureDiagnosis === undefined ? undefined : validateDebuggerOutput(afterValue.failureDiagnosis)
    };
  } else if (mode === "bug_diagnosed") {
    after = {
      mode,
      diagnosis: validateDebuggerOutput(afterValue.diagnosis),
      scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else {
    throw new Error("Scope revision continuation mode is invalid");
  }
  return { planning, revised, additions, evidence, scopeRevision, reviewIndex, after };
}

function builderBlocker(value: unknown): NonNullable<import("../types.js").BuilderBlocker> {
  const item = objectValue(value, "Builder blocker");
  const kind = stringValue(item.kind, "Builder blocker kind");
  if (kind !== "scope" && kind !== "environment" && kind !== "tooling" && kind !== "insufficient_evidence") throw new Error("Builder blocker kind is invalid");
  return {
    kind,
    reason: stringValue(item.reason, "Builder blocker reason"),
    requiredFiles: arrayValue(item.requiredFiles, "Builder blocker requiredFiles").map((entry, index) => stringValue(entry, `Builder blocker requiredFiles[${index}]`))
  };
}

function reviewDecision(recorded: RecordedHumanDecision): { action: "accept" | "fix_again" } {
  if (recorded.action === "accept_current") return { action: "accept" };
  if (recorded.action === "fix_again") return { action: "fix_again" };
  throw new Error(`Recorded ${recorded.action} action is invalid for a review decision`);
}

function mutationConfirmation(recorded: RecordedHumanDecision): boolean {
  if (recorded.action === "proceed") return true;
  throw new Error(`Recorded ${recorded.action} action is invalid for mutation confirmation`);
}

function repairBudgetDecision(recorded: RecordedHumanDecision): void {
  if (recorded.action !== "fix_again") throw new Error(`Recorded ${recorded.action} action is invalid for a repair budget decision`);
}

function finalDeliveryDecision(recorded: RecordedHumanDecision): { action: "finish" | "request_changes"; feedback?: string } {
  if (recorded.action === "finish") return { action: "finish" };
  if (recorded.action === "request_changes") return { action: "request_changes", feedback: recorded.feedback };
  throw new Error(`Recorded ${recorded.action} action is invalid for final delivery`);
}

function planReviewDecision(recorded: RecordedHumanDecision): { approved: boolean; feedback?: string } {
  if (recorded.action === "approve") return { approved: true };
  if (recorded.action === "revise") return { approved: false, feedback: recorded.feedback };
  throw new Error(`Recorded ${recorded.action} action is invalid for a plan decision`);
}

function humanDecisionContinuation(
  value: unknown,
  requireRecorded: boolean
): { request: PendingHumanDecision; recorded?: RecordedHumanDecision } {
  const item = objectValue(value, "human decision checkpoint");
  const request = pendingHumanDecision(item.request);
  const recorded = item.recorded === undefined ? undefined : recordedHumanDecision(item.recorded, request.id);
  if (requireRecorded && !recorded) throw new Error("Recorded human decision checkpoint is missing its decision");
  if (!requireRecorded && recorded) throw new Error("Pending human decision checkpoint cannot contain a recorded decision");
  return { request, recorded };
}

function pendingHumanDecision(value: unknown): PendingHumanDecision {
  const item = objectValue(value, "pending human decision");
  if (item.schemaVersion !== 1) throw new Error("Pending human decision schemaVersion must be 1");
  const kind = stringValue(item.kind, "pending human decision kind") as PendingHumanDecision["kind"];
  if (!["plan_approval", "plan_revision_approval", "baseline_repair_approval", "mutation_confirmation", "scope_expansion", "code_review_rejection", "repair_budget_exhausted", "final_delivery"].includes(kind)) {
    throw new Error("Pending human decision kind is invalid");
  }
  const resumeValue = objectValue(item.resume, "pending human decision resume point");
  const point = stringValue(resumeValue.point, "pending human decision resume point");
  let resume: PendingHumanDecision["resume"];
  if (point === "plan_decision") {
    resume = { point, reviewIndex: nonNegativeInteger(resumeValue.reviewIndex, "reviewIndex") };
  } else if (point === "review_decision") {
    resume = {
      point,
      completedFixes: nonNegativeInteger(resumeValue.completedFixes, "completedFixes"),
      allowedReviewFixes: nonNegativeInteger(resumeValue.allowedReviewFixes, "allowedReviewFixes"),
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (point === "mutation_confirmation") {
    const mode = stringValue(resumeValue.mode, "mutation confirmation mode");
    if (mode !== "prepared" && mode !== "baseline_repair" && mode !== "bug_diagnosed") {
      throw new Error("Mutation confirmation mode is invalid");
    }
    resume = {
      point,
      mode,
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (point === "scope_revision_decision") {
    resume = {
      point,
      additions: arrayValue(resumeValue.additions, "additions").map((entry, index) => stringValue(entry, `additions[${index}]`)),
      scopeRevision: positiveInteger(resumeValue.scopeRevision, "scopeRevision"),
      reviewIndex: nonNegativeInteger(resumeValue.reviewIndex, "reviewIndex")
    };
  } else if (point === "budget_exhausted") {
    const phase = stringValue(resumeValue.phase, "repair budget phase");
    if (phase !== "implementation") throw new Error("Repair budget phase is invalid");
    resume = {
      point,
      phase,
      nextAttempt: positiveInteger(resumeValue.nextAttempt, "nextAttempt"),
      allowedAttempts: positiveInteger(resumeValue.allowedAttempts, "allowedAttempts"),
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (point === "final_delivery") {
    const mode = stringValue(resumeValue.mode, "final delivery mode");
    if (mode !== "review" && mode !== "specialized") throw new Error("Final delivery mode is invalid");
    resume = { point, mode, changeRound: nonNegativeInteger(resumeValue.changeRound, "changeRound") };
  } else if (point === "baseline_repair_decision") {
    resume = { point } as PendingHumanDecision["resume"];
  } else {
    throw new Error("Pending human decision resume point is invalid");
  }
  const requestedAt = stringValue(item.requestedAt, "pending human decision requestedAt");
  if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("Pending human decision requestedAt is invalid");
  return {
    schemaVersion: 1,
    id: stringValue(item.id, "pending human decision id"),
    kind,
    label: stringValue(item.label, "pending human decision label"),
    requestedAt,
    resume
  };
}

function recordedHumanDecision(value: unknown, requestId: string): RecordedHumanDecision {
  const item = objectValue(value, "recorded human decision");
  if (item.schemaVersion !== 1) throw new Error("Recorded human decision schemaVersion must be 1");
  if (stringValue(item.requestId, "recorded human decision requestId") !== requestId) throw new Error("Recorded human decision requestId does not match");
  const action = stringValue(item.action, "recorded human decision action") as HumanDecisionAction;
  if (!["approve", "revise", "cancel", "proceed", "accept_current", "fix_again", "finish", "request_changes", "defer"].includes(action)) {
    throw new Error("Recorded human decision action is invalid");
  }
  const decidedAt = stringValue(item.decidedAt, "recorded human decision decidedAt");
  if (!Number.isFinite(Date.parse(decidedAt))) throw new Error("Recorded human decision decidedAt is invalid");
  const source = item.source;
  if (source !== "tui" && source !== "rpc") throw new Error("Recorded human decision source is invalid");
  return {
    schemaVersion: 1,
    requestId,
    decidedAt,
    source,
    action,
    feedback: item.feedback === undefined ? undefined : stringValue(item.feedback, "recorded human decision feedback")
  };
}

function planningResult(value: unknown): PlanningResult {
  const item = objectValue(value, "planning continuation");
  return { exploration: validateExplorerOutput(item.exploration), plan: validatePlannerOutput(item.plan) };
}

function implementationPlanningResult(value: unknown): ImplementationPlanningResult {
  const planning = planningResult(value);
  const item = objectValue(value, "implementation planning");
  return {
    ...planning,
    baseline: validateCheckResults(item.baseline),
    scopeRevisionCount: nonNegativeInteger(item.scopeRevisionCount, "scopeRevisionCount"),
    ...(item.baselineDiagnosis === undefined ? {} : { baselineDiagnosis: validateDebuggerOutput(item.baselineDiagnosis) })
  };
}

function implementationResult(value: unknown): ImplementationResult {
  const item = objectValue(value, "implementation continuation");
  const planning = implementationPlanningResult(item);
  let tester: ImplementationResult["tester"];
  if (item.tester === undefined) {
    if (planning.plan.route !== "quick_implementation") throw new Error("Implementation checkpoint is missing Tester output");
  } else {
    tester = validateTesterOutput(item.tester, planning.plan.acceptanceCriteria);
  }
  return {
    ...planning,
    tester,
    finalImplChecks: validateCheckResults(item.finalImplChecks),
    diagnosis: item.diagnosis === undefined ? undefined : validateDebuggerOutput(item.diagnosis)
  };
}

function reviewResult(value: unknown): ReviewResult {
  const item = objectValue(value, "review continuation");
  const codeReview = validateReviewOutput(item.codeReview);
  const reviewApprovalSource = approvalSource(item.reviewApprovalSource);
  if (reviewApprovalSource === "reviewer" && codeReview.decision !== "approved") {
    throw new Error("Reviewer approval checkpoint must contain an approved review");
  }
  return {
    ...implementationResult(item),
    codeReview,
    reviewApprovalSource,
    priorCodeReviews: arrayValue(item.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`))
  };
}

function readOnlyReviewResult(value: unknown): ReadOnlyReviewResult {
  const item = objectValue(value, "repository review continuation");
  return { ...planningResult(item), codeReview: validateReviewOutput(item.codeReview) };
}

function specializedMutationResult(value: unknown): SpecializedMutationResult {
  const item = objectValue(value, "specialized mutation continuation");
  const planning = implementationPlanningResult(item);
  if (planning.plan.route === "tests_only") {
    const tester = validateTesterOutput(item.tester, planning.plan.acceptanceCriteria);
    assertTesterComplete(tester, "tests_only");
    return { ...planning, route: "tests_only", tester };
  }
  if (planning.plan.route === "documentation_only") {
    const documentation = validateDocumenterOutput(item.documentation);
    assertDocumenterComplete(documentation);
    return { ...planning, route: "documentation_only", documentation };
  }
  throw new Error("Specialized mutation checkpoint has an invalid route");
}

function serializedLessonPreparation(value: unknown): SerializedLessonPreparation {
  const item = objectValue(value, "lesson preparation");
  const documentation = validateDocumenterOutput(item.documentation);
  const proposedCandidates = validateCandidates(item.proposedCandidates);
  const duplicateCandidateIds = arrayValue(item.duplicateCandidateIds, "duplicateCandidateIds").map((entry, index) => stringValue(entry, `duplicateCandidateIds[${index}]`));
  const candidateIds = new Set(proposedCandidates.map(candidate => candidate.id));
  if (new Set(duplicateCandidateIds).size !== duplicateCandidateIds.length || duplicateCandidateIds.some(id => !candidateIds.has(id))) {
    throw new Error("duplicateCandidateIds must be unique candidate IDs");
  }
  const duplicateCount = nonNegativeInteger(item.duplicateCount, "duplicateCount");
  if (duplicateCount !== duplicateCandidateIds.length) throw new Error("duplicateCount does not match duplicateCandidateIds");
  const machineEligibleCount = nonNegativeInteger(item.machineEligibleCount, "machineEligibleCount");
  const machineRejectedCount = nonNegativeInteger(item.machineRejectedCount, "machineRejectedCount");
  if (machineEligibleCount + machineRejectedCount + duplicateCount > proposedCandidates.length) {
    throw new Error("lesson preparation counts exceed proposed candidates");
  }
  return {
    documentation,
    proposedCandidates,
    duplicateCandidateIds,
    machineEligibleCount,
    machineRejectedCount,
    duplicateCount
  };
}

function resetStateForResume(state: WorkflowState, checkpoint: WorkflowCheckpoint): void {
  const interruptedAt = new Date().toISOString();
  for (const step of state.steps) {
    if (step.status === "running") {
      step.status = "cancelled";
      step.completedAt = interruptedAt;
      step.message = "Interrupted before workflow resume";
    }
  }
  for (const agent of Object.values(state.agents)) {
    if (agent.status === "running") {
      agent.status = "cancelled";
      agent.completedAt = interruptedAt;
      agent.error = "Interrupted before workflow resume";
    }
  }
  state.activeAgent = undefined;
  state.failedStage = undefined;
  state.stoppedStage = undefined;
  state.termination = undefined;
  state.completedAt = undefined;
  state.currentTool = undefined;
  state.currentToolArgs = undefined;
  state.agentOutput = undefined;
  state.toolStatus = undefined;
  state.resumeCount = (state.resumeCount ?? 0) + 1;
  state.resumedAt = interruptedAt;
  state.resumedFromCheckpoint = checkpoint.cursor.kind;
  state.resumeBlockedReason = undefined;
  state.latestCheckpoint = { number: checkpoint.checkpointNumber, cursor: checkpoint.cursor.kind, createdAt: checkpoint.createdAt };
  if (checkpoint.cursor.kind === "human_decision_pending") {
    state.status = "paused";
    state.stage = checkpoint.state.stage;
    return;
  }
  if (checkpoint.cursor.kind === "human_decision_recorded") {
    state.status = "running";
    state.waitingFor = undefined;
    state.humanGate = undefined;
    state.pendingDecision = undefined;
    // The decision was already acted on; continue past this checkpoint.
    return;
  }
  state.status = "running";
  state.stage = checkpoint.state.stage;
  state.waitingFor = undefined;
  state.humanGate = undefined;
  state.pendingDecision = undefined;
}

async function readFinalizationMarker(
  directory: string,
  name: "finalization-intent.json" | "finalization-complete.json",
  checkpoint: WorkflowCheckpoint
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readSafeArtifact(directory, name, 64 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  let marker: Record<string, unknown>;
  try {
    marker = objectValue(JSON.parse(text) as unknown, name);
  } catch (error) {
    throw new Error(`Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (marker.runId !== checkpoint.runId) throw new Error(`Invalid ${name}: runId does not match`);
  const savedCheckpoint = objectValue(marker.checkpoint, `${name}.checkpoint`);
  if (savedCheckpoint.number !== checkpoint.checkpointNumber || savedCheckpoint.cursor !== checkpoint.cursor.kind) {
    throw new Error(`Invalid ${name}: checkpoint does not match`);
  }
  if (typeof marker.finalChecksDigest !== "string" || !/^[a-f0-9]{64}$/.test(marker.finalChecksDigest)) {
    throw new Error(`Invalid ${name}: finalChecksDigest is invalid`);
  }
  if (checkpoint.cursor.kind === "final_checks_passed" || checkpoint.cursor.kind === "route_final_checks_passed") {
    const continuation = objectValue(checkpoint.cursor.continuation, "final-check checkpoint");
    const checks = validateCheckResultsAgainstCommands(continuation.finalChecks, checkpoint.config.checks, "finalChecks");
    if (computeFinalChecksDigest(checks) !== marker.finalChecksDigest) throw new Error(`Invalid ${name}: final checks digest does not match`);
  }
  return marker;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

function approvalSource(value: unknown): ReviewApprovalSource {
  if (value !== "reviewer" && value !== "user_override") throw new Error("reviewApprovalSource is invalid");
  return value;
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}
