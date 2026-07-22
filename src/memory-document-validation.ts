import {
  MEMORY_SCHEMA_VERSION,
  MAX_LESSONS_PER_DOC,
  MAX_LESSON_TITLE_BYTES,
  MAX_LESSON_GUIDANCE_BYTES,
  type MemoryDocument,
  type MemoryLesson
} from "./memory-types.js";
import {
  MemoryValidationError,
  evidenceList,
  isRecord,
  memoryString,
  scopeObject,
  validDate,
  validateMemoryId,
  validateRevision
} from "./memory-validation-core.js";
import { contentDigest, permanentLessonId } from "./memory-digest.js";

function provenanceObject(v: unknown): MemoryLesson["provenance"] {
  if (!isRecord(v)) throw new MemoryValidationError("provenance must be an object");
  return {
    sourceRunId: validateMemoryId(v.sourceRunId),
    candidateId: validateMemoryId(v.candidateId),
    finalChecksDigest: memoryString(v.finalChecksDigest, 64),
    approvedAt: validDate(v.approvedAt, "approvedAt"),
    extensionVersion: memoryString(v.extensionVersion, 64)
  };
}

function validateLesson(v: unknown, index: number): MemoryLesson {
  if (!isRecord(v)) throw new MemoryValidationError(`lessons[${index}] must be an object`);
  const guidance = memoryString(v.guidance, MAX_LESSON_GUIDANCE_BYTES);
  const digest = memoryString(v.contentDigest, 64);
  if (digest !== contentDigest(guidance)) throw new MemoryValidationError(`lessons[${index}].contentDigest does not match guidance`);
  const scope = scopeObject(v.scope);
  const evidence = evidenceList(v.evidence);
  if (scope.roles.length + scope.paths.length + scope.categories.length + scope.keywords.length === 0) {
    throw new MemoryValidationError(`lessons[${index}].scope must have at least one non-empty dimension`);
  }
  if (evidence.length === 0) throw new MemoryValidationError(`lessons[${index}].evidence must not be empty`);
  return {
    id: validateMemoryId(v.id),
    contentDigest: digest,
    title: memoryString(v.title, MAX_LESSON_TITLE_BYTES),
    guidance,
    scope,
    evidence,
    provenance: provenanceObject(v.provenance),
    createdAt: validDate(v.createdAt, "createdAt")
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
    projectPath: memoryString(v.projectPath, 1024),
    lessons: lessons.map((lesson, index) => validateLesson(lesson, index))
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

function validateApprovedAt(v: unknown): string {
  if (typeof v !== "string") throw new MemoryValidationError("approvedAt must be a string");
  const date = new Date(v);
  if (isNaN(date.getTime())) throw new MemoryValidationError("approvedAt must be a valid ISO date");
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
  const sourceRunId = validateMemoryId(provenance.sourceRunId);
  const candidateId = validateMemoryId(provenance.candidateId);
  const validatedId = validateMemoryId(id);
  const validatedScope = scopeObject(scope);
  const validatedEvidence = evidenceList(evidence);
  if (validatedScope.roles.length + validatedScope.paths.length + validatedScope.categories.length + validatedScope.keywords.length === 0) {
    throw new MemoryValidationError("lesson scope must have at least one non-empty dimension");
  }
  if (validatedEvidence.length === 0) throw new MemoryValidationError("lesson evidence must not be empty");
  return {
    id: validatedId === candidateId ? permanentLessonId(sourceRunId, candidateId) : validatedId,
    contentDigest: contentDigest(guidance),
    title: memoryString(title, MAX_LESSON_TITLE_BYTES),
    guidance: memoryString(guidance, MAX_LESSON_GUIDANCE_BYTES),
    scope: validatedScope,
    evidence: validatedEvidence,
    provenance: {
      sourceRunId,
      candidateId,
      finalChecksDigest: memoryString(provenance.finalChecksDigest, 64),
      approvedAt: validateApprovedAt(provenance.approvedAt),
      extensionVersion: memoryString(provenance.extensionVersion, 64)
    },
    createdAt: validateApprovedAt(new Date().toISOString())
  };
}
