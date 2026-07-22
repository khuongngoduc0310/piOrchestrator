import {
  MAX_EVIDENCE_DETAIL_BYTES,
  MAX_EVIDENCE_PATH_BYTES,
  MAX_EVIDENCE_PER_LESSON,
  type MemoryEvidence,
  type MemoryLesson
} from "./memory-types.js";
import { AGENT_NAMES, LESSON_CATEGORIES, type AgentName } from "./types.js";
import { normalizeRepositoryPath, RepositoryPathError } from "./path-validation.js";

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function memoryString(v: unknown, maxBytes: number): string {
  if (typeof v !== "string") throw new MemoryValidationError("expected a string");
  const trimmed = v.trim();
  if (!trimmed) throw new MemoryValidationError("must not be empty");
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) {
    throw new MemoryValidationError(`must not exceed ${maxBytes} bytes`);
  }
  return trimmed;
}

function strings(v: unknown, maxBytes: number, maxCount: number): string[] {
  if (!Array.isArray(v)) throw new MemoryValidationError("expected an array");
  if (v.length > maxCount) throw new MemoryValidationError(`must not have more than ${maxCount} items`);
  return v.map((item, i) => {
    if (typeof item !== "string") throw new MemoryValidationError(`[${i}] expected a string`);
    if (Buffer.byteLength(item, "utf8") > maxBytes) throw new MemoryValidationError(`[${i}] must not exceed ${maxBytes} bytes`);
    return item.trim();
  }).filter(Boolean);
}

function validateAgentNames(v: unknown): AgentName[] {
  if (!Array.isArray(v)) throw new MemoryValidationError("expected an array");
  const agentSet = new Set(AGENT_NAMES);
  for (const item of v) {
    if (typeof item !== "string" || !agentSet.has(item as AgentName)) {
      throw new MemoryValidationError(`invalid agent name: ${String(item)}`);
    }
  }
  return v as AgentName[];
}

export function validateMemoryId(v: unknown): string {
  const s = memoryString(v, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new MemoryValidationError("id must be alphanumeric with _ and -");
  return s;
}

export function validatePath(v: unknown, allowTrailingSlash = false): string {
  const s = memoryString(v, MAX_EVIDENCE_PATH_BYTES);
  try {
    return normalizeRepositoryPath(s, allowTrailingSlash);
  } catch (error) {
    if (error instanceof RepositoryPathError) throw new MemoryValidationError(`path ${error.message}`);
    throw error;
  }
}

function evidenceItem(v: unknown): MemoryEvidence {
  if (!isRecord(v)) throw new MemoryValidationError("evidence item must be an object");
  return {
    path: validatePath(v.path),
    detail: memoryString(v.detail, MAX_EVIDENCE_DETAIL_BYTES),
    contentHash: v.contentHash !== undefined ? memoryString(v.contentHash, 64) : undefined
  };
}

export function evidenceList(v: unknown): MemoryEvidence[] {
  if (!Array.isArray(v)) throw new MemoryValidationError("evidence must be an array");
  if (v.length > MAX_EVIDENCE_PER_LESSON) throw new MemoryValidationError(`evidence must not exceed ${MAX_EVIDENCE_PER_LESSON} items`);
  return v.map(evidenceItem);
}

export function scopeObject(v: unknown): MemoryLesson["scope"] {
  if (!isRecord(v)) throw new MemoryValidationError("scope must be an object");
  const roles = validateAgentNames(v.roles ?? []);
  const paths = strings(v.paths ?? [], 200, 20).map(p => validatePath(p, true));
  const categories = strings(v.categories ?? [], 100, 20);
  for (const category of categories) {
    if (!LESSON_CATEGORIES.includes(category as (typeof LESSON_CATEGORIES)[number])) {
      throw new MemoryValidationError(`scope.categories contains unsupported category: ${category}`);
    }
  }
  const keywords = strings(v.keywords ?? [], 100, 20);
  for (const [label, values] of [["roles", roles], ["paths", paths], ["categories", categories], ["keywords", keywords]] as const) {
    if (new Set(values).size !== values.length) throw new MemoryValidationError(`scope.${label} must not contain duplicates`);
  }
  return { roles, paths, categories, keywords };
}

export function validDate(v: unknown, label: string): string {
  const value = memoryString(v, 64);
  if (!Number.isFinite(Date.parse(value))) throw new MemoryValidationError(`${label} must be a valid date`);
  return value;
}

export function validateRevision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new MemoryValidationError("revision must be a non-negative integer");
  }
  return v;
}
