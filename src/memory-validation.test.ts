import { describe, it, expect } from "vitest";
import {
  contentDigest,
  validateMemoryDocument,
  validateCandidates,
  deduplicateAgainstMemory,
  computeFinalChecksDigest,
  candidateLessonId,
  permanentLessonId,
  validateNewLesson,
  MemoryValidationError,
} from "./memory-validation.js";
import { MEMORY_SCHEMA_VERSION } from "./memory-types.js";
import type { MemoryLesson } from "./memory-types.js";

function validDoc(overrides: Partial<any> = {}) {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    revision: 1,
    updatedAt: "2025-01-01T00:00:00.000Z",
    projectPath: "/project",
    lessons: [],
    ...overrides,
  };
}

function validLesson(overrides: Partial<any> = {}): any {
  return {
    id: "lesson-01",
    contentDigest: contentDigest("Always verify before merging"),
    title: "Verify before merge",
    guidance: "Always verify before merging",
    scope: { roles: ["builder"], paths: [], categories: [], keywords: ["verify"] },
    evidence: [{ path: "src/main.ts", detail: "Found unverified merge" }],
    provenance: {
      sourceRunId: "run-abc",
      candidateId: "lesson-01",
      finalChecksDigest: "abc123",
      approvedAt: "2025-01-01T00:00:00.000Z",
      extensionVersion: "1.0.0",
    },
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("contentDigest", () => {
  it("produces stable digest for same text", () => {
    expect(contentDigest("Always verify before merging")).toBe(contentDigest("Always verify before merging"));
  });

  it("normalizes whitespace", () => {
    expect(contentDigest("  Always  verify  ")).toBe(contentDigest("Always verify"));
  });

  it("normalizes Unicode", () => {
    expect(contentDigest("\u0065\u0301")).toBe(contentDigest("\u00e9"));
  });

  it("produces different digest for different text", () => {
    expect(contentDigest("Always verify")).not.toBe(contentDigest("Never trust"));
  });
});

describe("stable lesson IDs", () => {
  it("creates deterministic run-local candidate and permanent IDs", () => {
    expect(candidateLessonId("run-abc", 0)).toBe(candidateLessonId("run-abc", 0));
    expect(candidateLessonId("run-abc", 0)).not.toBe(candidateLessonId("run-abc", 1));
    expect(permanentLessonId("run-abc", "c01")).toBe(permanentLessonId("run-abc", "c01"));
    expect(permanentLessonId("run-abc", "c01")).not.toBe(permanentLessonId("run-def", "c01"));
  });
});

describe("validateMemoryDocument", () => {
  it("accepts a valid empty document", () => {
    const doc = validateMemoryDocument(validDoc());
    expect(doc.schemaVersion).toBe(MEMORY_SCHEMA_VERSION);
    expect(doc.lessons).toEqual([]);
    expect(doc.revision).toBe(1);
  });

  it("accepts a document with valid lessons", () => {
    const doc = validateMemoryDocument(validDoc({ lessons: [validLesson()] }));
    expect(doc.lessons).toHaveLength(1);
    expect(doc.lessons[0].id).toBe("lesson-01");
  });

  it("rejects non-object", () => {
    expect(() => validateMemoryDocument("string")).toThrow(MemoryValidationError);
    expect(() => validateMemoryDocument(null)).toThrow(MemoryValidationError);
    expect(() => validateMemoryDocument(42)).toThrow(MemoryValidationError);
  });

  it("rejects an invalid revision instead of coercing it", () => {
    expect(() => validateMemoryDocument(validDoc({ revision: "1" }))).toThrow("revision must be a non-negative integer");
  });

  it("rejects future schema version", () => {
    expect(() => validateMemoryDocument(validDoc({ schemaVersion: 999 }))).toThrow("future schema version");
  });

  it("rejects duplicate lesson IDs", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ id: "same" }), validLesson({ id: "same" })],
    }))).toThrow("duplicate lesson id");
  });

  it("rejects oversized lessons array", () => {
    const lessons = Array.from({ length: 101 }, (_, i) => validLesson({ id: `lesson-${String(i).padStart(3, "0")}` }));
    expect(() => validateMemoryDocument(validDoc({ lessons }))).toThrow("must not exceed 100 items");
  });

  it("rejects invalid lesson ID characters", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ id: "lesson/one" })],
    }))).toThrow("id must be alphanumeric");
  });

  it("rejects path traversal in evidence", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ evidence: [{ path: "foo/../../etc/passwd", detail: "bad" }] })],
    }))).toThrow("must not contain empty, . or .. path segments");
  });

  it("rejects absolute paths in evidence", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ evidence: [{ path: "/etc/passwd", detail: "bad" }] })],
    }))).toThrow("path must be repository-relative");
  });

  it("normalizes Windows path separators", () => {
    const validated = validateMemoryDocument(validDoc({
      lessons: [validLesson({ evidence: [{ path: "src\\main.ts", detail: "normalized" }] })],
    }));
    expect(validated.lessons[0].evidence[0].path).toBe("src/main.ts");
  });

  it("accepts filenames containing two dots without a traversal segment", () => {
    const validated = validateMemoryDocument(validDoc({
      lessons: [validLesson({ evidence: [{ path: "src/file..backup.ts", detail: "valid filename" }] })],
    }));
    expect(validated.lessons[0].evidence[0].path).toBe("src/file..backup.ts");
  });

  it("rejects unknown agent name", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ scope: { roles: ["unknown_role"], paths: [], categories: [], keywords: [] } })],
    }))).toThrow("invalid agent name");
  });

  it("rejects duplicate scope entries", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ scope: { roles: ["builder", "builder"], paths: [], categories: [], keywords: [] } })],
    }))).toThrow("scope.roles must not contain duplicates");
  });

  it("rejects empty title", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ title: "  " })],
    }))).toThrow("must not be empty");
  });

  it("rejects a stored content digest that does not match guidance", () => {
    expect(() => validateMemoryDocument(validDoc({
      lessons: [validLesson({ contentDigest: "forged" })],
    }))).toThrow("contentDigest does not match guidance");
  });
});

