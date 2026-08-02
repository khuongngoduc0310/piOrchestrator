import type { CheckpointCursorKind } from "../../persistence/checkpoint-types.js";
import { validateCheckResults, validateCheckResultsAgainstCommands } from "../../persistence/checkpoint-validation.js";
import { allGreen } from "../orchestrator-helpers.js";
import { runSpecializedMutationRoute } from "../orchestrator-specialized-routes.js";
import { implementationPlanningResult, specializedMutationResult } from "./serializers.js";
import { objectValue, type ContinuationModule } from "./shared.js";

export const specializedContinuations = {
  route_agent_completed: {
    validate(value) {
      specializedMutationResult(value);
    },
    async continue(runtime, workflow, checkpoint) {
      await runSpecializedMutationRoute(runtime, workflow, implementationPlanningResult(checkpoint.cursor.continuation), specializedMutationResult(checkpoint.cursor.continuation));
    }
  },
  route_final_checks_passed: {
    validate(value, checkpoint) {
      const item = objectValue(value, "specialized final-check checkpoint");
      specializedMutationResult(item.result);
      const checks = validateCheckResultsAgainstCommands(item.finalChecks, checkpoint.config.checks, "finalChecks");
      if (!allGreen(checks, checkpoint.config.checks.length)) throw new Error("Checkpoint final checks are not green");
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "specialized final-check checkpoint");
      const result = specializedMutationResult(value.result);
      await runSpecializedMutationRoute(runtime, workflow, result, result, validateCheckResults(value.finalChecks));
    }
  }
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
