import type { WorkflowCheckpoint, CheckpointCursorKind } from "../../persistence/checkpoint-types.js";
import { validateCheckResults, validateCheckResultsAgainstCommands } from "../../persistence/checkpoint-validation.js";
import { canonicalSha256 } from "../../workspace/workspace-guard.js";
import {
  validateDebuggerOutput,
  validateDocumenterOutput,
  validateExplorerOutput,
  validatePlannerOutput,
  validateReviewOutput,
  validateTesterOutput
} from "../../validation.js";
import { automatedCriteria } from "../acceptance-criteria.js";
import type { HumanDecisionAction, PendingHumanDecision, RecordedHumanDecision } from "../human-decision-types.js";
import { allGreen } from "../orchestrator-helpers.js";
import type { ImplementationPlanningResult, ImplementationResult, ReviewResult, WorkflowContext } from "../orchestrator-context.js";
import type { OrchestratorRuntime } from "../orchestrator-runtime.js";
import { requestBugDiagnosisApproval } from "../orchestrator-human-gates.js";
import { continueBugFixAfterDiagnosis, runSelectedRoute } from "../orchestrator-routes.js";
import { continueBaselineRepair, continuePlanningDecision, enterMutationPhase } from "../orchestrator-planning.js";
import { requestImplementationBudgetExtension, runImplementationPhase } from "../orchestrator-implementation.js";
import { runReviewPhase } from "../orchestrator-review.js";
import { applyFinalChangeRequest, runFinalizationPhase } from "../orchestrator-finalization.js";
import { applySpecializedFinalChangeRequest, runSpecializedMutationRoute } from "../orchestrator-specialized-routes.js";
import { continueScopeRevisionDecision, type ScopeRevisionDecisionContext } from "../orchestrator-scope-revision.js";
import { saveWorkflowCheckpoint } from "../orchestrator-checkpoints.js";
import { validateFailureScopeRevision } from "../plan-revision.js";
import { WorkflowPausedError } from "../workflow-errors.js";
import { builderBlocker, implementationPlanningResult, reviewResult, serializedLessonPreparation, specializedMutationResult } from "./serializers.js";
import { arrayValue, hydrateCandidates, nonNegativeInteger, objectValue, positiveInteger, preflightRemainingRoute, stringValue, type ContinuationModule } from "./shared.js";

