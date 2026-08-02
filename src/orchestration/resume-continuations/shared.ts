import type { WorkflowCheckpoint } from "../../persistence/checkpoint-types.js";
import { requiredAgentsForRoute } from "../route-preflight.js";
import type { OrchestratorRuntime } from "../orchestrator-runtime.js";
import type { WorkflowContext } from "../orchestrator-context.js";
import { hydrateLessonPreparation, type SerializedLessonPreparation } from "../orchestrator-lessons.js";

export const MAX_STATE_BYTES = 16 * 1024 * 1024;

/** One checkpoint cursor kind's resume behavior: fail-closed validation, then continuation. */
export interface ContinuationModule {
  /** Fails closed on malformed continuation values before any workflow side effects. */
  validate(value: unknown, checkpoint: WorkflowCheckpoint): void;
  /** Resumes the workflow from this checkpoint cursor. */
  continue(runtime: OrchestratorRuntime, workflow: WorkflowContext, checkpoint: WorkflowCheckpoint): Promise<void>;
}

export function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function arrayValue(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

export function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} must be a non-negative integer`);
  return value as number;
}

export function positiveInteger(value: unknown, label: string): number {
  const result = nonNegativeInteger(value, label);
  if (result < 1) throw new Error(`${label} must be positive`);
  return result;
}

/** Preflights the agents the remaining route needs (shared by diagnosis and human-decision resumes). */
export async function preflightRemainingRoute(runtime: OrchestratorRuntime, workflow: WorkflowContext): Promise<void> {
  const requiredAgents = requiredAgentsForRoute(workflow.route, workflow.config);
  await runtime.agents.preflight(
    workflow.config,
    workflow.cwd,
    runtime.extensionRoot,
    runtime.requireController().signal,
    workflow.config.limits.agentTimeoutMs,
    requiredAgents
  );
}

/** Rehydrates the runtime's proposed lesson candidates from a serialized preparation. */
export function hydrateCandidates(runtime: OrchestratorRuntime, preparation: SerializedLessonPreparation): void {
  runtime.candidateLessons = hydrateLessonPreparation(preparation).proposedCandidates;
}
