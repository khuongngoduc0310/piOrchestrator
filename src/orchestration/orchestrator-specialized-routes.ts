import type { ImplementationPlanningResult, SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { runCheckStep } from "./orchestrator-workspace.js";
import { parseDebuggerOutput, parseDocumenterOutput, parsePlannerOutput, parseTesterOutput } from "../validation.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { runSpecializedMutationFinalization } from "./orchestrator-finalization.js";
import type { CheckResult } from "../workflow-types.js";
import type { DocumenterOutput, PlannerOutput, TesterOutput } from "../agent-task-types.js";
import { assertDocumenterComplete, assertTesterComplete } from "./mutation-completion.js";
import { allGreen } from "./orchestrator-helpers.js";
import { deriveRoleMutationPaths, isDocumentationPath } from "../workspace/workspace-guard.js";
import { CheckFailureError } from "./workflow-errors.js";
import { decisionAction, runDurableHumanGate } from "./orchestrator-human-gates.js";
import { filesOutsidePlan } from "./plan-revision.js";
import { validateFinalPlanRevision } from "./plan-revision.js";
import { reviseImplementationScope } from "./orchestrator-scope-revision.js";
import type { DocumentationScopePhase } from "./orchestrator-scope-revision.js";
import { consumeScopeRevision } from "./scope-revision-budget.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";
import { resolveAgentBlocker } from "./orchestrator-resolution.js";
import { runAgentStepWithResolution } from "./orchestrator-resolution-coordinator.js";
import { automatedCriteria } from "./acceptance-criteria.js";
import { formatPlanForReview } from "./plan-review.js";

export async function runSpecializedMutationRoute(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  restored?: SpecializedMutationResult,
  restoredFinalChecks?: CheckResult[],
  restoredDeliveryDecision?: { action: "finish" | "request_changes"; feedback?: string },
  changeRound = 0,
  previousResult?: SpecializedMutationResult
): Promise<void> {
  let result = restored;
  if (!result && workflow.route === "tests_only") {
    const coordResult = await runAgentStepWithResolution(
      runtime, workflow, planning,
      "tester", "creating_tests", "Add requested tests",
      {
        action: "create_tests",
        request: workflow.request,
        plan: planning.plan,
        acceptanceCriteria: automatedCriteria(planning.plan),
        baselineChecks: planning.baseline,
        diagnosis: planning.baselineDiagnosis
      },
      workflow.mutationCwd, workflow.ctx,
      text => parseTesterOutput(text, automatedCriteria(planning.plan)),
      { mutationPlan: planning.plan }
    );
    const tester = coordResult.output as TesterOutput;
    planning = coordResult.planning;
    if (!tester.blocker) {
      assertTesterComplete(tester, workflow.route);
      result = { ...planning, route: "tests_only", tester };
    } else if (coordResult.resolutionRecord?.status === "resolved") {
      result = { ...planning, route: "tests_only", tester };
    } else {
      throw new Error(`Tester returned an unresolved blocker: ${tester.blocker.reason}`);
    }
  } else if (!result && workflow.route === "documentation_only") {
    let currentPlanning = planning;
    for (let attempts = 0; attempts <= workflow.config.limits.planRevisions; attempts++) {
      const coordResult = await runAgentStepWithResolution(
        runtime, workflow, currentPlanning,
        "documenter", "documenting", "Update requested documentation",
        {
          action: "document_only",
          request: workflow.request,
          plan: currentPlanning.plan,
          baselineChecks: currentPlanning.baseline
        },
        workflow.mutationCwd, workflow.ctx, parseDocumenterOutput,
        { mutationPlan: currentPlanning.plan },
        { scopeOwner: "specialized_initial_documentation" }
      );
      const documentation = coordResult.output as DocumenterOutput;
      currentPlanning = coordResult.planning;
      if (documentation.blocker && documentation.blocker.kind === "scope") {
        const phase: DocumentationScopePhase = { phase: "initial_documentation", blockedDocumentation: documentation, changeRound: 0 };
        const updated = await resolveSpecializedDocumenterScope(runtime, workflow, currentPlanning, documentation, phase);
        currentPlanning = updated.planning;
        continue;
      }
      if (documentation.blocker && coordResult.resolutionRecord?.status !== "resolved") {
        throw new Error(`Documenter returned an unresolved blocker: ${documentation.blocker.reason}`);
      }
      assertDocumenterComplete(documentation);
      if (documentation.proposedLessons.length > 0) throw new Error("Documentation-only workflows cannot propose permanent-memory lessons");
      result = { ...currentPlanning, route: "documentation_only", documentation };
      break;
    }
    if (!result) throw new Error("Documentation-only scope revision was not approved within the plan revision limit");
  }
  if (result && previousResult?.route === "tests_only" && result.route === "tests_only") {
    result = {
      ...result,
      tester: {
        ...result.tester,
        changedFiles: [...new Set([...previousResult.tester.changedFiles, ...result.tester.changedFiles])],
        testsAdded: [...new Set([...previousResult.tester.testsAdded, ...result.tester.testsAdded])]
      }
    };
  } else if (result && previousResult?.route === "documentation_only" && result.route === "documentation_only") {
    result = {
      ...result,
      documentation: {
        ...result.documentation,
        changedFiles: [...new Set([...previousResult.documentation.changedFiles, ...result.documentation.changedFiles])]
      }
    };
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
        && diagnosis.affectedFiles.every(file => authorized.has(file) || (role === "documenter" && isDocumentationPath(file)))
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
          acceptanceCriteria: automatedCriteria(result!.plan),
          checks: finalChecks,
          diagnosis,
          previous,
          attempt
        }, workflow.mutationCwd, workflow.ctx, text => parseTesterOutput(text, automatedCriteria(result!.plan)), { attempt, mutationPlan: result!.plan });
        if (tester.blocker) {
          const resolved = await resolveAgentBlocker(runtime, workflow, result!, tester.blocker);
          result = { ...resolved.planning, route: "tests_only", tester: { ...tester, changedFiles: [...new Set([...previous.changedFiles, ...tester.changedFiles])], testsAdded: [...new Set([...previous.testsAdded, ...tester.testsAdded])] } };
        } else {
          assertTesterComplete(tester, result!.route);
          result = { ...result!, tester: { ...tester, changedFiles: [...new Set([...previous.changedFiles, ...tester.changedFiles])], testsAdded: [...new Set([...previous.testsAdded, ...tester.testsAdded])] } };
        }
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
        if (documentation.blocker && documentation.blocker.kind === "scope") {
          const phase: DocumentationScopePhase = { phase: "repair_checks", blockedDocumentation: documentation, preparation: { documentation: result!.documentation, proposedCandidates: [], duplicateCandidateIds: [], machineEligibleCount: 0, machineRejectedCount: 0, duplicateCount: 0 }, failedChecks: finalChecks, diagnosis, attempt, changeRound: 0 };
          const updated = await resolveSpecializedDocumenterScope(runtime, workflow, result!, documentation, phase);
          result = { ...updated.planning, route: "documentation_only", documentation: result!.documentation };
          attempt--;
          continue;
        }
        if (documentation.blocker) {
          const resolved = await resolveAgentBlocker(runtime, workflow, result!, documentation.blocker);
          result = { ...resolved.planning, route: "documentation_only", documentation: { ...documentation, changedFiles: [...new Set([...previous.changedFiles, ...documentation.changedFiles])] } };
        } else {
          assertDocumenterComplete(documentation);
          if (documentation.proposedLessons.length > 0) throw new Error("Documentation-only workflows cannot propose permanent-memory lessons");
          result = { ...result!, documentation: { ...documentation, changedFiles: [...new Set([...previous.changedFiles, ...documentation.changedFiles])] } };
        }
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
  const policy = resolveParticipationPolicy(workflow.config);
  if (requiresHumanDecision(policy, "final_delivery")) {
    const decision = restoredDeliveryDecision ?? await runDurableHumanGate(
      runtime,
      workflow,
      "final_delivery",
      "Final delivery approval",
      { point: "final_delivery", mode: "specialized", changeRound },
      {
        exploration: result.exploration,
        plan: result.plan,
        baselineChecks: result.baseline,
        ...(result.route === "tests_only" ? { tester: result.tester } : { documentation: result.documentation }),
        decisionContext: { mode: "specialized", result, finalChecks, changeRound }
      },
      async signal => {
        const answer = await workflow.ctx.ui.select(
          `Final checks are green. Deliver ${result!.plan.summary}?`,
          ["Finish delivery", "Request changes", "Cancel workflow"],
          { signal }
        );
        if (!answer) return undefined;
        if (answer === "Cancel workflow") return { action: "cancel" as const };
        if (answer === "Finish delivery") return { action: "finish" as const };
        const feedback = await workflow.ctx.ui.input("Describe the required final changes:", "Be specific about behavior and files", { signal });
        return feedback === undefined ? undefined : { action: "request_changes" as const, feedback };
      },
      answer => ({ action: answer.action === "finish" ? "finish" : "request_changes", feedback: answer.feedback }),
      {
        format: "markdown",
        content: `## Final delivery approval\n\nAll ${finalChecks.length} final project check(s) are green. Review the approved delivery scope before finishing or requesting a final revision.\n\n${formatPlanForReview(result.plan)}`,
        actions: [
          decisionAction("finish", "Finish delivery"),
          decisionAction("request_changes", "Request final changes", true),
          decisionAction("cancel", "Cancel workflow"),
        ]
      }
    );
    if (decision.action === "request_changes") {
      await applySpecializedFinalChangeRequest(
        runtime,
        workflow,
        result,
        decision.feedback ?? "",
        changeRound + 1
      );
      return;
    }
  }
  await runSpecializedMutationFinalization(runtime, workflow, result, finalChecks);
}

