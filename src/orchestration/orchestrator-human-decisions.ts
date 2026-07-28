import { CheckpointPostCommitError, currentWorkspaceDigest, saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { messageOf } from "./orchestrator-helpers.js";
import { persist, publishMilestone, recordMarkdownMilestone } from "./orchestrator-state.js";
import type { CheckpointBindings } from "../persistence/checkpoint-types.js";
import type {
  HumanDecisionKind,
  HumanDecisionAction,
  HumanDecisionResumePoint,
  RecordedHumanDecision
} from "./human-decision-types.js";
import type { DashboardDecisionPresentation } from "../dashboard-types.js";
import type { DashboardDecisionSubmission } from "../ui/dashboard.js";
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
  dashboard: DashboardDecisionPresentation;
}

function formatDecisionAwaitingReview(kind: HumanDecisionKind, label: string, content: string): string {
  const title = kind === "plan_approval" || kind === "plan_revision_approval"
    ? "Plan awaiting review"
    : `${label} awaiting review`;
  return `## ${title}\n\n**Decision:** ${label}\n\n${content}`;
}

/**
 * Core durable human gate:
 * Register the dashboard before publishing the pending checkpoint, then race it
 * against an abortable Pi prompt. The winner is workspace-validated and recorded once.
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
  const workflowSignal = runtime.requireController().signal;
  if (workflowSignal.aborted) {
    const reason = workflowSignal.reason;
    throw reason instanceof WorkflowCancelledError ? reason : new WorkflowCancelledError("Workflow cancelled", "command");
  }
  const gateController = new AbortController();
  const cancelGate = (): void => gateController.abort(workflowSignal.reason);
  workflowSignal.addEventListener("abort", cancelGate, { once: true });
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

  // Register before checkpoint publication so every advertised decision is answerable.
  const hasDashboard = runtime.dashboard.isListening;
  let dashboardWait: Promise<DashboardDecisionSubmission> | undefined;
  if (hasDashboard) {
    try {
      dashboardWait = runtime.dashboard.registerDecision(
        id,
        interaction.dashboard,
        gateController.signal,
      );
    } catch (error) {
      if (!gateController.signal.aborted) gateController.abort(error);
      workflowSignal.removeEventListener("abort", cancelGate);
      throw new GateInteractionError(`${interaction.label} dashboard registration failed: ${messageOf(error)}`, { cause: error });
    }
    void dashboardWait.catch(() => undefined);
  }

  const milestoneId = `decision:${id}:requested`;
  const milestoneExisted = state.milestones?.some(entry => entry.id === milestoneId) === true;
  const awaitingMilestone = recordMarkdownMilestone(
    runtime,
    milestoneId,
    "human_decision_requested",
    formatDecisionAwaitingReview(kind, interaction.label, interaction.dashboard.content),
    id
  );

  let pendingCheckpoint;
  try {
    pendingCheckpoint = await saveWorkflowCheckpoint(
      runtime,
      workflow,
      "human_decision_pending",
      { request: state.pendingDecision },
      bindings
    );
  } catch (error) {
    runtime.dashboard.unregisterDecision(id, error);
    if (!gateController.signal.aborted) gateController.abort(error);
    workflowSignal.removeEventListener("abort", cancelGate);
    if (!(error instanceof CheckpointPostCommitError)) {
      if (!milestoneExisted) state.milestones = state.milestones?.filter(entry => entry.id !== milestoneId);
      state.pendingDecision = undefined;
      state.waitingFor = undefined;
      state.humanGate = undefined;
    }
    throw error;
  }

  if (!milestoneExisted) publishMilestone(runtime, awaitingMilestone);

  await persist(runtime, ctx);

  if (!dashboardWait && !canPrompt) {
    workflowSignal.removeEventListener("abort", cancelGate);
    if (mode === "mandatory") {
      throw new WorkflowPausedError(id, `${interaction.label} is awaiting human input`);
    }
    state.status = "running";
    state.pendingDecision = undefined;
    state.waitingFor = undefined;
    state.humanGate = undefined;
    await persist(runtime, ctx).catch(() => undefined);
    throw new HumanGateUnavailableError(`${interaction.label} requires TUI, RPC, or dashboard mode`);
  }

  type Winner = {
    source: "dashboard" | "pi";
    result: Awaited<ReturnType<GateInteraction<T>["prompt"]>>;
    acknowledge?: (error?: unknown) => void;
  };
  const candidates: Promise<Winner>[] = [];
  if (dashboardWait) candidates.push(dashboardWait.then(({ acknowledge, ...result }) => ({ source: "dashboard", result, acknowledge })));
  if (canPrompt) candidates.push(interaction.prompt(gateController.signal).then(result => ({ source: "pi", result })));

  let winner: Winner;
  try {
    winner = await Promise.race(candidates);
  } catch (error) {
    if (dashboardWait) void dashboardWait.then(submission => submission.acknowledge(error), () => undefined);
    runtime.dashboard.unregisterDecision(id, error);
    if (!gateController.signal.aborted) gateController.abort(error);
    workflowSignal.removeEventListener("abort", cancelGate);
    if (workflowSignal.aborted) {
      const reason = workflowSignal.reason;
      throw reason instanceof WorkflowCancelledError ? reason : new WorkflowCancelledError("Workflow cancelled", "command", { cause: error });
    }
    state.status = "running";
    state.pendingDecision = undefined;
    state.waitingFor = undefined;
    state.humanGate = undefined;
    await persist(runtime, ctx).catch(() => undefined);
    if (error instanceof WorkflowTerminationError) throw error;
    throw new GateInteractionError(`${interaction.label} interaction failed: ${messageOf(error)}`, { cause: error });
  }

  if (winner.source === "pi") {
    const reason = new Error("Pi prompt completed first");
    runtime.dashboard.unregisterDecision(id, reason);
    if (dashboardWait) void dashboardWait.then(submission => submission.acknowledge(reason), () => undefined);
  }
  if (!gateController.signal.aborted) gateController.abort(new Error(`${winner.source} decision completed first`));

  const raw = winner.result;
  if (raw === undefined || raw === "defer") {
    workflowSignal.removeEventListener("abort", cancelGate);
    state.status = "paused";
    state.humanGate = undefined;
    await persist(runtime, ctx).catch(() => undefined);
    throw new WorkflowPausedError(id, `${interaction.label} was deferred`);
  }
  const promptResult = { action: raw.action, feedback: raw.feedback };
  const fromDashboard = winner.source === "dashboard";

  try {
    const recordedSource = fromDashboard ? "dashboard" as const : ctx.mode === "rpc" ? "rpc" as const : "tui" as const;
    const recorded: RecordedHumanDecision = {
      schemaVersion: 1 as const,
      requestId: id,
      decidedAt: runtime.timestamp(),
      source: recordedSource,
      action: promptResult.action,
      feedback: promptResult.feedback
    };

    const workspaceRoot = workflow.worktreeHandle?.effectiveCwd ?? workflow.cwd;
    const decidedWorkspaceDigest = await currentWorkspaceDigest(runtime, workspaceRoot);
    if (decidedWorkspaceDigest !== pendingCheckpoint.workspaceDigest) {
      await workflow.store.saveJson(`human-decision-workspace-drift-${id}.json`, {
        decisionId: id,
        kind,
        expectedWorkspaceDigest: pendingCheckpoint.workspaceDigest,
        actualWorkspaceDigest: decidedWorkspaceDigest,
        detectedAt: runtime.timestamp()
      }).catch(() => undefined);
      state.status = "paused";
      state.warning = `${interaction.label} was not recorded because the workspace changed while awaiting input`;
      await persist(runtime, ctx).catch(() => undefined);
      const error = new WorkflowPausedError(id, `${interaction.label} must be repeated after restoring the checkpoint workspace`);
      winner.acknowledge?.(error);
      throw error;
    }

    await saveWorkflowCheckpoint(runtime, workflow, "human_decision_recorded", {
      request: state.pendingDecision,
      recorded
    }, bindings);

    state.status = "running";
    state.pendingDecision = undefined;
    state.waitingFor = undefined;
    state.humanGate = undefined;
    await persist(runtime, ctx);
    winner.acknowledge?.();

    if (promptResult.action === "cancel") {
      throw new WorkflowCancelledError(`${interaction.label} was cancelled by the user`, "human_gate");
    }
    return interaction.parse(promptResult as Exclude<typeof raw, undefined | "defer" | { action: "cancel" }>);
  } catch (error) {
    winner.acknowledge?.(error);
    throw error;
  } finally {
    workflowSignal.removeEventListener("abort", cancelGate);
  }
}
