import type { CheckpointCursorKind } from "../../persistence/checkpoint-types.js";
import { runSelectedRoute } from "../orchestrator-routes.js";
import type { OrchestratorRuntime } from "../orchestrator-runtime.js";
import type { WorkflowContext } from "../orchestrator-context.js";
import { planningResult } from "./serializers.js";
import type { ContinuationModule } from "./shared.js";

/** Shared by the plan_approved and checks_configured cursors: run the selected route. */
const runRoute: ContinuationModule = {
  validate(value) {
    planningResult(value);
  },
  async continue(runtime, workflow, checkpoint) {
    const planning = planningResult(checkpoint.cursor.continuation);
    await runSelectedRoute(runtime, workflow, planning);
  }
};

export const planningContinuations = {
  plan_approved: runRoute,
  checks_configured: runRoute
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