export async function resolveSpecializedDocumenterScope(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  documentation: DocumenterOutput,
  phase: DocumentationScopePhase
): Promise<{ planning: ImplementationPlanningResult; documentation: DocumenterOutput }> {
  const { config } = workflow;
  const blocker = documentation.blocker;
  if (!blocker || blocker.kind !== "scope") throw new Error("resolveSpecializedDocumenterScope called without a scope blocker");
  const additions = filesOutsidePlan(planning.plan, blocker.requiredFiles);
  if (additions.length === 0) throw new Error("Documenter scope blocker requested no files outside the approved plan");
  const nonDoc = additions.filter(file => !isDocumentationPath(file));
  if (nonDoc.length > 0) throw new Error(`Documenter scope blocker requested non-documentation files: ${nonDoc.join(", ")}`);
  const newScope = consumeScopeRevision(planning.scopeRevisionCount, config.limits.planRevisions, "during documentation_only");
  const updated = await reviseImplementationScope(
    runtime, workflow, planning, additions,
    { checks: [], blocker },
    newScope,
    { mode: "finalization", scopeRevisionCount: newScope, documentation: phase }
  );
  return { planning: updated, documentation };
}

export async function applySpecializedFinalChangeRequest(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  result: SpecializedMutationResult,
  feedback: string,
  changeRound: number,
  proposedPlan?: PlannerOutput,
  approved = false
): Promise<void> {
  if (result.scopeRevisionCount >= workflow.config.limits.planRevisions) {
    throw new Error("Final change request limit was exhausted");
  }
  const plan = proposedPlan ?? await runAgentStep(runtime, "planner", "planning", "Plan requested final changes", {
    action: "revise_plan",
    route: workflow.route,
    request: workflow.request,
    exploration: result.exploration,
    previousPlan: result.plan,
    feedback: { source: "human", text: feedback }
  }, workflow.mutationCwd, workflow.ctx, parsePlannerOutput, { revision: changeRound });
  validateFinalPlanRevision(result.plan, plan);
  if (!approved) {
    await runDurableHumanGate(
      runtime,
      workflow,
      "final_revision_approval",
      "Final revision plan approval",
      { point: "final_revision_decision", mode: "specialized", changeRound },
      {
        exploration: result.exploration,
        plan,
        baselineChecks: result.baseline,
        ...(result.route === "tests_only" ? { tester: result.tester } : { documentation: result.documentation }),
        decisionContext: { mode: "specialized", result, plan, feedback, changeRound }
      },
      async signal => {
        const answer = await workflow.ctx.ui.select(
          `Approve final revision plan: ${plan.summary}?`,
          ["Approve revised plan", "Cancel workflow"],
          { signal }
        );
        return answer === undefined ? undefined : { action: answer === "Approve revised plan" ? "approve" as const : "cancel" as const };
      },
      () => ({ approved: true }),
      {
        format: "markdown",
        content: formatPlanForReview(plan),
        actions: [
          decisionAction("approve", "Approve revised plan"),
          decisionAction("cancel", "Cancel workflow"),
        ]
      }
    );
  }
  await runSpecializedMutationRoute(
    runtime,
    workflow,
    { ...result, plan, scopeRevisionCount: result.scopeRevisionCount + 1 },
    undefined,
    undefined,
    undefined,
    changeRound,
    result
  );
}
