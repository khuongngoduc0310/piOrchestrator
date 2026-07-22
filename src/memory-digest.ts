import { createHash } from "node:crypto";
import { MemoryValidationError, validateMemoryId } from "./memory-validation-core.js";

export function candidateLessonId(runId: string, ordinal: number): string {
  const validatedRunId = validateMemoryId(runId);
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new MemoryValidationError("candidate ordinal must be a non-negative integer");
  const digest = createHash("sha256").update(`${validatedRunId}\0${ordinal}`, "utf8").digest("hex").slice(0, 20);
  return `candidate-${digest}`;
}

export function permanentLessonId(sourceRunId: string, candidateId: string): string {
  const run = validateMemoryId(sourceRunId);
  const candidate = validateMemoryId(candidateId);
  const digest = createHash("sha256").update(`${run}\0${candidate}`, "utf8").digest("hex").slice(0, 24);
  return `lesson-${digest}`;
}

export const createCandidateLessonId = candidateLessonId;
export const createPermanentLessonId = permanentLessonId;

export function contentDigest(guidance: string): string {
  const normalized = guidance
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  return createHash("sha256").update(normalized, "utf8").digest("hex");
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
