import { formatBaselineReport } from "../ui/session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseExplorerOutput, parsePlannerOutput, parseReviewOutput } from "../validation.js";
import type { BuilderOutput } from "../types.js";
import type { AgentResolutionRequest, PlannerTask } from "../agent-task-types.js";
import type { ImplementationPlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { persist, publishSessionMessage } from "./orchestrator-state.js";
import { assertBuilderComplete } from "./mutation-completion.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";
import { validateFinalPlanRevision } from "./plan-revision.js";

export type ResolutionResult = {
  planning: ImplementationPlanningResult;
};

export async function resolveAgentBlocker(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  blocker: AgentResolutionRequest
): Promise<ResolutionResult> {
  switch (blocker.kind) {
    case "baseline_repair": {
      const repaired = await runBaselineRepairSubworkflow(runtime, workflow, planning, blocker);
      return { planning: repaired };
    }
    case "prerequisite_repair": {
      const repaired = await runBaselineRepairSubworkflow(runtime, workflow, planning, blocker);
      return { planning: repaired };
    }
    case "role_handoff":
      return runRoleHandoff(runtime, workflow, planning, blocker);
    case "environment":
    case "tooling":
      return pauseForEnvironmentRetry(runtime, workflow, planning, blocker);
    case "insufficient_evidence":
      return resolveInsufficientEvidence(runtime, workflow, planning, blocker);
    case "scope":
      throw new Error("Scope blockers should be handled before resolveAgentBlocker");
  }
}

export async function runRoleHandoff(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  blocker: AgentResolutionRequest & { kind: "role_handoff" }
): Promise<ResolutionResult> {
  const { ctx } = workflow;
  ctx.ui.notify(`Handing off to ${blocker.requestedRole}: ${blocker.requestedCapability}`, "info");

  switch (blocker.requestedRole) {
    case "debugger": {
      const diagnosis = await runAgentStep(runtime, "debugger", "debugging", blocker.requestedCapability, {
        action: "diagnose_investigation",
        request: blocker.question || blocker.reason,
        plan: planning.plan,
        exploration: planning.exploration
      }, workflow.mutationCwd, ctx, parseDebuggerOutput);
      return { planning: { ...planning, baselineDiagnosis: diagnosis } };
    }
    case "explorer": {
      const exploration = await runAgentStep(runtime, "explorer", "exploring", blocker.requestedCapability, { route: workflow.route, request: blocker.question || blocker.reason }, workflow.mutationCwd, ctx, parseExplorerOutput);
      return { planning: { ...planning, exploration } };
    }
    case "planner": {
      const revisedPlan = await runAgentStep(runtime, "planner", "planning", blocker.requestedCapability, {
        action: "revise_plan",
        route: workflow.route,
        request: blocker.question || blocker.reason,
        exploration: planning.exploration,
        previousPlan: planning.plan,
        feedback: { source: "human", text: `[Handoff from agent] ${blocker.requestedCapability}` }
      }, workflow.mutationCwd, ctx, parsePlannerOutput);
      const validated = validateFinalPlanRevision(planning.plan, revisedPlan, { preserveAcceptanceCriteria: true });
      const review = await runAgentStep(runtime, "reviewer", "reviewing_plan", "Review handoff plan revision", {
        reviewType: "scope_revision",
        request: workflow.request,
        exploration: planning.exploration,
        previousPlan: planning.plan,
        plan: validated,
        checks: planning.baseline ?? [],
        requiredFiles: [],
        diagnosis: planning.baselineDiagnosis
      }, workflow.mutationCwd, ctx, parseReviewOutput, { revision: (planning.scopeRevisionCount ?? 0) + 1 });
      if (review.decision !== "approved") {
        throw new Error(`Handoff plan revision was not approved: ${review.blockingIssues.join("; ") || "reviewer rejected"}`);
      }
      return { planning: { ...planning, plan: validated } };
    }
    default:
      throw new Error(`Role handoff to ${blocker.requestedRole} is not supported`);
  }
}

export async function pauseForEnvironmentRetry(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  blocker: AgentResolutionRequest & { kind: "environment" | "tooling" }
): Promise<ResolutionResult> {
  const { ctx } = workflow;
  ctx.ui.notify(`Environment/tooling blocker: ${blocker.reason}.`, "warning");

  const state = runtime.requireState();
  state.status = "paused";
  state.message = `Blocked (${blocker.kind}): ${blocker.reason}` + (blocker.retryCondition ? `. Retry condition: ${blocker.retryCondition}` : "") + ". Fix the issue and use /orchestrator-resume <run-id> to retry.";
  state.waitingFor = blocker.retryCondition || "environment fix";
  state.currentTool = blocker.kind;
  state.currentToolArgs = blocker.reason;

  ctx.ui.notify(`Workflow paused. ${blocker.retryCondition ? `Retry condition: ${blocker.retryCondition}` : "Waiting for environment fix."} Use /orchestrator-resume to retry.`, "info");

  return { planning };
}

async function resolveInsufficientEvidence(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  blocker: AgentResolutionRequest & { kind: "insufficient_evidence" }
): Promise<ResolutionResult> {
  const { ctx } = workflow;
  ctx.ui.notify(`Agent needs more evidence: ${blocker.reason}. Running investigation...`, "info");

  const deeperExploration = await runAgentStep(runtime, "explorer", "exploring", "Deeper investigation requested by agent", { route: workflow.route, request: blocker.questions.join("; ") }, workflow.mutationCwd, ctx, parseExplorerOutput);

  const investigation = await runAgentStep(runtime, "debugger", "debugging", "Investigate based on expanded exploration", {
    action: "diagnose_investigation",
    request: blocker.reason,
    plan: planning.plan,
    exploration: deeperExploration
  }, workflow.mutationCwd, ctx, parseDebuggerOutput);

  return {
    planning: {
      ...planning,
      exploration: deeperExploration,
      baselineDiagnosis: investigation
    }
  };
}

export async function runBaselineRepairSubworkflow(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  blocker: AgentResolutionRequest & { kind: "baseline_repair" | "prerequisite_repair" }
): Promise<ImplementationPlanningResult> {
  const { request, ctx, config } = workflow;
  ctx.ui.notify("Baseline repair requested. Diagnosing failures...", "warning");
  const failedBaseline = await runCheckStep(runtime, "baseline", "Run baseline checks for repair", workflow.mutationCwd, ctx, { requireGreen: false, kind: "baseline" });
  const baselineDiagnosis = await runAgentStep(
    runtime,
    "debugger",
    "baseline",
    "Diagnose baseline failures",
    { action: "diagnose_baseline", request, checks: failedBaseline },
    workflow.mutationCwd,
    ctx,
    parseDebuggerOutput
  );
  const baselineFixPlan = await runAgentStep(
    runtime,
    "planner",
    "baseline",
    "Create baseline repair plan",
    { action: "repair_baseline", route: "implementation", request, diagnosis: baselineDiagnosis, checkFailures: failedBaseline } satisfies PlannerTask,
    workflow.mutationCwd,
    ctx,
    parsePlannerOutput
  );
  if (baselineFixPlan.route !== "implementation") {
    throw new Error("Baseline repair plan must use the implementation route");
  }
  const policy = resolveParticipationPolicy(config);
  if (requiresHumanDecision(policy, "baseline_repair")) {
    const approved = await ctx.ui.confirm(
      `Baseline repair needed: ${blocker.reason}. Approve repair plan "${baselineFixPlan.summary}"?`,
      "Baseline repair plan",
      { signal: workflow.controller.signal }
    );
    if (!approved) throw new Error(`Baseline repair was not approved: ${blocker.reason}`);
  }
  const repairOutput: BuilderOutput = await runAgentStep(
    runtime,
    "builder",
    "baseline",
    "Repair baseline failures",
    { action: "repair_baseline", request, fixPlan: baselineFixPlan, attempt: 1 },
    workflow.mutationCwd,
    ctx,
    parseBuilderOutput,
    { mutationPlan: baselineFixPlan }
  );
  assertBuilderComplete(repairOutput, "the approved baseline repair");
  const baseline = await runCheckStep(runtime, "baseline", "Verify baseline after repair", workflow.mutationCwd, ctx, { requireGreen: true, kind: "baseline-verify" });
  runtime.baselineRepaired = true;
  publishSessionMessage(runtime, formatBaselineReport(baseline, baselineDiagnosis, baselineFixPlan), { kind: "baseline_repaired" });
  return { ...planning, baseline, scopeRevisionCount: planning.scopeRevisionCount ?? 0 };
}
