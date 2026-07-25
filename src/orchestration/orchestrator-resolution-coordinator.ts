import { randomUUID } from "node:crypto";
import type { AgentName, AgentOutputMap, AgentTaskMap, PlannerOutput, Stage } from "../types.js";
import type { AgentResolutionRequest, ResolutionOutcome, ResolutionRecord } from "../agent-task-types.js";
import type { ImplementationPlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { resolveAgentBlocker } from "./orchestrator-resolution.js";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export type ResolutionStepResult = {
  readonly output: AgentOutputMap[keyof AgentOutputMap] & { blocker?: AgentResolutionRequest };
  readonly planning: ImplementationPlanningResult;
  readonly resolutionRecord?: ResolutionRecord;
  readonly resolutionOutcome?: ResolutionOutcome;
  readonly resolutionLedger: readonly ResolutionRecord[];
};

export async function runAgentStepWithResolution<A extends AgentName>(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  agent: A,
  stage: Stage,
  label: string,
  payload: AgentTaskMap[A],
  cwd: string,
  ctx: ExtensionCommandContext,
  validate: (text: string) => AgentOutputMap[A],
  qualifier?: { attempt?: number; revision?: number; mutationPlan?: PlannerOutput }
): Promise<ResolutionStepResult> {
  const output = await runAgentStep(runtime, agent, stage, label, payload, cwd, ctx, validate, qualifier);
  const outputWithBlocker = output as AgentOutputMap[keyof AgentOutputMap] & { blocker?: AgentResolutionRequest };

  if (!outputWithBlocker.blocker) {
    return { output, planning, resolutionLedger: [] };
  }

  const ledger: ResolutionRecord[] = [];
  const record: ResolutionRecord = {
    id: randomUUID(),
    request: outputWithBlocker.blocker,
    agent,
    status: "pending",
    createdAt: runtime.timestamp(),
    updatedAt: runtime.timestamp()
  };
  ledger.push(record);

  await saveWorkflowCheckpoint(
    runtime, workflow, "resolution_pending",
    { record, planning },
    { exploration: planning.exploration, plan: planning.plan, resolutionLedger: [...ledger] }
  );

  record.status = "in_progress";

  if (outputWithBlocker.blocker.kind === "scope") {
    return { output, planning, resolutionRecord: record, resolutionLedger: ledger };
  }

  const resolved = await resolveAgentBlocker(runtime, workflow, planning, outputWithBlocker.blocker);

  const outcome: ResolutionOutcome = {
    type: outputWithBlocker.blocker.kind === "baseline_repair" || outputWithBlocker.blocker.kind === "prerequisite_repair"
      ? "baseline_repair"
      : outputWithBlocker.blocker.kind === "insufficient_evidence"
      ? "abandoned"
      : "human_intervention",
    detail: outputWithBlocker.blocker.reason
  };

  record.status = "resolved";
  record.outcome = outcome;
  record.updatedAt = runtime.timestamp();

  return { output, planning: resolved.planning, resolutionRecord: record, resolutionOutcome: outcome, resolutionLedger: ledger };
}
