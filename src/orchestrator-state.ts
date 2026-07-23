import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AgentCancelledError } from "./agent-runner.js";
import { formatCancelledRun, formatFailedRun } from "./session-messages.js";
import type { AgentName, Stage, StepRecord } from "./types.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { messageOf } from "./orchestrator-helpers.js";
import { WorkflowCancelledError, WorkflowTerminationError } from "./workflow-errors.js";

export function beginStep(
  runtime: OrchestratorRuntime,
  stage: Stage,
  label: string,
  agent?: AgentName,
  qualifier: { attempt?: number; revision?: number } = {}
): StepRecord {
  const state = runtime.requireState();
  const sequence = state.steps.length + 1;
  const step: StepRecord = {
    id: `step-${String(sequence).padStart(3, "0")}`,
    sequence,
    stage,
    label,
    status: "running",
    agent,
    attempt: qualifier.attempt,
    revision: qualifier.revision,
    startedAt: runtime.timestamp()
  };
  state.steps.push(step);
  return step;
}

export async function transition(
  runtime: OrchestratorRuntime,
  stage: Stage,
  activeAgent: AgentName | undefined,
  message: string,
  ctx: ExtensionCommandContext
): Promise<void> {
  const state = runtime.requireState();
  state.stage = stage;
  state.activeAgent = activeAgent;
  state.message = message;
  state.updatedAt = runtime.timestamp();
  await runtime.store?.event("transition", { stage, activeAgent, message });
  await persist(runtime, ctx);
}

export async function persist(runtime: OrchestratorRuntime, ctx: ExtensionCommandContext): Promise<void> {
  const state = runtime.requireState();
  await runtime.store?.saveState(state);
  const vm = runtime.getViewModel();
  if (vm) runtime.dashboard.publish(vm);
  if (runtime.config && runtime.onStateChange) runtime.onStateChange(state, runtime.config, ctx);
  try {
    runtime.pi.appendEntry("pi-orchestrator-run", {
      runId: state.runId,
      stage: state.stage,
      failedStage: state.failedStage,
      stoppedStage: state.stoppedStage,
      termination: state.termination,
      status: state.status,
      runDir: state.runDir
    });
  } catch {
    // Run artifacts remain authoritative if session persistence is unavailable.
  }
}

export function updateAgentActivity(
  runtime: OrchestratorRuntime,
  event: { type: string; toolName?: string; args?: string; isError?: boolean; text?: string }
): void {
  const state = runtime.state;
  if (!state) return;
  switch (event.type) {
    case "tool_execution_start":
      state.currentTool = event.toolName;
      state.currentToolArgs = event.args;
      state.toolStatus = undefined;
      break;
    case "tool_execution_end":
      state.toolStatus = event.isError ? "error" : "ok";
      break;
    case "auto_retry_start":
      state.toolStatus = "retrying";
      break;
    case "message_update":
      if (event.text) state.agentOutput = (state.agentOutput ?? []).concat(event.text).slice(-5);
      break;
  }
}

export function throttledPersist(runtime: OrchestratorRuntime, ctx: ExtensionCommandContext): void {
  if (runtime.persistTimer) return;
  runtime.persistTimer = setTimeout(() => {
    runtime.persistTimer = undefined;
    const state = runtime.state;
    if (!state) return;
    state.updatedAt = runtime.timestamp();
    const vm = runtime.getViewModel();
    if (vm) runtime.dashboard.publish(vm);
    if (runtime.config && runtime.onStateChange) runtime.onStateChange(state, runtime.config, ctx);
  }, 500);
}

export function publishSessionMessage(runtime: OrchestratorRuntime, content: string, details?: Record<string, unknown>): void {
  try {
    runtime.pi.sendMessage({
      customType: "pi-orchestrator",
      content,
      display: true,
      details: { runId: runtime.state?.runId, ...details }
    });
  } catch {
    // Session messaging is supplementary; never fail the workflow.
  }
}

export function throwIfAborted(runtime: OrchestratorRuntime): void {
  const signal = runtime.requireController().signal;
  if (signal.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError("Workflow cancelled", "command");
  }
}

export async function fail(runtime: OrchestratorRuntime, error: unknown, ctx: ExtensionCommandContext): Promise<void> {
  const state = runtime.state;
  const controller = runtime.controller;
  if (!state || !controller) throw error;
  const abortReason = controller.signal.reason;
  const effectiveError = controller.signal.aborted && abortReason instanceof Error ? abortReason : error;
  const cancelled = effectiveError instanceof WorkflowCancelledError || controller.signal.aborted || error instanceof AgentCancelledError;
  state.stoppedStage = state.stage;
  state.failedStage = cancelled ? undefined : state.stage;
  state.status = cancelled ? "cancelled" : "failed";
  state.completedAt = runtime.timestamp();
  state.waitingFor = undefined;
  state.humanGate = undefined;
  const message = messageOf(effectiveError);
  state.termination = effectiveError instanceof WorkflowTerminationError
    ? { ...effectiveError.termination, stoppedStage: state.stoppedStage }
    : {
        kind: cancelled ? "cancelled" : "workflow_failed",
        code: cancelled ? "cancelled" : "workflow_failed",
        status: cancelled ? "cancelled" : "failed",
        message,
        stoppedStage: state.stoppedStage
      };
  try {
    await transition(runtime, cancelled ? "cancelled" : "failed", undefined, message, ctx);
  } catch {
    state.stage = cancelled ? "cancelled" : "failed";
    state.message = message;
  }
  try {
    const formatted = cancelled
      ? formatCancelledRun(state.stoppedStage ?? state.stage, message, state.runDir, state)
      : formatFailedRun(state.stoppedStage ?? state.stage, message, state.runDir, state);
    publishSessionMessage(runtime, formatted, { kind: cancelled ? "cancelled" : "failed" });
  } catch {
    // Session messaging is supplementary.
  }
  ctx.ui.notify(state.message ?? message, cancelled ? "warning" : "error");
}
