import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { beginStep, persist, transition } from "./orchestrator-state.js";
import { runCheckStep, workspaceExclusions } from "./orchestrator-workspace.js";
import { MutationBoundaryError, WorkflowPausedError } from "./workflow-errors.js";
import { compareWorkspaceSnapshots, createWorkspaceSnapshot } from "../workspace/workspace-guard.js";
import type { CheckResult } from "../workflow-types.js";
import type { CheckRunOptions } from "../checks/checks.js";
import { readSafeArtifact } from "../persistence/checkpoint-store.js";

const MAX_SETUP_ARTIFACT_BYTES = 2 * 1024 * 1024;

/** Verify that ignored dependencies and tools are available in a newly created worktree. */
export async function verifyIsolatedWorktreeReadiness(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext
): Promise<void> {
  if (!workflow.worktreeHandle) return;

  await provisionIsolatedWorktreeDependencies(runtime, workflow);

  const checks = await runCheckStep(
    runtime,
    "baseline",
    "Verify isolated worktree readiness",
    workflow.mutationCwd,
    workflow.ctx,
    { requireGreen: false, kind: "worktree-readiness" }
  );
  if (allGreen(checks, runtime.requireConfig().checks.length)) return;

  await pauseForWorktreeEnvironment(runtime, workflow, checks, "checks");
}

/** Run approved dependency setup without requiring a green project baseline. */
export async function provisionIsolatedWorktreeDependencies(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext
): Promise<void> {
  if (!workflow.worktreeHandle) return;
  const setup = await runIsolatedWorktreeSetup(runtime, workflow);
  if (setup.length > 0 && !allGreen(setup, runtime.requireConfig().worktreeSetup.commands.length)) {
    await pauseForWorktreeEnvironment(runtime, workflow, setup, "setup commands");
  }
}

async function runIsolatedWorktreeSetup(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext
): Promise<CheckResult[]> {
  const commands = runtime.requireConfig().worktreeSetup.mode === "commands"
    ? runtime.requireConfig().worktreeSetup.commands
    : [];
  if (commands.length === 0) return [];

  const controller = runtime.requireController();
  const store = runtime.requireStore();
  const step = beginStep(runtime, "baseline", "Provision isolated worktree dependencies");
  await transition(runtime, "baseline", undefined, step.label, workflow.ctx);
  const before = runtime.enforceWorkspacePolicy
    ? await createWorkspaceSnapshot(workflow.mutationCwd, {
        excludedRoots: workspaceExclusions(runtime, workflow.mutationCwd)
      })
    : undefined;
  const options: CheckRunOptions = {
    exec: (command, args, execOptions) => runtime.pi.exec(command, args, execOptions),
    timeoutMs: runtime.requireConfig().limits.checkTimeoutMs,
    maxOutputBytes: runtime.requireConfig().limits.maxOutputBytes,
    now: runtime.now
  };
  const completed = await completedSetupResults(runtime, commands);
  const results = [...completed];
  try {
    for (const command of commands) {
      if (completed.some(result => result.command === command)) continue;
      const [result] = await runtime.checks([command], workflow.mutationCwd, controller.signal, options);
      if (!result) throw new Error(`Worktree setup command produced no result: ${command}`);
      results.push(result);
      if (!result.passed) break;
    }
    if (before) {
      const after = await createWorkspaceSnapshot(workflow.mutationCwd, {
        excludedRoots: workspaceExclusions(runtime, workflow.mutationCwd)
      });
      const delta = compareWorkspaceSnapshots(before, after);
      if (delta.changedFiles.length > 0) {
        throw new MutationBoundaryError(`Worktree setup commands changed project files: ${delta.changedFiles.join(", ")}`);
      }
    }
    step.artifact = await store.saveJson(store.artifactName({ sequence: step.sequence, stage: step.stage, kind: "worktree-setup" }), results);
    step.status = allGreen(results, commands.length) ? "succeeded" : "failed";
    step.message = allGreen(results, results.length) ? "Worktree setup completed" : "Worktree setup failed";
    return results;
  } catch (error) {
    step.status = controller.signal.aborted ? "cancelled" : "failed";
    step.message = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    step.completedAt = runtime.timestamp();
    await persist(runtime, workflow.ctx);
  }
}

/** Reuse only successful commands from the last setup attempt; failed commands are retried. */
async function completedSetupResults(runtime: OrchestratorRuntime, commands: readonly string[]): Promise<CheckResult[]> {
  const artifact = [...runtime.requireState().steps]
    .reverse()
    .find(step => step.label === "Provision isolated worktree dependencies" && step.artifact)
    ?.artifact;
  if (!artifact) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(await readSafeArtifact(runtime.requireStore().runDir, artifact, MAX_SETUP_ARTIFACT_BYTES)) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(`Could not read prior worktree setup results: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!Array.isArray(parsed) || !parsed.every(isCheckResult)) {
    throw new Error("Prior worktree setup artifact is malformed");
  }

  const successful = new Map(parsed.filter(result => result.passed).map(result => [result.command, result]));
  return commands.flatMap(command => {
    const result = successful.get(command);
    return result ? [result] : [];
  });
}

function isCheckResult(value: unknown): value is CheckResult {
  return typeof value === "object" && value !== null
    && typeof (value as CheckResult).command === "string"
    && typeof (value as CheckResult).passed === "boolean";
}

async function pauseForWorktreeEnvironment(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  results: readonly CheckResult[],
  phase: string
): Promise<never> {
  const state = runtime.requireState();
  const failedCommands = results.filter(check => !check.passed).map(check => check.command);
  const artifact = state.steps.at(-1)?.artifact;
  const details = [
    `Isolated worktree ${phase} failed (${failedCommands.join(", ") || "unknown command"}).`,
    `Resolve dependencies or tooling in ${workflow.mutationCwd}.`,
    artifact ? `Inspect ${runtime.requireStore().runDir}/${artifact}.` : "Inspect the worktree environment artifact.",
    `Then use /orchestrator-resume ${workflow.runId} to retry before any mutation agent runs.`
  ];
  state.status = "paused";
  state.message = details.join(" ");
  state.waitingFor = "isolated worktree dependency or tooling setup";
  await persist(runtime, workflow.ctx);
  throw new WorkflowPausedError(`worktree-readiness:${workflow.runId}`, state.message);
}
