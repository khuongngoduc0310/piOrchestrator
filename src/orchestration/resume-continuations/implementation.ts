import type { CheckpointCursorKind } from "../../persistence/checkpoint-types.js";
import { validateCheckResults } from "../../persistence/checkpoint-validation.js";
import {
  validateDebuggerOutput,
  validateDocumenterOutput,
  validatePlannerOutput,
  validateReviewOutput,
  validateTesterOutput
} from "../../validation.js";
import { automatedCriteria } from "../acceptance-criteria.js";
import { requestBugDiagnosisApproval } from "../orchestrator-human-gates.js";
import { continueBugFixAfterDiagnosis, runSelectedRoute } from "../orchestrator-routes.js";
import { runApprovedBaselineRepair } from "../orchestrator-planning.js";
import { runImplementationPhase, type ImplementationContinuation } from "../orchestrator-implementation.js";
import { runReviewPhase, type ReviewContinuation } from "../orchestrator-review.js";
import { runFinalizationPhase } from "../orchestrator-finalization.js";
import { runCheckStep } from "../orchestrator-workspace.js";
import { saveWorkflowCheckpoint } from "../orchestrator-checkpoints.js";
import { assertTesterComplete } from "../mutation-completion.js";
import { requiresHumanDecision, resolveParticipationPolicy } from "../participation-policy.js";
import { implementationPlanningResult, implementationResult, planningResult, reviewResult, serializedLessonPreparation } from "./serializers.js";
import { arrayValue, nonNegativeInteger, objectValue, positiveInteger, preflightRemainingRoute, type ContinuationModule } from "./shared.js";

