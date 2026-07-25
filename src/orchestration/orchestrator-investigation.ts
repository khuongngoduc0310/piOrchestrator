import { formatInvestigation } from "../ui/session-messages.js";
import { parseDebuggerOutput } from "../validation.js";
import type { InvestigationResult, PlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { publishSessionMessage } from "./orchestrator-state.js";

export async function runInvestigationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult
): Promise<InvestigationResult> {
  const diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Investigate request", {
    action: "diagnose_investigation",
    request: workflow.request,
    plan: planning.plan,
    exploration: planning.exploration
  }, workflow.cwd, workflow.ctx, parseDebuggerOutput);
  const result = { ...planning, diagnosis };
  publishSessionMessage(runtime, formatInvestigation(diagnosis), { kind: "investigation_completed" });
  await saveWorkflowCheckpoint(runtime, workflow, "investigation_completed", result, {
    exploration: planning.exploration,
    plan: planning.plan,
    diagnosis
  });
  return result;
}
