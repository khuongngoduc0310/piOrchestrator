import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { StructuredAgentResponse } from "../ui/agent-session.js";
import { createHash } from "node:crypto";
import { AgentCancelledError, AgentIncompleteResponseError, type AgentRunOptions } from "../agents/agent-runner.js";
import { type SpawnExplorerResult, isSpawningRole } from "../agents/agent-runner-contracts.js";
import { agentRemainingTimeoutMs, spawnExplorerRunOptions } from "../agents/explorer-spawn.js";
import { AGENT_TASK_SCHEMA_VERSION, type AgentOutputMap, type AgentTaskEnvelope, type AgentTaskMap, type PlannerOutput } from "../agent-task-types.js";
import { type AgentResult, type AgentInvocationRecord, type AgentName, type AgentTranscript, type AgentTranscriptArtifact } from "../agent-types.js";
import { type Stage } from "../workflow-types.js";
import { ValidationError } from "../validation.js";
import { compareWorkspaceSnapshots, createWorkspaceSnapshot, deriveRoleMutationPaths, validateReportedFileSet } from "../workspace/workspace-guard.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { messageOf, projectTrusted, transcriptKey } from "./orchestrator-helpers.js";
import { beginStep, persist, throttledPersist, throwIfAborted, transition, updateAgentActivity } from "./orchestrator-state.js";
import { validateAgentMutation, validateAgentMutationScope, workspaceExclusions } from "./orchestrator-workspace.js";
import { captureGitTree, compareGitTrees } from "../workspace/git-tree-diff.js";
import { ROLE_MUTATION_KINDS } from "../agents/role-capabilities.js";
import { refreshCheckpointAfterInterruptedMutation } from "./orchestrator-checkpoints.js";
import type { WorkspaceSnapshot } from "../workspace/workspace-guard.js";
import { createFileAttestations } from "../workspace/workspace-attestation.js";

const OUTPUT_CORRECTABLE_AGENTS = new Set<AgentName>(["explorer", "planner", "reviewer", "debugger"]);
const CORRECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

