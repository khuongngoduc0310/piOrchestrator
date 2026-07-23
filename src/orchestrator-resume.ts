import { realpath } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CheckpointStore, readSafeArtifact } from "./checkpoint-store.js";
import { validateCheckResults, validateCheckResultsAgainstCommands, validateWorkflowStateForResume } from "./checkpoint-validation.js";
import type { WorkflowCheckpoint } from "./checkpoint-types.js";
import { loadConfig } from "./config.js";
import type { ImplementationPlanningResult, ImplementationResult, PlanningResult, ReadOnlyReviewResult, ReviewResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import { runFinalizationPhase, runReadOnlyFinalizationPhase, type FinalizationContinuation } from "./orchestrator-finalization.js";
import { runImplementationPhase, type ImplementationContinuation } from "./orchestrator-implementation.js";
import { hydrateLessonPreparation, type SerializedLessonPreparation } from "./orchestrator-lessons.js";
import { prepareImplementationPhase } from "./orchestrator-planning.js";
import { runReadOnlyReviewPhase } from "./orchestrator-read-only-review.js";
import { runReviewPhase, type ReviewContinuation } from "./orchestrator-review.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { fail, persist } from "./orchestrator-state.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { runSelectedRoute } from "./orchestrator-routes.js";
import { runSpecializedMutationRoute } from "./orchestrator-specialized-routes.js";
import { RunStore, type RunLease } from "./store.js";
import type { BuilderOutput, DocumenterOutput, ReviewApprovalSource, ReviewOutput, WorkflowState } from "./types.js";
import {
  validateBuilderOutput,
  validateDebuggerOutput,
  validateDocumenterOutput,
  validateExplorerOutput,
  validatePlannerOutput,
  validateReviewOutput,
  validateTesterOutput
} from "./validation.js";
import { attachWorktree, removeWorktree } from "./worktree.js";
import { canonicalSha256 } from "./workspace-guard.js";
import { currentWorkspaceDigest, saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { EXTENSION_VERSION } from "./orchestrator-helpers.js";
import { allGreen } from "./orchestrator-helpers.js";
import { computeFinalChecksDigest, validateCandidates } from "./memory-validation.js";

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
    await validateResumeBindings(runtime, cwd, store, checkpoint, currentState, ctx);

    runtime.controller = controller;
    runtime.store = store;
    runtime.state = currentState;
    runtime.config = checkpoint.config;
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
      mutationConfirmed: checkpoint.cursor.kind !== "plan_approved"
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
      await fail(runtime, error, ctx);
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
      validateTesterOutput(item.tester, planning.plan.acceptanceCriteria);
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
        validateBuilderOutput(item.repairOutput);
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
      return;
    }
    case "review_approved": reviewResult(value); return;
    case "documenter_completed": {
      const item = objectValue(value, "documenter checkpoint");
      reviewResult(item.review);
      validateDocumenterOutput(item.documentation);
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
  }
}

function validateBindings(checkpoint: WorkflowCheckpoint): void {
  const bindings = checkpoint.bindings;
  if (!bindings.exploration || !bindings.plan) throw new Error("Checkpoint is missing approved planning bindings");
  if (bindings.exploration) validateExplorerOutput(bindings.exploration, "checkpoint.bindings.exploration");
  if (bindings.plan) validatePlannerOutput(bindings.plan, "checkpoint.bindings.plan");
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
        const prepared = { ...planning, baseline };
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
        completedAttempt: positiveInteger(value.completedAttempt, "completedAttempt")
      };
      const implementation = await runImplementationPhase(runtime, workflow, planning, implementationContinuation, {
        skipTester: workflow.route === "quick_implementation"
      });
      const review = await runReviewPhase(runtime, workflow, implementation);
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
        allowedReviewFixes: nonNegativeInteger(value.allowedReviewFixes, "allowedReviewFixes")
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

function planningResult(value: unknown): PlanningResult {
  const item = objectValue(value, "planning continuation");
  return { exploration: validateExplorerOutput(item.exploration), plan: validatePlannerOutput(item.plan) };
}

function implementationPlanningResult(value: unknown): ImplementationPlanningResult {
  const planning = planningResult(value);
  return { ...planning, baseline: validateCheckResults(objectValue(value, "implementation planning").baseline) };
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
    return { ...planning, route: "tests_only", tester: validateTesterOutput(item.tester, planning.plan.acceptanceCriteria) };
  }
  if (planning.plan.route === "documentation_only") {
    return { ...planning, route: "documentation_only", documentation: validateDocumenterOutput(item.documentation) };
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
  state.status = "running";
  state.stage = checkpoint.state.stage;
  state.activeAgent = undefined;
  state.failedStage = undefined;
  state.stoppedStage = undefined;
  state.termination = undefined;
  state.completedAt = undefined;
  state.waitingFor = undefined;
  state.humanGate = undefined;
  state.currentTool = undefined;
  state.currentToolArgs = undefined;
  state.agentOutput = undefined;
  state.toolStatus = undefined;
  state.resumeCount = (state.resumeCount ?? 0) + 1;
  state.resumedAt = interruptedAt;
  state.resumedFromCheckpoint = checkpoint.cursor.kind;
  state.resumeBlockedReason = undefined;
  state.latestCheckpoint = { number: checkpoint.checkpointNumber, cursor: checkpoint.cursor.kind, createdAt: checkpoint.createdAt };
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