describe("validateCandidates", () => {
  it("accepts valid candidates", () => {
    const candidates = validateCandidates([
      { id: "c01", title: "A", guidance: "guidance", scope: { roles: ["builder"], paths: [], categories: [], keywords: [] }, evidence: [{ path: "src/main.ts", detail: "observed" }] },
    ]);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].contentDigest).toBe(contentDigest("guidance"));
  });

  it("preserves and normalizes candidate scope", () => {
    const candidates = validateCandidates([
      {
        id: "c01",
        title: "A",
        guidance: "guidance",
        scope: { roles: ["builder"], paths: ["src\\feature\\"], categories: ["testing"], keywords: ["verify"] },
        evidence: [{ path: "src\\feature\\test.ts", detail: "evidence" }]
      },
    ]);
    expect(candidates[0].scope).toEqual({ roles: ["builder"], paths: ["src/feature"], categories: ["testing"], keywords: ["verify"] });
    expect(candidates[0].evidence[0].path).toBe("src/feature/test.ts");
  });

  it("rejects duplicate candidate IDs", () => {
    expect(() => validateCandidates([
      { id: "c01", title: "A", guidance: "guidance", scope: { roles: ["builder"], paths: [], categories: [], keywords: [] }, evidence: [{ path: "src/main.ts", detail: "observed" }] },
      { id: "c01", title: "B", guidance: "other", scope: { roles: ["builder"], paths: [], categories: [], keywords: [] }, evidence: [{ path: "src/main.ts", detail: "observed" }] },
    ])).toThrow("duplicate candidate id");
  });

  it("rejects too many candidates", () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `c${String(i).padStart(2, "0")}`,
      title: "T",
      guidance: "G",
      scope: { roles: [], paths: [], categories: [], keywords: [] },
      evidence: [],
    }));
    expect(() => validateCandidates(many)).toThrow("must not exceed 20 items");
  });

  it("rejects oversized guidance", () => {
    expect(() => validateCandidates([
      { id: "c01", title: "T", guidance: "x".repeat(2001), scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [] },
    ])).toThrow("must not exceed 2000 bytes");
  });

  it("rejects candidates without evidence or scope", () => {
    expect(() => validateCandidates([
      { id: "c01", title: "T", guidance: "G", scope: { roles: ["builder"], paths: [], categories: [], keywords: [] }, evidence: [] },
    ])).toThrow("evidence must not be empty");
    expect(() => validateCandidates([
      { id: "c01", title: "T", guidance: "G", scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [{ path: "src/main.ts", detail: "observed" }] },
    ])).toThrow("scope must have at least one non-empty dimension");
  });
});

