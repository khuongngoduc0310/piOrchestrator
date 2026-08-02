import type { CheckpointBindings, CheckpointCursorKind, WorkflowCheckpoint } from "../../persistence/checkpoint-types.js";
import { readSafeArtifact } from "../../persistence/checkpoint-store.js";
import { validateCheckResults, validateResolutionRecord } from "../../persistence/checkpoint-validation.js";
import { validateDebuggerOutput, validateDocumenterOutput } from "../../validation.js";
import { canonicalSha256 } from "../../workspace/workspace-guard.js";
import type { ResolutionRecord } from "../../agent-task-types.js";
import type { WorkflowContext } from "../orchestrator-context.js";
import type { OrchestratorRuntime } from "../orchestrator-runtime.js";
import { resolveAgentBlocker } from "../orchestrator-resolution.js";
import { resolveDocumenterScopeBlockOnRepair, resolveInitialDocumenterScopeBlock, runFinalizationPhase } from "../orchestrator-finalization.js";
import { resolveSpecializedDocumenterScope, runSpecializedMutationRoute } from "../orchestrator-specialized-routes.js";
import { saveWorkflowCheckpoint } from "../orchestrator-checkpoints.js";
import { implementationPlanningResult, reviewResult, serializedLessonPreparation } from "./serializers.js";
import { MAX_STATE_BYTES, objectValue, positiveInteger, stringValue, type ContinuationModule } from "./shared.js";

async function continueDocumenterScopeResolution(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  checkpoint: WorkflowCheckpoint,
  value: Record<string, unknown>,
  record: ResolutionRecord
): Promise<void> {
  if (record.agent !== "documenter") {
    throw new Error(`Scope resolution checkpoint for ${record.agent} lacks phase-owned resume context`);
  }

  let legacyStepLabel: string | undefined;
  let rawOutput = value.output;
  if (rawOutput === undefined) {
    const step = [...checkpoint.state.steps].reverse().find(candidate =>
      candidate.agent === "documenter"
      && candidate.status === "succeeded"
      && candidate.artifact
    );
    if (!step?.artifact) throw new Error("Legacy Documenter scope checkpoint has no validated output artifact");
    legacyStepLabel = step.label;
    const artifact = objectValue(
      JSON.parse(await readSafeArtifact(workflow.store.runDir, step.artifact, MAX_STATE_BYTES)),
      "legacy Documenter output artifact"
    );
    rawOutput = artifact.output;
  }

  const documentation = validateDocumenterOutput(rawOutput, "resolution checkpoint output");
  if (!documentation.blocker || documentation.blocker.kind !== "scope") {
    throw new Error("Resolution checkpoint output does not contain a Documenter scope blocker");
  }
  if (canonicalSha256(documentation.blocker) !== canonicalSha256(record.request)) {
    throw new Error("Resolution checkpoint output blocker does not match its recorded request");
  }

  let owner = value.scopeOwner === undefined
    ? undefined
    : stringValue(value.scopeOwner, "resolution checkpoint scopeOwner");
  if (!owner) {
    if (legacyStepLabel !== "Update documentation and propose lessons" || workflow.route === "documentation_only") {
      throw new Error("Legacy Documenter scope checkpoint lacks supported phase-owned resume context");
    }
    owner = "finalization_initial_documentation";
  }

  workflow.ctx.ui.notify("Resuming Documenter scope expansion", "info");
  if (owner === "finalization_initial_documentation") {
    const review = reviewResult(value.planning);
    const revised = await resolveInitialDocumenterScopeBlock(runtime, workflow, review, documentation);
    await runFinalizationPhase(runtime, workflow, revised);
    return;
  }
  if (owner === "finalization_repair_documentation") {
    const review = reviewResult(value.planning);
    const context = objectValue(value.scopeContext, "resolution checkpoint scopeContext");
    const revised = await resolveDocumenterScopeBlockOnRepair(
      runtime,
      workflow,
      review,
      documentation,
      serializedLessonPreparation(context.preparation),
      validateCheckResults(context.failedChecks),
      validateDebuggerOutput(context.diagnosis),
      positiveInteger(context.attempt, "resolution checkpoint scopeContext.attempt")
    );
    await runFinalizationPhase(runtime, workflow, revised);
    return;
  }
  if (owner === "specialized_initial_documentation") {
    const planning = implementationPlanningResult(value.planning);
    const phase = { phase: "initial_documentation" as const, blockedDocumentation: documentation, changeRound: 0 };
    const updated = await resolveSpecializedDocumenterScope(runtime, workflow, planning, documentation, phase);
    await runSpecializedMutationRoute(runtime, workflow, updated.planning);
    return;
  }
  throw new Error(`Unsupported Documenter scope checkpoint owner ${owner}`);
}

export const resolutionContinuations = {
  resolution_pending: {
    validate(value) {
      const item = objectValue(value, "resolution checkpoint");
      validateResolutionRecord(item.record, "resolution checkpoint record");
      implementationPlanningResult(item.planning);
    },
    async continue(runtime, workflow, checkpoint) {
      const value = objectValue(checkpoint.cursor.continuation, "resolution checkpoint");
      const record = validateResolutionRecord(value.record, "resolution checkpoint record");
      if (record.request.kind === "scope") {
        await continueDocumenterScopeResolution(runtime, workflow, checkpoint, value, record);
        return;
      }
      const planning = implementationPlanningResult(value.planning);
      workflow.ctx.ui.notify(`Resolving agent blocker (${record.request.kind}) from ${record.agent}`, "info");
      await resolveAgentBlocker(runtime, workflow, planning, record.request);
    }
  },
  resolution_resolved: {
    validate(value) {
      const item = objectValue(value, "resolved checkpoint");
      validateResolutionRecord(item.record, "resolved checkpoint record");
      implementationPlanningResult(item.planning);
    },
    async continue(runtime, workflow, checkpoint) {
      const resolvedValue = objectValue(checkpoint.cursor.continuation, "resolved checkpoint");
      const resolvedRecord = validateResolutionRecord(resolvedValue.record, "resolved checkpoint record");
      workflow.ctx.ui.notify(`Resolution ${resolvedRecord.id} completed (${resolvedRecord.outcome?.type ?? "unknown"})`, "info");
    }
  },
  environment_retry_pending: {
    validate(value) {
      const item = objectValue(value, "environment retry checkpoint");
      validateResolutionRecord(item.record, "environment retry checkpoint record");
      implementationPlanningResult(item.planning);
      stringValue(item.blockedPhase, "environment retry checkpoint blockedPhase");
      if (item.blockedAgent !== undefined) stringValue(item.blockedAgent, "environment retry checkpoint blockedAgent");
      stringValue(item.retryCondition, "environment retry checkpoint retryCondition");
    },
    async continue(runtime, workflow, checkpoint) {
      const envValue = objectValue(checkpoint.cursor.continuation, "environment retry checkpoint");
      const envRecord = validateResolutionRecord(envValue.record, "environment retry checkpoint record");
      workflow.ctx.ui.notify(`Environment blocker resolved; retrying blocked phase from ${stringValue(envValue.blockedPhase, "blockedPhase")}`, "info");
      envRecord.status = "resolved";
      envRecord.outcome = { type: "retry", detail: "Environment issue resolved by user" };
      envRecord.updatedAt = runtime.timestamp();
      await saveWorkflowCheckpoint(runtime, workflow, "resolution_resolved",
        { record: envRecord, planning: envValue.planning },
        {} as CheckpointBindings
      );
    }
  }
} satisfies Partial<Record<CheckpointCursorKind, ContinuationModule>>;