export async function runAgentStep<A extends AgentName>(
  runtime: OrchestratorRuntime,
  agent: A,
  stage: Stage,
  label: string,
  payload: AgentTaskMap[A],
  cwd: string,
  ctx: ExtensionCommandContext,
  validate: (text: string) => AgentOutputMap[A],
  qualifier: { attempt?: number; revision?: number; mutationPlan?: PlannerOutput } = {}
): Promise<AgentOutputMap[A]> {
  const config = runtime.requireConfig();
  const controller = runtime.requireController();
  const state = runtime.requireState();
  const store = runtime.requireStore();
  const allowedWritePaths = qualifier.mutationPlan ? deriveRoleMutationPaths(agent, qualifier.mutationPlan) : [];
  state.currentTool = undefined;
  state.currentToolArgs = undefined;
  state.agentOutput = undefined;
  state.toolStatus = undefined;
  const step = beginStep(runtime, stage, label, agent, qualifier);
  const status = state.agents[agent];
  status.status = "running";
  status.startedAt = step.startedAt;
  delete status.error;
  await transition(runtime, stage, agent, `${agent} is running`, ctx);
  let beforeWorkspace: Awaited<ReturnType<typeof createWorkspaceSnapshot>> | undefined;
  let workspaceAudited = false;
  let rawText: string | undefined;
  try {
    beforeWorkspace = runtime.enforceWorkspacePolicy
      ? await createWorkspaceSnapshot(cwd, {
          excludedRoots: workspaceExclusions(runtime, cwd),
          requiredPaths: allowedWritePaths
        })
      : undefined;
    const onEvent = (event: Parameters<NonNullable<AgentRunOptions["onEvent"]>>[0]): void => {
      void store.event("agent_event", { stepId: step.id, agent, event }).catch(() => undefined);
      updateAgentActivity(runtime, event, agent);
      throttledPersist(runtime, ctx);
    };
    const spawnCount = { value: 0 };
    const parentRunStartedAt = { value: 0 };
    const runBase = {
      name: agent,
      cwd,
      extensionRoot: runtime.extensionRoot,
      config: config.agents[agent],
      timeoutMs: config.limits.agentTimeoutMs,
      signal: controller.signal,
      onEvent,
      allowedWritePaths,
      readRoots: [store.runDir],
      ...(isSpawningRole(agent)
        ? {
            spawnExplorer: (question: string) => runSpawnedExplorer(runtime, {
              step,
              qualifier,
              stage,
              agent,
              cwd,
              spawnCount,
              parentRunStartedAt: parentRunStartedAt.value,
              explorerModel: config.agents.explorer.model
            }, question)
          }
        : {})
    } satisfies Omit<AgentRunOptions, "task">;

    const executeInvocation = async (
      mode: "execute" | "correct_output",
      runConfig: AgentRunOptions["config"],
      task: string
    ): Promise<AgentResult> => {
      const baseRun = mode === "correct_output" ? omitSpawnExplorer(runBase) : runBase;
      parentRunStartedAt.value = Date.now();
      const invocation: AgentInvocationRecord = {
        sequence: (step.invocations?.length ?? 0) + 1,
        mode,
        status: "running",
        startedAt: runtime.timestamp(),
        messageCount: 0,
        truncated: false
      };
      step.invocations ??= [];
      step.invocations.push(invocation);
      const key = transcriptKey(step.id, invocation.sequence);
      const diffExclusions = [
        ...workspaceExclusions(runtime, cwd),
        `${CONFIG_DIR_NAME}/orchestrator/runs`,
        `${CONFIG_DIR_NAME}/orchestrator/worktrees`
      ];
      const beforeTree = await captureGitTree(cwd, diffExclusions);
      let latestTranscript: AgentTranscript | undefined;
      let invocationStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
      let invocationError: unknown;
      try {
        const result = await runtime.agents.run({
          ...baseRun,
          config: runConfig,
          task,
          onTranscript: next => {
            latestTranscript = next;
            runtime.activeTranscripts.set(key, next);
            invocation.messageCount = next.messages.length;
            invocation.truncated = next.truncated;
            runtime.transcriptRevision++;
            throttledPersist(runtime, ctx);
          },
          onUsage: snapshot => {
            invocation.usage = snapshot.usage;
            invocation.provider = snapshot.provider;
            invocation.model = snapshot.model;
            invocation.api = snapshot.api;
            invocation.stopReason = snapshot.stopReason;
            throttledPersist(runtime, ctx);
          }
        });
        latestTranscript = result.transcript ?? latestTranscript;
        if (result.usage) invocation.usage = result.usage;
        if (result.response) {
          invocation.provider = result.response.provider;
          invocation.model = result.response.model;
          invocation.api = result.response.api;
          invocation.stopReason = result.response.stopReason;
        }
        return result;
      } catch (error) {
        invocationError = error;
        invocationStatus = controller.signal.aborted || error instanceof AgentCancelledError ? "cancelled" : "failed";
        if (error instanceof AgentIncompleteResponseError) {
          invocation.usage = error.usage;
          invocation.provider = error.provider;
          invocation.model = error.model;
          invocation.stopReason = error.stopReason;
        }
        throw error;
      } finally {
        invocation.status = invocationStatus;
        invocation.completedAt = runtime.timestamp();
        let persistenceError: unknown;
        try {
          if (latestTranscript) {
            invocation.messageCount = latestTranscript.messages.length;
            invocation.truncated = latestTranscript.truncated;
            const transcriptName = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: `invocation-${invocation.sequence}-transcript` });
            const transcriptArtifact = buildTranscriptArtifact({
              transcript: latestTranscript,
              stepId: step.id,
              agent,
              invocation: invocation.sequence,
              mode,
              status: invocationStatus,
              model: runConfig.model,
              startedAt: invocation.startedAt,
              completedAt: invocation.completedAt
            });
            invocation.transcriptArtifact = await store.saveJson(transcriptName, transcriptArtifact);
          }
        } catch (transcriptError) {
          persistenceError = transcriptError;
        } finally {
          runtime.activeTranscripts.delete(key);
          runtime.transcriptRevision++;
        }
        try {
          const afterTree = beforeTree.available ? await captureGitTree(cwd, diffExclusions) : beforeTree;
          const diff = await compareGitTrees(beforeTree, afterTree);
          if (diff.patch && diff.patch.length > 0) {
            const patchName = store.artifactName({
              ...qualifier,
              sequence: step.sequence,
              stage,
              agent,
              kind: `invocation-${invocation.sequence}-files`,
              extension: "patch"
            });
            invocation.filePatchArtifact = await store.saveBuffer(patchName, diff.patch);
            diff.metadata.patchArtifact = invocation.filePatchArtifact;
            diff.metadata.patchDigest = createHash("sha256").update(diff.patch).digest("hex");
          }
          const diffName = store.artifactName({
            ...qualifier,
            sequence: step.sequence,
            stage,
            agent,
            kind: `invocation-${invocation.sequence}-file-diff`
          });
          invocation.fileDiffArtifact = await store.saveJson(diffName, diff.metadata);
          invocation.changedFileCount = diff.metadata.files.length;
        } catch (diffError) {
          invocation.fileDiffError = messageOf(diffError);
          persistenceError ??= diffError;
        }
        if (invocationError === undefined && persistenceError !== undefined) throw persistenceError;
      }
    };

    if (!projectTrusted(ctx)) {
      runtime.memoryMode = "untrusted";
      runtime.loadedMemoryDoc = null;
    }
    const memoryEnvelope = runtime.getMemoryEnvelope(agent) ?? null;
    const executeEnvelope: AgentTaskEnvelope<AgentTaskMap[A]> = {
      taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
      mode: "execute",
      task: payload,
      memoryContext: memoryEnvelope
    };
    let result = await executeInvocation("execute", runBase.config, JSON.stringify(executeEnvelope, null, 2));
    rawText = result.text;
    let output: AgentOutputMap[A];
    try {
      output = validate(result.text);
    } catch (validationError) {
      const rawArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "invalid-output-attempt-1", extension: "txt" });
      step.rawArtifact = await store.saveRaw(rawArtifact, result.text);
      const hadWritablePaths = allowedWritePaths.length > 0;
      const mutatingSession = beforeWorkspace !== undefined && ROLE_MUTATION_KINDS[agent] !== "none";
      if (!OUTPUT_CORRECTABLE_AGENTS.has(agent) && !mutatingSession && (hadWritablePaths || agent !== "documenter")) {
        throw new Error(`${agent} returned invalid structured output after a potentially mutating session: ${messageOf(validationError)}`);
      }
      const auditedMutation = mutatingSession ? await (async () => {
        const afterWorkspace = await createWorkspaceSnapshot(cwd, {
          excludedRoots: workspaceExclusions(runtime, cwd),
          requiredPaths: allowedWritePaths
        });
        const delta = compareWorkspaceSnapshots(beforeWorkspace!, afterWorkspace);
        validateAgentMutationScope(agent, qualifier.mutationPlan, delta);
        return { afterWorkspace, delta };
      })() : undefined;
      const rawPath = validationError instanceof ValidationError ? validationError.path : undefined;
      const fieldPath = rawPath && /^[a-zA-Z0-9_.[\]-]+$/.test(rawPath) ? rawPath : undefined;
      const correctionEnvelope: AgentTaskEnvelope<AgentTaskMap[A]> = {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode: "correct_output",
        task: payload,
        memoryContext: memoryEnvelope,
        correction: {
          attempt: 1,
          reason: "schema_validation_failed",
          ...(fieldPath ? { fieldPath } : {}),
          ...(auditedMutation ? { expectedChangedFiles: [...auditedMutation.delta.changedFiles] } : hadWritablePaths ? {} : { expectedChangedFiles: [] })
        }
      };
      const correctionConfig = { ...runBase.config, tools: runBase.config.tools.filter(tool => CORRECTION_TOOLS.has(tool)) };
      result = await executeInvocation("correct_output", correctionConfig, JSON.stringify(correctionEnvelope, null, 2));
      rawText = result.text;
      try {
        output = validate(result.text);
      } catch (correctionError) {
        const secondRawArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "invalid-output-attempt-2", extension: "txt" });
        step.rawArtifact = await store.saveRaw(secondRawArtifact, result.text);
        throw correctionError;
      }
      if (auditedMutation) {
        const afterCorrectionWorkspace = await createWorkspaceSnapshot(cwd, {
          excludedRoots: workspaceExclusions(runtime, cwd),
          requiredPaths: allowedWritePaths
        });
        const correctionDelta = compareWorkspaceSnapshots(auditedMutation.afterWorkspace, afterCorrectionWorkspace);
        if (correctionDelta.changedFiles.length > 0) {
          const finalDelta = compareWorkspaceSnapshots(beforeWorkspace!, afterCorrectionWorkspace);
          await validateAgentMutation(runtime, agent, qualifier.mutationPlan, output, finalDelta, afterCorrectionWorkspace, step, store, {
            initialReported: [],
            correctionAttempted: true,
            additionalViolations: [`${agent} output correction changed project files: ${correctionDelta.changedFiles.join(", ")}`]
          });
        }
        await validateAgentMutation(runtime, agent, qualifier.mutationPlan, output, auditedMutation.delta, auditedMutation.afterWorkspace, step, store, {
          initialReported: [],
          correctionAttempted: true
        });
        workspaceAudited = true;
      }
    }
    if (beforeWorkspace && !workspaceAudited) {
      const afterExecuteWorkspace = await createWorkspaceSnapshot(cwd, {
        excludedRoots: workspaceExclusions(runtime, cwd),
        requiredPaths: allowedWritePaths
      });
      const delta = compareWorkspaceSnapshots(beforeWorkspace, afterExecuteWorkspace);
      let mutationAudit: { initialReported: readonly string[]; correctionAttempted: true; correctionError?: string } | undefined;
      try {
        validateAgentMutationScope(agent, qualifier.mutationPlan, delta);
      } catch {
        await validateAgentMutation(runtime, agent, qualifier.mutationPlan, output, delta, afterExecuteWorkspace, step, store);
      }
      if (ROLE_MUTATION_KINDS[agent] !== "none") {
        const initialReported = changedFilesOf(output);
        try {
          validateReportedFileSet(initialReported, delta);
        } catch {
          const correctionEnvelope: AgentTaskEnvelope<AgentTaskMap[A]> = {
            taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
            mode: "correct_output",
            task: payload,
            memoryContext: memoryEnvelope,
            correction: {
              attempt: 1,
              reason: "reported_changed_files_mismatch",
              fieldPath: "changedFiles",
              expectedChangedFiles: [...delta.changedFiles]
            }
          };
          const correctionConfig = { ...runBase.config, tools: runBase.config.tools.filter(tool => CORRECTION_TOOLS.has(tool)) };
          let correctedOutput: AgentOutputMap[A];
          try {
            result = await executeInvocation("correct_output", correctionConfig, JSON.stringify(correctionEnvelope, null, 2));
            rawText = result.text;
            correctedOutput = validate(result.text);
          } catch (correctionError) {
            await validateAgentMutation(runtime, agent, qualifier.mutationPlan, output, delta, afterExecuteWorkspace, step, store, {
              initialReported,
              correctionAttempted: true,
              correctionError: messageOf(correctionError)
            });
            throw correctionError;
          }
          const afterCorrectionWorkspace = await createWorkspaceSnapshot(cwd, {
            excludedRoots: workspaceExclusions(runtime, cwd),
            requiredPaths: allowedWritePaths
          });
          const correctionDelta = compareWorkspaceSnapshots(afterExecuteWorkspace, afterCorrectionWorkspace);
          if (correctionDelta.changedFiles.length > 0) {
            const finalDelta = compareWorkspaceSnapshots(beforeWorkspace, afterCorrectionWorkspace);
            await validateAgentMutation(runtime, agent, qualifier.mutationPlan, correctedOutput, finalDelta, afterCorrectionWorkspace, step, store, {
              initialReported,
              correctionAttempted: true,
              additionalViolations: [`${agent} output correction changed project files: ${correctionDelta.changedFiles.join(", ")}`]
            });
          }
          output = correctedOutput;
          mutationAudit = { initialReported, correctionAttempted: true };
        }
      }
      await validateAgentMutation(runtime, agent, qualifier.mutationPlan, output, delta, afterExecuteWorkspace, step, store, mutationAudit);
      workspaceAudited = true;
    }
    const artifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "output" });
    step.artifact = await store.saveJson(artifact, { output, usage: result.usage });
    throwIfAborted(runtime);
    step.status = "succeeded";
    step.message = `${agent} completed`;
    status.status = "succeeded";
    status.summary = result.text.slice(0, 500);
    status.completedAt = runtime.timestamp();
    runtime.sessionBuffers.addEvent(agent, {
      id: `${step.id}:response`,
      type: "structured_response",
      timestamp: Date.now(),
      response: { agent, output } as StructuredAgentResponse,
    });
    return output;
  } catch (error) {
    let effectiveError = error;
    let recoverySnapshot: WorkspaceSnapshot | undefined;
    if (beforeWorkspace && !workspaceAudited && ROLE_MUTATION_KINDS[agent] !== "none") {
      try {
        const afterWorkspace = await createWorkspaceSnapshot(cwd, {
          excludedRoots: workspaceExclusions(runtime, cwd),
          requiredPaths: allowedWritePaths
        });
        const delta = compareWorkspaceSnapshots(beforeWorkspace, afterWorkspace);
        validateAgentMutationScope(agent, qualifier.mutationPlan, delta);
        for (const attestation of createFileAttestations(agent, step, delta, afterWorkspace)) {
          runtime.validatedChangedFiles.add(attestation.path);
          runtime.validatedFileAttestations.set(attestation.path, attestation);
        }
        recoverySnapshot = afterWorkspace;
        const auditArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "failed-mutation-audit" });
        step.artifact = await store.saveJson(auditArtifact, {
          actual: delta,
          originalError: messageOf(error),
          outputValidated: false,
          scopeValidated: true
        });
      } catch (auditError) {
        effectiveError = auditError;
        const auditArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "failed-mutation-audit" });
        step.artifact = await store.saveJson(auditArtifact, {
          originalError: messageOf(error),
          auditError: messageOf(auditError),
          outputValidated: false,
          scopeValidated: false
        }).catch(() => step.artifact);
      }
    }
    const cancelled = controller.signal.aborted || error instanceof AgentCancelledError;
    step.status = cancelled ? "cancelled" : "failed";
    step.message = messageOf(effectiveError);
    status.status = cancelled ? "cancelled" : "failed";
    status.error = messageOf(effectiveError);
    status.completedAt = runtime.timestamp();
    if (recoverySnapshot) {
      try {
        await refreshCheckpointAfterInterruptedMutation(runtime, recoverySnapshot);
      } catch (checkpointError) {
        state.resumeBlockedReason = `Interrupted mutation was audited, but its recovery checkpoint failed: ${messageOf(checkpointError)}`;
      }
    }
    if (rawText === undefined) {
      const errorArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "execution-error" });
      const details = error instanceof AgentIncompleteResponseError
        ? { kind: "agent_incomplete_response", error: error.message, agent: error.agent, stopReason: error.stopReason, provider: error.provider, model: error.model, providerError: error.providerError, partialText: error.partialText, usage: error.usage }
        : { error: messageOf(error) };
      step.artifact = await store.saveJson(errorArtifact, details);
    }
    throw effectiveError;
  } finally {
    step.completedAt = runtime.timestamp();
    state.activeAgent = undefined;
    await persist(runtime, ctx);
  }
}

