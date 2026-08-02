import type { CheckpointCursorKind } from "../../persistence/checkpoint-types.js";
import { validateCheckResults, validateCheckResultsAgainstCommands } from "../../persistence/checkpoint-validation.js";
import { validateDocumenterOutput } from "../../validation.js";
import { allGreen } from "../orchestrator-helpers.js";
import { runFinalizationPhase, type FinalizationContinuation } from "../orchestrator-finalization.js";
import { assertDocumenterComplete } from "../mutation-completion.js";
import { reviewResult, serializedLessonPreparation } from "./serializers.js";
import { hydrateCandidates, objectValue, type ContinuationModule } from "./shared.js";

export const finalizationContinuations = {
  review_approved: {
    validate(value) {
      reviewResult(value);
    },
    async continue(runtime, workflow, checkpoint) {
      await runFinalizationPhase(runtime, workflow, reviewResult(checkpoint.cursor.continuation));
    }
  },
  documenter_completed: {
    validate(value) {
      const item = objectValue(value, "documenter checkpoint");
      reviewResult(item.review);
      assertDocumenterComplete(validateDocumenterOutput(item.documentation));
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "documenter checkpoint");
      const review = reviewResult(value.review);
      const next: FinalizationContinuation = { point: "documenter_completed", documentation: validateDocumenterOutput(value.documentation), review };
      await runFinalizationPhase(runtime, workflow, review, next);
    }
  },
  lessons_screened: {
    validate(value) {
      const item = objectValue(value, "lessons checkpoint");
      reviewResult(item.review);
      serializedLessonPreparation(item.preparation);
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "lessons checkpoint");
      const review = reviewResult(value.review);
      const preparation = serializedLessonPreparation(value.preparation);
      hydrateCandidates(runtime, preparation);
      await runFinalizationPhase(runtime, workflow, review, { point: "lessons_screened", preparation, review });
    }
  },
  final_checks_passed: {
    validate(value, checkpoint) {
      const item = objectValue(value, "final-check checkpoint");
      reviewResult(item.review);
      serializedLessonPreparation(item.preparation);
      const checks = validateCheckResultsAgainstCommands(item.finalChecks, checkpoint.config.checks, "finalChecks");
      if (!allGreen(checks, checkpoint.config.checks.length)) throw new Error("Checkpoint final checks are not green");
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "final-check checkpoint");
      const review = reviewResult(value.review);
      const preparation = serializedLessonPreparation(value.preparation);
      hydrateCandidates(runtime, preparation);
      await runFinalizationPhase(runtime, workflow, review, { point: "final_checks_passed", preparation, finalChecks: validateCheckResults(value.finalChecks), review });
    }
  }
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
