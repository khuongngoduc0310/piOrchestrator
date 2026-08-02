import { realpath } from "node:fs/promises";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  CheckpointStore,
  readSafeArtifact,
} from "../persistence/checkpoint-store.js";
import {
  validateCheckResults,
  validateCheckResultsAgainstCommands,
  validateWorkflowStateForResume,
} from "../persistence/checkpoint-validation.js";
import type {
  CheckpointCursorKind,
  WorkflowCheckpoint,
} from "../persistence/checkpoint-types.js";
import { loadConfig } from "../config/config.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { fail, persist } from "./orchestrator-state.js";
import { WorkflowPausedError } from "./workflow-errors.js";
import { requiredAgentsForResume } from "./route-preflight.js";
import {
  requiresHumanDecision,
  resolveParticipationPolicy,
} from "./participation-policy.js";
import { automatedCriteria } from "./acceptance-criteria.js";
import { RunStore, type RunLease } from "../persistence/store.js";
import type { WorkflowState } from "../types.js";
import {
  validateBuilderOutput,
  validateDebuggerOutput,
  validateExplorerOutput,
  validatePlannerOutput,
  validateReviewOutput,
  validateTesterOutput,
} from "../validation.js";
import { attachWorktree, removeWorktree } from "../workspace/worktree.js";
import { canonicalSha256 } from "../workspace/workspace-guard.js";
import { currentWorkspaceDigest } from "./orchestrator-checkpoints.js";
import { EXTENSION_VERSION } from "./orchestrator-helpers.js";
import { computeFinalChecksDigest } from "../memory/memory-validation.js";
import {
  humanDecisionContinuation,
  humanDecisionContinuations,
} from "./resume-continuations/human-decisions.js";
import { planningContinuations } from "./resume-continuations/planning.js";
import { implementationContinuations } from "./resume-continuations/implementation.js";
import { finalizationContinuations } from "./resume-continuations/finalization.js";
import { readOnlyContinuations } from "./resume-continuations/read-only.js";
import { specializedContinuations } from "./resume-continuations/specialized.js";
import { resolutionContinuations } from "./resume-continuations/resolution.js";
import {
  MAX_STATE_BYTES,
  objectValue,
  type ContinuationModule,
} from "./resume-continuations/shared.js";
export async function resumeWorkflow(
  runtime: OrchestratorRuntime,
  runId: string,
  ctx: ExtensionCommandContext,
  controller: AbortController,
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const store = await RunStore.open(cwd, runId);
  let lease: RunLease | undefined;
  try {
    lease = await store.acquireLease({ recoverStale: true });
    const checkpoint = await new CheckpointStore(
      store.runDir,
      runId,
    ).loadLatest();
    if (!checkpoint)
      throw new Error(`Run ${runId} has no resumable checkpoint`);
    const currentState = validateWorkflowStateForResume(
      JSON.parse(
        await readSafeArtifact(store.runDir, "state.json", MAX_STATE_BYTES),
      ),
    );
    runtime.controller = controller;
    runtime.store = store;
    runtime.state = currentState;
    runtime.config = checkpoint.config;
    try {
      await validateResumeBindings(
        runtime,
        cwd,
        store,
        checkpoint,
        currentState,
        ctx,
      );
    } catch (error) {
      if (isPermanentResumeFailure(error)) {
        currentState.resumeBlockedReason = error.message;
        await store
          .saveJson("resume-precondition-error.json", {
            checkpointNumber: checkpoint.checkpointNumber,
            cursor: checkpoint.cursor.kind,
            error: error.message,
            blockedAt: runtime.timestamp(),
          })
          .catch(() => undefined);
        await store
          .event("resume_blocked", {
            checkpointNumber: checkpoint.checkpointNumber,
            error: error.message,
          })
          .catch(() => undefined);
        await persist(runtime, ctx).catch(() => undefined);
      }
      throw error;
    }
    const pendingDiagnosisDecision =
      checkpoint.cursor.kind === "human_decision_pending" &&
      humanDecisionContinuation(checkpoint.cursor.continuation, false).request
        .kind === "bug_diagnosis_approval";
    const diagnosisReadyDecision =
      checkpoint.cursor.kind === "bug_diagnosis_ready" &&
      requiresHumanDecision(
        resolveParticipationPolicy(checkpoint.config),
        "diagnosis_approval",
        {
          confidence: validateDebuggerOutput(
            objectValue(
              checkpoint.cursor.continuation,
              "bug diagnosis-ready checkpoint",
            ).diagnosis,
          ).confidence,
        },
      );
    const requiredAgents =
      pendingDiagnosisDecision || diagnosisReadyDecision
        ? []
        : requiredAgentsForResume(
            checkpoint.state.route!,
            checkpoint.config,
            checkpoint.cursor.kind,
          );
    if (requiredAgents.length > 0) {
      await runtime.agents.preflight(
        checkpoint.config,
        cwd,
        runtime.extensionRoot,
        controller.signal,
        checkpoint.config.limits.agentTimeoutMs,
        requiredAgents,
      );
    }
    runtime.baselineContext = checkpoint.baselineContext;
    runtime.baselineReviewContext = checkpoint.baselineReviewContext;
    runtime.baselineRepaired = checkpoint.baselineRepaired;
    runtime.lessonStatus = checkpoint.lessonStatus;
    runtime.builderSessionOutputs = (
      checkpoint.bindings.builderOutputs ?? []
    ).map((value, index) =>
      validateBuilderOutput(
        value,
        `checkpoint.bindings.builderOutputs[${index}]`,
      ),
    );
    runtime.validatedChangedFiles = new Set(checkpoint.validatedChangedFiles);
    runtime.validatedFileAttestations = new Map(
      checkpoint.validatedFileAttestations.map((attestation) => [
        attestation.path,
        attestation,
      ]),
    );
    runtime.selectedMemoryIds = new Set(checkpoint.selectedMemoryIds);
    runtime.explorerRelevantFiles =
      checkpoint.bindings.exploration?.relevantFiles.slice() ?? [];
    runtime.finalizationStarted = false;
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
      mutationConfirmed: checkpoint.mutationConfirmed,
    };
    if (checkpoint.worktreeHandle) {
      workflow.worktreeHandle = await attachWorktree(
        checkpoint.worktreeHandle,
        {
          expectedWorkspaceSnapshotDigest: checkpoint.workspaceDigest,
          workspaceSnapshotDigest: (root) =>
            currentWorkspaceDigest(runtime, root),
        },
      );
      workflow.mutationCwd = workflow.worktreeHandle.effectiveCwd;
    }
    resetStateForResume(currentState, checkpoint);
    await runtime.startWorkflowDashboard();
    await store.event("resumed", {
      checkpointNumber: checkpoint.checkpointNumber,
      cursor: checkpoint.cursor.kind,
    });
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
      if (
        workflow.worktreeHandle &&
        !workflow.worktreeSynced &&
        !workflow.retainWorktree
      ) {
        try {
          const latest = await new CheckpointStore(
            store.runDir,
            runId,
          ).loadLatest();
          workflow.retainWorktree =
            !!latest &&
            latest.workspaceDigest ===
              (await currentWorkspaceDigest(
                runtime,
                workflow.worktreeHandle.effectiveCwd,
              ));
        } catch {
          workflow.retainWorktree = false;
        }
      }
      if (
        workflow.worktreeHandle &&
        !workflow.worktreeSynced &&
        !workflow.retainWorktree
      ) {
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
    "checkpoint",
  ].some((fragment) => error.message.includes(fragment));
}
async function validateResumeBindings(
  runtime: OrchestratorRuntime,
  cwd: string,
  store: RunStore,
  checkpoint: WorkflowCheckpoint,
  state: WorkflowState,
  ctx: ExtensionCommandContext,
): Promise<void> {
  if (state.status === "completed")
    throw new Error("Completed workflows cannot be resumed");
  if (state.runId !== checkpoint.runId || state.runId !== store.runId)
    throw new Error("Run identity does not match its checkpoint");
  if (!state.route || checkpoint.state.route !== state.route)
    throw new Error("Workflow route does not match its checkpoint");
  if (
    state.extensionVersion !== EXTENSION_VERSION ||
    checkpoint.state.extensionVersion !== EXTENSION_VERSION
  ) {
    throw new Error(
      `Run ${state.runId} was created by extension ${state.extensionVersion}; current version is ${EXTENSION_VERSION}`,
    );
  }
  if (!samePath(await realpath(cwd), await realpath(state.cwd)))
    throw new Error("Run belongs to a different project path");
  if (!samePath(await realpath(store.runDir), await realpath(state.runDir)))
    throw new Error("Run directory does not match persisted state");
  const currentConfig = await loadConfig(cwd);
  if (
    canonicalSha256(currentConfig) !== checkpoint.configDigest ||
    canonicalSha256(checkpoint.config) !== checkpoint.configDigest
  ) {
    throw new Error("Orchestrator configuration changed since the checkpoint");
  }
  await runtime.loadProjectMemory(cwd, ctx);
  if (
    runtime.memoryMode !== checkpoint.memoryMode ||
    runtime.memoryRevision !== checkpoint.memoryRevision
  ) {
    throw new Error("Project memory changed since the checkpoint");
  }
  if (canonicalSha256(runtime.loadedMemoryDoc) !== checkpoint.memoryDigest)
    throw new Error("Project memory content changed since the checkpoint");
  if (runtime.loadedMemoryDoc) {
    const ids = new Set(
      runtime.loadedMemoryDoc.lessons.map((lesson) => lesson.id),
    );
    const missing = checkpoint.selectedMemoryIds.filter((id) => !ids.has(id));
    if (missing.length)
      throw new Error(
        `Checkpoint memory lessons are missing: ${missing.join(", ")}`,
      );
  }
  const finalizationComplete = await readFinalizationMarker(
    store.runDir,
    "finalization-complete.json",
    checkpoint,
  );
  if (finalizationComplete)
    throw new Error(
      "Finalization already completed; automatic replay is disabled",
    );
  if (
    await readFinalizationMarker(
      store.runDir,
      "finalization-intent.json",
      checkpoint,
    )
  ) {
    throw new Error(
      "Finalization outcome is uncertain; automatic resume is disabled",
    );
  }
  if (checkpoint.worktreeHandle) {
    if (
      !samePath(
        await realpath(checkpoint.worktreeHandle.sourceCwd),
        await realpath(cwd),
      )
    ) {
      throw new Error("Checkpoint worktree belongs to a different project");
    }
    if (
      !samePath(
        await realpath(checkpoint.workspaceRoot),
        await realpath(checkpoint.worktreeHandle.effectiveCwd),
      )
    ) {
      throw new Error("Checkpoint workspace root does not match its worktree");
    }
  }
  if (!checkpoint.worktreeHandle) {
    if (
      !samePath(await realpath(checkpoint.workspaceRoot), await realpath(cwd))
    )
      throw new Error("Checkpoint workspace root does not match the project");
    runtime.store = store;
    if (
      (await currentWorkspaceDigest(runtime, cwd)) !==
      checkpoint.workspaceDigest
    ) {
      throw new Error("Workspace differs from the latest safe checkpoint");
    }
  }
  validateBindings(checkpoint);
  validateContinuation(checkpoint);
}
function validateBindings(checkpoint: WorkflowCheckpoint): void {
  const bindings = checkpoint.bindings;
  if (!bindings.exploration || !bindings.plan)
    throw new Error("Checkpoint is missing approved planning bindings");
  if (bindings.exploration)
    validateExplorerOutput(
      bindings.exploration,
      "checkpoint.bindings.exploration",
    );
  if (bindings.plan)
    validatePlannerOutput(bindings.plan, "checkpoint.bindings.plan");
  if (bindings.proposedPlan)
    validatePlannerOutput(
      bindings.proposedPlan,
      "checkpoint.bindings.proposedPlan",
    );
  if (bindings.plan && bindings.plan.route !== checkpoint.state.route)
    throw new Error("Checkpoint plan route does not match workflow route");
  if (bindings.baselineChecks)
    validateCheckResults(
      bindings.baselineChecks,
      "checkpoint.bindings.baselineChecks",
    );
  if (bindings.tester) {
    if (!bindings.plan) throw new Error("Checkpoint Tester output has no plan");
    validateTesterOutput(
      bindings.tester,
      automatedCriteria(bindings.plan),
      "checkpoint.bindings.tester",
    );
  }
  bindings.builderOutputs?.forEach((value, index) =>
    validateBuilderOutput(
      value,
      `checkpoint.bindings.builderOutputs[${index}]`,
    ),
  );
  if (bindings.implementationChecks)
    validateCheckResults(
      bindings.implementationChecks,
      "checkpoint.bindings.implementationChecks",
    );
  if (bindings.diagnosis)
    validateDebuggerOutput(bindings.diagnosis, "checkpoint.bindings.diagnosis");
  if (bindings.codeReview)
    validateReviewOutput(bindings.codeReview, "checkpoint.bindings.codeReview");
  bindings.priorCodeReviews?.forEach((value, index) =>
    validateReviewOutput(
      value,
      `checkpoint.bindings.priorCodeReviews[${index}]`,
    ),
  );
}
/** * Every checkpoint cursor kind's resume behavior. The `Record` annotation * fails the build when a new cursor kind lacks a continuation handler. */
const CONTINUATIONS: Record<CheckpointCursorKind, ContinuationModule> = {
  ...planningContinuations,
  ...implementationContinuations,
  ...finalizationContinuations,
  ...readOnlyContinuations,
  ...specializedContinuations,
  ...resolutionContinuations,
  ...humanDecisionContinuations,
};
function validateContinuation(checkpoint: WorkflowCheckpoint): void {
  CONTINUATIONS[checkpoint.cursor.kind].validate(
    checkpoint.cursor.continuation,
    checkpoint,
  );
}
async function continueFromCheckpoint(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  checkpoint: WorkflowCheckpoint,
): Promise<void> {
  await CONTINUATIONS[checkpoint.cursor.kind].continue(
    runtime,
    workflow,
    checkpoint,
  );
}
function resetStateForResume(
  state: WorkflowState,
  checkpoint: WorkflowCheckpoint,
): void {
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
  state.latestCheckpoint = {
    number: checkpoint.checkpointNumber,
    cursor: checkpoint.cursor.kind,
    createdAt: checkpoint.createdAt,
  };
  if (checkpoint.cursor.kind === "human_decision_pending") {
    state.status = "paused";
    state.stage = checkpoint.state.stage;
    return;
  }
  if (checkpoint.cursor.kind === "human_decision_recorded") {
    state.status = "running";
    state.waitingFor = undefined;
    state.humanGate = undefined;
    state.pendingDecision = undefined; // The decision was already acted on; continue past this checkpoint.
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
  checkpoint: WorkflowCheckpoint,
): Promise<Record<string, unknown> | undefined> {
  let text: string;
  try {
    text = await readSafeArtifact(directory, name, 64 * 1024);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let marker: Record<string, unknown>;
  try {
    marker = objectValue(JSON.parse(text) as unknown, name);
  } catch (error) {
    throw new Error(
      `Invalid ${name}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (marker.runId !== checkpoint.runId)
    throw new Error(`Invalid ${name}: runId does not match`);
  const savedCheckpoint = objectValue(marker.checkpoint, `${name}.checkpoint`);
  if (
    savedCheckpoint.number !== checkpoint.checkpointNumber ||
    savedCheckpoint.cursor !== checkpoint.cursor.kind
  ) {
    throw new Error(`Invalid ${name}: checkpoint does not match`);
  }
  if (
    typeof marker.finalChecksDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(marker.finalChecksDigest as string)
  ) {
    throw new Error(`Invalid ${name}: finalChecksDigest is invalid`);
  }
  if (
    checkpoint.cursor.kind === "final_checks_passed" ||
    checkpoint.cursor.kind === "route_final_checks_passed"
  ) {
    const continuation = objectValue(
      checkpoint.cursor.continuation,
      "final-check checkpoint",
    );
    const checks = validateCheckResultsAgainstCommands(
      continuation.finalChecks,
      checkpoint.config.checks,
      "finalChecks",
    );
    if (computeFinalChecksDigest(checks) !== marker.finalChecksDigest)
      throw new Error(`Invalid ${name}: final checks digest does not match`);
  }
  return marker;
}
function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}