function changedFilesOf(output: unknown): string[] {
  const changedFiles = (output as { changedFiles?: unknown }).changedFiles;
  return Array.isArray(changedFiles) ? changedFiles.filter((value): value is string => typeof value === "string") : [];
}

/** Run a read-only explorer sub-agent and report its findings back to the parent agent. */
async function runSpawnedExplorer(
  runtime: OrchestratorRuntime,
  parent: {
    step: Awaited<ReturnType<typeof beginStep>>;
    qualifier: { attempt?: number; revision?: number; mutationPlan?: PlannerOutput };
    stage: Stage;
    agent: AgentName;
    cwd: string;
    spawnCount: { value: number };
    parentRunStartedAt: number;
    explorerModel: string;
  },
  question: string
): Promise<SpawnExplorerResult> {
  const config = runtime.requireConfig();
  const controller = runtime.requireController();
  const store = runtime.requireStore();
  const startedAt = runtime.timestamp();
  const child = spawnExplorerRunOptions({
    question,
    cwd: parent.cwd,
    extensionRoot: runtime.extensionRoot,
    explorerConfig: config.agents.explorer,
    timeoutMs: agentRemainingTimeoutMs(config.limits.agentTimeoutMs, parent.parentRunStartedAt),
    signal: controller.signal,
    readRoots: [store.runDir],
    onEvent: event => {
      void store.event("agent_event", { stepId: parent.step.id, agent: "explorer", spawned: true, event }).catch(() => undefined);
    }
  });
  try {
    const result = await runtime.agents.run(child);
    if (result.transcript) {
      const completedAt = runtime.timestamp();
      const name = store.artifactName({
        ...parent.qualifier,
        sequence: parent.step.sequence,
        stage: parent.stage,
        agent: parent.agent,
        kind: `spawn-${++parent.spawnCount.value}-transcript`
      });
      const artifact = buildTranscriptArtifact({
        transcript: result.transcript,
        stepId: parent.step.id,
        agent: "explorer",
        invocation: 0,
        mode: "execute",
        status: "succeeded",
        model: parent.explorerModel,
        startedAt,
        completedAt
      });
      await store.saveJson(name, artifact);
    }
    return { text: result.text, usage: result.usage, transcript: result.transcript };
  } catch (error) {
    if (error instanceof AgentCancelledError) throw error;
    const usage = error instanceof AgentIncompleteResponseError ? error.usage : undefined;
    return { text: `Explorer sub-agent failed: ${messageOf(error)}`, usage };
  }
}

export function buildTranscriptArtifact(options: {
  transcript: AgentTranscript;
  stepId: string;
  agent: AgentName;
  invocation: number;
  mode: AgentInvocationRecord["mode"];
  status: AgentInvocationRecord["status"];
  model: string;
  startedAt: string;
  completedAt: string;
}): AgentTranscriptArtifact {
  return {
    ...options.transcript,
    stepId: options.stepId,
    agent: options.agent,
    invocation: options.invocation,
    mode: options.mode,
    status: options.status,
    model: options.model,
    startedAt: options.startedAt,
    completedAt: options.completedAt
  };
}

function omitSpawnExplorer(runBase: Omit<AgentRunOptions, "task">): Omit<AgentRunOptions, "task"> {
  const { spawnExplorer: _omitted, ...rest } = runBase;
  return rest;
}
