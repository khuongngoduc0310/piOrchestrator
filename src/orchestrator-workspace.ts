import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunStore } from "./store.js";
import type { WorktreeHandle } from "./worktree.js";
import { ROLE_MUTATION_KINDS } from "./role-capabilities.js";
import { MutationBoundaryError } from "./workflow-errors.js";
import {
  compareWorkspaceSnapshots,
  createWorkspaceSnapshot,
  deriveRoleMutationPaths,
  validateReportedFileSet,
  validateRoleDelta,
  type WorkspaceDelta
} from "./workspace-guard.js";
import type { AgentName, AgentOutputMap, CheckResult, PlannerOutput, Stage, StepRecord } from "./types.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen, messageOf } from "./orchestrator-helpers.js";
import { beginStep, persist, throwIfAborted, transition } from "./orchestrator-state.js";
import type { CheckRunOptions } from "./checks.js";

export async function runCheckStep(
  runtime: OrchestratorRuntime,
  stage: Stage,
  label: string,
  cwd: string,
  ctx: ExtensionCommandContext,
  options: { requireGreen: boolean; attempt?: number; revision?: number; kind?: string }
): Promise<CheckResult[]> {
  const config = runtime.requireConfig();
  const controller = runtime.requireController();
  const step = beginStep(runtime, stage, label, undefined, options);
  await transition(runtime, stage, undefined, label, ctx);
  const beforeWorkspace = runtime.enforceWorkspacePolicy
    ? await createWorkspaceSnapshot(cwd, { excludedRoots: workspaceExclusions(runtime, cwd) })
    : undefined;
  try {
    const checkOptions: CheckRunOptions = {
      exec: (command, args, execOptions) => runtime.pi.exec(command, args, execOptions),
      timeoutMs: config.limits.checkTimeoutMs,
      maxOutputBytes: config.limits.maxOutputBytes,
      now: runtime.now
    };
    const results = await runtime.checks(config.checks, cwd, controller.signal, checkOptions);
    if (beforeWorkspace) {
      const afterWorkspace = await createWorkspaceSnapshot(cwd, { excludedRoots: workspaceExclusions(runtime, cwd) });
      const delta = compareWorkspaceSnapshots(beforeWorkspace, afterWorkspace);
      if (delta.changedFiles.length > 0) {
        const mutationArtifact = runtime.requireStore().artifactName({ sequence: step.sequence, stage, attempt: options.attempt, revision: options.revision, kind: "check-mutation" });
        step.artifact = await runtime.requireStore().saveJson(mutationArtifact, { actual: delta, violations: delta.changedFiles });
        throw new MutationBoundaryError(`Configured checks changed project files: ${delta.changedFiles.join(", ")}`);
      }
    }
    const artifact = runtime.requireStore().artifactName({ sequence: step.sequence, stage, attempt: options.attempt, revision: options.revision, kind: options.kind ?? "checks" });
    step.artifact = await runtime.requireStore().saveJson(artifact, results);
    if (controller.signal.aborted || results.some(result => result.cancelled)) throw new Error("Checks cancelled");
    const infrastructureFailure = results.find(result => result.timedOut || result.executionError);
    if (infrastructureFailure) {
      throw new Error(`Check could not complete: ${infrastructureFailure.command} (${infrastructureFailure.executionError ?? "timeout"})`);
    }
    if (options.requireGreen && !allGreen(results, config.checks.length)) throw new Error(`${label} failed`);
    throwIfAborted(runtime);
    step.status = "succeeded";
    step.message = allGreen(results, config.checks.length) ? "All checks passed" : "Checks completed with failures";
    return results;
  } catch (error) {
    step.status = controller.signal.aborted ? "cancelled" : "failed";
    step.message = messageOf(error);
    throw error;
  } finally {
    step.completedAt = runtime.timestamp();
    await persist(runtime, ctx);
  }
}

export function workspaceExclusions(runtime: OrchestratorRuntime, cwd: string): string[] {
  const relative = path.relative(cwd, runtime.requireStore().runDir).split(path.sep).join("/");
  return relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative) ? [relative] : [];
}

export function validateFinalWorktreeChanges(
  runtime: OrchestratorRuntime,
  handle: WorktreeHandle,
  repositoryPaths: readonly string[]
): void {
  const projectPrefix = handle.projectRelativePath.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
  const projectFiles: string[] = [];
  const outsideProject: string[] = [];
  for (const repositoryPath of repositoryPaths) {
    const normalized = repositoryPath.replace(/\\/g, "/");
    if (!projectPrefix) projectFiles.push(normalized);
    else if (normalized === projectPrefix || normalized.startsWith(`${projectPrefix}/`)) {
      projectFiles.push(normalized.slice(projectPrefix.length).replace(/^\//, ""));
    } else outsideProject.push(normalized);
  }
  const unvalidated = projectFiles.filter(file => file && !runtime.validatedChangedFiles.has(file));
  if (outsideProject.length > 0 || unvalidated.length > 0) {
    const detail = [
      outsideProject.length ? `outside project: ${outsideProject.join(", ")}` : "",
      unvalidated.length ? `not validated: ${unvalidated.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    throw new MutationBoundaryError(`Worktree contains changes that cannot be synchronized (${detail})`);
  }
}

export async function validateAgentMutation<A extends AgentName>(
  runtime: OrchestratorRuntime,
  agent: A,
  plan: PlannerOutput | undefined,
  output: AgentOutputMap[A],
  delta: WorkspaceDelta,
  step: StepRecord,
  store: RunStore
): Promise<void> {
  const mutation = ROLE_MUTATION_KINDS[agent];
  const reported = "changedFiles" in (output as object)
    ? ((output as unknown as { changedFiles: string[] }).changedFiles ?? [])
    : [];
  const violations: string[] = [];
  try {
    if (mutation === "none") {
      if (delta.changedFiles.length > 0) throw new Error(`${agent} is read-only but changed ${delta.changedFiles.join(", ")}`);
    } else {
      if (!plan) throw new Error(`${agent} has no approved mutation plan`);
      validateRoleDelta(agent, plan, delta);
      validateReportedFileSet(reported, delta);
    }
  } catch (error) {
    violations.push(messageOf(error));
  }
  const artifact = store.artifactName({ sequence: step.sequence, stage: step.stage, agent, attempt: step.attempt, revision: step.revision, kind: "mutation" });
  step.mutationArtifact = await store.saveJson(artifact, { role: agent, policy: mutation, allowed: plan ? deriveRoleMutationPaths(agent, plan) : [], reported, actual: delta, violations });
  if (violations.length > 0) throw new MutationBoundaryError(violations.join("; "));
  for (const file of delta.changedFiles) runtime.validatedChangedFiles.add(file);
}
