import { ensureChecksConfigured } from "../checks/check-setup.js";
import { formatApprovedPlan, formatBaselineReport } from "../ui/session-messages.js";
import { formatPlanForReview } from "./plan-review.js";
import { parseBuilderOutput, parseDebuggerOutput, parseExplorerOutput, parsePlannerOutput, parseReviewOutput } from "../validation.js";
import type { CheckResult, HumanPlanReviewResult } from "../workflow-types.js";
import type { DebuggerOutput } from "../workflow-shared.js";
import type { OrchestratorConfig } from "../config-types.js";
import type { PlannerOutput } from "../agent-task-types.js";
import type { ImplementationPlanningResult, PlanningResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { allGreen } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { decisionAction, promptHumanPlanReview, runDurableHumanGate } from "./orchestrator-human-gates.js";
import { persist, publishMilestone, publishSessionMessage, recordMarkdownMilestone, transition } from "./orchestrator-state.js";
import { WorkflowCancelledError } from "./workflow-errors.js";
import { createWorktree } from "../workspace/worktree.js";
import { CheckpointPostCommitError, saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { canonicalSha256, deriveMutationPathScope } from "../workspace/workspace-guard.js";
import { assertBuilderComplete } from "./mutation-completion.js";
import { requiredAgentsForRoute } from "./route-preflight.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";

export async function runPlanningPhase(runtime: OrchestratorRuntime, workflow: WorkflowContext): Promise<PlanningResult> {
  const { request, ctx, cwd, config, controller } = workflow;
  await transition(runtime, "preflight", undefined, "Validating configuration and models", ctx);
  await runtime.agents.preflight(
    config,
    cwd,
    runtime.extensionRoot,
    controller.signal,
    config.limits.agentTimeoutMs,
    requiredAgentsForRoute(workflow.route, config)
  );

  const exploration = await runAgentStep(runtime, "explorer", "exploring", "Explore repository", { route: workflow.route, request }, cwd, ctx, parseExplorerOutput);
  runtime.explorerRelevantFiles = exploration.relevantFiles;
  const plan = assertSelectedRoute(await runAgentStep(runtime, "planner", "planning", "Create selected-route plan", { action: "create_plan", route: workflow.route, request, exploration }, cwd, ctx, parsePlannerOutput, { revision: 0 }), workflow.route);
  return continuePlanningDecision(runtime, workflow, exploration, plan, 0);
}

export async function continuePlanningDecision(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  exploration: PlanningResult["exploration"],
  initialPlan: PlannerOutput,
  firstReviewIndex: number,
  recordedDecision?: HumanPlanReviewResult
): Promise<PlanningResult> {
  const { request, ctx, cwd, config, store } = workflow;
  let plan = initialPlan;
  let planApproved = false;
  const policy = resolveParticipationPolicy(config);
  for (let reviewIndex = firstReviewIndex; reviewIndex <= config.limits.planRevisions; reviewIndex++) {
    const useHuman = reviewIndex === 0
      ? requiresHumanDecision(policy, "initial_plan")
      : requiresHumanDecision(policy, "plan_revision");
    if (useHuman) {
      const label = reviewIndex === 0 ? "Review routed plan" : "Review revised plan";
      const humanDecision = recordedDecision ?? await runDurableHumanGate(
        runtime,
        workflow,
        reviewIndex === 0 ? "plan_approval" : "plan_revision_approval",
        reviewIndex === 0 ? "Plan approval" : "Plan revision approval",
        { point: "plan_decision", reviewIndex },
        { exploration, plan },
        async (signal) => {
          const decision = await promptHumanPlanReview(runtime, plan, label, ctx, signal);
          if (!decision) return undefined;
          if (decision.cancelled) return { action: "cancel" as const };
          if (decision.approved) return { action: "approve" as const };
          return { action: "revise" as const, feedback: decision.feedback };
        },
        (result) => ({
          approved: result.action === "approve",
          feedback: result.feedback
        }),
        {
          format: "markdown",
          content: formatPlanForReview(plan),
          actions: [
            decisionAction("approve", "Approve plan"),
            decisionAction("revise", "Request changes", true),
            decisionAction("cancel", "Cancel workflow"),
          ],
        }
      );
      recordedDecision = undefined;
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
  const planMilestoneId = `plan-approved:${canonicalSha256(plan)}`;
  const planMilestoneExisted = runtime.requireState().milestones?.some(entry => entry.id === planMilestoneId) === true;
  const planMilestone = recordMarkdownMilestone(runtime, planMilestoneId, "plan_approved", formatApprovedPlan(plan));
  const result = { exploration, plan };
  try {
    await saveWorkflowCheckpoint(runtime, workflow, "plan_approved", result, { exploration, plan });
  } catch (error) {
    if (!(error instanceof CheckpointPostCommitError) && !planMilestoneExisted) {
      runtime.requireState().milestones = runtime.requireState().milestones?.filter(entry => entry.id !== planMilestoneId);
    }
    throw error;
  }
  if (!planMilestoneExisted) publishMilestone(runtime, planMilestone);
  return result;
}

export async function prepareImplementationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult,
  options: { allowBaselineRepair?: boolean; deferMutation?: boolean } = {}
): Promise<ImplementationPlanningResult> {
  const { request, ctx, cwd } = workflow;
  await runtime.agents.preflight(
    workflow.config,
    cwd,
    runtime.extensionRoot,
    workflow.controller.signal,
    workflow.config.limits.agentTimeoutMs,
    requiredAgentsForRoute(workflow.route, workflow.config)
  );
  if (workflow.config.checks.length === 0) {
    runtime.requireState().waitingFor = "Check setup";
    await persist(runtime, ctx);
  }
  let configured: OrchestratorConfig;
  try {
    const result = await ensureChecksConfigured(cwd, workflow.config, ctx);
    if (!result) throw new WorkflowCancelledError("Workflow cancelled during project check setup", "human_gate");
    configured = result;
  } finally {
    runtime.requireState().waitingFor = undefined;
  }
  workflow.config = configured;
  runtime.config = configured;
  const config = configured;
  await saveWorkflowCheckpoint(runtime, workflow, "checks_configured", planning, {
    exploration: planning.exploration,
    plan: planning.plan
  });

  const baseline = await runCheckStep(runtime, "baseline", "Run green baseline", cwd, ctx, { requireGreen: false });
  let baselineDiagnosis;
  if (!allGreen(baseline, config.checks.length)) {
    if (options.allowBaselineRepair === false) throw new Error(`${workflow.route} requires a green baseline before mutation`);
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
    return continueBaselineRepair(runtime, workflow, planning, baseline, baselineDiagnosis, baselineFixPlan);
    }
  }
  const result = { ...planning, baseline, scopeRevisionCount: 0, ...(baselineDiagnosis ? { baselineDiagnosis } : {}) };
  if (!options.deferMutation) {
    await enterMutationPhase(runtime, workflow, {
      resume: { point: "mutation_confirmation", mode: "prepared", scopeRevisionCount: result.scopeRevisionCount },
      bindings: {
        exploration: planning.exploration,
        plan: planning.plan,
        baselineChecks: baseline,
        diagnosis: baselineDiagnosis
      }
    });
    await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", result, { exploration: planning.exploration, plan: planning.plan, baselineChecks: baseline, diagnosis: baselineDiagnosis });
  }
  return result;
}

export async function continueBaselineRepair(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: PlanningResult,
  failedBaseline: CheckResult[],
  baselineDiagnosis: DebuggerOutput,
  baselineFixPlan: PlannerOutput,
  recordedDecision?: HumanPlanReviewResult,
  recordedMutationConfirmation = false
): Promise<ImplementationPlanningResult> {
  const { request, ctx, store } = workflow;
  await store.saveJson("baseline-fix-plan.json", baselineFixPlan);
  const fixDecision = recordedDecision ?? await runDurableHumanGate(
    runtime,
    workflow,
    "baseline_repair_approval",
    "Baseline repair approval",
    { point: "baseline_repair_decision" },
    {
      exploration: planning.exploration,
      plan: planning.plan,
      proposedPlan: baselineFixPlan,
      baselineChecks: failedBaseline,
      diagnosis: baselineDiagnosis
    },
    async signal => {
      const decision = await promptHumanPlanReview(runtime, baselineFixPlan, "Review baseline repair plan", ctx, signal);
      if (!decision) return undefined;
      if (decision.cancelled) return { action: "cancel" as const };
      return decision.approved
        ? { action: "approve" as const }
        : { action: "revise" as const, feedback: decision.feedback };
    },
    result => ({ approved: result.action === "approve", feedback: result.feedback }),
    {
      format: "markdown",
      content: formatPlanForReview(baselineFixPlan),
      actions: [
        decisionAction("approve", "Approve repair plan"),
        decisionAction("revise", "Request changes", true),
        decisionAction("cancel", "Cancel workflow"),
      ],
    }
  );
  if (!fixDecision.approved) throw new WorkflowCancelledError("Baseline repair was not approved", "human_gate");
  await enterMutationPhase(runtime, workflow, {
    resume: { point: "mutation_confirmation", mode: "baseline_repair", scopeRevisionCount: 0 },
    bindings: {
      exploration: planning.exploration,
      plan: planning.plan,
      proposedPlan: baselineFixPlan,
      baselineChecks: failedBaseline,
      diagnosis: baselineDiagnosis
    }
  }, recordedMutationConfirmation);
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
    failedBaseline,
    baselineDiagnosis,
    baselineFixPlan,
    repairOutput
  }, {
    exploration: planning.exploration,
    plan: planning.plan,
    baselineChecks: failedBaseline,
    builderOutputs: [repairOutput],
    diagnosis: baselineDiagnosis
  });
  const baseline = await runCheckStep(runtime, "baseline", "Verify baseline after repair", workflow.mutationCwd, ctx, { requireGreen: true, kind: "baseline-verify" });
  runtime.baselineRepaired = true;
  publishSessionMessage(runtime, formatBaselineReport(baseline, baselineDiagnosis, baselineFixPlan), { kind: "baseline_repaired" });
  const result = { ...planning, baseline, scopeRevisionCount: 0, baselineDiagnosis };
  await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", result, {
    exploration: planning.exploration,
    plan: planning.plan,
    baselineChecks: baseline,
    diagnosis: baselineDiagnosis
  });
  return result;
}

