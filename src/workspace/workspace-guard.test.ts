import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlannerOutput } from "../types.js";
import {
  compareWorkspaceSnapshots,
  canonicalSha256,
  createWorkspaceSnapshot,
  deriveMutationPathScope,
  deriveRoleMutationPaths,
  isDocumentationPath,
  isTestPath,
  workspaceSnapshotDigest,
  validateReportedFileSet,
  validateRoleDelta
} from "./workspace-guard.js";

const directories: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function plan(files: string[]): PlannerOutput {
  return {
    route: "implementation",
    summary: "guarded change",
    assumptions: [],
    acceptanceCriteria: ["works"],
    tasks: [{ id: "one", description: "change", files, dependencies: [], verification: ["test"] }],
    risks: []
  };
}

describe("mutation path scopes", () => {
  it("rejects mutation scope derivation for review-only plans", () => {
    expect(() => deriveMutationPathScope({ ...plan(["src/code.ts"]), route: "review_only" }))
      .toThrow("does not authorize mutations");
  });

  it("normalizes, deduplicates, and conservatively classifies exact planned files", () => {
    const scope = deriveMutationPathScope(plan([
      "src\\feature.ts",
      "src/feature.ts",
      "src/feature.test.ts",
      "docs/guide.txt",
      "README.md",
      "vitest.config.ts"
    ]));
    expect(scope.planFiles).toEqual([
      "README.md",
      "docs/guide.txt",
      "src/feature.test.ts",
      "src/feature.ts",
      "vitest.config.ts"
    ]);
    expect(scope.testFiles).toEqual(["src/feature.test.ts"]);
    expect(scope.documentationFiles).toEqual(["README.md", "docs/guide.txt"]);
  });

  it("does not classify ambiguous source and configuration paths", () => {
    expect(isTestPath("src/contest.ts")).toBe(false);
    expect(isTestPath("vitest.config.ts")).toBe(false);
    expect(isDocumentationPath("src/markdown-parser.ts")).toBe(false);
  });

  it("rejects role changes outside exact role scope", () => {
    const planned = plan(["src/code.ts", "test/code.test.ts", "docs/usage.md"]);
    const delta = { added: [], modified: ["src/code.ts"], deleted: [], changedFiles: ["src/code.ts"] };
    expect(() => validateRoleDelta("tester", planned, delta)).toThrow("outside its tests scope");
    expect(() => validateRoleDelta("builder", planned, delta)).not.toThrow();
    expect(() => validateRoleDelta("reviewer", planned, delta)).toThrow("outside its none scope");
  });

  it("enforces specialized route and role scopes", () => {
    const testsPlan = { ...plan(["test/code.test.ts"]), route: "tests_only" as const };
    expect(deriveRoleMutationPaths("tester", testsPlan)).toEqual(["test/code.test.ts"]);
    expect(() => deriveRoleMutationPaths("builder", testsPlan)).toThrow("does not authorize builder");
    expect(() => deriveMutationPathScope({ ...testsPlan, tasks: [{ ...testsPlan.tasks[0], files: ["src/code.ts"] }] }))
      .toThrow("only test-classified files");

    const docsPlan = { ...plan(["README.md"]), route: "documentation_only" as const };
    expect(deriveRoleMutationPaths("documenter", docsPlan)).toEqual(["README.md"]);
    expect(() => deriveRoleMutationPaths("tester", docsPlan)).toThrow("does not authorize tester");
    expect(() => deriveMutationPathScope({ ...docsPlan, tasks: [{ ...docsPlan.tasks[0], files: ["src/code.ts"] }] }))
      .toThrow("only documentation-classified files");
  });

  it("authorizes exact explicit Tester support files", () => {
    const testsPlan = {
      ...plan(["test/code.test.ts"]),
      route: "tests_only" as const,
      tasks: [{
        ...plan(["test/code.test.ts"]).tasks[0],
        testSupportFiles: ["vitest.config.ts", "fixtures/example.json"]
      }]
    };
    expect(deriveRoleMutationPaths("tester", testsPlan)).toEqual([
      "fixtures/example.json",
      "test/code.test.ts",
      "vitest.config.ts"
    ]);
    expect(deriveMutationPathScope(testsPlan).testSupportFiles).toEqual(["fixtures/example.json", "vitest.config.ts"]);
  });

  it("requires exact normalized reported and actual sets", () => {
    expect(() => validateReportedFileSet(["src\\a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"])).not.toThrow();
    expect(() => validateReportedFileSet(["src/a.ts"], ["src/a.ts", "src/b.ts"])).toThrow("unreported: src/b.ts");
    expect(() => validateReportedFileSet(["src/a.ts", "src/b.ts"], ["src/a.ts"])).toThrow("not actually changed: src/b.ts");
    expect(() => validateReportedFileSet(["src/a.ts"], {
      added: ["src/a.ts"], modified: [], deleted: [], changedFiles: []
    })).not.toThrow();
  });
});

