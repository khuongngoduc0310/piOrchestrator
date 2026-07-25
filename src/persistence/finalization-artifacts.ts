import { createHash } from "node:crypto";
import type { WorkflowCheckpoint } from "./checkpoint-types.js";

export type FinalizationOperation =
  | "synchronize_and_promote"
  | "synchronize_and_complete"
  | "promote"
  | "complete";

export type DeliveryKind = "worktree" | "direct";

export const FINALIZATION_PREPARED_VERSION = 1 as const;
export const FINALIZATION_INTENT_VERSION = 1 as const;

export interface CheckpointRef {
  readonly number: number;
  readonly cursor: string;
  readonly createdAt: string;
}

export interface WorktreeDelivery {
  readonly kind: "worktree";
  readonly patchArtifact: "worktree-final.patch";
  readonly patchDigest: string;
  readonly baselineCommit: string;
  readonly finalCommit: string;
  readonly changedFiles: string[];
}

export interface DirectDelivery {
  readonly kind: "direct";
  readonly workspaceDigest: string;
  readonly changedFiles: string[];
}

export interface FinalizationPreparedV1 {
  readonly schemaVersion: typeof FINALIZATION_PREPARED_VERSION;
  readonly runId: string;
  readonly checkpoint: CheckpointRef;
  readonly operation: FinalizationOperation;
  readonly finalChecksDigest: string;
  readonly delivery: WorktreeDelivery | DirectDelivery;
  readonly preparedAt: string;
}

export interface FinalizationIntentV1 {
  readonly schemaVersion: typeof FINALIZATION_INTENT_VERSION;
  readonly runId: string;
  readonly checkpoint: CheckpointRef;
  readonly operation: "synchronize_and_promote" | "synchronize_and_complete" | "promote";
  readonly finalChecksDigest: string;
  readonly preparationDigest: string;
  readonly createdAt: string;
}

export function computePreparationDigest(prepared: Omit<FinalizationPreparedV1, "preparedAt">): string {
  const canonical = JSON.stringify(prepared, Object.keys(prepared).sort());
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function validateCheckpointRef(value: unknown, label: string): CheckpointRef {
  if (typeof value !== "object" || value === null) throw new Error(`${label}: checkpoint must be an object`);
  const ref = value as Record<string, unknown>;
  if (typeof ref.number !== "number" || !Number.isSafeInteger(ref.number) || ref.number < 1) {
    throw new Error(`${label}: checkpoint.number must be a positive integer`);
  }
  if (typeof ref.cursor !== "string" || !ref.cursor) throw new Error(`${label}: checkpoint.cursor must be a non-empty string`);
  if (typeof ref.createdAt !== "string" || !ref.createdAt) throw new Error(`${label}: checkpoint.createdAt must be a string`);
  return { number: ref.number, cursor: ref.cursor, createdAt: ref.createdAt };
}

export function validateFinalChecksDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label}: finalChecksDigest must be a lowercase 64-char hex string`);
  }
  return value;
}

export function validateSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label}: must be a lowercase 64-char hex digest`);
  }
  return value;
}

