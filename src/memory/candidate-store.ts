import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { configPath } from "../config/config.js";
import {
  CANDIDATE_LEDGER_SCHEMA_VERSION,
  MAX_CANDIDATE_LEDGER_BYTES,
  type CandidateLedger,
  type CandidateLedgerEntry,
  type CandidateLesson,
  type CandidateState,
} from "./memory-types.js";
import {
  permanentLessonId,
  transitionCandidateState,
  validateCandidateLedger,
  validateCandidates,
  validateMemoryId,
} from "./memory-validation.js";

const LEDGER_FILE = "candidate-ledger.json";
const MAX_RUN_ARTIFACT_BYTES = 1_048_576;

export interface CandidateLedgerLoadResult {
  ledger: CandidateLedger | null;
  error?: string;
}

export function createCandidateLedger(
  projectPath: string,
  runId: string,
  candidates: CandidateLesson[],
  finalChecksDigest: string,
  extensionVersion: string,
  now: string = new Date().toISOString()
): CandidateLedger {
  return validateCandidateLedger({
    schemaVersion: CANDIDATE_LEDGER_SCHEMA_VERSION,
    revision: 0,
    runId,
    projectPath: path.resolve(projectPath),
    finalChecksDigest,
    extensionVersion,
    updatedAt: now,
    candidates: validateCandidates(candidates).map(candidate => ({
      ...candidate,
      state: "proposed",
      updatedAt: now,
      transitions: [],
    })),
  });
}

export async function loadCandidateLedger(cwd: string, runId: string): Promise<CandidateLedgerLoadResult> {
  let id: string;
  try {
    id = validateMemoryId(runId);
  } catch (error) {
    return { ledger: null, error: messageOf(error) };
  }
  const runDir = getRunDir(cwd, id);
  const ledgerFile = path.join(runDir, LEDGER_FILE);
  try {
    const stored = await readJson(ledgerFile, MAX_CANDIDATE_LEDGER_BYTES);
    if (stored !== undefined) return bindLedger(stored, cwd, id);
    return await loadLegacyLedger(cwd, id, runDir);
  } catch (error) {
    return { ledger: null, error: `Candidate ledger is invalid: ${messageOf(error)}` };
  }
}

