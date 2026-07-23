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
import type { DebuggerOutput } from "../types.js";
import { filesOutsidePlan } from "./plan-revision.js";
import { reviseImplementationScope } from "./orchestrator-scope-revision.js";
import { consumeScopeRevision } from "./scope-revision-budget.js";

export async function runSelectedRoute(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult | ImplementationPlanningResult,
  options: { prepared?: boolean; bugDiagnosis?: DebuggerOutput } = {}
): Promise<void> {
  switch (workflow.route) {
    case "implementation": {
      const prepared = options.prepared ? planning as ImplementationPlanningResult : await prepareImplementationPhase(runtime, workflow, planning);
      const implementation = await runImplementationPhase(runtime, workflow, prepared);
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "bug_fix": {
      let prepared = options.prepared
        ? planning as ImplementationPlanningResult
        : await prepareImplementationPhase(runtime, workflow, planning, {
            agents: ["debugger", "tester", "builder", "reviewer", "documenter"],
            allowBaselineRepair: false,
            deferMutation: true
          });
      const diagnosis = options.bugDiagnosis ?? await runAgentStep(runtime, "debugger", "debugging", "Diagnose requested bug", {
        action: "diagnose_bug",
        request: workflow.request,
        plan: prepared.plan,
        exploration: prepared.exploration,
        checks: prepared.baseline
      }, workflow.mutationCwd, workflow.ctx, parseDebuggerOutput);
      if (!options.bugDiagnosis) {
        if (["environment_error", "tooling_error", "unknown"].includes(diagnosis.category) || diagnosis.affectedFiles.length === 0) {
          throw new Error(`Bug diagnosis is not actionable as a repository mutation: ${diagnosis.rootCause}`);
        }
        const additions = filesOutsidePlan(prepared.plan, diagnosis.affectedFiles);
        if (additions.length > 0) {
          const scopeRevisionCount = consumeScopeRevision(prepared.scopeRevisionCount, workflow.config.limits.planRevisions, "during bug diagnosis");
          prepared = await reviseImplementationScope(
            runtime,
            workflow,
            prepared,
            additions,
            { checks: prepared.baseline, diagnosis },
            scopeRevisionCount,
            { mode: "bug_diagnosed", diagnosis, scopeRevisionCount }
          );
          prepared = { ...prepared, scopeRevisionCount };
        }
        await enterMutationPhase(runtime, workflow, {
          resume: { point: "mutation_confirmation", mode: "bug_diagnosed", scopeRevisionCount: prepared.scopeRevisionCount },
          bindings: {
            exploration: prepared.exploration,
            plan: prepared.plan,
            baselineChecks: prepared.baseline,
            diagnosis
          }
        });
      }
      if (!options.bugDiagnosis) {
        await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosed", { planning: prepared, diagnosis }, {
          exploration: prepared.exploration,
          plan: prepared.plan,
          baselineChecks: prepared.baseline,
          diagnosis
        });
      }
      const implementation = await runImplementationPhase(runtime, workflow, prepared, undefined, { initialDiagnosis: diagnosis });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "quick_implementation": {
      const prepared = options.prepared
        ? planning as ImplementationPlanningResult
        : await prepareImplementationPhase(runtime, workflow, planning, {
            agents: ["builder", "debugger", "reviewer", "documenter"],
            allowBaselineRepair: false
          });
      const implementation = await runImplementationPhase(runtime, workflow, prepared, undefined, { skipTester: true });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "documentation_only":
    case "tests_only": {
      const prepared = options.prepared
        ? planning as ImplementationPlanningResult
        : await prepareImplementationPhase(runtime, workflow, planning, {
            agents: workflow.route === "tests_only" ? ["debugger", "tester"] : ["debugger", "documenter"],
            allowBaselineRepair: false,
            allowAuthorizedTestFailures: workflow.route === "tests_only"
          });
      await runSpecializedMutationRoute(runtime, workflow, prepared);
      return;
    }
    case "review_only":
    case "investigation_only": {
      const review = await runReadOnlyReviewPhase(runtime, workflow, planning);
      await runReadOnlyFinalizationPhase(runtime, workflow, review);
      return;
    }
    case "planning_only":
      await runReadOnlyFinalizationPhase(runtime, workflow, planning);
      return;
  }
}