async function continueHumanDecision(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  checkpoint: WorkflowCheckpoint,
  request: PendingHumanDecision,
  recorded?: RecordedHumanDecision
): Promise<void> {
  if (request.resume.point !== "plan_decision") {
    if (request.resume.point === "baseline_repair_decision") {
      const { exploration, plan, proposedPlan, baselineChecks, diagnosis } = checkpoint.bindings;
      if (!exploration || !plan || !proposedPlan || !baselineChecks || !diagnosis) {
        throw new Error("Baseline repair decision checkpoint is missing repair bindings");
      }
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const prepared = await continueBaselineRepair(
        runtime,
        workflow,
        { exploration: validateExplorerOutput(exploration), plan: validatePlannerOutput(plan) },
        validateCheckResults(baselineChecks),
        validateDebuggerOutput(diagnosis),
        validatePlannerOutput(proposedPlan),
        recorded ? planReviewDecision(recorded) : undefined
      );
      await runSelectedRoute(runtime, workflow, prepared, { prepared: true });
      return;
    }
    if (request.resume.point === "bug_diagnosis_decision") {
      if (workflow.route !== "bug_fix") throw new Error("Bug diagnosis decision requires the bug_fix route");
      const { exploration, plan, baselineChecks, diagnosis } = checkpoint.bindings;
      if (!exploration || !plan || !baselineChecks || !diagnosis) {
        throw new Error("Bug diagnosis decision checkpoint is missing diagnosis bindings");
      }
      const planning: ImplementationPlanningResult = {
        exploration: validateExplorerOutput(exploration),
        plan: validatePlannerOutput(plan),
        baseline: validateCheckResults(baselineChecks),
        scopeRevisionCount: request.resume.scopeRevisionCount
      };
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const validatedDiagnosis = validateDebuggerOutput(diagnosis);
      if (recorded) {
        bugDiagnosisDecision(recorded);
      } else {
        await requestBugDiagnosisApproval(runtime, workflow, planning, validatedDiagnosis);
        await preflightRemainingRoute(runtime, workflow);
      }
      await continueBugFixAfterDiagnosis(runtime, workflow, planning, validatedDiagnosis, true);
      return;
    }
    if (request.resume.point === "mutation_confirmation") {
      const { exploration, plan, proposedPlan, baselineChecks, diagnosis } = checkpoint.bindings;
      if (!exploration || !plan || !baselineChecks) throw new Error("Mutation confirmation checkpoint is missing planning bindings");
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const confirmed = recorded ? mutationConfirmation(recorded) : false;
      if (request.resume.mode === "baseline_repair") {
        if (!proposedPlan || !diagnosis) throw new Error("Baseline repair mutation confirmation is missing repair bindings");
        const prepared = await continueBaselineRepair(
          runtime,
          workflow,
          { exploration: validateExplorerOutput(exploration), plan: validatePlannerOutput(plan) },
          validateCheckResults(baselineChecks),
          validateDebuggerOutput(diagnosis),
          validatePlannerOutput(proposedPlan),
          { approved: true },
          confirmed
        );
        await runSelectedRoute(runtime, workflow, prepared, { prepared: true });
        return;
      }
      const prepared: ImplementationPlanningResult = {
        exploration: validateExplorerOutput(exploration),
        plan: validatePlannerOutput(plan),
        baseline: validateCheckResults(baselineChecks),
        scopeRevisionCount: request.resume.scopeRevisionCount,
        ...(request.resume.mode === "prepared" && diagnosis ? { baselineDiagnosis: validateDebuggerOutput(diagnosis) } : {})
      };
      await enterMutationPhase(runtime, workflow, { resume: request.resume, bindings: checkpoint.bindings }, confirmed);
      if (request.resume.mode === "bug_diagnosed") {
        if (!diagnosis) throw new Error("Bug diagnosis mutation confirmation is missing diagnosis bindings");
        const bugDiagnosis = validateDebuggerOutput(diagnosis);
        await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosed", { planning: prepared, diagnosis: bugDiagnosis }, checkpoint.bindings);
        await runSelectedRoute(runtime, workflow, prepared, { prepared: true, bugDiagnosis });
      } else {
        await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", prepared, checkpoint.bindings);
        await runSelectedRoute(runtime, workflow, prepared, { prepared: true });
      }
      return;
    }
    if (request.resume.point === "scope_revision_decision") {
      const context = scopeRevisionDecisionContext(checkpoint.bindings.decisionContext, request.resume);
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const revised = await continueScopeRevisionDecision(
        runtime,
        workflow,
        context,
        recorded ? planReviewDecision(recorded) : undefined
      );
      const after = context.after;
      if (after.mode === "implementation") {
        const planning = revised as ImplementationPlanningResult;
        await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
          mode: "implementation",
          planning,
          tester: after.tester,
          checksAfterTests: after.checksAfterTests,
          previousChecks: after.previousChecks,
          diagnosis: after.diagnosis,
          attempt: after.attempt,
          scopeRevisionCount: after.scopeRevisionCount
        }, {
          exploration: planning.exploration,
          plan: planning.plan,
          baselineChecks: planning.baseline,
          tester: after.tester,
          builderOutputs: runtime.builderSessionOutputs,
          implementationChecks: after.previousChecks,
          diagnosis: after.diagnosis
        });
        const implementation = await runImplementationPhase(runtime, workflow, planning, {
          point: "scope_revision_approved",
          tester: after.tester,
          checksAfterTests: after.checksAfterTests,
          previousChecks: after.previousChecks,
          diagnosis: after.diagnosis,
          attempt: after.attempt,
          scopeRevisionCount: after.scopeRevisionCount
        }, { skipTester: workflow.route === "quick_implementation" });
        const review = await runReviewPhase(runtime, workflow, implementation);
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      if (after.mode === "review") {
        const implementation = { ...(context.planning as ImplementationResult), plan: revised.plan, scopeRevisionCount: after.scopeRevisionCount };
        await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", {
          mode: "review",
          implementation,
          finalImplChecks: after.finalImplChecks,
          codeReview: after.codeReview,
          priorCodeReviews: after.priorCodeReviews,
          pendingFix: after.pendingFix,
          allowedReviewFixes: after.allowedReviewFixes,
          scopeRevisionCount: after.scopeRevisionCount,
          failureChecks: after.failureChecks,
          failureDiagnosis: after.failureDiagnosis
        }, {
          exploration: implementation.exploration,
          plan: implementation.plan,
          baselineChecks: implementation.baseline,
          tester: implementation.tester,
          builderOutputs: runtime.builderSessionOutputs,
          implementationChecks: after.finalImplChecks,
          codeReview: after.codeReview,
          priorCodeReviews: after.priorCodeReviews,
          diagnosis: after.failureDiagnosis
        });
        const review = await runReviewPhase(runtime, workflow, implementation, {
          point: "scope_revision_approved",
          finalImplChecks: after.finalImplChecks,
          codeReview: after.codeReview,
          priorCodeReviews: after.priorCodeReviews,
          pendingFix: after.pendingFix,
          allowedReviewFixes: after.allowedReviewFixes,
          scopeRevisionCount: after.scopeRevisionCount,
          failureChecks: after.failureChecks,
          failureDiagnosis: after.failureDiagnosis
        });
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      if (after.mode === "finalization") {
        const review = revised as ReviewResult;
        const docPhase = after.documentation;
        const savedContinuation = {
          mode: "finalization",
          review,
          documentation: docPhase.blockedDocumentation,
          ...(docPhase.phase === "repair_checks" ? {
            preparation: docPhase.preparation,
            failedChecks: docPhase.failedChecks,
            diagnosis: docPhase.diagnosis,
            attempt: docPhase.attempt,
            changeRound: docPhase.changeRound
          } : { changeRound: docPhase.changeRound })
        };
        await saveWorkflowCheckpoint(runtime, workflow, "scope_revision_approved", savedContinuation, {
          exploration: review.exploration,
          plan: review.plan,
          baselineChecks: review.baseline,
          tester: review.tester,
          builderOutputs: runtime.builderSessionOutputs,
          implementationChecks: review.finalImplChecks,
          codeReview: review.codeReview,
          priorCodeReviews: review.priorCodeReviews,
          reviewApprovalSource: review.reviewApprovalSource
        });
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      if (after.mode !== "bug_diagnosed") throw new Error("Unexpected scope revision mode after review");
      const planning = { ...(revised as ImplementationPlanningResult), scopeRevisionCount: after.scopeRevisionCount };
      await enterMutationPhase(runtime, workflow, {
        resume: { point: "mutation_confirmation", mode: "bug_diagnosed", scopeRevisionCount: after.scopeRevisionCount },
        bindings: {
          exploration: planning.exploration,
          plan: planning.plan,
          baselineChecks: planning.baseline,
          diagnosis: after.diagnosis
        }
      });
      await saveWorkflowCheckpoint(runtime, workflow, "bug_diagnosed", { planning, diagnosis: after.diagnosis }, {
        exploration: planning.exploration,
        plan: planning.plan,
        baselineChecks: planning.baseline,
        diagnosis: after.diagnosis
      });
      await runSelectedRoute(runtime, workflow, planning, { prepared: true, bugDiagnosis: after.diagnosis });
      return;
    }
    if (request.resume.point === "budget_exhausted") {
      const { exploration, plan, baselineChecks, tester, implementationChecks, diagnosis, decisionContext } = checkpoint.bindings;
      if (!exploration || !plan || !baselineChecks || !implementationChecks || !diagnosis) {
        throw new Error("Repair budget decision checkpoint is missing implementation bindings");
      }
      const context = objectValue(decisionContext, "repair budget decision context");
      const checksAfterTests = validateCheckResults(context.checksAfterTests);
      const validatedTester = tester === undefined ? undefined : validateTesterOutput(tester, automatedCriteria(plan));
      const failedChecks = validateCheckResults(implementationChecks);
      const validatedDiagnosis = validateDebuggerOutput(diagnosis);
      const planning: ImplementationPlanningResult = {
        exploration: validateExplorerOutput(exploration),
        plan: validatePlannerOutput(plan),
        baseline: validateCheckResults(baselineChecks),
        scopeRevisionCount: request.resume.scopeRevisionCount
      };
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      if (recorded) repairBudgetDecision(recorded);
      else await requestImplementationBudgetExtension(
        runtime,
        workflow,
        planning,
        validatedTester,
        checksAfterTests,
        failedChecks,
        validatedDiagnosis,
        request.resume.nextAttempt - 1,
        request.resume.allowedAttempts - 1,
        request.resume.scopeRevisionCount
      );
      const implementation = await runImplementationPhase(runtime, workflow, planning, {
        point: "budget_extended",
        tester: validatedTester,
        checksAfterTests,
        failedChecks,
        diagnosis: validatedDiagnosis,
        attempt: request.resume.nextAttempt,
        allowedAttempts: request.resume.allowedAttempts,
        scopeRevisionCount: request.resume.scopeRevisionCount
      }, { skipTester: workflow.route === "quick_implementation" });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    if (request.resume.point === "final_revision_decision") {
      const context = objectValue(checkpoint.bindings.decisionContext, "final revision decision context");
      const mode = stringValue(context.mode, "final revision decision mode");
      if (mode !== request.resume.mode) throw new Error("Final revision mode does not match its decision context");
      const changeRound = nonNegativeInteger(context.changeRound, "changeRound");
      if (changeRound !== request.resume.changeRound) throw new Error("Final revision change round does not match its decision context");
      const feedback = context.feedback;
      if (typeof feedback !== "string") throw new Error("Final revision feedback must be a string");
      const plan = validatePlannerOutput(context.plan);
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const approval = recorded ? planReviewDecision(recorded) : undefined;
      if (approval && !approval.approved) throw new Error("Final revision decisions can only approve or cancel the proposed plan");
      if (mode === "specialized") {
        const result = specializedMutationResult(context.result);
        await applySpecializedFinalChangeRequest(runtime, workflow, result, feedback, changeRound, plan, approval?.approved === true);
        return;
      }
      const review = reviewResult(context.review);
      await applyFinalChangeRequest(runtime, workflow, review, feedback, changeRound, plan, approval?.approved === true);
      return;
    }
    if (request.resume.point === "final_delivery") {
      const context = objectValue(checkpoint.bindings.decisionContext, "final delivery decision context");
      const mode = stringValue(context.mode, "final delivery decision mode");
      if (mode !== request.resume.mode) throw new Error("Final delivery mode does not match its decision context");
      const changeRound = nonNegativeInteger(context.changeRound, "changeRound");
      if (changeRound !== request.resume.changeRound) throw new Error("Final delivery change round does not match its decision context");
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      if (mode === "specialized") {
        const result = specializedMutationResult(context.result);
        const finalChecks = validateCheckResultsAgainstCommands(context.finalChecks, checkpoint.config.checks, "finalChecks");
        if (!allGreen(finalChecks, checkpoint.config.checks.length)) throw new Error("Final delivery decision checks are not green");
        await runSpecializedMutationRoute(
          runtime,
          workflow,
          result,
          result,
          finalChecks,
          recorded ? finalDeliveryDecision(recorded) : undefined,
          changeRound
        );
        return;
      }
      const review = reviewResult(context.review);
      const preparation = serializedLessonPreparation(context.preparation);
      const finalChecks = validateCheckResultsAgainstCommands(context.finalChecks, checkpoint.config.checks, "finalChecks");
      if (!allGreen(finalChecks, checkpoint.config.checks.length)) throw new Error("Final delivery decision checks are not green");
      hydrateCandidates(runtime, preparation);
      await runFinalizationPhase(runtime, workflow, review, {
        point: "final_delivery",
        preparation,
        finalChecks,
        changeRound,
        review,
        decision: recorded ? finalDeliveryDecision(recorded) : undefined
      });
      return;
    }
    if (request.resume.point === "review_decision") {
      const implementation = implementationResultFromDecisionBindings(checkpoint, request.resume.scopeRevisionCount);
      const codeReview = checkpoint.bindings.codeReview;
      if (!codeReview) throw new Error("Review decision checkpoint is missing code review bindings");
      const decision = recorded ? reviewDecision(recorded) : undefined;
      runtime.requireState().pendingDecision = recorded ? undefined : request;
      const review = await runReviewPhase(runtime, workflow, implementation, {
        point: "review_decision",
        finalImplChecks: implementation.finalImplChecks,
        codeReview,
        priorCodeReviews: (checkpoint.bindings.priorCodeReviews ?? []).slice(),
        completedFixes: request.resume.completedFixes,
        allowedReviewFixes: request.resume.allowedReviewFixes,
        scopeRevisionCount: request.resume.scopeRevisionCount,
        decision
      });
      await runFinalizationPhase(runtime, workflow, review);
      return;
    }
    throw new WorkflowPausedError(request.id, `${request.label} cannot yet be resumed automatically`);
  }
  const exploration = checkpoint.bindings.exploration;
  const plan = checkpoint.bindings.plan;
  if (!exploration || !plan) throw new Error("Plan decision checkpoint is missing planning bindings");
  runtime.requireState().pendingDecision = recorded ? undefined : request;
  const decision = recorded ? planReviewDecision(recorded) : undefined;
  const planning = await continuePlanningDecision(runtime, workflow, exploration, plan, request.resume.reviewIndex, decision);
  await runSelectedRoute(runtime, workflow, planning);
}

