import type { ImplementationPlanningResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { parseDebuggerOutput, parseDocumenterOutput, parseTesterOutput } from "./validation.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { runSpecializedMutationFinalization } from "./orchestrator-finalization.js";
import type { CheckResult, DocumenterOutput, TesterOutput } from "./types.js";
import { assertDocumenterComplete, assertTesterComplete } from "./mutation-completion.js";
import { allGreen } from "./orchestrator-helpers.js";
import { deriveRoleMutationPaths } from "./workspace-guard.js";
import { CheckFailureError } from "./workflow-errors.js";

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
      baselineChecks: planning.baseline,
      diagnosis: planning.baselineDiagnosis
    }, workflow.mutationCwd, workflow.ctx, text => parseTesterOutput(text, planning.plan.acceptanceCriteria), { mutationPlan: planning.plan });
    assertTesterComplete(tester, workflow.route);
    result = { ...planning, route: "tests_only", tester };
  } else if (!result && workflow.route === "documentation_only") {
    const documentation = await runAgentStep(runtime, "documenter", "documenting", "Update requested documentation", {
      action: "document_only",
      request: workflow.request,
      plan: planning.plan,
      baselineChecks: planning.baseline
    }, workflow.mutationCwd, workflow.ctx, parseDocumenterOutput, { mutationPlan: planning.plan });
    assertDocumenterComplete(documentation);
    if (documentation.proposedLessons.length > 0) throw new Error("Documentation-only workflows cannot propose permanent-memory lessons");
    result = { ...planning, route: "documentation_only", documentation };
  }
  if (!result) throw new Error(`Unsupported specialized mutation route: ${workflow.route}`);
  if (result.route !== workflow.route) throw new Error("Specialized mutation result route does not match the selected workflow route");
  if (result.route === "tests_only") assertTesterComplete(result.tester, result.route);
  else assertDocumenterComplete(result.documentation);

  if (!restored) {
    await saveWorkflowCheckpoint(runtime, workflow, "route_agent_completed", result, {
      exploration: result.exploration,
      plan: result.plan,
      baselineChecks: result.baseline,
      ...(result.route === "tests_only" ? { tester: result.tester } : { documentation: result.documentation })
    });
  }
  let finalChecks = restoredFinalChecks;
  if (!finalChecks) {
    const maxAttempts = Math.max(1, workflow.config.limits.implementationRetries + 1);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      finalChecks = await runCheckStep(runtime, "testing", "Run final checks", workflow.mutationCwd, workflow.ctx, {
        requireGreen: false,
        attempt,
        kind: "final"
      });
      if (allGreen(finalChecks, workflow.config.checks.length)) break;
      const diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Diagnose specialized final check failures", {
        action: "diagnose_verification",
        request: workflow.request,
        plan: result!.plan,
        checks: finalChecks,
        phase: "final",
        attempt
      }, workflow.mutationCwd, workflow.ctx, parseDebuggerOutput, { attempt });
      const role = result!.route === "tests_only" ? "tester" : "documenter";
      const authorized = new Set(deriveRoleMutationPaths(role, result!.plan));
      const repairable = diagnosis.affectedFiles.length > 0
        && diagnosis.affectedFiles.every(file => authorized.has(file))
        && !["environment_error", "tooling_error", "unknown"].includes(diagnosis.category);
      if (!repairable || attempt === maxAttempts) {
        throw new CheckFailureError("Final checks", finalChecks.filter(check => !check.passed).map(check => check.command), diagnosis);
      }
      if (result!.route === "tests_only") {
        const previous: TesterOutput = result!.tester;
        const tester: TesterOutput = await runAgentStep(runtime, "tester", "creating_tests", "Repair test check failures", {
          action: "repair_checks",
          request: workflow.request,
          plan: result!.plan,
          acceptanceCriteria: result!.plan.acceptanceCriteria.map((text, index) => ({ index, text })),
          checks: finalChecks,
          diagnosis,
          previous,
          attempt
        }, workflow.mutationCwd, workflow.ctx, text => parseTesterOutput(text, result!.plan.acceptanceCriteria), { attempt, mutationPlan: result!.plan });
        assertTesterComplete(tester, result!.route);
        result = { ...result!, tester: { ...tester, changedFiles: [...new Set([...previous.changedFiles, ...tester.changedFiles])], testsAdded: [...new Set([...previous.testsAdded, ...tester.testsAdded])] } };
      } else {
        const previous: DocumenterOutput = result!.documentation;
        const documentation: DocumenterOutput = await runAgentStep(runtime, "documenter", "documenting", "Repair documentation check failures", {
          action: "repair_checks",
          request: workflow.request,
          plan: result!.plan,
          checks: finalChecks,
          diagnosis,
          previous,
          attempt
        }, workflow.mutationCwd, workflow.ctx, parseDocumenterOutput, { attempt, mutationPlan: result!.plan });
        assertDocumenterComplete(documentation);
        result = { ...result!, documentation: { ...documentation, changedFiles: [...new Set([...previous.changedFiles, ...documentation.changedFiles])] } };
      }
    }
  }
  if (!finalChecks || !allGreen(finalChecks, workflow.config.checks.length)) throw new Error("Specialized final checks did not reach a verified state");
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
