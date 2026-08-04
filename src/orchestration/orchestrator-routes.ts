import type { ImplementationPlanningResult, PlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { enterMutationPhase, prepareImplementationPhase } from "./orchestrator-planning.js";
import { runImplementationPhase } from "./orchestrator-implementation.js";
import { runReviewPhase } from "./orchestrator-review.js";
import { runFinalizationPhase, runReadOnlyFinalizationPhase } from "./orchestrator-finalization.js";
import { runReadOnlyReviewPhase } from "./orchestrator-read-only-review.js";
import { runSpecializedMutationRoute } from "./orchestrator-specialized-routes.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { parseDebuggerOutput } from "../validation.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import type { DebuggerOutput } from "../workflow-shared.js";
import { filesOutsidePlan } from "./plan-revision.js";
import { reviseImplementationScope } from "./orchestrator-scope-revision.js";
import { consumeScopeRevision } from "./scope-revision-budget.js";
import { runInvestigationPhase } from "./orchestrator-investigation.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";
import { requestBugDiagnosisApproval } from "./orchestrator-human-gates.js";
import { verifyIsolatedWorktreeReadiness } from "./worktree-readiness.js";

export async function runSelectedRoute(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult | ImplementationPlanningResult,
  options: { prepared?: boolean; bugDiagnosis?: DebuggerOutput } = {}
): Promise<void> {
  switch (workflow.route) {
    case "implementation": {
      const prepared = options.prepared ? planning as ImplementationPlanningResult : await prepareImplementationPhase(runtime, workflow, planning);
      await verifyIsolatedWorktreeReadiness(runtime, workflow);
      const implementation = await runImplementationPhase(runtime, workflow, prepared);
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "bug_fix": {
      const prepared = options.prepared
        ? planning as ImplementationPlanningResult
        : await prepareImplementationPhase(runtime, workflow, planning, {
            allowBaselineRepair: false,
            deferMutation: true
      });
      if (options.bugDiagnosis) {
        await verifyIsolatedWorktreeReadiness(runtime, workflow);
        await runBugFixImplementation(runtime, workflow, prepared, options.bugDiagnosis);
        return;
      }
      const diagnosis = await runAgentStep(runtime, "debugger", "debugging", "Diagnose requested bug", {
        action: "diagnose_bug",
        request: workflow.request,
        plan: prepared.plan,
        exploration: prepared.exploration,
        checks: prepared.baseline
      }, workflow.mutationCwd, workflow.ctx, parseDebuggerOutput);
      assertActionableBugDiagnosis(diagnosis);
      await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosis_ready", { planning: prepared, diagnosis }, {
        exploration: prepared.exploration,
        plan: prepared.plan,
        baselineChecks: prepared.baseline,
        diagnosis
      });
      await continueBugFixAfterDiagnosis(runtime, workflow, prepared, diagnosis);
      return;
    }
    case "quick_implementation": {
      const prepared = options.prepared
        ? planning as ImplementationPlanningResult
        : await prepareImplementationPhase(runtime, workflow, planning, {
            allowBaselineRepair: false
          });
      await verifyIsolatedWorktreeReadiness(runtime, workflow);
      const implementation = await runImplementationPhase(runtime, workflow, prepared, undefined, { skipTester: true });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "documentation_only":
    case "tests_only": {
      const prepared = options.prepared
        ? planning as ImplementationPlanningResult
        : await prepareImplementationPhase(runtime, workflow, planning, { allowBaselineRepair: false });
      await verifyIsolatedWorktreeReadiness(runtime, workflow);
      await runSpecializedMutationRoute(runtime, workflow, prepared);
      return;
    }
    case "review_only": {
      const review = await runReadOnlyReviewPhase(runtime, workflow, planning);
      await runReadOnlyFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "investigation_only": {
      const investigation = await runInvestigationPhase(runtime, workflow, planning);
      await runReadOnlyFinalizationPhase(runtime, workflow, investigation);
      return;
    }
    case "planning_only":
      await runReadOnlyFinalizationPhase(runtime, workflow, planning);
      return;
  }
}

export async function continueBugFixAfterDiagnosis(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  initialPlanning: ImplementationPlanningResult,
  diagnosis: DebuggerOutput,
  approved = false
): Promise<void> {
  if (workflow.route !== "bug_fix") throw new Error("Bug diagnosis continuation requires the bug_fix route");
  assertActionableBugDiagnosis(diagnosis);
  let planning = initialPlanning;
  const policy = resolveParticipationPolicy(workflow.config);
  if (!approved && requiresHumanDecision(policy, "diagnosis_approval", { confidence: diagnosis.confidence })) {
    await requestBugDiagnosisApproval(runtime, workflow, planning, diagnosis);
  }

  const additions = filesOutsidePlan(planning.plan, diagnosis.affectedFiles);
  if (additions.length > 0) {
    const scopeRevisionCount = consumeScopeRevision(planning.scopeRevisionCount, workflow.config.limits.planRevisions, "during bug diagnosis");
    planning = await reviseImplementationScope(
      runtime,
      workflow,
      planning,
      additions,
      { checks: planning.baseline, diagnosis },
      scopeRevisionCount,
      { mode: "bug_diagnosed", diagnosis, scopeRevisionCount }
    );
    planning = { ...planning, scopeRevisionCount };
  }

  const bindings = {
    exploration: planning.exploration,
    plan: planning.plan,
    baselineChecks: planning.baseline,
    diagnosis
  };
  await enterMutationPhase(runtime, workflow, {
    resume: { point: "mutation_confirmation", mode: "bug_diagnosed", scopeRevisionCount: planning.scopeRevisionCount },
    bindings
  });
  await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosed", { planning, diagnosis }, bindings);
  await verifyIsolatedWorktreeReadiness(runtime, workflow);
  await runBugFixImplementation(runtime, workflow, planning, diagnosis);
}

function assertActionableBugDiagnosis(diagnosis: DebuggerOutput): void {
  if (["environment_error", "tooling_error", "unknown"].includes(diagnosis.category) || diagnosis.affectedFiles.length === 0) {
    throw new Error(`Bug diagnosis is not actionable as a repository mutation: ${diagnosis.rootCause}`);
  }
}

async function runBugFixImplementation(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  diagnosis: DebuggerOutput
): Promise<void> {
  const implementation = await runImplementationPhase(runtime, workflow, planning, undefined, { initialDiagnosis: diagnosis });
  const review = await runReviewPhase(runtime, workflow, implementation);
  await runFinalizationPhase(runtime, workflow, review);
}