describe("workspace snapshots", () => {
  it("uses canonical hashes and stable snapshot digests", () => {
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(canonicalSha256({ a: 1, b: 2 }));
    const snapshot = {
      root: "C:/first",
      kind: "filesystem" as const,
      files: { "a.txt": { hash: "content", mode: 0o644 } },
      fileCount: 1,
      totalBytes: 7
    };
    expect(workspaceSnapshotDigest(snapshot)).toBe(workspaceSnapshotDigest({ ...snapshot, root: "D:/other" }));
    expect(workspaceSnapshotDigest(snapshot)).not.toBe(workspaceSnapshotDigest({
      ...snapshot,
      files: { "a.txt": { hash: "changed", mode: 0o644 } }
    }));
  });

  it("compares content hashes, additions, and deletions", async () => {
    const root = await temporaryDirectory("workspace-guard-fs-");
    await mkdir(path.join(root, "src"));
    await writeFile(path.join(root, "src", "modify.ts"), "before\n");
    await writeFile(path.join(root, "delete.ts"), "delete\n");
    const before = await createWorkspaceSnapshot(root);

    await writeFile(path.join(root, "src", "modify.ts"), "after\n");
    await rm(path.join(root, "delete.ts"));
    await writeFile(path.join(root, "added.ts"), "added\n");
    const after = await createWorkspaceSnapshot(root);
    const delta = compareWorkspaceSnapshots(before, after);

    expect(delta.added).toEqual(["added.ts"]);
    expect(delta.deleted).toEqual(["delete.ts"]);
    expect(delta.modified).toEqual(["src/modify.ts"]);
  });

  it("detects mode and symlink target changes from snapshot metadata", () => {
    const before = {
      root: "same-root",
      kind: "filesystem" as const,
      files: {
        "mode.ts": { hash: "same", mode: 0o644 },
        "link.ts": { hash: "old-target-hash", mode: 0o777, symlinkTarget: "old.ts" }
      },
      fileCount: 2,
      totalBytes: 0
    };
    const after = {
      ...before,
      files: {
        "mode.ts": { hash: "same", mode: 0o755 },
        "link.ts": { hash: "new-target-hash", mode: 0o777, symlinkTarget: "new.ts" }
      }
    };
    expect(compareWorkspaceSnapshots(before, after).modified).toEqual(["link.ts", "mode.ts"]);
  });

  it("tracks Git tracked and nonignored untracked files only", async () => {
    const root = await temporaryDirectory("workspace-guard-git-");
    execFileSync("git", ["init"], { cwd: root, stdio: "pipe" });
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
    await writeFile(path.join(root, "tracked.txt"), "tracked\n");
    execFileSync("git", ["add", ".gitignore", "tracked.txt"], { cwd: root, stdio: "pipe" });
    await writeFile(path.join(root, "untracked.txt"), "untracked\n");
    await writeFile(path.join(root, "ignored.txt"), "ignored\n");

    const snapshot = await createWorkspaceSnapshot(root);
    expect(snapshot.kind).toBe("git");
    expect(Object.keys(snapshot.files)).toEqual([".gitignore", "tracked.txt", "untracked.txt"]);
  });

  it("excludes only explicitly supplied roots and enforces bounds", async () => {
    const root = await temporaryDirectory("workspace-guard-bounds-");
    await mkdir(path.join(root, "excluded"));
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "excluded", "artifact.json"), "large artifact");
    await writeFile(path.join(root, "node_modules", "kept.js"), "dependency");
    await writeFile(path.join(root, "kept.txt"), "kept");

    const snapshot = await createWorkspaceSnapshot(root, { excludedRoots: ["excluded/"] });
    expect(Object.keys(snapshot.files)).toEqual(["kept.txt", "node_modules/kept.js"]);
    expect(await readFile(path.join(root, "excluded", "artifact.json"), "utf8")).toBe("large artifact");
    await expect(createWorkspaceSnapshot(root, { excludedRoots: ["excluded"], maxFiles: 1 })).rejects.toThrow("more than 1 files");
    await expect(createWorkspaceSnapshot(root, { excludedRoots: ["excluded"], maxBytes: 2 })).rejects.toThrow("exceeds maxBytes");
  });
});
