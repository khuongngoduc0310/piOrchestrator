import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_MEMORY_BYTES, MEMORY_SCHEMA_VERSION } from "./memory-types.js";
import type { MemoryLesson } from "./memory-types.js";

const testDirs: string[] = [];

async function withTempCwd(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "memory-store-test-"));
  testDirs.push(dir);
  return dir;
}

// We need to mock getAgentDir to point to our temp dir
// Instead, let's test the store indirectly through its public interface
// by setting up the environment

// Since getAgentDir returns a fixed path based on user home,
// our tests need to work with the actual agent dir.
// For isolation, we'll test the validation and load/promote functions
// with known file paths.

import { loadMemory, promoteLessons, removeLesson, getMemoryRevision, getMemoryStorePath } from "./memory-store.js";

function sampleLesson(id: string, guidance?: string): MemoryLesson {
  const now = new Date().toISOString();
  const text = guidance ?? `Always verify before merging (${id})`;
  const digest = createHash("sha256").update(text, "utf8").digest("hex");
  return {
    id,
    contentDigest: digest,
    title: `Test lesson ${id}`,
    guidance: text,
    scope: { roles: ["builder"], paths: [], categories: [], keywords: ["verify"] },
    evidence: [{ path: "src/main.ts", detail: "Found unverified merge" }],
    provenance: {
      sourceRunId: "run-abc",
      candidateId: id,
      finalChecksDigest: "abc123",
      approvedAt: now,
      extensionVersion: "1.0.0",
    },
    createdAt: now,
  };
}

describe("memory-store", () => {
  afterEach(async () => {
    await Promise.all(testDirs.splice(0).flatMap(cwd => {
      const store = getMemoryStorePath(cwd);
      return [
        rm(store, { force: true }),
        rm(store.replace(/\.json$/, ".lock"), { recursive: true, force: true }),
        rm(cwd, { recursive: true, force: true })
      ];
    }));
  });

  describe("loadMemory", () => {
    it("returns null for non-existent memory", async () => {
      const cwd = await withTempCwd();
      const { document, error } = await loadMemory(cwd);
      expect(document).toBeNull();
      expect(error).toBeUndefined();
    });
  });

  describe("promoteLessons", () => {
    it("promotes new lessons and increments revision", async () => {
      const cwd = await withTempCwd();
      const result = await promoteLessons(cwd, [sampleLesson("l1")], 0);
      expect(result.promoted).toHaveLength(1);
      expect(result.promoted[0]).toBe("l1");
      expect(result.duplicates).toHaveLength(0);
      expect(result.revision).toBe(1);
    });

    it("rejects duplicate lessons", async () => {
      const cwd = await withTempCwd();
      await promoteLessons(cwd, [sampleLesson("l1")], 0);
      const result = await promoteLessons(cwd, [sampleLesson("l1")], 1);
      expect(result.promoted).toHaveLength(0);
      expect(result.duplicates).toHaveLength(1);
      expect(result.revision).toBe(1);
      expect(await getMemoryRevision(cwd)).toBe(1);
    });

    it("rejects stale revision", async () => {
      const cwd = await withTempCwd();
      await promoteLessons(cwd, [sampleLesson("l1")], 0);
      const result = await promoteLessons(cwd, [sampleLesson("l2")], 0);
      expect(result.retryable).toBe(true);
      expect(result.promoted).toHaveLength(0);
    });

    it("can promote after getting current revision", async () => {
      const cwd = await withTempCwd();
      await promoteLessons(cwd, [sampleLesson("l1")], 0);
      const rev = await getMemoryRevision(cwd);
      const result = await promoteLessons(cwd, [sampleLesson("l2")], rev);
      expect(result.promoted).toHaveLength(1);
      expect(result.revision).toBe(2);
    });

    it("handles empty lessons gracefully", async () => {
      const cwd = await withTempCwd();
      const result = await promoteLessons(cwd, [], 0);
      expect(result.promoted).toHaveLength(0);
      expect(result.revision).toBe(0);
    });

    it("promotes multiple lessons atomically", async () => {
      const cwd = await withTempCwd();
      const result = await promoteLessons(cwd, [sampleLesson("l1"), sampleLesson("l2"), sampleLesson("l3")], 0);
      expect(result.promoted).toHaveLength(3);
      const { document } = await loadMemory(cwd);
      expect(document!.lessons).toHaveLength(3);
    });

    it.each([
      ["malformed", "{not-json"],
      ["oversized", "x".repeat(MAX_MEMORY_BYTES + 1)],
      ["future schema", JSON.stringify({ schemaVersion: 999, revision: 1, updatedAt: new Date().toISOString(), projectPath: "unused", lessons: [] })],
    ])("does not overwrite %s memory", async (_label, original) => {
      const cwd = await withTempCwd();
      const file = getMemoryStorePath(cwd);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, original, "utf8");
      const result = await promoteLessons(cwd, [sampleLesson("l1")], 0);
      expect(result.error).toBeTruthy();
      expect(await readFile(file, "utf8")).toBe(original);
    });

    it("does not overwrite memory bound to another project", async () => {
      const cwd = await withTempCwd();
      const file = getMemoryStorePath(cwd);
      const original = JSON.stringify({
        schemaVersion: MEMORY_SCHEMA_VERSION,
        revision: 3,
        updatedAt: new Date().toISOString(),
        projectPath: path.resolve(`${cwd}-other`),
        lessons: [],
      });
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, original, "utf8");
      const result = await promoteLessons(cwd, [sampleLesson("l1")], 0);
      expect(result.error).toContain("projectPath mismatch");
      expect(await readFile(file, "utf8")).toBe(original);
    });

    it("checks the exact serialized UTF-8 size before writing", async () => {
      const cwd = await withTempCwd();
      const lessons = Array.from({ length: 70 }, (_, index) => sampleLesson(`large-${index}`, `${index}:${"x".repeat(1990)}`));
      const result = await promoteLessons(cwd, lessons, 0);
      expect(result.promoted.length).toBeGreaterThan(0);
      expect(result.failed.length).toBeGreaterThan(0);
      const bytes = Buffer.byteLength(await readFile(getMemoryStorePath(cwd), "utf8"), "utf8");
      expect(bytes).toBeLessThanOrEqual(MAX_MEMORY_BYTES);
    });
  });

  describe("removeLesson", () => {
    it("removes an existing lesson", async () => {
      const cwd = await withTempCwd();
      await promoteLessons(cwd, [sampleLesson("l1")], 0);
      const result = await removeLesson(cwd, "l1", 1);
      expect(result.removed).toBe(true);
      const { document } = await loadMemory(cwd);
      expect(document!.lessons).toHaveLength(0);
    });

    it("returns error for non-existent lesson", async () => {
      const cwd = await withTempCwd();
      await promoteLessons(cwd, [sampleLesson("l1")], 0);
      const result = await removeLesson(cwd, "nonexistent", 1);
      expect(result.removed).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("rejects stale revision", async () => {
      const cwd = await withTempCwd();
      await promoteLessons(cwd, [sampleLesson("l1")], 0);
      const result = await removeLesson(cwd, "l1", 0);
      expect(result.removed).toBe(false);
      expect(result.error).toContain("Revision mismatch");
    });
  });
});
