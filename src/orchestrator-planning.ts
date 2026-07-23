import path from "node:path";
import { ensureChecksConfigured } from "./check-setup.js";
import { formatApprovedPlan, formatBaselineReport } from "./session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseExplorerOutput, parsePlannerOutput, parseReviewOutput } from "./validation.js";
import type { AgentName, PlannerOutput } from "./types.js";
import type { ImplementationPlanningResult, PlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { promptHumanPlanReview, runRequiredHumanGate } from "./orchestrator-human-gates.js";
import { publishSessionMessage, transition } from "./orchestrator-state.js";
import { WorkflowCancelledError } from "./workflow-errors.js";
import { createWorktree } from "./worktree.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { deriveMutationPathScope } from "./workspace-guard.js";
import { assertBuilderComplete } from "./mutation-completion.js";
import { deriveRoleMutationPaths } from "./workspace-guard.js";

export async function runPlanningPhase(runtime: OrchestratorRuntime, workflow: WorkflowContext): Promise<PlanningResult> {
  const { request, ctx, cwd, config, store, controller } = workflow;
  await transition(runtime, "preflight", undefined, "Validating configuration and models", ctx);
  await runtime.agents.preflight(
    config,
    cwd,
    runtime.extensionRoot,
    controller.signal,
    config.limits.agentTimeoutMs,
    ["explorer", "planner", "reviewer"]
  );

  const exploration = await runAgentStep(runtime, "explorer", "exploring", "Explore repository", { route: workflow.route, request }, cwd, ctx, parseExplorerOutput);
  runtime.explorerRelevantFiles = exploration.relevantFiles;
  let plan = assertSelectedRoute(await runAgentStep(runtime, "planner", "planning", "Create selected-route plan", { action: "create_plan", route: workflow.route, request, exploration }, cwd, ctx, parsePlannerOutput, { revision: 0 }), workflow.route);

  let planApproved = false;
  for (let reviewIndex = 0; reviewIndex <= config.limits.planRevisions; reviewIndex++) {
    const useHuman = reviewIndex === 0 ? config.humanInTheLoop.planApproval : config.humanInTheLoop.planRevisionApproval;
    if (useHuman) {
      const label = reviewIndex === 0 ? "Review routed plan" : "Review revised plan";
      const humanDecision = await runRequiredHumanGate(
        runtime,
        reviewIndex === 0 ? "plan_approval" : "plan_revision_approval",
        reviewIndex === 0 ? "Plan approval" : "Plan revision approval",
        ctx,
        async () => {
          const decision = await promptHumanPlanReview(runtime, plan, label, ctx);
          if (!decision) throw new WorkflowCancelledError("Workflow cancelled during plan review", "human_gate");
          return decision;
        }
      );
      if (humanDecision.approved) {
        planApproved = true;
        break;
      }
      if (reviewIndex === config.limits.planRevisions) break;
       plan = assertSelectedRoute(await runAgentStep(
        runtime,
        "planner",
        "planning",
        "Revise routed plan",
         { action: "revise_plan", route: workflow.route, request, exploration, previousPlan: plan, feedback: { source: "human", text: humanDecision.feedback ?? "" } },
        cwd,
        ctx,
        parsePlannerOutput,
         { revision: reviewIndex + 1 }
       ), workflow.route);
    } else {
      const review = await runAgentStep(
        runtime,
        "reviewer",
        "reviewing_plan",
        "Review routed plan",
        { reviewType: "plan", request, exploration, plan },
        cwd,
        ctx,
        parseReviewOutput,
        { revision: reviewIndex }
      );
      if (review.decision === "approved") {
        planApproved = true;
        break;
      }
      if (reviewIndex === config.limits.planRevisions) break;
       plan = assertSelectedRoute(await runAgentStep(
        runtime,
        "planner",
        "planning",
        "Revise routed plan",
         { action: "revise_plan", route: workflow.route, request, exploration, previousPlan: plan, feedback: { source: "reviewer", review } },
        cwd,
        ctx,
        parsePlannerOutput,
         { revision: reviewIndex + 1 }
       ), workflow.route);
    }
  }
  if (!planApproved) throw new Error("Plan was not approved within the revision limit");
  if (plan.route === "tests_only" || plan.route === "documentation_only") deriveMutationPathScope(plan);
  await store.saveJson("plan.json", plan);
  publishSessionMessage(runtime, formatApprovedPlan(plan), { kind: "plan_approved" });
  const result = { exploration, plan };
  await saveWorkflowCheckpoint(runtime, workflow, "plan_approved", result, { exploration, plan });
  return result;
}

export async function prepareImplementationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult,
  options: { agents?: readonly AgentName[]; allowBaselineRepair?: boolean; allowAuthorizedTestFailures?: boolean; deferMutation?: boolean } = {}
): Promise<ImplementationPlanningResult> {
  const { request, ctx, cwd, store } = workflow;
  await runtime.agents.preflight(
    workflow.config,
    cwd,
    runtime.extensionRoot,
    workflow.controller.signal,
    workflow.config.limits.agentTimeoutMs,
    options.agents
  );
  const configured = await ensureChecksConfigured(cwd, workflow.config, ctx);
  if (!configured) throw new WorkflowCancelledError("Workflow cancelled during project check setup", "human_gate");
  workflow.config = configured;
  runtime.config = configured;
  const config = configured;
  await saveWorkflowCheckpoint(runtime, workflow, "checks_configured", planning, {
    exploration: planning.exploration,
    plan: planning.plan
  });

  let baseline = await runCheckStep(runtime, "baseline", "Run green baseline", cwd, ctx, { requireGreen: false });
  let baselineDiagnosis;
  if (!allGreen(baseline, config.checks.length)) {
    if (options.allowAuthorizedTestFailures) {
      baselineDiagnosis = await runAgentStep(
        runtime,
        "debugger",
        "baseline",
        "Diagnose tests-only baseline failures",
        { action: "diagnose_baseline", request, checks: baseline },
        cwd,
        ctx,
        parseDebuggerOutput
      );
      const authorized = new Set(deriveRoleMutationPaths("tester", planning.plan));
      const affected = baselineDiagnosis.affectedFiles;
      if (["environment_error", "tooling_error", "unknown"].includes(baselineDiagnosis.category)
        || affected.length === 0
        || affected.some(file => !authorized.has(file))) {
        throw new Error(`tests_only baseline failures are not confined to authorized test files: ${baselineDiagnosis.rootCause}`);
      }
    } else if (options.allowBaselineRepair === false) throw new Error(`${workflow.route} requires a green baseline before mutation`);
    else {
    ctx.ui.notify("Baseline checks are not all green. Diagnosing failures...", "warning");
    const baselineDiagnosis = await runAgentStep(
      runtime,
      "debugger",
      "baseline",
      "Diagnose baseline failures",
      { action: "diagnose_baseline", request, checks: baseline },
      cwd,
      ctx,
      parseDebuggerOutput
    );
    const baselineFixPlan = await runAgentStep(
      runtime,
      "planner",
      "baseline",
      "Create baseline repair plan",
       { action: "repair_baseline", route: "implementation", request, diagnosis: baselineDiagnosis, checkFailures: baseline },
      cwd,
      ctx,
      parsePlannerOutput
    );
    if (baselineFixPlan.route !== "implementation") {
      throw new Error("Baseline repair plan must use the implementation route");
    }
    await store.saveJson("baseline-fix-plan.json", baselineFixPlan);
    if (!ctx.hasUI) {
      const dir = path.relative(cwd, store.runDir);
      throw new Error(
        `Baseline checks failed and need repair. A repair plan has been saved to ${dir}/baseline-fix-plan.json. ` +
        "Apply the fixes manually or re-run with an interactive UI to approve the repair plan."
      );
    }
    const fixDecision = await runRequiredHumanGate(runtime, "baseline_repair_approval", "Baseline repair approval", ctx, async () => {
      const decision = await promptHumanPlanReview(runtime, baselineFixPlan, "Review baseline repair plan", ctx);
      if (!decision) throw new WorkflowCancelledError("Workflow cancelled during baseline repair review", "human_gate");
      return decision;
    });
    if (!fixDecision.approved) throw new WorkflowCancelledError("Baseline repair was not approved", "human_gate");
    await enterMutationPhase(runtime, workflow);
    const repairOutput = await runAgentStep(
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
    await saveWorkflowCheckpoint(runtime, workflow, "builder_completed", {
      mode: "baseline_repair",
      planning,
      failedBaseline: baseline,
      baselineDiagnosis,
      baselineFixPlan,
      repairOutput
    }, { exploration: planning.exploration, plan: planning.plan, baselineChecks: baseline, builderOutputs: [repairOutput], diagnosis: baselineDiagnosis });
    baseline = await runCheckStep(runtime, "baseline", "Verify baseline after repair", workflow.mutationCwd, ctx, { requireGreen: true, kind: "baseline-verify" });
    runtime.baselineRepaired = true;
    publishSessionMessage(runtime, formatBaselineReport(baseline, baselineDiagnosis, baselineFixPlan), { kind: "baseline_repaired" });
    }
  }
  const result = { ...planning, baseline, scopeRevisionCount: 0, ...(baselineDiagnosis ? { baselineDiagnosis } : {}) };
  if (!options.deferMutation) {
    await enterMutationPhase(runtime, workflow);
    await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", result, { exploration: planning.exploration, plan: planning.plan, baselineChecks: baseline, diagnosis: baselineDiagnosis });
  }
  return result;
}

export async function enterMutationPhase(runtime: OrchestratorRuntime, workflow: WorkflowContext): Promise<void> {
  const { config, ctx, cwd, runId, store } = workflow;
  if (!workflow.mutationConfirmed && config.humanInTheLoop.confirmBeforeMutation) {
    await runRequiredHumanGate(runtime, "mutation_confirmation", "Mutation phase confirmation", ctx, async signal => {
      const proceed = await ctx.ui.confirm(
        "Enter the mutation phase?",
        "Tester, Builder, Documenter, and project checks may modify files. Continue?",
        { signal }
      );
      if (!proceed) throw new WorkflowCancelledError("Workflow cancelled before mutation", "human_gate");
    });
  }
  workflow.mutationConfirmed = true;
  if (config.limits.worktreeIsolation && !workflow.worktreeHandle) {
    workflow.worktreeHandle = await createWorktree(cwd, runId);
    workflow.mutationCwd = workflow.worktreeHandle.effectiveCwd;
    await store.saveJson("worktree.json", {
      repositoryRoot: workflow.worktreeHandle.repositoryRoot,
      sourceCwd: workflow.worktreeHandle.sourceCwd,
      projectRelativePath: workflow.worktreeHandle.projectRelativePath,
      worktreeRoot: workflow.worktreeHandle.worktreeRoot,
      effectiveCwd: workflow.worktreeHandle.effectiveCwd,
      baselineCommit: workflow.worktreeHandle.baselineCommit
    });
    ctx.ui.notify(`Mutation phase isolated in ${workflow.mutationCwd}`, "info");
  }
}

function assertSelectedRoute(plan: PlannerOutput, route: WorkflowContext["route"]): PlannerOutput {
  if (plan.route !== route) {
    throw new Error(`Planner returned route ${plan.route}; user selected ${route}`);
  }
  return plan;
}
