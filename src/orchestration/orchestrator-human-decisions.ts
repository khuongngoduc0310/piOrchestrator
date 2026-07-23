import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { messageOf } from "./orchestrator-helpers.js";
import { persist } from "./orchestrator-state.js";
import type { CheckpointBindings } from "../persistence/checkpoint-types.js";
import type {
  HumanDecisionKind,
  HumanDecisionAction,
  HumanDecisionResumePoint,
  RecordedHumanDecision
} from "./human-decision-types.js";
import { HumanGateUnavailableError, WorkflowCancelledError, WorkflowPausedError, GateInteractionError, WorkflowTerminationError } from "./workflow-errors.js";

let decisionCounter = 0;

function nextDecisionId(): string {
  decisionCounter++;
  return `decision-${Date.now()}-${decisionCounter}`;
}

export interface GateInteraction<T> {
  label: string;
  prompt: (signal: AbortSignal) => Promise<{ action: HumanDecisionAction; feedback?: string } | undefined | "defer">;
  parse: (result: Exclude<Awaited<ReturnType<GateInteraction<T>["prompt"]>>, undefined | "defer" | { action: "cancel" }>) => T;
}

/**
 * Core durable human gate:
 * 1. Save a human_decision_pending checkpoint.
 * 2. Set paused state.
 * 3. If UI available, prompt.
 * 4. If answer received, save human_decision_recorded, clear pause, return.
 * 5. If no UI / defer / interrupt, throw WorkflowPausedError.
 */
export async function requestHumanDecision<T>(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  kind: HumanDecisionKind,
  mode: "mandatory" | "optional",
  resume: HumanDecisionResumePoint,
  bindings: CheckpointBindings,
  interaction: GateInteraction<T>
): Promise<T> {
  const state = runtime.requireState();
  const { ctx } = workflow;

  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  const existing = state.pendingDecision;
  const request = existing?.kind === kind && JSON.stringify(existing.resume) === JSON.stringify(resume)
    ? existing
    : {
        schemaVersion: 1 as const,
        id: nextDecisionId(),
        kind,
        label: interaction.label,
        requestedAt: runtime.timestamp(),
        resume
      };
  const id = request.id;

  state.pendingDecision = request;
  state.waitingFor = interaction.label;
  state.humanGate = { kind, label: interaction.label, startedAt: runtime.timestamp() };
  state.status = "paused";
  state.activeAgent = undefined;

  await saveWorkflowCheckpoint(runtime, workflow, "human_decision_pending", { request: state.pendingDecision }, bindings);
  await persist(runtime, ctx);

  if (!canPrompt) {
    if (mode === "mandatory") {
      throw new WorkflowPausedError(id, `${interaction.label} is awaiting human input`);
    }
    state.status = "running";
    state.pendingDecision = undefined;
    state.waitingFor = undefined;
    state.humanGate = undefined;
    await persist(runtime, ctx).catch(() => undefined);
    throw new HumanGateUnavailableError(`${interaction.label} requires TUI or RPC mode`);
  }

  const signal = runtime.requireController().signal;

  let promptResult: { action: HumanDecisionAction; feedback?: string } | undefined;

  try {
    const raw = await interaction.prompt(signal);
    if (raw === undefined || raw === "defer") {
      throw new WorkflowPausedError(id, `${interaction.label} was deferred`);
    }
    const { action, feedback } = raw;
    if (action === "cancel") {
      throw new WorkflowCancelledError(`${interaction.label} was cancelled by the user`, "human_gate");
    }
    promptResult = { action, feedback };
  } catch (error) {
    if (error instanceof WorkflowPausedError) {
      state.status = "paused";
      await persist(runtime, ctx).catch(() => undefined);
      throw error;
    }

    state.status = "running";
    state.pendingDecision = undefined;
    state.waitingFor = undefined;
    state.humanGate = undefined;

    if (error instanceof WorkflowTerminationError) throw error;
    if (signal.aborted) {
      const reason = signal.reason;
      throw reason instanceof WorkflowCancelledError ? reason : new WorkflowCancelledError("Workflow cancelled", "command", { cause: error });
    }
    await persist(runtime, ctx).catch(() => undefined);
    throw new GateInteractionError(`${interaction.label} interaction failed: ${messageOf(error)}`, { cause: error });
  }

  const recorded: RecordedHumanDecision = {
    schemaVersion: 1 as const,
    requestId: id,
    decidedAt: runtime.timestamp(),
    source: "tui",
    action: promptResult.action,
    feedback: promptResult.feedback
  };

  await saveWorkflowCheckpoint(runtime, workflow, "human_decision_recorded", {
    request: state.pendingDecision,
    recorded
  }, bindings);

  state.status = "running";
  state.pendingDecision = undefined;
  state.waitingFor = undefined;
  state.humanGate = undefined;
  await persist(runtime, ctx);

  return interaction.parse(promptResult);
}
