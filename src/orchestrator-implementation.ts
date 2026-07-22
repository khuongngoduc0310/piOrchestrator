import { formatVerifiedImplementation } from "./session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseTesterOutput } from "./validation.js";
import type { CheckResult, DebuggerOutput, BuilderTask } from "./types.js";
import type { ImplementationResult, PlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { publishSessionMessage } from "./orchestrator-state.js";

export async function runImplementationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult
): Promise<ImplementationResult> {
  const { request, ctx, config, store } = workflow;
  const { plan, baseline } = planning;
  const tester = await runAgentStep(
    runtime,
    "tester",
    "creating_tests",
    "Create acceptance tests",
    {
      action: "create_tests",
      request,
      plan,
      acceptanceCriteria: plan.acceptanceCriteria.map((text, index) => ({ index, text })),
      baselineChecks: baseline
    },
    workflow.mutationCwd,
    ctx,
    text => parseTesterOutput(text, plan.acceptanceCriteria),
    { mutationPlan: plan }
  );
  const checksAfterTests = await runCheckStep(runtime, "testing", "Run checks after test creation", workflow.mutationCwd, ctx, { requireGreen: false, kind: "after-tests" });

  let diagnosis: DebuggerOutput | undefined;
  const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
  let implAttemptChecks: CheckResult[] | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    runtime.requireState().attempt = attempt;
    const builderTask: BuilderTask = attempt === 1
      ? { action: "implement", request, plan, tester, checks: implAttemptChecks ?? checksAfterTests, attempt }
      : { action: "fix_failure", request, plan, tester, checks: implAttemptChecks ?? checksAfterTests, diagnosis: diagnosis!, attempt };
    const builderOut = await runAgentStep(
      runtime,
      "builder",
      "implementing",
      attempt === 1 ? "Implement approved plan" : "Fix diagnosed check failures",
      builderTask,
      workflow.mutationCwd,
      ctx,
      parseBuilderOutput,
      { attempt, mutationPlan: plan }
    );
    runtime.builderSessionOutputs.push(builderOut);
    implAttemptChecks = await runCheckStep(runtime, "testing", `Run implementation checks (attempt ${attempt})`, workflow.mutationCwd, ctx, {
      requireGreen: false,
      attempt,
      kind: "implementation"
    });
    if (allGreen(implAttemptChecks, config.checks.length)) break;
    if (attempt === maxAttempts) throw new Error("Implementation retry limit reached with failing checks");
    diagnosis = await runAgentStep(
      runtime,
      "debugger",
      "debugging",
      "Diagnose check failures",
      { action: "diagnose_implementation", request, plan, checks: implAttemptChecks, attempt },
      workflow.mutationCwd,
      ctx,
      parseDebuggerOutput,
      { attempt }
    );
  }
  if (!implAttemptChecks || !allGreen(implAttemptChecks, config.checks.length)) throw new Error("Implementation did not reach a verified state");
  publishSessionMessage(
    runtime,
    formatVerifiedImplementation(plan, runtime.builderSessionOutputs, implAttemptChecks, !!config.limits.worktreeIsolation, store.runDir),
    { kind: "implementation_verified" }
  );
  return { ...planning, tester, finalImplChecks: implAttemptChecks, diagnosis };
}
