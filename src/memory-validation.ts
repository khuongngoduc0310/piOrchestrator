import { createHash } from "node:crypto";
import {
  MEMORY_SCHEMA_VERSION,
  MAX_MEMORY_BYTES,
  MAX_LESSONS_PER_DOC,
  MAX_LESSON_TITLE_BYTES,
  MAX_LESSON_GUIDANCE_BYTES,
  MAX_EVIDENCE_PER_LESSON,
  MAX_EVIDENCE_PATH_BYTES,
  MAX_EVIDENCE_DETAIL_BYTES,
  MAX_CANDIDATE_TITLE_BYTES,
  MAX_CANDIDATE_GUIDANCE_BYTES,
  MAX_CANDIDATES_PER_RUN,
  MAX_SELECTED_LESSONS,
  MAX_SELECTED_LESSONS_BYTES,
  CANDIDATE_LEDGER_SCHEMA_VERSION,
  CANDIDATE_STATES,
  type CandidateLesson,
  type CandidateLedger,
  type CandidateLedgerEntry,
  type CandidateState,
  type MemoryDocument,
  type MemoryEvidence,
  type MemoryLesson,
  type MemoryLessonRef,
} from "./memory-types.js";
import { AGENT_NAMES, LESSON_CATEGORIES, type AgentName } from "./types.js";
import { normalizeRepositoryPath, RepositoryPathError } from "./path-validation.js";
import { repositoryPathMatches } from "./memory-selection.js";

export class MemoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryValidationError";
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function string(v: unknown, maxBytes: number): string {
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
  const s = string(v, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new MemoryValidationError("id must be alphanumeric with _ and -");
  return s;
}

function validateId(v: unknown): string {
  return validateMemoryId(v);
}

export function candidateLessonId(runId: string, ordinal: number): string {
  const validatedRunId = validateId(runId);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new MemoryValidationError("candidate ordinal must be a non-negative integer");
  const digest = createHash("sha256").update(`${validatedRunId}\0${ordinal}`, "utf8").digest("hex").slice(0, 20);
  return `candidate-${digest}`;
}

export function permanentLessonId(sourceRunId: string, candidateId: string): string {
  const run = validateId(sourceRunId);
  const candidate = validateId(candidateId);
  const digest = createHash("sha256").update(`${run}\0${candidate}`, "utf8").digest("hex").slice(0, 24);
  return `lesson-${digest}`;
}

export const createCandidateLessonId = candidateLessonId;
export const createPermanentLessonId = permanentLessonId;

function validatePath(v: unknown, allowTrailingSlash = false): string {
  const s = string(v, MAX_EVIDENCE_PATH_BYTES);
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
    detail: string(v.detail, MAX_EVIDENCE_DETAIL_BYTES),
    contentHash: v.contentHash !== undefined ? string(v.contentHash, 64) : undefined,
  };
}

function evidenceList(v: unknown): MemoryEvidence[] {
  if (!Array.isArray(v)) throw new MemoryValidationError("evidence must be an array");
  if (v.length > MAX_EVIDENCE_PER_LESSON) throw new MemoryValidationError(`evidence must not exceed ${MAX_EVIDENCE_PER_LESSON} items`);
  return v.map(evidenceItem);
}

function scopeObject(v: unknown): { roles: AgentName[]; paths: string[]; categories: string[]; keywords: string[] } {
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
  return {
    roles,
    paths,
    categories,
    keywords,
  };
}

export function contentDigest(guidance: string): string {
  const normalized = guidance
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}

function provenanceObject(v: unknown): MemoryLesson["provenance"] {
  if (!isRecord(v)) throw new MemoryValidationError("provenance must be an object");
  return {
    sourceRunId: validateId(v.sourceRunId),
    candidateId: validateId(v.candidateId),
    finalChecksDigest: string(v.finalChecksDigest, 64),
    approvedAt: validDate(v.approvedAt, "approvedAt"),
    extensionVersion: string(v.extensionVersion, 64),
  };
}

function validateLesson(v: unknown, index: number): MemoryLesson {
  if (!isRecord(v)) throw new MemoryValidationError(`lessons[${index}] must be an object`);
  const guidance = string(v.guidance, MAX_LESSON_GUIDANCE_BYTES);
  const digest = string(v.contentDigest, 64);
  if (digest !== contentDigest(guidance)) throw new MemoryValidationError(`lessons[${index}].contentDigest does not match guidance`);
  const scope = scopeObject(v.scope);
  const evidence = evidenceList(v.evidence);
  if (scope.roles.length + scope.paths.length + scope.categories.length + scope.keywords.length === 0) {
    throw new MemoryValidationError(`lessons[${index}].scope must have at least one non-empty dimension`);
  }
  if (evidence.length === 0) throw new MemoryValidationError(`lessons[${index}].evidence must not be empty`);
  return {
    id: validateId(v.id),
    contentDigest: digest,
    title: string(v.title, MAX_LESSON_TITLE_BYTES),
    guidance,
    scope,
    evidence,
    provenance: provenanceObject(v.provenance),
    createdAt: validDate(v.createdAt, "createdAt"),
  };
}

