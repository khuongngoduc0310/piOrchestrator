import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AgentCancelledError, AgentIncompleteResponseError, type AgentRunOptions } from "./agent-runner.js";
import { AGENT_TASK_SCHEMA_VERSION, type AgentOutputMap, type AgentResult, type AgentTaskEnvelope, type AgentTaskMap, type AgentInvocationRecord, type AgentName, type AgentTranscript, type AgentTranscriptArtifact, type PlannerOutput, type Stage } from "./types.js";
import { ValidationError } from "./validation.js";
import { compareWorkspaceSnapshots, createWorkspaceSnapshot, deriveRoleMutationPaths } from "./workspace-guard.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { messageOf, projectTrusted, transcriptKey } from "./orchestrator-helpers.js";
import { beginStep, persist, throttledPersist, throwIfAborted, transition, updateAgentActivity } from "./orchestrator-state.js";
import { validateAgentMutation, workspaceExclusions } from "./orchestrator-workspace.js";

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
  const beforeWorkspace = runtime.enforceWorkspacePolicy
    ? await createWorkspaceSnapshot(cwd, { excludedRoots: workspaceExclusions(runtime, cwd) })
    : undefined;
  let rawText: string | undefined;
  try {
    const onEvent = (event: Parameters<NonNullable<AgentRunOptions["onEvent"]>>[0]): void => {
      void store.event("agent_event", { stepId: step.id, agent, event }).catch(() => undefined);
      updateAgentActivity(runtime, event);
      throttledPersist(runtime, ctx);
    };
    const runBase = {
      name: agent,
      cwd,
      extensionRoot: runtime.extensionRoot,
      config: config.agents[agent],
      timeoutMs: config.limits.agentTimeoutMs,
      signal: controller.signal,
      onEvent,
      allowedWritePaths: qualifier.mutationPlan ? deriveRoleMutationPaths(agent, qualifier.mutationPlan) : [],
      readRoots: [store.runDir]
    } satisfies Omit<AgentRunOptions, "task">;

    const executeInvocation = async (
      mode: "execute" | "correct_output",
      runConfig: AgentRunOptions["config"],
      task: string
    ): Promise<AgentResult> => {
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
      let latestTranscript: AgentTranscript | undefined;
      let invocationStatus: "succeeded" | "failed" | "cancelled" = "succeeded";
      let invocationError: unknown;
      try {
        const result = await runtime.agents.run({
          ...runBase,
          config: runConfig,
          task,
          onTranscript: next => {
            latestTranscript = next;
            runtime.activeTranscripts.set(key, next);
            invocation.messageCount = next.messages.length;
            invocation.truncated = next.truncated;
            runtime.transcriptRevision++;
            throttledPersist(runtime, ctx);
          }
        });
        latestTranscript = result.transcript ?? latestTranscript;
        return result;
      } catch (error) {
        invocationError = error;
        invocationStatus = controller.signal.aborted || error instanceof AgentCancelledError ? "cancelled" : "failed";
        throw error;
      } finally {
        invocation.status = invocationStatus;
        invocation.completedAt = runtime.timestamp();
        try {
          if (latestTranscript) {
            invocation.messageCount = latestTranscript.messages.length;
            invocation.truncated = latestTranscript.truncated;
            const transcriptName = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: `invocation-${invocation.sequence}-transcript` });
            const transcriptArtifact: AgentTranscriptArtifact = {
              ...latestTranscript,
              stepId: step.id,
              agent,
              invocation: invocation.sequence,
              mode,
              status: invocationStatus,
              model: runConfig.model,
              startedAt: invocation.startedAt,
              completedAt: invocation.completedAt
            };
            invocation.transcriptArtifact = await store.saveJson(transcriptName, transcriptArtifact);
          }
        } catch (transcriptError) {
          if (invocationError === undefined) throw transcriptError;
        } finally {
          runtime.activeTranscripts.delete(key);
          runtime.transcriptRevision++;
        }
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
      if (!OUTPUT_CORRECTABLE_AGENTS.has(agent)) {
        throw new Error(`${agent} returned invalid structured output after a potentially mutating session: ${messageOf(validationError)}`);
      }
      const rawPath = validationError instanceof ValidationError ? validationError.path : undefined;
      const fieldPath = rawPath && /^[a-zA-Z0-9_.\[\]-]+$/.test(rawPath) ? rawPath : undefined;
      const correctionEnvelope: AgentTaskEnvelope<AgentTaskMap[A]> = {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode: "correct_output",
        task: payload,
        memoryContext: memoryEnvelope,
        correction: { attempt: 1, reason: "schema_validation_failed", ...(fieldPath ? { fieldPath } : {}) }
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
    }
    if (beforeWorkspace) {
      const afterWorkspace = await createWorkspaceSnapshot(cwd, { excludedRoots: workspaceExclusions(runtime, cwd) });
      await validateAgentMutation(runtime, agent, qualifier.mutationPlan, output, compareWorkspaceSnapshots(beforeWorkspace, afterWorkspace), step, store);
    }
    const artifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "output" });
    step.artifact = await store.saveJson(artifact, { output, usage: result.usage });
    throwIfAborted(runtime);
    step.status = "succeeded";
    step.message = `${agent} completed`;
    status.status = "succeeded";
    status.summary = result.text.slice(0, 500);
    status.completedAt = runtime.timestamp();
    return output;
  } catch (error) {
    const cancelled = controller.signal.aborted || error instanceof AgentCancelledError;
    step.status = cancelled ? "cancelled" : "failed";
    step.message = messageOf(error);
    status.status = cancelled ? "cancelled" : "failed";
    status.error = messageOf(error);
    status.completedAt = runtime.timestamp();
    if (rawText === undefined) {
      const errorArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "execution-error" });
      const details = error instanceof AgentIncompleteResponseError
        ? { kind: "agent_incomplete_response", error: error.message, agent: error.agent, stopReason: error.stopReason, provider: error.provider, model: error.model, providerError: error.providerError, partialText: error.partialText, usage: error.usage }
        : { error: messageOf(error) };
      step.artifact = await store.saveJson(errorArtifact, details);
    }
    throw error;
  } finally {
    step.completedAt = runtime.timestamp();
    state.activeAgent = undefined;
    await persist(runtime, ctx);
  }
}
