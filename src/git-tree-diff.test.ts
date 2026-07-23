import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { captureGitTree, compareGitTrees, validateInvocationFileDiff } from "./git-tree-diff.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
}

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-invocation-diff-"));
  directories.push(root);
  git(root, "init");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  await writeFile(path.join(root, "modify.txt"), "before\n");
  await writeFile(path.join(root, "delete.txt"), "delete\n");
  await writeFile(path.join(root, "rename.txt"), "rename\n");
  git(root, "add", "-A");
  git(root, "commit", "-m", "initial");
  return root;
}

describe("Git invocation tree diffs", () => {
  it("captures additions, modifications, deletions, renames, and binary files without changing the index", async () => {
    const root = await repository();
    const indexBefore = git(root, "diff", "--cached");
    const before = await captureGitTree(root);
    await writeFile(path.join(root, "modify.txt"), "after\n");
    await rm(path.join(root, "delete.txt"));
    await rename(path.join(root, "rename.txt"), path.join(root, "renamed.txt"));
    await writeFile(path.join(root, "added.txt"), "added\n");
    await writeFile(path.join(root, "binary.bin"), Buffer.from([0, 1, 2, 3, 255]));
    const after = await captureGitTree(root);
    const diff = await compareGitTrees(before, after);

    expect(diff.metadata.status).toBe("available");
    expect(diff.metadata.changedFiles).toEqual(expect.arrayContaining([
      "added.txt", "binary.bin", "delete.txt", "modify.txt", "rename.txt", "renamed.txt"
    ]));
    expect(diff.metadata.files.some(file => file.status.startsWith("R") && file.oldPath === "rename.txt" && file.newPath === "renamed.txt")).toBe(true);
    expect(diff.metadata.files.find(file => file.newPath === "binary.bin")?.binary).toBe(true);
    expect(() => validateInvocationFileDiff(diff.metadata)).not.toThrow();
    expect(diff.patch?.toString("utf8")).toContain("diff --git");
    expect(git(root, "diff", "--cached")).toBe(indexBefore);
  }, 15_000);

  it("scopes nested projects and excludes run artifacts", async () => {
    const root = await repository();
    const project = path.join(root, "packages", "app");
    await mkdir(path.join(project, ".pi", "orchestrator", "runs", "run-1"), { recursive: true });
    await writeFile(path.join(project, "app.ts"), "one\n");
    const before = await captureGitTree(project, [".pi/orchestrator/runs/run-1"]);
    await writeFile(path.join(project, "app.ts"), "two\n");
    await writeFile(path.join(project, ".pi", "orchestrator", "runs", "run-1", "state.json"), "changed");
    await writeFile(path.join(root, "outside.txt"), "outside\n");
    const after = await captureGitTree(project, [".pi/orchestrator/runs/run-1"]);
    const diff = await compareGitTrees(before, after);

    expect(diff.metadata.changedFiles).toEqual(["app.ts"]);
    expect(diff.patch?.toString("utf8")).toContain("packages/app/app.ts");
    expect(diff.patch?.toString("utf8")).not.toContain("state.json");
    expect(diff.patch?.toString("utf8")).not.toContain("outside.txt");
  }, 15_000);

  it("reports an unavailable diff outside Git", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "pi-no-git-"));
    directories.push(root);
    const capture = await captureGitTree(root);
    const diff = await compareGitTrees(capture, capture);
    expect(diff.metadata).toMatchObject({ status: "unavailable", changedFiles: [], patchBytes: 0 });
  });

  it("rejects malformed persisted diff metadata", () => {
    expect(() => validateInvocationFileDiff({ schemaVersion: 1, status: "available", changedFiles: ["../escape"], files: [], patchBytes: 0 })).toThrow();
    expect(() => validateInvocationFileDiff({ schemaVersion: 1, status: "unavailable", unavailableReason: "not git", changedFiles: [], files: [], patchBytes: 0 })).not.toThrow();
  });
});
