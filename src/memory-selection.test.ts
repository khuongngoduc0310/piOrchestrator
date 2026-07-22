import { describe, it, expect } from "vitest";
import { repositoryPathMatches, selectMemoryLessons } from "./memory-selection.js";
import { MEMORY_SCHEMA_VERSION, type MemoryDocument } from "./memory-types.js";

function doc(lessons: any[]): MemoryDocument {
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION,
    revision: 1,
    updatedAt: "2025-01-01T00:00:00.000Z",
    projectPath: "/project",
    lessons,
  };
}

function lesson(overrides: Partial<any> = {}): any {
  return {
    id: "l-01",
    contentDigest: "abc",
    title: "Lesson title",
    guidance: "Lesson guidance text",
    scope: { roles: [], paths: [], categories: [], keywords: [] },
    evidence: [],
    provenance: { sourceRunId: "r", candidateId: "c", finalChecksDigest: "d", approvedAt: "2025-01-01T00:00:00.000Z", extensionVersion: "1.0.0" },
    createdAt: "2025-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("selectMemoryLessons", () => {
  it("returns empty for null document", () => {
    const result = selectMemoryLessons(null, "builder", "add feature", []);
    expect(result.lessons).toHaveLength(0);
    expect(result.revision).toBe(0);
  });

  it("returns empty for document with no lessons", () => {
    const result = selectMemoryLessons(doc([]), "builder", "add feature", []);
    expect(result.lessons).toHaveLength(0);
  });

  it("selects lessons matching the role", () => {
    const d = doc([
      lesson({ id: "l1", scope: { roles: ["builder"], paths: [], categories: [], keywords: [] } }),
      lesson({ id: "l2", scope: { roles: ["tester"], paths: ["src/other.ts"], categories: [], keywords: [] } }),
    ]);
    const result = selectMemoryLessons(d, "builder", "add feature", []);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].id).toBe("l1");
  });

  it("selects lessons with empty roles (applies to all)", () => {
    const d = doc([
      lesson({ id: "l1", scope: { roles: [], paths: [], categories: [], keywords: [] } }),
    ]);
    const result = selectMemoryLessons(d, "builder", "add feature", []);
    expect(result.lessons).toHaveLength(1);
    expect(result.lessons[0].id).toBe("l1");
  });

  it("prefers lessons matching request terms", () => {
    const d = doc([
      lesson({ id: "l1", scope: { roles: ["builder"], paths: [], categories: [], keywords: ["verify"] }, createdAt: "2025-01-01T00:00:00.000Z" }),
      lesson({ id: "l2", scope: { roles: ["builder"], paths: [], categories: [], keywords: ["verify"] }, createdAt: "2025-01-02T00:00:00.000Z" }),
    ]);
    const result = selectMemoryLessons(d, "builder", "verify transactions", []);
    expect(result.lessons).toHaveLength(2);
    expect(result.lessons[0].id).toBe("l1");
    expect(result.lessons[1].id).toBe("l2");
  });

  it("prefers lessons matching relevant paths", () => {
    const d = doc([
      lesson({ id: "l1", scope: { roles: [], paths: ["src/payment.ts"], categories: [], keywords: [] }, createdAt: "2025-01-01T00:00:00.000Z" }),
      lesson({ id: "l2", scope: { roles: [], paths: [], categories: [], keywords: [] }, createdAt: "2025-01-02T00:00:00.000Z" }),
    ]);
    const result = selectMemoryLessons(d, "builder", "fix payment", ["src/payment.ts", "src/main.ts"]);
    expect(result.lessons[0].id).toBe("l1");
  });

  it("does not select a scoped lesson for an unrelated role or path", () => {
    const d = doc([
      lesson({ id: "l1", scope: { roles: ["tester"], paths: ["src/payments"], categories: [], keywords: [] } }),
    ]);
    const result = selectMemoryLessons(d, "builder", "add profile", ["src/profile.ts"]);
    expect(result.lessons).toEqual([]);
  });

  it("does not let a matching role override unrelated topical scope", () => {
    const d = doc([lesson({
      id: "payments-only",
      scope: { roles: ["builder"], paths: ["src/payments"], categories: [], keywords: [] },
    })]);
    expect(selectMemoryLessons(d, "builder", "add profile", ["src/profile.ts"]).lessons).toEqual([]);
  });

  it("matches keywords as whole tokens rather than substrings", () => {
    const d = doc([lesson({ id: "auth", scope: { roles: ["builder"], paths: [], categories: [], keywords: ["auth"] } })]);
    expect(selectMemoryLessons(d, "builder", "improve authorization", []).lessons).toEqual([]);
    expect(selectMemoryLessons(d, "builder", "fix auth flow", []).lessons[0].id).toBe("auth");
  });

  it("respects maxCount", () => {
    const d = doc(Array.from({ length: 5 }, (_, i) => lesson({
      id: `l${i}`,
      scope: { roles: [], paths: [], categories: [], keywords: [] },
      createdAt: `2025-01-0${i + 1}T00:00:00.000Z`,
    })));
    const result = selectMemoryLessons(d, "builder", "test", [], 2);
    expect(result.lessons).toHaveLength(2);
  });

  it("respects maxBytes", () => {
    const d = doc([
      lesson({ id: "l1", guidance: "x".repeat(30), title: "t", evidence: [], scope: { roles: [], paths: [], categories: [], keywords: [] } }),
      lesson({ id: "l2", guidance: "y".repeat(30), title: "t", evidence: [], scope: { roles: [], paths: [], categories: [], keywords: [] } }),
    ]);
    const firstRef = { id: "l1", title: "t", guidance: "x".repeat(30), scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [], trust: "human-approved-project-memory" };
    const maxBytes = Buffer.byteLength(JSON.stringify({ advisoryOnly: true, selectedAtRevision: 1, lessons: [firstRef] }), "utf8");
    const result = selectMemoryLessons(d, "builder", "test", [], 10, maxBytes);
    expect(result.lessons).toHaveLength(1);
    expect(result.totalBytes).toBe(Buffer.byteLength(JSON.stringify({ advisoryOnly: true, selectedAtRevision: 1, lessons: result.lessons }), "utf8"));
  });

  it("skips an oversized high-ranked lesson and continues", () => {
    const d = doc([
      lesson({ id: "large", guidance: "x".repeat(100), scope: { roles: [], paths: [], categories: [], keywords: ["test"] } }),
      lesson({ id: "small", title: "t", guidance: "g", scope: { roles: [], paths: [], categories: [], keywords: [] } }),
    ]);
    const smallRef = { id: "small", title: "t", guidance: "g", scope: { roles: [], paths: [], categories: [], keywords: [] }, evidence: [], trust: "human-approved-project-memory" };
    const result = selectMemoryLessons(d, "builder", "test", [], 10, Buffer.byteLength(JSON.stringify({ advisoryOnly: true, selectedAtRevision: 1, lessons: [smallRef] }), "utf8"));
    expect(result.lessons.map(item => item.id)).toEqual(["small"]);
  });

  it("treats role scope as a hard eligibility requirement", () => {
    const d = doc([lesson({
      id: "tester-only",
      scope: { roles: ["tester"], paths: ["src"], categories: ["testing"], keywords: ["test"] },
    })]);
    expect(selectMemoryLessons(d, "builder", "test src", ["src/main.ts"]).lessons).toEqual([]);
  });

  it("matches paths only at repository segment boundaries", () => {
    expect(repositoryPathMatches("src/payment.ts", "src/pay")).toBe(false);
    expect(repositoryPathMatches("src/pay/index.ts", "src/pay")).toBe(true);
    expect(repositoryPathMatches("src/pay", "src/pay")).toBe(true);
  });

  it("sorts by score descending then createdAt ascending", () => {
    const d = doc([
      lesson({ id: "old", scope: { roles: [], paths: [], categories: [], keywords: [] }, createdAt: "2025-01-01T00:00:00.000Z" }),
      lesson({ id: "new", scope: { roles: [], paths: [], categories: [], keywords: [] }, createdAt: "2025-01-10T00:00:00.000Z" }),
    ]);
    const result = selectMemoryLessons(d, "builder", "test", []);
    expect(result.lessons[0].id).toBe("old");
    expect(result.lessons[1].id).toBe("new");
  });
});