export async function enterMutationPhase(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  decisionContext: {
    resume: Extract<import("./human-decision-types.js").HumanDecisionResumePoint, { point: "mutation_confirmation" }>;
    bindings: import("../persistence/checkpoint-types.js").CheckpointBindings;
  },
  recordedConfirmation = false
): Promise<void> {
  const { config, ctx, cwd, runId, store } = workflow;
  const policy = resolveParticipationPolicy(config);
  if (!workflow.mutationConfirmed && requiresHumanDecision(policy, "mutation_confirmation")) {
    const proceed = recordedConfirmation || await runDurableHumanGate(
      runtime,
      workflow,
      "mutation_confirmation",
      "Mutation phase confirmation",
      decisionContext.resume,
      decisionContext.bindings,
      async signal => {
        const answer = await ctx.ui.select(
          "Enter the mutation phase? Tester, Builder, Documenter, and project checks may modify authorized files.",
          ["Enter mutation phase", "Cancel workflow"],
          { signal },
        );
        if (!answer) return undefined;
        return { action: answer === "Enter mutation phase" ? "proceed" as const : "cancel" as const };
      },
      () => true,
      {
        format: "markdown",
        content: `## Mutation phase confirmation\n\nThe approved plan is ready to enter the mutation phase. Tester, Builder, Documenter, and project checks may modify authorized files.\n\n### Approved plan\n\n${decisionContext.bindings.plan ? formatPlanForReview(decisionContext.bindings.plan) : "The approved plan is stored in the run artifacts."}`,
        actions: [
          decisionAction("proceed", "Enter mutation phase"),
          decisionAction("cancel", "Cancel workflow"),
        ],
      }
    );
    if (!proceed) throw new WorkflowCancelledError("Workflow cancelled before mutation", "human_gate");
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
