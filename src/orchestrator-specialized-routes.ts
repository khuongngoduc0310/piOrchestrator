import type { ImplementationPlanningResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { parseDocumenterOutput, parseTesterOutput } from "./validation.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { runSpecializedMutationFinalization } from "./orchestrator-finalization.js";
import type { CheckResult } from "./types.js";

export async function runSpecializedMutationRoute(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  restored?: SpecializedMutationResult,
  restoredFinalChecks?: CheckResult[]
): Promise<void> {
  let result = restored;
  if (!result && workflow.route === "tests_only") {
    const tester = await runAgentStep(runtime, "tester", "creating_tests", "Add requested tests", {
      action: "create_tests",
      request: workflow.request,
      plan: planning.plan,
      acceptanceCriteria: planning.plan.acceptanceCriteria.map((text, index) => ({ index, text })),
      baselineChecks: planning.baseline
    }, workflow.mutationCwd, workflow.ctx, text => parseTesterOutput(text, planning.plan.acceptanceCriteria), { mutationPlan: planning.plan });
    result = { ...planning, route: "tests_only", tester };
  } else if (!result && workflow.route === "documentation_only") {
    const documentation = await runAgentStep(runtime, "documenter", "documenting", "Update requested documentation", {
      action: "document_only",
      request: workflow.request,
      plan: planning.plan,
      baselineChecks: planning.baseline
    }, workflow.mutationCwd, workflow.ctx, parseDocumenterOutput, { mutationPlan: planning.plan });
    if (documentation.proposedLessons.length > 0) throw new Error("Documentation-only workflows cannot propose permanent-memory lessons");
    result = { ...planning, route: "documentation_only", documentation };
  }
  if (!result) throw new Error(`Unsupported specialized mutation route: ${workflow.route}`);
  if (result.route !== workflow.route) throw new Error("Specialized mutation result route does not match the selected workflow route");

  if (!restored) {
    await saveWorkflowCheckpoint(runtime, workflow, "route_agent_completed", result, {
      exploration: result.exploration,
      plan: result.plan,
      baselineChecks: result.baseline,
      ...(result.route === "tests_only" ? { tester: result.tester } : { documentation: result.documentation })
    });
  }
  const finalChecks = restoredFinalChecks ?? await runCheckStep(runtime, "testing", "Run final checks", workflow.mutationCwd, workflow.ctx, {
    requireGreen: true,
    kind: "final"
  });
  if (!restoredFinalChecks) {
    await saveWorkflowCheckpoint(runtime, workflow, "route_final_checks_passed", { result, finalChecks }, {
      exploration: result.exploration,
      plan: result.plan,
      baselineChecks: result.baseline,
      ...(result.route === "tests_only" ? { tester: result.tester } : { documentation: result.documentation })
    });
  }
  await runSpecializedMutationFinalization(runtime, workflow, result, finalChecks);
}
