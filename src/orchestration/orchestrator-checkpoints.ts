import { CheckpointStore } from "../persistence/checkpoint-store.js";
import type { CheckpointBindings, CheckpointCursorKind, WorkflowCheckpoint } from "../persistence/checkpoint-types.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { persist } from "./orchestrator-state.js";
import { createWorkspaceSnapshot, canonicalSha256, workspaceSnapshotDigest, type WorkspaceSnapshot } from "../workspace/workspace-guard.js";
import { workspaceExclusions } from "./orchestrator-workspace.js";

export async function saveWorkflowCheckpoint(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  kind: CheckpointCursorKind,
  continuation: unknown,
  bindings: CheckpointBindings
): Promise<WorkflowCheckpoint> {
  await workflow.store.flush();
  const workspaceRoot = workflow.worktreeHandle?.effectiveCwd ?? workflow.cwd;
  const snapshot = await createWorkspaceSnapshot(workspaceRoot, {
    excludedRoots: workspaceExclusions(runtime, workspaceRoot)
  });
  const store = new CheckpointStore(workflow.store.runDir, workflow.runId);
  const checkpoint = await store.save({
    runId: workflow.runId,
    createdAt: runtime.timestamp(),
    workspaceDigest: workspaceSnapshotDigest(snapshot),
    workspaceRoot,
    config: structuredClone(workflow.config),
    configDigest: canonicalSha256(workflow.config),
    memoryMode: runtime.memoryMode,
    memoryRevision: runtime.memoryRevision,
    memoryDigest: canonicalSha256(runtime.loadedMemoryDoc),
    selectedMemoryIds: [...runtime.selectedMemoryIds].sort(),
    validatedChangedFiles: [...runtime.validatedChangedFiles].sort(),
    baselineRepaired: runtime.baselineRepaired,
    baselineContext: runtime.baselineContext!,
    baselineReviewContext: runtime.requireBaselineReviewContext(),
    lessonStatus: runtime.lessonStatus,
    mutationConfirmed: workflow.mutationConfirmed,
    worktreeHandle: workflow.worktreeHandle ? { ...workflow.worktreeHandle } : undefined,
    state: structuredClone(runtime.requireState()),
    cursor: { kind, continuation } as WorkflowCheckpoint["cursor"],
    bindings
  });
  const state = runtime.requireState();
  state.latestCheckpoint = {
    number: checkpoint.checkpointNumber,
    cursor: kind,
    createdAt: checkpoint.createdAt
  };
  await workflow.store.event("checkpoint", state.latestCheckpoint);
  await persist(runtime, workflow.ctx);
  return checkpoint;
}

export async function currentWorkspaceDigest(runtime: OrchestratorRuntime, workspaceRoot: string): Promise<string> {
  const snapshot = await createWorkspaceSnapshot(workspaceRoot, {
    excludedRoots: workspaceExclusions(runtime, workspaceRoot)
  });
  return workspaceSnapshotDigest(snapshot);
}

/** Preserve the last completed semantic cursor after an interrupted, scope-valid mutation. */
export async function refreshCheckpointAfterInterruptedMutation(
  runtime: OrchestratorRuntime,
  snapshot: WorkspaceSnapshot
): Promise<void> {
  const state = runtime.requireState();
  const runStore = runtime.requireStore();
  const store = new CheckpointStore(runStore.runDir, state.runId);
  const latest = await store.loadLatest();
  if (!latest) return;
  const { schemaVersion: _schemaVersion, checkpointNumber: _checkpointNumber, ...previous } = latest;
  const checkpoint = await store.save({
    ...previous,
    createdAt: runtime.timestamp(),
    workspaceDigest: workspaceSnapshotDigest(snapshot),
    workspaceRoot: snapshot.root,
    validatedChangedFiles: [...runtime.validatedChangedFiles].sort(),
    state: structuredClone(state)
  });
  state.latestCheckpoint = {
    number: checkpoint.checkpointNumber,
    cursor: checkpoint.cursor.kind,
    createdAt: checkpoint.createdAt
  };
  await runStore.event("checkpoint_recovered", {
    checkpointNumber: checkpoint.checkpointNumber,
    cursor: checkpoint.cursor.kind,
    reason: "interrupted_mutation"
  });
}