export function validateMemoryDocument(v: unknown): MemoryDocument {
  if (!isRecord(v)) throw new MemoryValidationError("document must be an object");
  const schemaVersion = v.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    throw new MemoryValidationError("schemaVersion must be a positive integer");
  }
  if (schemaVersion > MEMORY_SCHEMA_VERSION) {
    throw new MemoryValidationError(`unsupported future schema version ${schemaVersion}`);
  }
  const lessons = v.lessons;
  if (!Array.isArray(lessons)) throw new MemoryValidationError("lessons must be an array");
  if (lessons.length > MAX_LESSONS_PER_DOC) throw new MemoryValidationError(`lessons must not exceed ${MAX_LESSONS_PER_DOC} items`);
  const validated: MemoryDocument = {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    revision: validateRevision(v.revision),
    updatedAt: validDate(v.updatedAt, "updatedAt"),
    projectPath: string(v.projectPath, 1024),
    lessons: lessons.map((l, i) => validateLesson(l, i)),
  };
  const ids = new Set<string>();
  const digests = new Set<string>();
  for (const lesson of validated.lessons) {
    if (ids.has(lesson.id)) throw new MemoryValidationError(`duplicate lesson id: ${lesson.id}`);
    if (digests.has(lesson.contentDigest)) throw new MemoryValidationError(`duplicate lesson content digest: ${lesson.contentDigest}`);
    ids.add(lesson.id);
    digests.add(lesson.contentDigest);
  }
  return validated;
}

function validateRevision(v: unknown): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new MemoryValidationError("revision must be a non-negative integer");
  }
  return v;
}

export function validateCandidate(v: unknown, index: number): CandidateLesson {
  if (!isRecord(v)) throw new MemoryValidationError(`candidates[${index}] must be an object`);
  const guidance = string(v.guidance, MAX_CANDIDATE_GUIDANCE_BYTES);
  const digest = contentDigest(guidance);
  const scope = scopeObject(v.scope);
  const evidence = evidenceList(v.evidence);
  if (scope.roles.length + scope.paths.length + scope.categories.length + scope.keywords.length === 0) {
    throw new MemoryValidationError(`candidates[${index}].scope must have at least one non-empty dimension`);
  }
  if (evidence.length === 0) throw new MemoryValidationError(`candidates[${index}].evidence must not be empty`);
  return {
    id: validateId(v.id),
    contentDigest: digest,
    title: string(v.title, MAX_CANDIDATE_TITLE_BYTES),
    guidance,
    scope,
    evidence,
  };
}

