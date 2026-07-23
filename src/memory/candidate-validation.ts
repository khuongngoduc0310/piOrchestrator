import {
  MAX_CANDIDATE_GUIDANCE_BYTES,
  MAX_CANDIDATE_TITLE_BYTES,
  MAX_CANDIDATES_PER_RUN,
  type CandidateLesson,
  type MemoryLesson
} from "./memory-types.js";
import {
  MemoryValidationError,
  evidenceList,
  isRecord,
  memoryString,
  scopeObject,
  validateMemoryId
} from "./memory-validation-core.js";
import { contentDigest } from "./memory-digest.js";

export function validateCandidate(v: unknown, index: number): CandidateLesson {
  if (!isRecord(v)) throw new MemoryValidationError(`candidates[${index}] must be an object`);
  const guidance = memoryString(v.guidance, MAX_CANDIDATE_GUIDANCE_BYTES);
  const digest = contentDigest(guidance);
  const scope = scopeObject(v.scope);
  const evidence = evidenceList(v.evidence);
  if (scope.roles.length + scope.paths.length + scope.categories.length + scope.keywords.length === 0) {
    throw new MemoryValidationError(`candidates[${index}].scope must have at least one non-empty dimension`);
  }
  if (evidence.length === 0) throw new MemoryValidationError(`candidates[${index}].evidence must not be empty`);
  return {
    id: validateMemoryId(v.id),
    contentDigest: digest,
    title: memoryString(v.title, MAX_CANDIDATE_TITLE_BYTES),
    guidance,
    scope,
    evidence
  };
}

export function validateCandidates(v: unknown): CandidateLesson[] {
  if (!Array.isArray(v)) throw new MemoryValidationError("candidates must be an array");
  if (v.length > MAX_CANDIDATES_PER_RUN) throw new MemoryValidationError(`candidates must not exceed ${MAX_CANDIDATES_PER_RUN} items`);
  const ids = new Set<string>();
  return v.map((item, index) => {
    const candidate = validateCandidate(item, index);
    if (ids.has(candidate.id)) throw new MemoryValidationError(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
    return candidate;
  });
}

export function deduplicateAgainstMemory(
  candidates: CandidateLesson[],
  memory: MemoryLesson[]
): { eligible: CandidateLesson[]; duplicates: CandidateLesson[] } {
  const existingDigests = new Set(memory.map(lesson => lesson.contentDigest));
  const eligible: CandidateLesson[] = [];
  const duplicates: CandidateLesson[] = [];
  for (const candidate of candidates) {
    if (existingDigests.has(candidate.contentDigest)) duplicates.push(candidate);
    else eligible.push(candidate);
  }
  return { eligible, duplicates };
}
