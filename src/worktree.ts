import { randomUUID } from "node:crypto";
import { access, copyFile, lstat, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { GitError, gitText, runGit } from "./git.js";

const RUN_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9_-])?$/;
const WINDOWS_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

export interface WorktreeHandle {
  repositoryRoot: string;
  sourceCwd: string;
  projectRelativePath: string;
  worktreeRoot: string;
  effectiveCwd: string;
  baselineCommit: string;
}

export interface AttachWorktreeOptions {
  expectedWorkspaceSnapshotDigest?: string;
  workspaceSnapshotDigest?: (effectiveCwd: string) => string | Promise<string>;
}

export interface WorktreeRename {
  from: string;
  to: string;
}

export interface WorktreeChanges {
  additions: string[];
  modifications: string[];
  deletions: string[];
  renames: WorktreeRename[];
  binaries: string[];
  changedFiles: string[];
  patch: Buffer;
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validateRunId(runId: string): void {
  if (!RUN_ID.test(runId) || WINDOWS_DEVICE_NAME.test(runId)) {
    throw new Error(`Invalid worktree run ID: ${JSON.stringify(runId)}`);
  }
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === "win32"
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function persistedString(value: unknown, name: keyof WorktreeHandle): string {
  if (typeof value !== "string" || (name !== "projectRelativePath" && value.length === 0)) {
    throw new Error(`Cannot attach worktree: invalid ${name}`);
  }
  return value;
}

async function persistedRealpath(value: unknown, name: keyof WorktreeHandle): Promise<string> {
  const filePath = persistedString(value, name);
  if (!path.isAbsolute(filePath)) throw new Error(`Cannot attach worktree: ${name} must be absolute`);
  try {
    return await realpath(filePath);
  } catch {
    throw new Error(`Cannot attach worktree: ${name} does not exist: ${filePath}`);
  }
}

function splitNul(buffer: Buffer): string[] {
  const values: string[] = [];
  let start = 0;
  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0) continue;
    values.push(buffer.subarray(start, index).toString("utf8"));
    start = index + 1;
  }
  if (start < buffer.length) values.push(buffer.subarray(start).toString("utf8"));
  return values;
}

