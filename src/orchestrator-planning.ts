import path from "node:path";
import { configPath } from "./config.js";
import { formatApprovedPlan, formatBaselineReport } from "./session-messages.js";
import { parseBuilderOutput, parseDebuggerOutput, parseExplorerOutput, parsePlannerOutput, parseReviewOutput } from "./validation.js";
import type { PlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { promptHumanPlanReview, runRequiredHumanGate } from "./orchestrator-human-gates.js";
import { publishSessionMessage, transition } from "./orchestrator-state.js";
import { WorkflowCancelledError } from "./workflow-errors.js";
import { createWorktree } from "./worktree.js";

export async function runPlanningPhase(runtime: OrchestratorRuntime, workflow: WorkflowContext): Promise<PlanningResult> {
  const { request, ctx, cwd, config, store, controller } = workflow;
  await transition(runtime, "preflight", undefined, "Validating configuration and models", ctx);
  if (config.checks.length === 0) {
    throw new Error(`No project checks are configured. Edit ${configPath(cwd)} before running the workflow.`);
  }
  await runtime.agents.preflight(config, cwd, runtime.extensionRoot, controller.signal, config.limits.agentTimeoutMs);

  const exploration = await runAgentStep(runtime, "explorer", "exploring", "Explore repository", { request }, cwd, ctx, parseExplorerOutput);
  runtime.explorerRelevantFiles = exploration.relevantFiles;
  let plan = await runAgentStep(runtime, "planner", "planning", "Create implementation plan", { action: "create_plan", request, exploration }, cwd, ctx, parsePlannerOutput, { revision: 0 });

  let planApproved = false;
  for (let reviewIndex = 0; reviewIndex <= config.limits.planRevisions; reviewIndex++) {
    const useHuman = reviewIndex === 0 ? config.humanInTheLoop.planApproval : config.humanInTheLoop.planRevisionApproval;
    if (useHuman) {
      const label = reviewIndex === 0 ? "Review implementation plan" : "Review revised plan";
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
      plan = await runAgentStep(
        runtime,
        "planner",
        "planning",
        "Revise implementation plan",
        { action: "revise_plan", request, exploration, previousPlan: plan, feedback: { source: "human", text: humanDecision.feedback ?? "" } },
        cwd,
        ctx,
        parsePlannerOutput,
        { revision: reviewIndex + 1 }
      );
    } else {
      const review = await runAgentStep(
        runtime,
        "reviewer",
        "reviewing_plan",
        "Review implementation plan",
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
      plan = await runAgentStep(
        runtime,
        "planner",
        "planning",
        "Revise implementation plan",
        { action: "revise_plan", request, exploration, previousPlan: plan, feedback: { source: "reviewer", review } },
        cwd,
        ctx,
        parsePlannerOutput,
        { revision: reviewIndex + 1 }
      );
    }
  }
  if (!planApproved) throw new Error("Plan was not approved within the revision limit");
  await store.saveJson("plan.json", plan);
  publishSessionMessage(runtime, formatApprovedPlan(plan), { kind: "plan_approved" });

  let baseline = await runCheckStep(runtime, "baseline", "Run green baseline", cwd, ctx, { requireGreen: false });
  if (!allGreen(baseline, config.checks.length)) {
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
      { action: "repair_baseline", request, diagnosis: baselineDiagnosis, checkFailures: baseline },
      cwd,
      ctx,
      parsePlannerOutput
    );
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
    await runAgentStep(
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
    baseline = await runCheckStep(runtime, "baseline", "Verify baseline after repair", workflow.mutationCwd, ctx, { requireGreen: true, kind: "baseline-verify" });
    runtime.baselineRepaired = true;
    publishSessionMessage(runtime, formatBaselineReport(baseline, baselineDiagnosis, baselineFixPlan), { kind: "baseline_repaired" });
  }
  await enterMutationPhase(runtime, workflow);
  return { exploration, plan, baseline };
}

async function enterMutationPhase(runtime: OrchestratorRuntime, workflow: WorkflowContext): Promise<void> {
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
      effectiveCwd: workflow.worktreeHandle.effectiveCwd,
      baselineCommit: workflow.worktreeHandle.baselineCommit
    });
    ctx.ui.notify(`Mutation phase isolated in ${workflow.mutationCwd}`, "info");
  }
}