export const implementationContinuations = {
  baseline_repair_ready: {
    validate(value) {
      const item = objectValue(value, "baseline repair-ready checkpoint");
      planningResult(item.planning);
      validateCheckResults(item.failedBaseline);
      validateDebuggerOutput(item.baselineDiagnosis);
      validatePlannerOutput(item.baselineFixPlan);
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "baseline repair-ready checkpoint");
      await runApprovedBaselineRepair(
        runtime,
        workflow,
        planningResult(value.planning),
        validateCheckResults(value.failedBaseline),
        validateDebuggerOutput(value.baselineDiagnosis),
        validatePlannerOutput(value.baselineFixPlan)
      );
    }
  },
  mutation_ready: {
    validate(value) {
      implementationPlanningResult(value);
    },
    async continue(runtime, workflow, _checkpoint) {
      const planning = implementationPlanningResult(_checkpoint.cursor.continuation);
      await runSelectedRoute(runtime, workflow, planning, { prepared: true });
    }
  },
  bug_diagnosis_ready: {
    validate(value, _checkpoint) {
      const item = objectValue(value, "bug diagnosis-ready checkpoint");
      const planning = implementationPlanningResult(item.planning);
      if (planning.plan.route !== "bug_fix") throw new Error("Bug diagnosis-ready checkpoint requires the bug_fix route");
      validateDebuggerOutput(item.diagnosis);
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "bug diagnosis-ready checkpoint");
      const planning = implementationPlanningResult(value.planning);
      const diagnosis = validateDebuggerOutput(value.diagnosis);
      const approvalRequired = requiresHumanDecision(
        resolveParticipationPolicy(workflow.config),
        "diagnosis_approval",
        { confidence: diagnosis.confidence }
      );
      if (approvalRequired) {
        await requestBugDiagnosisApproval(runtime, workflow, planning, diagnosis);
        await preflightRemainingRoute(runtime, workflow);
      }
      await continueBugFixAfterDiagnosis(runtime, workflow, planning, diagnosis, approvalRequired);
    }
  },
  bug_diagnosed: {
    validate(value) {
      const item = objectValue(value, "bug diagnosis checkpoint");
      implementationPlanningResult(item.planning);
      validateDebuggerOutput(item.diagnosis);
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "bug diagnosis checkpoint");
      await runSelectedRoute(runtime, workflow, implementationPlanningResult(value.planning), {
        prepared: true,
        bugDiagnosis: validateDebuggerOutput(value.diagnosis)
      });
    }
  },
  tester_completed: {
    validate(value) {
      const item = objectValue(value, "tester checkpoint");
      const planning = implementationPlanningResult(item.planning);
      assertTesterComplete(validateTesterOutput(item.tester, automatedCriteria(planning.plan)), planning.plan.route);
      if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "tester checkpoint");
      const planning = implementationPlanningResult(value.planning);
      const tester = validateTesterOutput(value.tester, automatedCriteria(planning.plan));
      const diagnosis = value.diagnosis === undefined ? undefined : validateDebuggerOutput(value.diagnosis);
      const implementation = await runImplementationPhase(runtime, workflow, planning, { point: "tester_completed", tester, diagnosis }, {
        initialDiagnosis: diagnosis
      });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
    }
  },
  builder_completed: {
    validate(value) {
      const item = objectValue(value, "builder checkpoint");
      if (item.mode === "baseline_repair") {
        planningResult(item.planning);
        validateCheckResults(item.failedBaseline);
        validateDebuggerOutput(item.baselineDiagnosis);
        validatePlannerOutput(item.baselineFixPlan);
        return;
      }
      const planning = implementationPlanningResult(item.planning);
      if (item.tester === undefined) {
        if (planning.plan.route !== "quick_implementation") throw new Error("Builder checkpoint is missing Tester output");
      } else {
        validateTesterOutput(item.tester, automatedCriteria(planning.plan));
      }
      validateCheckResults(item.checksAfterTests);
      if (item.previousChecks !== undefined) validateCheckResults(item.previousChecks);
      if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
      positiveInteger(item.completedAttempt, "completedAttempt");
      if (item.scopeRevisionCount !== undefined) nonNegativeInteger(item.scopeRevisionCount, "scopeRevisionCount");
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "builder checkpoint");
      if (value.mode === "baseline_repair") {
        const planning = planningResult(value.planning);
        const baseline = await runCheckStep(runtime, "baseline", "Verify baseline after repair", workflow.mutationCwd, workflow.ctx, { requireGreen: true, kind: "baseline-verify" });
        runtime.baselineRepaired = true;
        const prepared = { ...planning, baseline, scopeRevisionCount: 0 };
        await saveWorkflowCheckpoint(runtime, workflow, "mutation_ready", prepared, { exploration: planning.exploration, plan: planning.plan, baselineChecks: baseline });
        const implementation = await runImplementationPhase(runtime, workflow, prepared);
        const review = await runReviewPhase(runtime, workflow, implementation);
        await runFinalizationPhase(runtime, workflow, review);
        return;
      }
      const planning = implementationPlanningResult(value.planning);
      const tester = value.tester === undefined ? undefined : validateTesterOutput(value.tester, automatedCriteria(planning.plan));
      const implementationContinuation: ImplementationContinuation = {
        point: "builder_completed",
        tester,
        checksAfterTests: validateCheckResults(value.checksAfterTests),
        previousChecks: value.previousChecks === undefined ? undefined : validateCheckResults(value.previousChecks),
        diagnosis: value.diagnosis === undefined ? undefined : validateDebuggerOutput(value.diagnosis),
        completedAttempt: positiveInteger(value.completedAttempt, "completedAttempt"),
        scopeRevisionCount: value.scopeRevisionCount === undefined ? undefined : nonNegativeInteger(value.scopeRevisionCount, "scopeRevisionCount")
      };
      const implementation = await runImplementationPhase(runtime, workflow, planning, implementationContinuation, {
        skipTester: workflow.route === "quick_implementation"
      });
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
    }
  },
  scope_revision_approved: {
    validate(value) {
      const item = objectValue(value, "scope revision checkpoint");
      if (item.mode === "implementation") {
        const planning = implementationPlanningResult(item.planning);
        if (item.tester === undefined) {
          if (planning.plan.route !== "quick_implementation") throw new Error("Scope revision checkpoint is missing Tester output");
        } else {
          validateTesterOutput(item.tester, automatedCriteria(planning.plan));
        }
        validateCheckResults(item.checksAfterTests);
        if (item.previousChecks !== undefined) validateCheckResults(item.previousChecks);
        if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
        positiveInteger(item.attempt, "attempt");
      } else if (item.mode === "review") {
        implementationResult(item.implementation);
        validateCheckResults(item.finalImplChecks);
        validateReviewOutput(item.codeReview);
        arrayValue(item.priorCodeReviews, "priorCodeReviews").forEach((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`));
        positiveInteger(item.pendingFix, "pendingFix");
        nonNegativeInteger(item.allowedReviewFixes, "allowedReviewFixes");
        if (item.failureChecks !== undefined) validateCheckResults(item.failureChecks);
        if (item.failureDiagnosis !== undefined) validateDebuggerOutput(item.failureDiagnosis);
      } else if (item.mode === "finalization") {
        reviewResult(item.review);
        validateDocumenterOutput(item.documentation);
        if (item.changeRound !== undefined) nonNegativeInteger(item.changeRound, "changeRound");
        if (item.preparation !== undefined) serializedLessonPreparation(item.preparation);
        if (item.failedChecks !== undefined) validateCheckResults(item.failedChecks);
        if (item.diagnosis !== undefined) validateDebuggerOutput(item.diagnosis);
        if (item.attempt !== undefined) positiveInteger(item.attempt, "attempt");
      } else {
        throw new Error("Unsupported scope revision checkpoint mode");
      }
      positiveInteger(item.scopeRevisionCount, "scopeRevisionCount");
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "scope revision checkpoint");
      let review;
      if (value.mode === "implementation") {
        const planning = implementationPlanningResult(value.planning);
        const tester = value.tester === undefined ? undefined : validateTesterOutput(value.tester, automatedCriteria(planning.plan));
        const implementation = await runImplementationPhase(runtime, workflow, planning, {
          point: "scope_revision_approved",
          tester,
          checksAfterTests: validateCheckResults(value.checksAfterTests),
          previousChecks: value.previousChecks === undefined ? undefined : validateCheckResults(value.previousChecks),
          diagnosis: value.diagnosis === undefined ? undefined : validateDebuggerOutput(value.diagnosis),
          attempt: positiveInteger(value.attempt, "attempt"),
          scopeRevisionCount: positiveInteger(value.scopeRevisionCount, "scopeRevisionCount")
        }, { skipTester: workflow.route === "quick_implementation" });
        review = await runReviewPhase(runtime, workflow, implementation);
      } else if (value.mode === "review") {
        const implementation = implementationResult(value.implementation);
        review = await runReviewPhase(runtime, workflow, implementation, {
          point: "scope_revision_approved",
          finalImplChecks: validateCheckResults(value.finalImplChecks),
          codeReview: validateReviewOutput(value.codeReview),
          priorCodeReviews: arrayValue(value.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`)),
          pendingFix: positiveInteger(value.pendingFix, "pendingFix"),
          allowedReviewFixes: nonNegativeInteger(value.allowedReviewFixes, "allowedReviewFixes"),
          scopeRevisionCount: positiveInteger(value.scopeRevisionCount, "scopeRevisionCount"),
          failureChecks: value.failureChecks === undefined ? undefined : validateCheckResults(value.failureChecks),
          failureDiagnosis: value.failureDiagnosis === undefined ? undefined : validateDebuggerOutput(value.failureDiagnosis)
        });
      } else if (value.mode === "finalization") {
        review = reviewResult(value.review);
      } else {
        throw new Error("Unsupported scope revision checkpoint mode");
      }
      await runFinalizationPhase(runtime, workflow, review);
    }
  },
  implementation_verified: {
    validate(value) {
      implementationResult(value);
    },
    async continue(runtime, workflow, checkpoint) {
      const implementation = implementationResult(checkpoint.cursor.continuation);
      const review = await runReviewPhase(runtime, workflow, implementation);
      await runFinalizationPhase(runtime, workflow, review);
    }
  },
  review_fix_completed: {
    validate(value) {
      const item = objectValue(value, "review-fix checkpoint");
      implementationResult(item.implementation);
      validateCheckResults(item.finalImplChecks);
      validateReviewOutput(item.codeReview);
      arrayValue(item.priorCodeReviews, "priorCodeReviews").forEach((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`));
      positiveInteger(item.completedFix, "completedFix");
      nonNegativeInteger(item.allowedReviewFixes, "allowedReviewFixes");
      nonNegativeInteger(item.scopeRevisionCount, "scopeRevisionCount");
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "review-fix checkpoint");
      const implementation = implementationResult(value.implementation);
      const reviewContinuation: ReviewContinuation = {
        point: "review_fix_completed",
        finalImplChecks: validateCheckResults(value.finalImplChecks),
        codeReview: validateReviewOutput(value.codeReview),
        priorCodeReviews: arrayValue(value.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`)),
        completedFix: positiveInteger(value.completedFix, "completedFix"),
        allowedReviewFixes: nonNegativeInteger(value.allowedReviewFixes, "allowedReviewFixes"),
        scopeRevisionCount: nonNegativeInteger(value.scopeRevisionCount, "scopeRevisionCount")
      };
      const review = await runReviewPhase(runtime, workflow, implementation, reviewContinuation);
      await runFinalizationPhase(runtime, workflow, review);
    }
  }
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
