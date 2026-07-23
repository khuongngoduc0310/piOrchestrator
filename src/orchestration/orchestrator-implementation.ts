import { formatVerifiedImplementation } from "../ui/session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseTesterOutput } from "../validation.js";
import type { BuilderOutput, CheckResult, DebuggerOutput, BuilderTask } from "../types.js";
import type { ImplementationPlanningResult, ImplementationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { publishSessionMessage, transition } from "./orchestrator-state.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { deriveMutationPathScope } from "../workspace/workspace-guard.js";
import { filesOutsidePlan } from "./plan-revision.js";
import { reviseImplementationScope, type ScopeRevisionAfter } from "./orchestrator-scope-revision.js";
import { assertTesterComplete } from "./mutation-completion.js";
import { consumeScopeRevision } from "./scope-revision-budget.js";
import { CheckFailureError } from "./workflow-errors.js";
import { runDurableHumanGate } from "./orchestrator-human-gates.js";

export type ImplementationContinuation =
  | { point: "tester_completed"; tester: NonNullable<ImplementationResult["tester"]>; diagnosis?: DebuggerOutput }
  | {
      point: "scope_revision_approved";
      tester?: ImplementationResult["tester"];
      checksAfterTests: CheckResult[];
      previousChecks?: CheckResult[];
      diagnosis?: DebuggerOutput;
      attempt: number;
      scopeRevisionCount: number;
    }
  | {
      point: "builder_completed";
      tester?: ImplementationResult["tester"];
      checksAfterTests: CheckResult[];
      previousChecks?: CheckResult[];
      diagnosis?: DebuggerOutput;
      completedAttempt: number;
      scopeRevisionCount?: number;
    }
  | {
      point: "budget_extended";
      tester?: ImplementationResult["tester"];
      checksAfterTests: CheckResult[];
      failedChecks: CheckResult[];
      diagnosis: DebuggerOutput;
      attempt: number;
      allowedAttempts: number;
      scopeRevisionCount: number;
    };

export async function runImplementationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  continuation?: ImplementationContinuation,
  options: { skipTester?: boolean; initialDiagnosis?: DebuggerOutput } = {}
): Promise<ImplementationResult> {
  const { request, ctx, config, store } = workflow;
  let currentPlanning = planning;
  let { plan } = currentPlanning;
  const { baseline } = currentPlanning;
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
  if (tester) assertTesterComplete(tester, plan.route);
  if (!options.skipTester && !continuation) {
    await saveWorkflowCheckpoint(runtime, workflow, "tester_completed", { planning, tester, diagnosis: options.initialDiagnosis }, {
      exploration: planning.exploration, plan, baselineChecks: baseline, tester
      , diagnosis: options.initialDiagnosis
    });
  }
  const checksAfterTests = options.skipTester
    ? baseline
    : continuation?.point === "builder_completed" || continuation?.point === "scope_revision_approved" || continuation?.point === "budget_extended"
    ? continuation.checksAfterTests
    : await runCheckStep(runtime, "testing", "Run checks after test creation", workflow.mutationCwd, ctx, { requireGreen: false, kind: "after-tests" });

  let diagnosis: DebuggerOutput | undefined = continuation?.diagnosis ?? options.initialDiagnosis;
  let scopeRevisionCount = continuation?.point === "scope_revision_approved"
    ? continuation.scopeRevisionCount
    : continuation?.point === "builder_completed" || continuation?.point === "budget_extended"
    ? continuation.scopeRevisionCount ?? planning.scopeRevisionCount
    : planning.scopeRevisionCount;
  let maxAttempts = continuation?.point === "budget_extended"
    ? continuation.allowedAttempts
    : Math.max(1, config.limits.implementationRetries + 1);
  let implAttemptChecks: CheckResult[] | undefined = continuation?.point === "builder_completed" || continuation?.point === "scope_revision_approved"
    ? continuation.previousChecks
    : continuation?.point === "budget_extended"
    ? continuation.failedChecks
    : undefined;
  let firstAttempt = continuation?.point === "scope_revision_approved" || continuation?.point === "budget_extended" ? continuation.attempt : 1;
  if (continuation?.point === "builder_completed") {
    const attempt = continuation.completedAttempt;
    runtime.requireState().attempt = attempt;
    implAttemptChecks = await runCheckStep(runtime, "testing", `Run implementation checks (attempt ${attempt})`, workflow.mutationCwd, ctx, {
      requireGreen: false,
      attempt,
      kind: "implementation"
    });
    if (!allGreen(implAttemptChecks, config.checks.length)) {
      diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Diagnose check failures", {
        action: "diagnose_implementation", request, plan, checks: implAttemptChecks, attempt
      }, workflow.mutationCwd, ctx, parseDebuggerOutput, { attempt });
      if (attempt === maxAttempts) maxAttempts = await requestImplementationBudgetExtension(
        runtime, workflow, currentPlanning, tester, checksAfterTests, implAttemptChecks, diagnosis, attempt, maxAttempts, scopeRevisionCount
      );
      const previousPlan = currentPlanning.plan;
      ({ planning: currentPlanning, count: scopeRevisionCount } = await expandForDiagnosis(
        runtime, workflow, currentPlanning, diagnosis, implAttemptChecks, scopeRevisionCount,
        { mode: "implementation", tester, checksAfterTests, previousChecks: implAttemptChecks, diagnosis, attempt: attempt + 1 }
      ));
      plan = currentPlanning.plan;
      if (plan !== previousPlan) {
        await saveScopeRevisionCheckpoint(runtime, workflow, currentPlanning, tester, checksAfterTests, implAttemptChecks, diagnosis, attempt + 1, scopeRevisionCount);
      }
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
    let builderOut: BuilderOutput;
    while (true) {
      builderOut = await runAgentStep(
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
      if (!builderOut.blocker) {
        if (builderOut.unresolvedIssues.length > 0) {
          const planFiles = deriveMutationPathScope(plan).planFiles.join(", ");
          throw new Error(
            `Builder did not complete the requested work: ${builderOut.unresolvedIssues.join("; ")}. ` +
            `Plan files: [${planFiles}]. ` +
            `Use the structured blocker field to request scope expansion instead of unresolvedIssues.`
          );
        }
        break;
      }
      if (builderOut.blocker.kind !== "scope") {
        throw new Error(`Builder blocked (${builderOut.blocker.kind}): ${builderOut.blocker.reason}`);
      }
      const additions = filesOutsidePlan(plan, builderOut.blocker.requiredFiles);
      if (additions.length === 0) throw new Error(`Builder reported an invalid scope blocker: ${builderOut.blocker.reason}`);
      scopeRevisionCount = consumeScopeRevision(scopeRevisionCount, config.limits.planRevisions, "during implementation");
      currentPlanning = await reviseImplementationScope(
        runtime,
        workflow,
        currentPlanning,
        additions,
        { checks: implAttemptChecks ?? checksAfterTests, diagnosis, blocker: builderOut.blocker },
        scopeRevisionCount,
        { mode: "implementation", tester, checksAfterTests, previousChecks: implAttemptChecks, diagnosis, attempt, scopeRevisionCount }
      );
      plan = currentPlanning.plan;
      builderTask.plan = plan;
      await saveScopeRevisionCheckpoint(runtime, workflow, currentPlanning, tester, checksAfterTests, implAttemptChecks, diagnosis, attempt, scopeRevisionCount);
    }
    await saveWorkflowCheckpoint(runtime, workflow, "builder_completed", {
      mode: "implementation",
      planning: currentPlanning,
      tester,
      checksAfterTests,
      previousChecks: implAttemptChecks,
      diagnosis,
      completedAttempt: attempt,
      scopeRevisionCount
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
    if (attempt === maxAttempts) maxAttempts = await requestImplementationBudgetExtension(
      runtime, workflow, currentPlanning, tester, checksAfterTests, implAttemptChecks, diagnosis, attempt, maxAttempts, scopeRevisionCount
    );
    const previousPlan = currentPlanning.plan;
    ({ planning: currentPlanning, count: scopeRevisionCount } = await expandForDiagnosis(
      runtime, workflow, currentPlanning, diagnosis, implAttemptChecks, scopeRevisionCount,
      { mode: "implementation", tester, checksAfterTests, previousChecks: implAttemptChecks, diagnosis, attempt: attempt + 1 }
    ));
    plan = currentPlanning.plan;
    if (plan !== previousPlan) {
      await saveScopeRevisionCheckpoint(runtime, workflow, currentPlanning, tester, checksAfterTests, implAttemptChecks, diagnosis, attempt + 1, scopeRevisionCount);
    }
  }
  if (!implAttemptChecks || !allGreen(implAttemptChecks, config.checks.length)) throw new Error("Implementation did not reach a verified state");
  publishSessionMessage(
    runtime,
    formatVerifiedImplementation(plan, runtime.builderSessionOutputs, implAttemptChecks, !!config.limits.worktreeIsolation, store.runDir),
    { kind: "implementation_verified" }
  );
  const result = { ...currentPlanning, scopeRevisionCount, tester, finalImplChecks: implAttemptChecks, diagnosis };
  await saveWorkflowCheckpoint(runtime, workflow, "implementation_verified", result, {
    exploration: planning.exploration, plan, baselineChecks: baseline, tester,
    builderOutputs: runtime.builderSessionOutputs, implementationChecks: implAttemptChecks, diagnosis
  });
  return result;
}

export async function requestImplementationBudgetExtension(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  tester: ImplementationResult["tester"],
  checksAfterTests: CheckResult[],
  failedChecks: CheckResult[],
  diagnosis: DebuggerOutput,
  completedAttempt: number,
  allowedAttempts: number,
  scopeRevisionCount: number
): Promise<number> {
  if (!workflow.config.humanInTheLoop.importantDecisions) {
    throw new CheckFailureError("Implementation retry limit", failedCommands(failedChecks), diagnosis);
  }
  const nextAllowed = allowedAttempts + 1;
  await runDurableHumanGate(
    runtime,
    workflow,
    "repair_budget_exhausted",
    "Implementation repair budget exhausted",
    { point: "budget_exhausted", phase: "implementation", nextAttempt: completedAttempt + 1, allowedAttempts: nextAllowed, scopeRevisionCount },
    {
      exploration: planning.exploration,
      plan: planning.plan,
      baselineChecks: planning.baseline,
      tester,
      builderOutputs: runtime.builderSessionOutputs,
      implementationChecks: failedChecks,
      diagnosis,
      decisionContext: { checksAfterTests }
    },
    async signal => {
      const answer = await workflow.ctx.ui.select(
        `Implementation checks are still failing after ${completedAttempt} attempt(s). Allow one more targeted repair?`,
        ["Allow one more repair", "Stop workflow"],
        { signal }
      );
      if (!answer) return undefined;
      return answer === "Allow one more repair" ? { action: "fix_again" as const } : { action: "cancel" as const };
    },
    () => true
  );
  return nextAllowed;
}

function failedCommands(checks: readonly CheckResult[]): string[] {
  return checks.filter(check => !check.passed).map(check => check.command);
}

async function expandForDiagnosis(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  diagnosis: DebuggerOutput,
  checks: CheckResult[],
  count: number,
  after: Omit<Extract<ScopeRevisionAfter, { mode: "implementation" }>, "scopeRevisionCount">
): Promise<{ planning: ImplementationPlanningResult; count: number }> {
  const additions = filesOutsidePlan(planning.plan, diagnosis.affectedFiles);
  if (additions.length === 0) {
    if (["environment_error", "tooling_error", "unknown"].includes(diagnosis.category) && diagnosis.affectedFiles.length === 0) {
      throw new Error(`Checks cannot be repaired by Builder: ${diagnosis.rootCause}`);
    }
    return { planning, count };
  }
  const next = consumeScopeRevision(count, workflow.config.limits.planRevisions, "during implementation");
  workflow.ctx.ui.notify(
    `Diagnosis identified ${additions.length} file(s) outside the approved plan (${additions.join(", ")}). Expanding scope to include ${additions.length === 1 ? "it" : "them"}.`,
    "info"
  );
  return {
    planning: await reviseImplementationScope(runtime, workflow, planning, additions, { checks, diagnosis }, next, { ...after, scopeRevisionCount: next }),
    count: next
  };
}

async function saveScopeRevisionCheckpoint(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  tester: ImplementationResult["tester"],
  checksAfterTests: CheckResult[],
  previousChecks: CheckResult[] | undefined,
  diagnosis: DebuggerOutput | undefined,
  attempt: number,
  scopeRevisionCount: number
): Promise<void> {
  await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
    mode: "implementation",
    planning,
    tester,
    checksAfterTests,
    previousChecks,
    diagnosis,
    attempt,
    scopeRevisionCount
  }, {
    exploration: planning.exploration,
    plan: planning.plan,
    baselineChecks: planning.baseline,
    tester,
    builderOutputs: runtime.builderSessionOutputs,
    implementationChecks: previousChecks,
    diagnosis
  });
}