export function validateCandidates(v: unknown): CandidateLesson[] {
  if (!Array.isArray(v)) throw new MemoryValidationError("candidates must be an array");
  if (v.length > MAX_CANDIDATES_PER_RUN) throw new MemoryValidationError(`candidates must not exceed ${MAX_CANDIDATES_PER_RUN} items`);
  const ids = new Set<string>();
  const result = v.map((c, i) => {
    const candidate = validateCandidate(c, i);
    if (ids.has(candidate.id)) throw new MemoryValidationError(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    return candidate;
  });
  return result;
}

const LEGAL_CANDIDATE_TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = {
  proposed: ["machine_approved", "machine_rejected"],
  machine_approved: ["duplicate", "pending", "declined", "promotion_pending"],
  machine_rejected: [],
  duplicate: [],
  pending: ["declined", "promotion_pending"],
  declined: [],
  promotion_pending: ["pending", "duplicate", "promotion_failed", "promoted"],
  promotion_failed: ["declined", "promotion_pending"],
  promoted: [],
};

export function isLegalCandidateTransition(from: CandidateState, to: CandidateState): boolean {
  return LEGAL_CANDIDATE_TRANSITIONS[from].includes(to);
}

function candidateState(v: unknown): CandidateState {
  if (typeof v !== "string" || !CANDIDATE_STATES.includes(v as CandidateState)) {
    throw new MemoryValidationError(`invalid candidate state: ${String(v)}`);
  }
  return v as CandidateState;
}

function validDate(v: unknown, label: string): string {
  const value = string(v, 64);
  if (!Number.isFinite(Date.parse(value))) throw new MemoryValidationError(`${label} must be a valid date`);
  return value;
}

function validateLedgerEntry(v: unknown, index: number): CandidateLedgerEntry {
  if (!isRecord(v)) throw new MemoryValidationError(`candidates[${index}] must be an object`);
  const candidate = validateCandidate(v, index);
  const state = candidateState(v.state);
  if (!Array.isArray(v.transitions)) throw new MemoryValidationError(`candidates[${index}].transitions must be an array`);
  let replayed: CandidateState = "proposed";
  const transitions = v.transitions.map((item, transitionIndex) => {
    if (!isRecord(item)) throw new MemoryValidationError(`candidates[${index}].transitions[${transitionIndex}] must be an object`);
    const from = candidateState(item.from);
    const to = candidateState(item.to);
    if (from !== replayed || !isLegalCandidateTransition(from, to)) {
      throw new MemoryValidationError(`illegal candidate transition ${from} -> ${to}`);
    }
    replayed = to;
    return {
      from,
      to,
      at: validDate(item.at, "transition.at"),
      reason: item.reason === undefined ? undefined : string(item.reason, 500),
    };
  });
  if (state !== replayed) throw new MemoryValidationError(`candidate ${candidate.id} state does not match its transitions`);
  return {
    ...candidate,
    state,
    updatedAt: validDate(v.updatedAt, "candidate.updatedAt"),
    transitions,
  };
}

export function validateCandidateLedger(v: unknown): CandidateLedger {
  if (!isRecord(v)) throw new MemoryValidationError("candidate ledger must be an object");
  if (v.schemaVersion !== CANDIDATE_LEDGER_SCHEMA_VERSION) {
    throw new MemoryValidationError(`unsupported candidate ledger schema version ${String(v.schemaVersion)}`);
  }
  if (!Array.isArray(v.candidates)) throw new MemoryValidationError("candidates must be an array");
  if (v.candidates.length > MAX_CANDIDATES_PER_RUN) {
    throw new MemoryValidationError(`candidates must not exceed ${MAX_CANDIDATES_PER_RUN} items`);
  }
  const ledger: CandidateLedger = {
    schemaVersion: CANDIDATE_LEDGER_SCHEMA_VERSION,
    revision: validateRevision(v.revision),
    runId: validateId(v.runId),
    projectPath: string(v.projectPath, 1024),
    finalChecksDigest: string(v.finalChecksDigest, 64),
    extensionVersion: string(v.extensionVersion, 64),
    updatedAt: validDate(v.updatedAt, "updatedAt"),
    candidates: v.candidates.map(validateLedgerEntry),
  };
  const ids = new Set<string>();
  for (const candidate of ledger.candidates) {
    if (ids.has(candidate.id)) throw new MemoryValidationError(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
  return ledger;
}

export function transitionCandidateState(
  ledger: CandidateLedger,
  candidateId: string,
  to: CandidateState,
  reason?: string,
  at: string = new Date().toISOString()
): CandidateLedger {
  const validated = validateCandidateLedger(ledger);
  const id = validateId(candidateId);
  const candidate = validated.candidates.find(item => item.id === id);
  if (!candidate) throw new MemoryValidationError(`candidate not found: ${id}`);
  if (!isLegalCandidateTransition(candidate.state, to)) {
    throw new MemoryValidationError(`illegal candidate transition ${candidate.state} -> ${to}`);
  }
  const timestamp = validDate(at, "transition.at");
  candidate.transitions.push({
    from: candidate.state,
    to,
    at: timestamp,
    reason: reason === undefined ? undefined : string(reason, 500),
  });
  candidate.state = to;
  candidate.updatedAt = timestamp;
  validated.updatedAt = timestamp;
  return validated;
}

export function deduplicateAgainstMemory(
  candidates: CandidateLesson[],
  memory: MemoryLesson[]
): { eligible: CandidateLesson[]; duplicates: CandidateLesson[] } {
  const existingDigests = new Set(memory.map(l => l.contentDigest));
  const eligible: CandidateLesson[] = [];
  const duplicates: CandidateLesson[] = [];
  for (const c of candidates) {
    if (existingDigests.has(c.contentDigest)) {
      duplicates.push(c);
    } else {
      eligible.push(c);
    }
  }
  return { eligible, duplicates };
}

export function selectLessons(
  lessons: MemoryLesson[],
  role: AgentName,
  requestTerms: string[],
  relevantPaths: string[],
  maxCount: number = MAX_SELECTED_LESSONS,
  maxBytes: number = MAX_SELECTED_LESSONS_BYTES
): MemoryLessonRef[] {
  const scored: Array<{ lesson: MemoryLesson; score: number; bytes: number }> = [];
  const requestLower = requestTerms.map(t => t.toLowerCase());

  for (const lesson of lessons) {
    let score = 0;
    if (lesson.scope.roles.length > 0 && !lesson.scope.roles.includes(role)) continue;
    score += 4;
    if (lesson.scope.paths.length > 0) {
      const pathMatch = relevantPaths.some(rp =>
        lesson.scope.paths.some(sp => repositoryPathMatches(rp, sp))
      );
      if (pathMatch) score += 3;
    }
    if (lesson.scope.keywords.length > 0) {
      const kwMatch = requestLower.some(rt =>
        lesson.scope.keywords.some(kw => rt.includes(kw.toLowerCase()) || kw.toLowerCase().includes(rt))
      );
      if (kwMatch) score += 2;
    }
    if (lesson.scope.categories.length > 0) {
      const catMatch = requestLower.some(rt =>
        lesson.scope.categories.some(c => rt.includes(c.toLowerCase()))
      );
      if (catMatch) score += 1;
    }
    if (score > 0) {
      const bytes = Buffer.byteLength(JSON.stringify(serializedLessonRef(lesson)), "utf8");
      scored.push({ lesson, score, bytes });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.lesson.createdAt.localeCompare(b.lesson.createdAt));

  const selected: MemoryLessonRef[] = [];
  let totalBytes = 0;
  for (const item of scored) {
    if (selected.length >= maxCount) break;
    const nextTotal = selected.length === 0 ? item.bytes + 2 : totalBytes + item.bytes + 1;
    if (nextTotal > maxBytes) continue;
    selected.push(serializedLessonRef(item.lesson));
    totalBytes = nextTotal;
  }
  return selected;
}

function serializedLessonRef(lesson: MemoryLesson): MemoryLessonRef {
  return {
    id: lesson.id,
    title: lesson.title,
    guidance: lesson.guidance,
    scope: structuredClone(lesson.scope),
    evidence: lesson.evidence.map(e => ({ path: e.path, detail: e.detail })),
    trust: "human-approved-project-memory",
  };
}

function validateApprovedAt(v: unknown): string {
  if (typeof v !== "string") throw new MemoryValidationError("approvedAt must be a string");
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new MemoryValidationError("approvedAt must be a valid ISO date");
  return v;
}

export function validateNewLesson(
  id: string,
  title: string,
  guidance: string,
  scope: unknown,
  evidence: unknown,
  provenance: {
    sourceRunId: string;
    candidateId: string;
    finalChecksDigest: string;
    approvedAt: string;
    extensionVersion: string;
  }
): MemoryLesson {
  const sourceRunId = validateId(provenance.sourceRunId);
  const candidateId = validateId(provenance.candidateId);
  const validatedId = validateId(id);
  const validatedScope = scopeObject(scope);
  const validatedEvidence = evidenceList(evidence);
  if (validatedScope.roles.length + validatedScope.paths.length + validatedScope.categories.length + validatedScope.keywords.length === 0) {
    throw new MemoryValidationError("lesson scope must have at least one non-empty dimension");
  }
  if (validatedEvidence.length === 0) throw new MemoryValidationError("lesson evidence must not be empty");
  return {
    id: validatedId === candidateId ? permanentLessonId(sourceRunId, candidateId) : validatedId,
    contentDigest: contentDigest(guidance),
    title: string(title, MAX_LESSON_TITLE_BYTES),
    guidance: string(guidance, MAX_LESSON_GUIDANCE_BYTES),
    scope: validatedScope,
    evidence: validatedEvidence,
    provenance: {
      sourceRunId,
      candidateId,
      finalChecksDigest: string(provenance.finalChecksDigest, 64),
      approvedAt: validateApprovedAt(provenance.approvedAt),
      extensionVersion: string(provenance.extensionVersion, 64),
    },
    createdAt: validateApprovedAt(new Date().toISOString()),
  };
}

export function computeFinalChecksDigest(results: Array<{
  command: string;
  passed: boolean;
  exitCode: number | null;
  timedOut?: boolean;
  cancelled?: boolean;
  executionError?: string;
  stdout?: string;
  stderr?: string;
}>): string {
  const stable = JSON.stringify(results.map(result => ({
    command: result.command,
    passed: result.passed,
    exitCode: result.exitCode,
    timedOut: result.timedOut ?? false,
    cancelled: result.cancelled ?? false,
    executionError: result.executionError ?? null,
    stdoutDigest: createHash("sha256").update(result.stdout ?? "", "utf8").digest("hex"),
    stderrDigest: createHash("sha256").update(result.stderr ?? "", "utf8").digest("hex")
  })));
  return createHash("sha256").update(stable, "utf8").digest("hex");
}