describe("deduplicateAgainstMemory", () => {
  it("finds duplicates by content digest", () => {
    const guidance = "Always verify";
    const mem: MemoryLesson[] = [{
      id: "existing",
      contentDigest: contentDigest(guidance),
      title: "existing",
      guidance,
      scope: { roles: [], paths: [], categories: [], keywords: [] },
      evidence: [],
      provenance: { sourceRunId: "", candidateId: "", finalChecksDigest: "", approvedAt: "", extensionVersion: "" },
      createdAt: "",
    }];
    const candidates = [
      { id: "c01", title: "dup", contentDigest: contentDigest(guidance), guidance, scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [] },
      { id: "c02", title: "new", contentDigest: contentDigest("New lesson"), guidance: "New lesson", scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [] },
    ];
    const { eligible, duplicates } = deduplicateAgainstMemory(candidates, mem);
    expect(eligible).toHaveLength(1);
    expect(eligible[0].id).toBe("c02");
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].id).toBe("c01");
  });

  it("handles empty memory", () => {
    const candidates = [
      { id: "c01", title: "T", contentDigest: "", guidance: "G", scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [] },
    ];
    const { eligible, duplicates } = deduplicateAgainstMemory(candidates, []);
    expect(eligible).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });
});

describe("computeFinalChecksDigest", () => {
  it("produces stable digest for same results", () => {
    const a = [{ command: "npm test", passed: true, exitCode: 0 }];
    const b = [{ command: "npm test", passed: true, exitCode: 0 }];
    expect(computeFinalChecksDigest(a)).toBe(computeFinalChecksDigest(b));
  });

  it("changes when results change", () => {
    const a = [{ command: "npm test", passed: true, exitCode: 0 }];
    const b = [{ command: "npm test", passed: false, exitCode: 1 }];
    expect(computeFinalChecksDigest(a)).not.toBe(computeFinalChecksDigest(b));
  });
});

describe("validateNewLesson", () => {
  it("creates a valid lesson with correct digest", () => {
    const lesson = validateNewLesson(
      "lesson-01",
      "Title",
      "Guidance text",
      { roles: ["builder"], paths: ["src/"], categories: ["testing"], keywords: ["verify"] },
      [{ path: "src/main.ts", detail: "detail" }],
      { sourceRunId: "run-abc", candidateId: "c01", finalChecksDigest: "abc", approvedAt: new Date().toISOString(), extensionVersion: "1.0.0" }
    );
    expect(lesson.id).toBe("lesson-01");
    expect(lesson.contentDigest).toBe(contentDigest("Guidance text"));
    expect(lesson.scope.roles).toEqual(["builder"]);
  });

  it("turns a run-local candidate ID into a stable permanent ID", () => {
    const lesson = validateNewLesson(
      "c01", "Title", "Guidance", { roles: ["builder"], paths: [], categories: [], keywords: [] }, [{ path: "src/main.ts", detail: "observed" }],
      { sourceRunId: "run-abc", candidateId: "c01", finalChecksDigest: "abc", approvedAt: new Date().toISOString(), extensionVersion: "1.0.0" }
    );
    expect(lesson.id).toBe(permanentLessonId("run-abc", "c01"));
  });

  it("rejects invalid scope roles", () => {
    expect(() => validateNewLesson(
      "id", "T", "G",
      { roles: ["bogus"], paths: [], categories: [], keywords: [] },
      [],
      { sourceRunId: "run", candidateId: "c", finalChecksDigest: "a", approvedAt: new Date().toISOString(), extensionVersion: "1.0.0" }
    )).toThrow("invalid agent name");
  });
});