async function withTemporaryIndex<T>(cwd: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const sourceIndex = (await gitText(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const temporaryIndex = `${sourceIndex}.pi-orchestrator-${process.pid}-${randomUUID()}`;
  try {
    try {
      await copyFile(sourceIndex, temporaryIndex);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    return await action({ GIT_INDEX_FILE: temporaryIndex });
  } finally {
    await Promise.all([
      rm(temporaryIndex, { force: true }),
      rm(`${temporaryIndex}.lock`, { force: true }),
    ]);
  }
}

async function headCommit(cwd: string): Promise<string | undefined> {
  try {
    return (await gitText(cwd, ["rev-parse", "--verify", "HEAD"])).trim();
  } catch (error) {
    if (error instanceof GitError) return undefined;
    throw error;
  }
}

async function snapshotCommit(cwd: string, parent: string | undefined, message: string): Promise<string> {
  return withTemporaryIndex(cwd, async env => {
    // Seed from the real index so tracked ignored files remain tracked, then capture
    // the working filesystem without ever writing the real index.
    try {
      await access(env.GIT_INDEX_FILE!);
    } catch {
      await runGit(cwd, ["read-tree", "--empty"], { env });
    }
    await runGit(cwd, ["add", "-A"], { env });
    await runGit(cwd, [
      "rm", "-r", "--cached", "--ignore-unmatch", "--",
       `${CONFIG_DIR_NAME}/orchestrator/runs`, `${CONFIG_DIR_NAME}/orchestrator/worktrees`
    ], { env });
    const tree = (await gitText(cwd, ["write-tree"], { env })).trim();
    const args = ["commit-tree", tree];
    if (parent) args.push("-p", parent);
    args.push("-m", message);
    const identity: NodeJS.ProcessEnv = {
      GIT_AUTHOR_NAME: "pi-orchestrator",
      GIT_AUTHOR_EMAIL: "pi-orchestrator@localhost",
      GIT_COMMITTER_NAME: "pi-orchestrator",
      GIT_COMMITTER_EMAIL: "pi-orchestrator@localhost",
    };
    return (await gitText(cwd, args, { env: identity })).trim();
  });
}

async function assertPathAbsent(filePath: string): Promise<void> {
  try {
    await lstat(filePath);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  throw new Error(`Worktree already exists: ${filePath}`);
}

/** Create a detached worktree from the exact tracked/nonignored source filesystem. */
export async function createWorktree(cwd: string, runId: string): Promise<WorktreeHandle> {
  validateRunId(runId);

  let sourceCwd: string;
  try {
    sourceCwd = await realpath(cwd);
  } catch {
    throw new Error(`Not a git repository: ${cwd}`);
  }

  let repositoryRoot: string;
  try {
    repositoryRoot = await realpath((await gitText(sourceCwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch (error) {
    if (error instanceof GitError) throw new Error(`Not a git repository: ${cwd}`);
    throw error;
  }

  const projectRelativePath = path.relative(repositoryRoot, sourceCwd);
  if (projectRelativePath === ".." || projectRelativePath.startsWith(`..${path.sep}`) || path.isAbsolute(projectRelativePath)) {
    throw new Error(`Project directory is outside repository root: ${sourceCwd}`);
  }

  const baselineCommit = await snapshotCommit(repositoryRoot, await headCommit(repositoryRoot), `pi-orchestrator baseline ${runId}`);
  const worktreesDirectory = path.join(repositoryRoot, CONFIG_DIR_NAME, "orchestrator", "worktrees");
  const requestedRoot = path.join(worktreesDirectory, runId);
  await assertPathAbsent(requestedRoot);

  try {
    await runGit(repositoryRoot, ["worktree", "add", "--detach", requestedRoot, baselineCommit], { timeoutMs: 60_000 });
    const worktreeRoot = await realpath(requestedRoot);
    const effectiveCwd = path.join(worktreeRoot, projectRelativePath);
    await access(effectiveCwd);
    return { repositoryRoot, sourceCwd, projectRelativePath, worktreeRoot, effectiveCwd, baselineCommit };
  } catch (error) {
    const errors: unknown[] = [error];
    try {
      await rm(requestedRoot, { recursive: true, force: true });
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    try {
      await runGit(repositoryRoot, ["worktree", "prune", "--expire", "now"]);
    } catch (cleanupError) {
      errors.push(cleanupError);
    }
    if (errors.length > 1) throw new AggregateError(errors, `Failed to create and clean up worktree ${requestedRoot}`);
    throw error;
  }
}

/** Validate and canonicalize a persisted detached-worktree handle before reuse. */
export async function attachWorktree(
  persisted: Readonly<WorktreeHandle>,
  options: AttachWorktreeOptions = {}
): Promise<WorktreeHandle> {
  if (!persisted || typeof persisted !== "object") throw new Error("Cannot attach worktree: invalid handle");

  const repositoryRoot = await persistedRealpath(persisted.repositoryRoot, "repositoryRoot");
  const sourceCwd = await persistedRealpath(persisted.sourceCwd, "sourceCwd");
  const worktreeRoot = await persistedRealpath(persisted.worktreeRoot, "worktreeRoot");
  const effectiveCwd = await persistedRealpath(persisted.effectiveCwd, "effectiveCwd");

  let discoveredRepositoryRoot: string;
  try {
    discoveredRepositoryRoot = await realpath((await gitText(repositoryRoot, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error(`Cannot attach worktree: repositoryRoot is not a Git repository: ${repositoryRoot}`);
  }
  if (!samePath(repositoryRoot, discoveredRepositoryRoot)) {
    throw new Error(`Cannot attach worktree: repositoryRoot does not match Git repository root: ${repositoryRoot}`);
  }

  let sourceRepositoryRoot: string;
  try {
    sourceRepositoryRoot = await realpath((await gitText(sourceCwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error(`Cannot attach worktree: sourceCwd is not in the persisted repository: ${sourceCwd}`);
  }
  if (!samePath(repositoryRoot, sourceRepositoryRoot)) {
    throw new Error(`Cannot attach worktree: sourceCwd is not in the persisted repository: ${sourceCwd}`);
  }

  const projectRelativePath = path.relative(repositoryRoot, sourceCwd);
  const persistedProjectRelativePath = persistedString(persisted.projectRelativePath, "projectRelativePath");
  const normalizedPersistedRelativePath = persistedProjectRelativePath === "" || persistedProjectRelativePath === "."
    ? ""
    : path.normalize(persistedProjectRelativePath);
  if (
    normalizedPersistedRelativePath === ".."
    || normalizedPersistedRelativePath.startsWith(`..${path.sep}`)
    || path.isAbsolute(normalizedPersistedRelativePath)
    || !samePath(normalizedPersistedRelativePath, projectRelativePath)
  ) {
    throw new Error("Cannot attach worktree: projectRelativePath does not match sourceCwd");
  }

  let discoveredWorktreeRoot: string;
  try {
    discoveredWorktreeRoot = await realpath((await gitText(worktreeRoot, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    throw new Error(`Cannot attach worktree: worktreeRoot is not a Git worktree: ${worktreeRoot}`);
  }
  if (!samePath(worktreeRoot, discoveredWorktreeRoot)) {
    throw new Error(`Cannot attach worktree: worktreeRoot does not match Git worktree root: ${worktreeRoot}`);
  }

  const expectedEffectiveCwd = await realpath(path.join(worktreeRoot, projectRelativePath));
  if (!samePath(effectiveCwd, expectedEffectiveCwd)) {
    throw new Error("Cannot attach worktree: effectiveCwd does not match worktreeRoot and projectRelativePath");
  }

  const baselineValue = persistedString(persisted.baselineCommit, "baselineCommit");
  if (!/^[0-9a-fA-F]{40,64}$/.test(baselineValue)) {
    throw new Error("Cannot attach worktree: invalid baselineCommit");
  }
  let baselineCommit: string;
  try {
    baselineCommit = (await gitText(repositoryRoot, ["rev-parse", "--verify", "--end-of-options", `${baselineValue}^{commit}`])).trim();
  } catch {
    throw new Error(`Cannot attach worktree: baselineCommit does not exist: ${baselineValue}`);
  }

  const records = splitNul(Buffer.from(await gitText(repositoryRoot, ["worktree", "list", "--porcelain", "-z"])));
  let registration: { path: string; head?: string; detached: boolean } | undefined;
  let current: typeof registration;
  for (const record of records) {
    if (record.startsWith("worktree ")) {
      current = { path: record.slice("worktree ".length), detached: false };
      if (samePath(path.resolve(current.path), worktreeRoot)) registration = current;
    } else if (current && record.startsWith("HEAD ")) {
      current.head = record.slice("HEAD ".length);
    } else if (current && record === "detached") {
      current.detached = true;
    }
  }
  if (!registration) throw new Error(`Cannot attach worktree: worktree is not registered: ${worktreeRoot}`);

  const head = (await gitText(worktreeRoot, ["rev-parse", "--verify", "HEAD"])).trim();
  const headName = (await gitText(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  if (headName !== "HEAD" || !registration.detached) {
    throw new Error(`Cannot attach worktree: worktree HEAD is not detached: ${worktreeRoot}`);
  }
  if (head !== baselineCommit || registration.head !== baselineCommit) {
    throw new Error(`Cannot attach worktree: worktree HEAD does not match baselineCommit: ${baselineCommit}`);
  }

  const handle = { repositoryRoot, sourceCwd, projectRelativePath, worktreeRoot, effectiveCwd, baselineCommit };
  if (options.expectedWorkspaceSnapshotDigest !== undefined) {
    if (!options.workspaceSnapshotDigest) {
      throw new Error("Cannot attach worktree: workspaceSnapshotDigest callback is required for the expected digest");
    }
    const actualDigest = await options.workspaceSnapshotDigest(effectiveCwd);
    if (actualDigest !== options.expectedWorkspaceSnapshotDigest) {
      throw new Error("Cannot attach worktree: workspace snapshot digest does not match");
    }
  }
  return handle;
}

function parseNameStatus(output: Buffer): Omit<WorktreeChanges, "binaries" | "changedFiles" | "patch"> {
  const tokens = splitNul(output);
  const additions: string[] = [];
  const modifications: string[] = [];
  const deletions: string[] = [];
  const renames: WorktreeRename[] = [];

  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    if (!status) continue;
    const code = status[0];
    const first = tokens[index++];
    if (first === undefined) throw new Error("Malformed NUL-delimited git diff output");
    if (code === "R") {
      const to = tokens[index++];
      if (to === undefined) throw new Error("Malformed rename in git diff output");
      renames.push({ from: first, to });
    } else if (code === "A") {
      additions.push(first);
    } else if (code === "D") {
      deletions.push(first);
    } else {
      modifications.push(first);
    }
  }
  return { additions, modifications, deletions, renames };
}

function parseBinaryPaths(output: Buffer): string[] {
  const tokens = splitNul(output);
  const binaries: string[] = [];
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("Malformed NUL-delimited git numstat output");
    const isBinary = record.slice(0, firstTab) === "-" && record.slice(firstTab + 1, secondTab) === "-";
    const inlinePath = record.slice(secondTab + 1);
    if (inlinePath) {
      if (isBinary) binaries.push(inlinePath);
      continue;
    }
    const from = tokens[index++];
    const to = tokens[index++];
    if (from === undefined || to === undefined) throw new Error("Malformed rename in git numstat output");
    if (isBinary) binaries.push(to);
  }
  return binaries;
}

/** Collect the final worktree filesystem delta relative to its synthetic baseline. */
export async function collectWorktreeChanges(handle: WorktreeHandle): Promise<WorktreeChanges> {
  const finalCommit = await snapshotCommit(handle.worktreeRoot, handle.baselineCommit, "pi-orchestrator final snapshot");
  const diffArgs = [handle.baselineCommit, finalCommit];
  const [status, numstat, patch] = await Promise.all([
    runGit(handle.worktreeRoot, ["diff", "--name-status", "-z", "--find-renames", ...diffArgs]),
    runGit(handle.worktreeRoot, ["diff", "--numstat", "-z", "--find-renames", ...diffArgs]),
    runGit(handle.worktreeRoot, ["diff", "--binary", "--full-index", "--find-renames", ...diffArgs]),
  ]);
  const changes = parseNameStatus(status.stdout);
  const binaries = parseBinaryPaths(numstat.stdout);
  const changedFiles = [
    ...changes.additions,
    ...changes.modifications,
    ...changes.deletions,
    ...changes.renames.flatMap(rename => [rename.from, rename.to]),
  ];
  return { ...changes, binaries, changedFiles: [...new Set(changedFiles)], patch: patch.stdout };
}

async function assertSourceHasNotDrifted(handle: WorktreeHandle, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  await withTemporaryIndex(handle.repositoryRoot, async env => {
    await runGit(handle.repositoryRoot, ["read-tree", handle.baselineCommit], { env });
    await runGit(handle.repositoryRoot, [
      "add",
      "-A",
      "--",
      ".",
       `:(exclude,top,literal)${CONFIG_DIR_NAME}/orchestrator/runs`,
       `:(exclude,top,literal)${CONFIG_DIR_NAME}/orchestrator/worktrees`,
    ], { env });
    const drift = splitNul((await runGit(handle.repositoryRoot, [
      "diff",
      "--cached",
      "--name-only",
      "-z",
      handle.baselineCommit,
    ], { env })).stdout);
    const touched = new Set(paths);
    const conflicts = drift.filter(file => touched.has(file));
    if (conflicts.length > 0) {
      throw new Error(`Cannot sync worktree because source paths changed after creation: ${conflicts.join(", ")}`);
    }
  });
}

/** Apply worktree changes only when all touched source paths still match the baseline. */
export async function syncWorktreeChanges(handle: WorktreeHandle): Promise<WorktreeChanges> {
  const changes = await collectWorktreeChanges(handle);
  if (changes.changedFiles.length === 0) return changes;

  await assertSourceHasNotDrifted(handle, changes.changedFiles);
  await runGit(handle.repositoryRoot, ["apply", "--check", "--binary"], { input: changes.patch });
  await runGit(handle.repositoryRoot, ["apply", "--binary"], { input: changes.patch });
  return changes;
}

/** Force-remove a worktree, prune its registration, and surface incomplete cleanup. */
export async function removeWorktree(handle: WorktreeHandle): Promise<void> {
  let removalError: unknown;
  try {
    await runGit(handle.repositoryRoot, ["worktree", "unlock", handle.worktreeRoot]);
  } catch {
    // Unlocked and already-removed worktrees both reach this path normally.
  }
  try {
    await runGit(handle.repositoryRoot, ["worktree", "remove", "--force", handle.worktreeRoot], { timeoutMs: 60_000 });
  } catch (error) {
    removalError = error;
    try {
      await rm(handle.worktreeRoot, { recursive: true, force: true });
    } catch (filesystemError) {
      throw new AggregateError([error, filesystemError], `Failed to remove worktree ${handle.worktreeRoot}`);
    }
  }

  try {
    await runGit(handle.repositoryRoot, ["worktree", "prune", "--expire", "now"]);
    const listing = await gitText(handle.repositoryRoot, ["worktree", "list", "--porcelain", "-z"]);
    const registered = splitNul(Buffer.from(listing)).some(record => {
      if (!record.startsWith("worktree ")) return false;
      return path.resolve(record.slice("worktree ".length)) === path.resolve(handle.worktreeRoot);
    });
    if (registered) throw new Error(`Worktree remains registered: ${handle.worktreeRoot}`);
  } catch (pruneError) {
    throw new AggregateError(removalError ? [removalError, pruneError] : [pruneError], `Failed to prune worktree ${handle.worktreeRoot}`);
  }
}