export async function saveCandidateLedger(cwd: string, ledger: CandidateLedger): Promise<CandidateLedger> {
  const validated = validateCandidateLedger(ledger);
  const expectedProjectPath = path.resolve(cwd);
  if (!sameProjectPath(validated.projectPath, expectedProjectPath)) {
    throw new Error(`Candidate ledger projectPath mismatch: expected ${expectedProjectPath}, got ${validated.projectPath}`);
  }
  const runDir = getRunDir(cwd, validated.runId);
  await mkdir(runDir, { recursive: false }).catch((error: unknown) => {
    if (!isFsError(error) || error.code !== "EEXIST") throw error;
  });
  return withLedgerLock(runDir, async () => {
    const target = path.join(runDir, LEDGER_FILE);
    const currentValue = await readJson(target, MAX_CANDIDATE_LEDGER_BYTES);
    if (currentValue !== undefined) {
      const current = validateCandidateLedger(currentValue);
      if (current.revision !== validated.revision) {
        throw new Error(`Candidate ledger revision mismatch: expected ${validated.revision}, got ${current.revision}`);
      }
    } else if (validated.revision !== 0) {
      throw new Error(`Candidate ledger revision mismatch: expected ${validated.revision}, got 0`);
    }
    const next = validateCandidateLedger({ ...validated, revision: validated.revision + 1, updatedAt: new Date().toISOString() });
    const json = JSON.stringify(next, null, 2) + "\n";
    if (Buffer.byteLength(json, "utf8") > MAX_CANDIDATE_LEDGER_BYTES) {
      throw new Error(`Candidate ledger exceeds ${MAX_CANDIDATE_LEDGER_BYTES} bytes`);
    }
    const temporary = path.join(runDir, `.${LEDGER_FILE}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, json, "utf8");
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
    return next;
  });
}

async function withLedgerLock<T>(runDir: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(runDir, ".candidate-ledger.lock");
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      await mkdir(lock);
      try { return await operation(); }
      finally { await rm(lock, { recursive: true, force: true }).catch(() => undefined); }
    } catch (error) {
      if (!isFsError(error) || error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > 30_000) {
          await rm(lock, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (!isFsError(lockError) || lockError.code !== "ENOENT") throw lockError;
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  throw new Error("Could not acquire candidate ledger lock");
}

export function setCandidateState(
  ledger: CandidateLedger,
  candidateId: string,
  state: CandidateState,
  reason?: string,
  at?: string
): CandidateLedger {
  return transitionCandidateState(ledger, candidateId, state, reason, at);
}

function bindLedger(value: unknown, cwd: string, runId: string): CandidateLedgerLoadResult {
  const ledger = validateCandidateLedger(value);
  const expectedProjectPath = path.resolve(cwd);
  if (!sameProjectPath(ledger.projectPath, expectedProjectPath)) {
    return { ledger: null, error: `Candidate ledger projectPath mismatch: expected ${expectedProjectPath}, got ${ledger.projectPath}` };
  }
  if (ledger.runId !== runId) {
    return { ledger: null, error: `Candidate ledger runId mismatch: expected ${runId}, got ${ledger.runId}` };
  }
  return { ledger };
}

async function loadLegacyLedger(cwd: string, runId: string, runDir: string): Promise<CandidateLedgerLoadResult> {
  const rawCandidates = await readJson(path.join(runDir, "pending-candidates.json"), MAX_CANDIDATE_LEDGER_BYTES);
  if (rawCandidates === undefined) return { ledger: null };
  const candidates = validateCandidates(rawCandidates);
  const state = requireRecord(await readJson(path.join(runDir, "state.json"), MAX_RUN_ARTIFACT_BYTES), "state.json");
  if (state.runId !== runId) throw new Error(`state.json runId does not match ${runId}`);
  const expectedProjectPath = path.resolve(cwd);
  if (typeof state.cwd !== "string" || !sameProjectPath(state.cwd, expectedProjectPath)) throw new Error(`state.json cwd does not match ${expectedProjectPath}`);
  const extensionVersion = requiredString(state.extensionVersion, "state.json extensionVersion", 64);
  const digestArtifact = requireRecord(
    await readJson(path.join(runDir, "final-checks-digest.json"), MAX_CANDIDATE_LEDGER_BYTES),
    "final-checks-digest.json"
  );
  const finalChecksDigest = requiredString(digestArtifact.digest, "final checks digest", 64);
  const statusArtifact = await readJson(path.join(runDir, "proposed-lessons-status.json"), MAX_CANDIDATE_LEDGER_BYTES);
  if (statusArtifact === undefined) throw new Error("proposed-lessons-status.json is required to verify machine approval");
  const savedStatus = requireRecord(statusArtifact, "proposed-lessons-status.json").status;
  if (savedStatus !== "machine_approved" && savedStatus !== "rejected" && !(savedStatus === "skipped" && candidates.length === 0)) {
    throw new Error(`proposed-lessons-status.json has unsupported status ${String(savedStatus)}`);
  }
  const machineRejected = savedStatus === "rejected";
  const now = new Date().toISOString();
  let ledger = createCandidateLedger(expectedProjectPath, runId, candidates, finalChecksDigest, extensionVersion, now);

  for (const candidate of candidates) {
    ledger = setCandidateState(ledger, candidate.id, machineRejected ? "machine_rejected" : "machine_approved", "legacy run artifacts", now);
    if (!machineRejected) ledger = setCandidateState(ledger, candidate.id, "pending", "awaiting human decision", now);
  }

  const approvalsValue = await readJson(path.join(runDir, "human-approvals.json"), MAX_CANDIDATE_LEDGER_BYTES);
  const promotionValue = await readJson(path.join(runDir, "promotion-result.json"), MAX_CANDIDATE_LEDGER_BYTES);
  if (approvalsValue !== undefined && !machineRejected) {
    const approvals = requireRecord(approvalsValue, "human-approvals.json");
    const approved = idSet(approvals.approvedIds, "approvedIds");
    const declined = idSet(approvals.declinedIds, "declinedIds");
    const candidateIds = new Set(candidates.map(candidate => candidate.id));
    for (const id of [...approved, ...declined]) {
      if (!candidateIds.has(id)) throw new Error(`human approval references unknown candidate ${id}`);
    }
    const promotion = promotionValue === undefined ? undefined : requireRecord(promotionValue, "promotion-result.json");
    const promoted = promotion ? idSet(promotion.promoted, "promoted") : new Set<string>();
    const duplicates = promotion ? idSet(promotion.duplicates, "duplicates") : new Set<string>();
    const failed = promotion ? failedCandidateIds(promotion.failed) : new Set<string>();
    const promotionError = promotion?.error === undefined ? undefined : requiredString(promotion.error, "promotion error", 500);
    if (promotion?.retryable !== undefined && typeof promotion.retryable !== "boolean") {
      throw new Error("promotion retryable must be a boolean");
    }

    for (const candidate of candidates) {
      if (declined.has(candidate.id)) {
        ledger = setCandidateState(ledger, candidate.id, "declined", "saved human decision", now);
        continue;
      }
      if (!approved.has(candidate.id) || !promotion) continue;
      ledger = setCandidateState(ledger, candidate.id, "promotion_pending", "saved human approval", now);
      const lessonId = permanentLessonId(runId, candidate.id);
      if (promoted.has(candidate.id) || promoted.has(lessonId)) {
        ledger = setCandidateState(ledger, candidate.id, "promoted", "saved promotion result", now);
      } else if (duplicates.has(candidate.id) || duplicates.has(lessonId)) {
        ledger = setCandidateState(ledger, candidate.id, "duplicate", "saved promotion result", now);
      } else if (failed.has(candidate.id)) {
        ledger = setCandidateState(ledger, candidate.id, "promotion_failed", "saved promotion result", now);
      } else if (promotionError && promotion.retryable !== true) {
        ledger = setCandidateState(ledger, candidate.id, "promotion_failed", promotionError, now);
      } else {
        ledger = setCandidateState(ledger, candidate.id, "pending", "promotion was deferred", now);
      }
    }
  }
  return { ledger };
}

function getRunDir(cwd: string, runId: string): string {
  const id = validateMemoryId(runId);
  return path.join(path.dirname(configPath(path.resolve(cwd))), "runs", id);
}

async function readJson(file: string, maxBytes: number): Promise<unknown | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${path.basename(file)} exceeds ${maxBytes} bytes`);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${path.basename(file)} is malformed: ${messageOf(error)}`);
  }
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  const trimmed = value.trim();
  if (Buffer.byteLength(trimmed, "utf8") > maxBytes) throw new Error(`${label} exceeds ${maxBytes} bytes`);
  return trimmed;
}

function idSet(value: unknown, label: string): Set<string> {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return new Set(value.map(validateMemoryId));
}

function failedCandidateIds(value: unknown): Set<string> {
  if (!Array.isArray(value)) throw new Error("failed must be an array");
  return new Set(value.map((item, index) => {
    const record = requireRecord(item, `failed[${index}]`);
    return validateMemoryId(record.candidateId);
  }));
}

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sameProjectPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
