import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { RunStore } from "../persistence/store.js";
import type { WorktreeHandle } from "../workspace/worktree.js";
import { ROLE_MUTATION_KINDS } from "../agents/role-capabilities.js";
import { CheckFailureError, MutationBoundaryError } from "./workflow-errors.js";
import {
  compareWorkspaceSnapshots,
  createWorkspaceSnapshot,
  deriveRoleMutationPaths,
  validateReportedFileSet,
  validateRoleDelta,
  type WorkspaceDelta,
  type WorkspaceSnapshot
} from "../workspace/workspace-guard.js";
import { createFileAttestations, validateAttestedWorkspaceFiles } from "../workspace/workspace-attestation.js";
import type { AgentName, AgentOutputMap, CheckResult, PlannerOutput, Stage, StepRecord } from "../types.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen, messageOf } from "./orchestrator-helpers.js";
import { beginStep, persist, throwIfAborted, transition } from "./orchestrator-state.js";
import type { CheckRunOptions } from "../checks/checks.js";

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
  const attestedPaths = [...runtime.validatedFileAttestations.keys()];
  const beforeWorkspace = runtime.enforceWorkspacePolicy
    ? await createWorkspaceSnapshot(cwd, {
        excludedRoots: workspaceExclusions(runtime, cwd),
        requiredPaths: attestedPaths
      })
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
      const afterWorkspace = await createWorkspaceSnapshot(cwd, {
        excludedRoots: workspaceExclusions(runtime, cwd),
        requiredPaths: attestedPaths
      });
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
    if (options.requireGreen && !allGreen(results, config.checks.length)) {
      throw new CheckFailureError(label, results.filter(result => !result.passed).map(result => result.command));
    }
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

export async function validateFinalWorktreeChanges(
  runtime: OrchestratorRuntime,
  handle: WorktreeHandle,
  repositoryPaths: readonly string[]
): Promise<void> {
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
  const workspace = await createWorkspaceSnapshot(handle.effectiveCwd, {
    excludedRoots: workspaceExclusions(runtime, handle.effectiveCwd),
    requiredPaths: [...runtime.validatedFileAttestations.keys()]
  });
  const changedSet = new Set(projectFiles.filter(Boolean));
  const attestedSet = new Set(runtime.validatedFileAttestations.keys());
  const missingChanges = [...attestedSet].filter(file => !changedSet.has(file));
  const unattestedChanges = [...changedSet].filter(file => !attestedSet.has(file));
  const attestationViolations = validateAttestedWorkspaceFiles(
    runtime.validatedFileAttestations,
    workspace,
    [...attestedSet]
  );
  if (outsideProject.length > 0 || missingChanges.length > 0 || unattestedChanges.length > 0 || attestationViolations.length > 0) {
    const detail = [
      outsideProject.length ? `outside project: ${outsideProject.join(", ")}` : "",
      missingChanges.length ? `validated but absent from final changes: ${missingChanges.join(", ")}` : "",
      unattestedChanges.length ? `changed without validation: ${unattestedChanges.join(", ")}` : "",
      attestationViolations.length ? `not validated: ${attestationViolations.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    throw new MutationBoundaryError(`Worktree contains changes that cannot be synchronized (${detail})`);
  }
}

export async function validateFinalDirectWorkspace(runtime: OrchestratorRuntime, cwd: string): Promise<void> {
  const paths = [...runtime.validatedFileAttestations.keys()].sort();
  const workspace = await createWorkspaceSnapshot(cwd, {
    excludedRoots: workspaceExclusions(runtime, cwd),
    requiredPaths: paths
  });
  const violations = validateAttestedWorkspaceFiles(runtime.validatedFileAttestations, workspace, paths);
  if (violations.length > 0) {
    throw new MutationBoundaryError(`Direct workspace changed after validation (${violations.join(", ")})`);
  }
}

export async function validateAgentMutation<A extends AgentName>(
  runtime: OrchestratorRuntime,
  agent: A,
  plan: PlannerOutput | undefined,
  output: AgentOutputMap[A],
  delta: WorkspaceDelta,
  afterWorkspace: WorkspaceSnapshot,
  step: StepRecord,
  store: RunStore,
  audit?: {
    initialReported: readonly string[];
    correctionAttempted: true;
    correctionError?: string;
    additionalViolations?: readonly string[];
  }
): Promise<void> {
  const mutation = ROLE_MUTATION_KINDS[agent];
  const reported = "changedFiles" in (output as object)
    ? ((output as unknown as { changedFiles: string[] }).changedFiles ?? [])
    : [];
  const violations: string[] = [...(audit?.additionalViolations ?? [])];
  try {
    validateAgentMutationScope(agent, plan, delta);
    if (mutation !== "none") validateReportedFileSet(reported, delta);
  } catch (error) {
    violations.push(messageOf(error));
  }
  const artifact = store.artifactName({ sequence: step.sequence, stage: step.stage, agent, attempt: step.attempt, revision: step.revision, kind: "mutation" });
  step.mutationArtifact = await store.saveJson(artifact, {
    role: agent,
    policy: mutation,
    allowed: plan ? deriveRoleMutationPaths(agent, plan) : [],
    reported,
    actual: delta,
    violations,
    ...(audit ? {
      correction: {
        attempted: audit.correctionAttempted,
        initialReported: [...audit.initialReported],
        expectedChangedFiles: [...delta.changedFiles],
        ...(audit.correctionError ? { error: audit.correctionError } : {})
      }
    } : {})
  });
  if (violations.length > 0) throw new MutationBoundaryError(violations.join("; "));
  for (const attestation of createFileAttestations(agent, step, delta, afterWorkspace)) {
    runtime.validatedChangedFiles.add(attestation.path);
    runtime.validatedFileAttestations.set(attestation.path, attestation);
  }
}

export function validateAgentMutationScope(
  agent: AgentName,
  plan: PlannerOutput | undefined,
  delta: WorkspaceDelta
): void {
  const mutation = ROLE_MUTATION_KINDS[agent];
  if (mutation === "none") {
    if (delta.changedFiles.length > 0) throw new Error(`${agent} is read-only but changed ${delta.changedFiles.join(", ")}`);
    return;
  }
  if (!plan) throw new Error(`${agent} has no approved mutation plan`);
  validateRoleDelta(agent, plan, delta);
}
