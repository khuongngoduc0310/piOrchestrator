import type { CheckpointCursorKind } from "../../persistence/checkpoint-types.js";
import { runReadOnlyFinalizationPhase } from "../orchestrator-finalization.js";
import { investigationResult, readOnlyReviewResult } from "./serializers.js";
import type { ContinuationModule } from "./shared.js";

export const readOnlyContinuations = {
  repository_reviewed: {
    validate(value) {
      readOnlyReviewResult(value);
    },
    async continue(runtime, workflow, checkpoint) {
      await runReadOnlyFinalizationPhase(runtime, workflow, readOnlyReviewResult(checkpoint.cursor.continuation));
    }
  },
  investigation_completed: {
    validate(value) {
      investigationResult(value);
    },
    async continue(runtime, workflow, checkpoint) {
      await runReadOnlyFinalizationPhase(runtime, workflow, investigationResult(checkpoint.cursor.continuation));
    }
  }
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