export function validateRunId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label}: runId must be a non-empty string`);
  return value;
}

export interface LegacyIntent {
  readonly runId: string;
  readonly checkpoint: CheckpointRef;
  readonly operation?: string;
  readonly finalChecksDigest: string;
}

export function isLegacyIntent(marker: Record<string, unknown>): boolean {
  return typeof marker.schemaVersion !== "number";
}

export function validateLegacyIntent(marker: Record<string, unknown>, expectedRunId: string, expectedCheckpoint: CheckpointRef): LegacyIntent {
  const runId = validateRunId(marker.runId, "finalization-intent.json");
  if (runId !== expectedRunId) throw new Error("finalization-intent.json: runId does not match");
  validateCheckpointRef(marker.checkpoint, "finalization-intent.json");
  const savedCheckpoint = marker.checkpoint as Record<string, unknown>;
  if (savedCheckpoint.number !== expectedCheckpoint.number || savedCheckpoint.cursor !== expectedCheckpoint.cursor) {
    throw new Error("finalization-intent.json: checkpoint does not match");
  }
  const d = validateFinalChecksDigest(marker.finalChecksDigest, "finalization-intent.json");
  return { runId, checkpoint: expectedCheckpoint, operation: typeof marker.operation === "string" ? marker.operation : undefined, finalChecksDigest: d };
}

export function validateVersionedIntent(marker: Record<string, unknown>, expectedRunId: string, expectedCheckpoint: CheckpointRef): FinalizationIntentV1 {
  const schemaVersion = marker.schemaVersion;
  if (schemaVersion !== FINALIZATION_INTENT_VERSION) throw new Error("finalization-intent.json: unsupported schema version");
  const runId = validateRunId(marker.runId, "finalization-intent.json");
  if (runId !== expectedRunId) throw new Error("finalization-intent.json: runId does not match");
  validateCheckpointRef(marker.checkpoint, "finalization-intent.json");
  const savedCheckpoint = marker.checkpoint as Record<string, unknown>;
  if (savedCheckpoint.number !== expectedCheckpoint.number || savedCheckpoint.cursor !== expectedCheckpoint.cursor) {
    throw new Error("finalization-intent.json: checkpoint does not match");
  }
  const operation = marker.operation;
  if (operation !== "synchronize_and_promote" && operation !== "synchronize_and_complete" && operation !== "promote") {
    throw new Error("finalization-intent.json: invalid operation");
  }
  const finalChecksDigest = validateFinalChecksDigest(marker.finalChecksDigest, "finalization-intent.json");
  const preparationDigest = validateSha256(marker.preparationDigest, "finalization-intent.json.preparationDigest");
  const createdAt = marker.createdAt;
  if (typeof createdAt !== "string" || !createdAt) throw new Error("finalization-intent.json: createdAt is required");
  return { schemaVersion, runId, checkpoint: expectedCheckpoint, operation, finalChecksDigest, preparationDigest, createdAt };
}

export function validateFinalizationPrepared(value: unknown, label: string): FinalizationPreparedV1 {
  if (typeof value !== "object" || value === null) throw new Error(`${label}: must be an object`);
  const obj = value as Record<string, unknown>;
  if (obj.schemaVersion !== FINALIZATION_PREPARED_VERSION) throw new Error(`${label}: unsupported schema version`);
  validateRunId(obj.runId, `${label}.runId`);
  validateCheckpointRef(obj.checkpoint, `${label}.checkpoint`);
  const operation = obj.operation;
  if (operation !== "synchronize_and_promote" && operation !== "synchronize_and_complete" && operation !== "promote" && operation !== "complete") {
    throw new Error(`${label}: invalid operation`);
  }
  validateFinalChecksDigest(obj.finalChecksDigest, `${label}.finalChecksDigest`);
  const delivery = obj.delivery;
  if (typeof delivery !== "object" || delivery === null) throw new Error(`${label}.delivery: must be an object`);
  const deliveryObj = delivery as Record<string, unknown>;
  if (deliveryObj.kind === "worktree") {
    if (deliveryObj.patchArtifact !== "worktree-final.patch") throw new Error(`${label}.delivery.patchArtifact: must be worktree-final.patch`);
    validateSha256(deliveryObj.patchDigest, `${label}.delivery.patchDigest`);
    if (typeof deliveryObj.baselineCommit !== "string" || !deliveryObj.baselineCommit) throw new Error(`${label}.delivery.baselineCommit: required`);
    if (typeof deliveryObj.finalCommit !== "string" || !deliveryObj.finalCommit) throw new Error(`${label}.delivery.finalCommit: required`);
    if (!Array.isArray(deliveryObj.changedFiles)) throw new Error(`${label}.delivery.changedFiles: must be an array`);
  } else if (deliveryObj.kind === "direct") {
    validateSha256(deliveryObj.workspaceDigest, `${label}.delivery.workspaceDigest`);
    if (!Array.isArray(deliveryObj.changedFiles)) throw new Error(`${label}.delivery.changedFiles: must be an array`);
  } else {
    throw new Error(`${label}.delivery.kind: must be worktree or direct`);
  }
  if (typeof obj.preparedAt !== "string" || !obj.preparedAt) throw new Error(`${label}.preparedAt: required`);
  return value as FinalizationPreparedV1;
}
