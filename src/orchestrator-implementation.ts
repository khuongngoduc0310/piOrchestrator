import { formatVerifiedImplementation } from "./session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseTesterOutput } from "./validation.js";
import type { CheckResult, DebuggerOutput, BuilderTask } from "./types.js";
import type { ImplementationPlanningResult, ImplementationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { publishSessionMessage } from "./orchestrator-state.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";

export type ImplementationContinuation =
  | { point: "tester_completed"; tester: NonNullable<ImplementationResult["tester"]>; diagnosis?: DebuggerOutput }
  | {
      point: "builder_completed";
      tester?: ImplementationResult["tester"];
      checksAfterTests: CheckResult[];
      previousChecks?: CheckResult[];
      diagnosis?: DebuggerOutput;
      completedAttempt: number;
    };

export async function runImplementationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  continuation?: ImplementationContinuation,
  options: { skipTester?: boolean; initialDiagnosis?: DebuggerOutput } = {}
): Promise<ImplementationResult> {
  const { request, ctx, config, store } = workflow;
  const { plan, baseline } = planning;
  const tester = options.skipTester ? undefined : continuation?.tester ?? await runAgentStep(
      runtime,
      "tester",
      "creating_tests",
      "Create acceptance tests",
      {
        action: "create_tests",
        request,
        plan,
        acceptanceCriteria: plan.acceptanceCriteria.map((text, index) => ({ index, text })),
        baselineChecks: baseline,
        diagnosis: options.initialDiagnosis
      },
      workflow.mutationCwd,
      ctx,
      text => parseTesterOutput(text, plan.acceptanceCriteria),
      { mutationPlan: plan }
    );
  if (!options.skipTester && !continuation) {
    await saveWorkflowCheckpoint(runtime, workflow, "tester_completed", { planning, tester, diagnosis: options.initialDiagnosis }, {
      exploration: planning.exploration, plan, baselineChecks: baseline, tester
      , diagnosis: options.initialDiagnosis
    });
  }
  const checksAfterTests = options.skipTester
    ? baseline
    : continuation?.point === "builder_completed"
    ? continuation.checksAfterTests
    : await runCheckStep(runtime, "testing", "Run checks after test creation", workflow.mutationCwd, ctx, { requireGreen: false, kind: "after-tests" });

  let diagnosis: DebuggerOutput | undefined = continuation?.diagnosis ?? options.initialDiagnosis;
  const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
  let implAttemptChecks: CheckResult[] | undefined = continuation?.point === "builder_completed" ? continuation.previousChecks : undefined;
  let firstAttempt = 1;
  if (continuation?.point === "builder_completed") {
    const attempt = continuation.completedAttempt;
    runtime.requireState().attempt = attempt;
    implAttemptChecks = await runCheckStep(runtime, "testing", `Run implementation checks (attempt ${attempt})`, workflow.mutationCwd, ctx, {
      requireGreen: false,
      attempt,
      kind: "implementation"
    });
    if (!allGreen(implAttemptChecks, config.checks.length)) {
      if (attempt === maxAttempts) throw new Error("Implementation retry limit reached with failing checks");
      diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Diagnose check failures", {
        action: "diagnose_implementation", request, plan, checks: implAttemptChecks, attempt
      }, workflow.mutationCwd, ctx, parseDebuggerOutput, { attempt });
      firstAttempt = attempt + 1;
    } else {
      firstAttempt = maxAttempts + 1;
    }
  }
  for (let attempt = firstAttempt; attempt <= maxAttempts; attempt++) {
    runtime.requireState().attempt = attempt;
    const builderTask: BuilderTask = attempt === 1
      ? { action: "implement", request, plan, tester, checks: implAttemptChecks ?? checksAfterTests, diagnosis, attempt }
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
    await saveWorkflowCheckpoint(runtime, workflow, "builder_completed", {
      mode: "implementation",
      planning,
      tester,
      checksAfterTests,
      previousChecks: implAttemptChecks,
      diagnosis,
      completedAttempt: attempt
    }, {
      exploration: planning.exploration,
      plan,
      baselineChecks: baseline,
      tester,
      builderOutputs: runtime.builderSessionOutputs,
      implementationChecks: implAttemptChecks,
      diagnosis
    });
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
  const result = { ...planning, tester, finalImplChecks: implAttemptChecks, diagnosis };
  await saveWorkflowCheckpoint(runtime, workflow, "implementation_verified", result, {
    exploration: planning.exploration, plan, baselineChecks: baseline, tester,
    builderOutputs: runtime.builderSessionOutputs, implementationChecks: implAttemptChecks, diagnosis
  });
  return result;
}