function implementationResultFromDecisionBindings(checkpoint: WorkflowCheckpoint, scopeRevisionCount: number): ImplementationResult {
  const { exploration, plan, baselineChecks, tester, implementationChecks, diagnosis } = checkpoint.bindings;
  if (!exploration || !plan || !baselineChecks || !implementationChecks) {
    throw new Error("Review decision checkpoint is missing implementation bindings");
  }
  if (!tester && plan.route !== "quick_implementation") throw new Error("Review decision checkpoint is missing Tester output");
  return {
    exploration: validateExplorerOutput(exploration),
    plan: validatePlannerOutput(plan),
    baseline: validateCheckResults(baselineChecks),
    scopeRevisionCount,
    tester: tester ? validateTesterOutput(tester, automatedCriteria(plan)) : undefined,
    finalImplChecks: validateCheckResults(implementationChecks),
    diagnosis: diagnosis ? validateDebuggerOutput(diagnosis) : undefined
  };
}

function scopeRevisionDecisionContext(
  value: unknown,
  resume: Extract<PendingHumanDecision["resume"], { point: "scope_revision_decision" }>
): ScopeRevisionDecisionContext {
  const item = objectValue(value, "scope revision decision context");
  const afterValue = objectValue(item.after, "scope revision continuation");
  const mode = stringValue(afterValue.mode, "scope revision continuation mode");
  const planning = mode === "review" || mode === "finalization" ? reviewResult(item.planning) : implementationPlanningResult(item.planning);
  const additions = arrayValue(item.additions, "scope revision additions").map((entry, index) => stringValue(entry, `scope revision additions[${index}]`));
  if (canonicalSha256(additions) !== canonicalSha256(resume.additions)) throw new Error("Scope revision additions do not match the pending decision");
  const scopeRevision = positiveInteger(item.scopeRevision, "scopeRevision");
  const reviewIndex = nonNegativeInteger(item.reviewIndex, "reviewIndex");
  if (scopeRevision !== resume.scopeRevision || reviewIndex !== resume.reviewIndex) throw new Error("Scope revision cursor does not match its decision context");
  const revised = validateFailureScopeRevision(planning.plan, validatePlannerOutput(item.revised), additions);
  const evidenceValue = objectValue(item.evidence, "scope revision evidence");
  const evidence: ScopeRevisionDecisionContext["evidence"] = {
    checks: validateCheckResults(evidenceValue.checks),
    diagnosis: evidenceValue.diagnosis === undefined ? undefined : validateDebuggerOutput(evidenceValue.diagnosis),
    blocker: evidenceValue.blocker === undefined ? undefined : builderBlocker(evidenceValue.blocker)
  };
  let after: ScopeRevisionDecisionContext["after"];
  if (mode === "implementation") {
    const tester = afterValue.tester === undefined ? undefined : validateTesterOutput(afterValue.tester, automatedCriteria(planning.plan));
    after = {
      mode,
      tester,
      checksAfterTests: validateCheckResults(afterValue.checksAfterTests),
      previousChecks: afterValue.previousChecks === undefined ? undefined : validateCheckResults(afterValue.previousChecks),
      diagnosis: afterValue.diagnosis === undefined ? undefined : validateDebuggerOutput(afterValue.diagnosis),
      attempt: positiveInteger(afterValue.attempt, "attempt"),
      scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (mode === "review") {
    after = {
      mode,
      finalImplChecks: validateCheckResults(afterValue.finalImplChecks),
      codeReview: validateReviewOutput(afterValue.codeReview),
      priorCodeReviews: arrayValue(afterValue.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`)),
      pendingFix: positiveInteger(afterValue.pendingFix, "pendingFix"),
      allowedReviewFixes: nonNegativeInteger(afterValue.allowedReviewFixes, "allowedReviewFixes"),
      scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount"),
      failureChecks: afterValue.failureChecks === undefined ? undefined : validateCheckResults(afterValue.failureChecks),
      failureDiagnosis: afterValue.failureDiagnosis === undefined ? undefined : validateDebuggerOutput(afterValue.failureDiagnosis)
    };
  } else if (mode === "bug_diagnosed") {
    after = {
      mode,
      diagnosis: validateDebuggerOutput(afterValue.diagnosis),
      scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (mode === "finalization") {
    const documentationValue = objectValue(afterValue.documentation, "scope revision documentation");
    const phase = stringValue(documentationValue.phase, "documentation phase");
    const blockedDocumentation = validateDocumenterOutput(documentationValue.blockedDocumentation);
    if (phase === "initial_documentation") {
      after = {
        mode,
        scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount"),
        documentation: {
          phase: "initial_documentation",
          blockedDocumentation,
          changeRound: nonNegativeInteger(documentationValue.changeRound, "changeRound")
        }
      };
    } else if (phase === "repair_checks") {
      after = {
        mode,
        scopeRevisionCount: positiveInteger(afterValue.scopeRevisionCount, "scopeRevisionCount"),
        documentation: {
          phase: "repair_checks",
          blockedDocumentation,
          preparation: serializedLessonPreparation(documentationValue.preparation),
          failedChecks: validateCheckResults(documentationValue.failedChecks),
          diagnosis: validateDebuggerOutput(documentationValue.diagnosis),
          attempt: positiveInteger(documentationValue.attempt, "attempt"),
          changeRound: nonNegativeInteger(documentationValue.changeRound, "changeRound")
        }
      };
    } else {
      throw new Error("Documentation scope phase is invalid");
    }
  } else {
    throw new Error("Scope revision continuation mode is invalid");
  }
  return { planning, revised, additions, evidence, scopeRevision, reviewIndex, after };
}

function reviewDecision(recorded: RecordedHumanDecision): { action: "accept" | "fix_again" } {
  if (recorded.action === "accept_current") return { action: "accept" };
  if (recorded.action === "fix_again") return { action: "fix_again" };
  throw new Error(`Recorded ${recorded.action} action is invalid for a review decision`);
}

function mutationConfirmation(recorded: RecordedHumanDecision): boolean {
  if (recorded.action === "proceed") return true;
  throw new Error(`Recorded ${recorded.action} action is invalid for mutation confirmation`);
}

function bugDiagnosisDecision(recorded: RecordedHumanDecision): void {
  if (recorded.action !== "approve") throw new Error(`Recorded ${recorded.action} action is invalid for bug diagnosis approval`);
}

function repairBudgetDecision(recorded: RecordedHumanDecision): void {
  if (recorded.action !== "fix_again") throw new Error(`Recorded ${recorded.action} action is invalid for a repair budget decision`);
}

function finalDeliveryDecision(recorded: RecordedHumanDecision): { action: "finish" | "request_changes"; feedback?: string } {
  if (recorded.action === "finish") return { action: "finish" };
  if (recorded.action === "request_changes") return { action: "request_changes", feedback: recorded.feedback };
  throw new Error(`Recorded ${recorded.action} action is invalid for final delivery`);
}

function planReviewDecision(recorded: RecordedHumanDecision): { approved: boolean; feedback?: string } {
  if (recorded.action === "approve") return { approved: true };
  if (recorded.action === "revise") return { approved: false, feedback: recorded.feedback };
  throw new Error(`Recorded ${recorded.action} action is invalid for a plan decision`);
}

export function humanDecisionContinuation(
  value: unknown,
  requireRecorded: boolean
): { request: PendingHumanDecision; recorded?: RecordedHumanDecision } {
  const item = objectValue(value, "human decision checkpoint");
  const request = pendingHumanDecision(item.request);
  const recorded = item.recorded === undefined ? undefined : recordedHumanDecision(item.recorded, request.id);
  if (requireRecorded && !recorded) throw new Error("Recorded human decision checkpoint is missing its decision");
  if (!requireRecorded && recorded) throw new Error("Pending human decision checkpoint cannot contain a recorded decision");
  return { request, recorded };
}

function pendingHumanDecision(value: unknown): PendingHumanDecision {
  const item = objectValue(value, "pending human decision");
  if (item.schemaVersion !== 1) throw new Error("Pending human decision schemaVersion must be 1");
  const kind = stringValue(item.kind, "pending human decision kind") as PendingHumanDecision["kind"];
  if (!["plan_approval", "plan_revision_approval", "baseline_repair_approval", "bug_diagnosis_approval", "mutation_confirmation", "scope_expansion", "code_review_rejection", "repair_budget_exhausted", "final_revision_approval", "final_delivery"].includes(kind)) {
    throw new Error("Pending human decision kind is invalid");
  }
  const resumeValue = objectValue(item.resume, "pending human decision resume point");
  const point = stringValue(resumeValue.point, "pending human decision resume point");
  let resume: PendingHumanDecision["resume"];
  if (point === "plan_decision") {
    resume = { point, reviewIndex: nonNegativeInteger(resumeValue.reviewIndex, "reviewIndex") };
  } else if (point === "review_decision") {
    resume = {
      point,
      completedFixes: nonNegativeInteger(resumeValue.completedFixes, "completedFixes"),
      allowedReviewFixes: nonNegativeInteger(resumeValue.allowedReviewFixes, "allowedReviewFixes"),
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (point === "mutation_confirmation") {
    const mode = stringValue(resumeValue.mode, "mutation confirmation mode");
    if (mode !== "prepared" && mode !== "baseline_repair" && mode !== "bug_diagnosed") {
      throw new Error("Mutation confirmation mode is invalid");
    }
    resume = {
      point,
      mode,
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (point === "scope_revision_decision") {
    resume = {
      point,
      additions: arrayValue(resumeValue.additions, "additions").map((entry, index) => stringValue(entry, `additions[${index}]`)),
      scopeRevision: positiveInteger(resumeValue.scopeRevision, "scopeRevision"),
      reviewIndex: nonNegativeInteger(resumeValue.reviewIndex, "reviewIndex")
    };
  } else if (point === "budget_exhausted") {
    const phase = stringValue(resumeValue.phase, "repair budget phase");
    if (phase !== "implementation") throw new Error("Repair budget phase is invalid");
    resume = {
      point,
      phase,
      nextAttempt: positiveInteger(resumeValue.nextAttempt, "nextAttempt"),
      allowedAttempts: positiveInteger(resumeValue.allowedAttempts, "allowedAttempts"),
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else if (point === "final_revision_decision") {
    const mode = stringValue(resumeValue.mode, "final revision mode");
    if (mode !== "review" && mode !== "specialized") throw new Error("Final revision mode is invalid");
    resume = { point, mode, changeRound: positiveInteger(resumeValue.changeRound, "changeRound") };
  } else if (point === "final_delivery") {
    const mode = stringValue(resumeValue.mode, "final delivery mode");
    if (mode !== "review" && mode !== "specialized") throw new Error("Final delivery mode is invalid");
    resume = { point, mode, changeRound: nonNegativeInteger(resumeValue.changeRound, "changeRound") };
  } else if (point === "baseline_repair_decision") {
    resume = { point } as PendingHumanDecision["resume"];
  } else if (point === "bug_diagnosis_decision") {
    resume = {
      point,
      scopeRevisionCount: nonNegativeInteger(resumeValue.scopeRevisionCount, "scopeRevisionCount")
    };
  } else {
    throw new Error("Pending human decision resume point is invalid");
  }
  const requestedAt = stringValue(item.requestedAt, "pending human decision requestedAt");
  if (!Number.isFinite(Date.parse(requestedAt))) throw new Error("Pending human decision requestedAt is invalid");
  if ((kind === "bug_diagnosis_approval") !== (resume.point === "bug_diagnosis_decision")) {
    throw new Error("Bug diagnosis approval kind and resume point must be paired");
  }
  return {
    schemaVersion: 1,
    id: stringValue(item.id, "pending human decision id"),
    kind,
    label: stringValue(item.label, "pending human decision label"),
    requestedAt,
    resume
  };
}

function recordedHumanDecision(value: unknown, requestId: string): RecordedHumanDecision {
  const item = objectValue(value, "recorded human decision");
  if (item.schemaVersion !== 1) throw new Error("Recorded human decision schemaVersion must be 1");
  if (stringValue(item.requestId, "recorded human decision requestId") !== requestId) throw new Error("Recorded human decision requestId does not match");
  const action = stringValue(item.action, "recorded human decision action") as HumanDecisionAction;
  if (!["approve", "revise", "cancel", "proceed", "accept_current", "fix_again", "finish", "request_changes", "defer"].includes(action)) {
    throw new Error("Recorded human decision action is invalid");
  }
  const decidedAt = stringValue(item.decidedAt, "recorded human decision decidedAt");
  if (!Number.isFinite(Date.parse(decidedAt))) throw new Error("Recorded human decision decidedAt is invalid");
  const source = item.source;
  if (source !== "tui" && source !== "rpc" && source !== "dashboard") throw new Error("Recorded human decision source is invalid");
  return {
    schemaVersion: 1,
    requestId,
    decidedAt,
    source,
    action,
    feedback: item.feedback === undefined ? undefined : stringValue(item.feedback, "recorded human decision feedback")
  };
}

export const humanDecisionContinuations = {
  human_decision_pending: {
    validate(value) {
      humanDecisionContinuation(value, false);
    },
    async continue(runtime, workflow, checkpoint) {
      const { request } = humanDecisionContinuation(checkpoint.cursor.continuation, false);
      await continueHumanDecision(runtime, workflow, checkpoint, request);
    }
  },
  human_decision_recorded: {
    validate(value) {
      humanDecisionContinuation(value, true);
    },
    async continue(runtime, workflow, checkpoint) {
      const { request, recorded } = humanDecisionContinuation(checkpoint.cursor.continuation, true);
      await continueHumanDecision(runtime, workflow, checkpoint, request, recorded);
    }
  }
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
