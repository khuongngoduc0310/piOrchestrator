import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectWorktreeChanges, createWorktree, removeWorktree, syncWorktreeChanges, type WorktreeHandle } from "./worktree.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf8" });
}

async function initGitRepo(): Promise<string> {
  const repository = await mkdtemp(path.join(os.tmpdir(), "pi-worktree-"));
  directories.push(repository);
  git(repository, "init");
  git(repository, "config", "user.email", "test@test.com");
  git(repository, "config", "user.name", "Test");
  await writeFile(path.join(repository, ".gitignore"), "ignored.txt\n");
  await writeFile(path.join(repository, "README.md"), "# initial\n");
  await writeFile(path.join(repository, "delete.txt"), "delete me\n");
  await writeFile(path.join(repository, "rename.txt"), "rename me\n");
  git(repository, "add", "-A");
  git(repository, "commit", "-m", "init");
  return repository;
}

async function create(repository: string, runId: string): Promise<WorktreeHandle> {
  const handle = await createWorktree(repository, runId);
  return handle;
}

describe("worktree", () => {
  it("creates an exact detached snapshot from a nested project without changing the source index", async () => {
    const repository = await initGitRepo();
    const project = path.join(repository, "packages", "app");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "app.txt"), "untracked app\n");
    await writeFile(path.join(repository, "README.md"), "# dirty source\n");
    await writeFile(path.join(repository, "staged.txt"), "staged\n");
    await writeFile(path.join(repository, "ignored.txt"), "ignored\n");
    git(repository, "add", "staged.txt");
    const indexPath = git(repository, "rev-parse", "--git-path", "index").trim();
    const indexBefore = await readFile(path.resolve(repository, indexPath));

    const handle = await createWorktree(project, "nested-run");

    expect(handle.repositoryRoot).toBe(await realpath(repository));
    expect(handle.sourceCwd).toBe(await realpath(project));
    expect(handle.projectRelativePath).toBe(path.join("packages", "app"));
    expect(handle.effectiveCwd).toBe(path.join(handle.worktreeRoot, "packages", "app"));
    expect(git(handle.worktreeRoot, "rev-parse", "HEAD").trim()).toBe(handle.baselineCommit);
    expect(git(handle.worktreeRoot, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("HEAD");
    expect((await readFile(path.join(handle.worktreeRoot, "README.md"), "utf8")).replace(/\r\n/g, "\n")).toBe("# dirty source\n");
    expect((await readFile(path.join(handle.effectiveCwd, "app.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("untracked app\n");
    await expect(readFile(path.join(handle.worktreeRoot, "ignored.txt"))).rejects.toThrow();
    expect(await readFile(path.resolve(repository, indexPath))).toEqual(indexBefore);
  });

  it.each(["../escape", "with/slash", "", ".", "CON", "ends."])("rejects unsafe run ID %j", async runId => {
    const repository = await initGitRepo();
    await expect(createWorktree(repository, runId)).rejects.toThrow("Invalid worktree run ID");
  });

  it("rejects a non-repository directory", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "pi-no-repo-"));
    directories.push(directory);
    await expect(createWorktree(directory, "failure")).rejects.toThrow("Not a git repository");
  });

  it("collects additions, modifications, deletions, renames, and binary patches", async () => {
    const repository = await initGitRepo();
    const handle = await create(repository, "collect-run");
    await writeFile(path.join(handle.worktreeRoot, "README.md"), "# changed\n");
    await writeFile(path.join(handle.worktreeRoot, "new file.txt"), "new\n");
    await writeFile(path.join(handle.worktreeRoot, "binary.bin"), Buffer.from([0, 1, 2, 0, 255]));
    await rm(path.join(handle.worktreeRoot, "delete.txt"));
    git(handle.worktreeRoot, "mv", "rename.txt", "renamed.txt");

    const changes = await collectWorktreeChanges(handle);

    expect(changes.additions).toEqual(expect.arrayContaining(["new file.txt", "binary.bin"]));
    expect(changes.modifications).toContain("README.md");
    expect(changes.deletions).toContain("delete.txt");
    expect(changes.renames).toContainEqual({ from: "rename.txt", to: "renamed.txt" });
    expect(changes.binaries).toContain("binary.bin");
    expect(changes.patch.includes(Buffer.from("GIT binary patch"))).toBe(true);
  });

  it("syncs a binary-capable patch while preserving the source index", async () => {
    const repository = await initGitRepo();
    await writeFile(path.join(repository, "source-staged.txt"), "source staged\n");
    git(repository, "add", "source-staged.txt");
    const indexPath = path.resolve(repository, git(repository, "rev-parse", "--git-path", "index").trim());
    const handle = await create(repository, "sync-run");
    const indexBefore = await readFile(indexPath);

    await writeFile(path.join(handle.worktreeRoot, "README.md"), "# synced\n");
    await writeFile(path.join(handle.worktreeRoot, "binary.bin"), Buffer.from([0, 10, 0, 20, 255]));
    await rm(path.join(handle.worktreeRoot, "delete.txt"));
    git(handle.worktreeRoot, "mv", "rename.txt", "renamed.txt");

    const result = await syncWorktreeChanges(handle);

    expect(result.changedFiles).toEqual(expect.arrayContaining(["README.md", "binary.bin", "delete.txt", "rename.txt", "renamed.txt"]));
    expect((await readFile(path.join(repository, "README.md"), "utf8")).replace(/\r\n/g, "\n")).toBe("# synced\n");
    expect(await readFile(path.join(repository, "binary.bin"))).toEqual(Buffer.from([0, 10, 0, 20, 255]));
    await expect(readFile(path.join(repository, "delete.txt"))).rejects.toThrow();
    expect((await readFile(path.join(repository, "renamed.txt"), "utf8")).replace(/\r\n/g, "\n")).toBe("rename me\n");
    expect(await readFile(indexPath)).toEqual(indexBefore);
  });

  it("refuses to overwrite a touched source path that drifted after creation", async () => {
    const repository = await initGitRepo();
    const handle = await create(repository, "conflict-run");
    await writeFile(path.join(handle.worktreeRoot, "README.md"), "# worktree\n");
    await writeFile(path.join(repository, "README.md"), "# concurrent source edit\n");

    await expect(syncWorktreeChanges(handle)).rejects.toThrow("source paths changed after creation");
    expect(await readFile(path.join(repository, "README.md"), "utf8")).toBe("# concurrent source edit\n");
  });

  it("returns no changes for an untouched worktree", async () => {
    const repository = await initGitRepo();
    const handle = await create(repository, "no-change-run");
    const changes = await syncWorktreeChanges(handle);
    expect(changes.changedFiles).toEqual([]);
    expect(changes.patch.length).toBe(0);
  });

  it("force-removes a dirty worktree and prunes its registration", async () => {
    const repository = await initGitRepo();
    const handle = await create(repository, "remove-run");
    await writeFile(path.join(handle.worktreeRoot, "README.md"), "dirty\n");

    await removeWorktree(handle);

    await expect(readFile(path.join(handle.worktreeRoot, "README.md"))).rejects.toThrow();
    expect(git(repository, "worktree", "list", "--porcelain")).not.toContain(handle.worktreeRoot);
    await expect(removeWorktree(handle)).resolves.toBeUndefined();
  });
});
