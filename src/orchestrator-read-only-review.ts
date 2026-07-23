import { formatRepositoryReview } from "./session-messages.js";
import { parseReviewOutput } from "./validation.js";
import type { PlanningResult, ReadOnlyReviewResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";

export async function runReadOnlyReviewPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult
): Promise<ReadOnlyReviewResult> {
  const codeReview = await runAgentStep(
    runtime,
    "reviewer",
    "reviewing_repository",
    "Review repository",
    {
      reviewType: "repository",
      request: workflow.request,
      exploration: planning.exploration,
      plan: planning.plan,
      baseline: runtime.requireBaselineReviewContext()
    },
    workflow.cwd,
    workflow.ctx,
    parseReviewOutput
  );
  publishSessionMessage(runtime, formatRepositoryReview(codeReview), { kind: "repository_reviewed" });
  const result = { ...planning, codeReview };
  await saveWorkflowCheckpoint(runtime, workflow, "repository_reviewed", result, {
    exploration: planning.exploration,
    plan: planning.plan,
    codeReview
  });
  return result;
}
