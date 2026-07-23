import { randomUUID } from "node:crypto";
import { copyFile, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { GitError, gitText, runGit } from "./git.js";
import { normalizeRepositoryPath } from "./path-validation.js";

export interface GitTreeSnapshot {
  repositoryRoot: string;
  projectRelativePath: string;
  tree: string;
}

export interface InvocationFileChange {
  status: string;
  oldPath?: string;
  newPath?: string;
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  binary: boolean;
}

export interface InvocationFileDiff {
  schemaVersion: 1;
  status: "available" | "unavailable";
  unavailableReason?: string;
  beforeTree?: string;
  afterTree?: string;
  changedFiles: string[];
  files: InvocationFileChange[];
  patchArtifact?: string;
  patchBytes: number;
  patchDigest?: string;
}

export interface GitTreeDiffResult {
  metadata: InvocationFileDiff;
  patch?: Buffer;
}

export type GitTreeCaptureResult =
  | { available: true; snapshot: GitTreeSnapshot }
  | { available: false; reason: string };

interface GitProjectContext {
  repositoryRoot: string;
  projectRelativePath: string;
}

const projectContextCache = new Map<string, Promise<GitProjectContext | { reason: string }>>();

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
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

async function withTemporaryIndex<T>(repositoryRoot: string, action: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const sourceIndex = (await gitText(repositoryRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  const temporaryIndex = `${sourceIndex}.pi-orchestrator-diff-${process.pid}-${randomUUID()}`;
  try {
    try {
      await copyFile(sourceIndex, temporaryIndex);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await runGit(repositoryRoot, ["read-tree", "--empty"], { env: { GIT_INDEX_FILE: temporaryIndex } });
    }
    return await action({ GIT_INDEX_FILE: temporaryIndex });
  } finally {
    await Promise.all([
      rm(temporaryIndex, { force: true }),
      rm(`${temporaryIndex}.lock`, { force: true })
    ]);
  }
}

function repositoryPath(projectRelativePath: string, relative: string): string {
  return [projectRelativePath, relative].filter(Boolean).join("/").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** Capture the current project filesystem as a Git tree without changing the real index. */
export async function captureGitTree(cwd: string, excludedRoots: readonly string[] = []): Promise<GitTreeCaptureResult> {
  const context = await gitProjectContext(cwd);
  if ("reason" in context) return { available: false, reason: context.reason };
  const { repositoryRoot, projectRelativePath } = context;
  try {
    const tree = await withTemporaryIndex(repositoryRoot, async env => {
      const projectPath = projectRelativePath || ".";
      const exclusions = excludedRoots.map(root => repositoryPath(projectRelativePath, root)).filter(Boolean);
      const pathspecs = [projectPath, ...exclusions.map(root => `:(exclude,top,literal)${root}`)];
      await runGit(repositoryRoot, ["add", "-A", "--", ...pathspecs], { env });
      return (await gitText(repositoryRoot, ["write-tree"], { env })).trim();
    });
    return { available: true, snapshot: { repositoryRoot, projectRelativePath, tree } };
  } catch (error) {
    return { available: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

async function gitProjectContext(cwd: string): Promise<GitProjectContext | { reason: string }> {
  const key = path.resolve(cwd);
  let pending = projectContextCache.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const projectRoot = await realpath(cwd);
        const repositoryRoot = await realpath((await gitText(projectRoot, ["rev-parse", "--show-toplevel"])).trim());
        const relative = path.relative(repositoryRoot, projectRoot);
        if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
          return { reason: "Project is outside its Git repository root" };
        }
        return {
          repositoryRoot,
          projectRelativePath: relative === "." ? "" : relative.split(path.sep).join("/")
        };
      } catch (error) {
        return { reason: error instanceof GitError ? "Workspace is not a Git repository" : error instanceof Error ? error.message : String(error) };
      }
    })();
    projectContextCache.set(key, pending);
  }
  return pending;
}

function projectPath(repositoryPathValue: string, projectPrefix: string): string | undefined {
  const normalized = repositoryPathValue.replace(/\\/g, "/");
  if (!projectPrefix) return normalized;
  if (normalized === projectPrefix) return "";
  return normalized.startsWith(`${projectPrefix}/`) ? normalized.slice(projectPrefix.length + 1) : undefined;
}

function parseRawDiff(output: Buffer, projectPrefix: string): InvocationFileChange[] {
  const tokens = splitNul(output);
  const files: InvocationFileChange[] = [];
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++];
    if (!header) continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])(\d*)$/.exec(header);
    if (!match) throw new Error("Malformed raw Git diff header");
    const first = tokens[index++];
    if (first === undefined) throw new Error("Malformed raw Git diff path");
    const renamed = match[5] === "R" || match[5] === "C";
    const second = renamed ? tokens[index++] : undefined;
    if (renamed && second === undefined) throw new Error("Malformed raw Git rename");
    const oldPath = match[5] === "A" ? undefined : projectPath(first, projectPrefix);
    const newPath = match[5] === "D" ? undefined : projectPath(second ?? first, projectPrefix);
    if (oldPath === undefined && newPath === undefined) continue;
    files.push({
      status: `${match[5]}${match[6]}`,
      ...(oldPath !== undefined ? { oldPath } : {}),
      ...(newPath !== undefined ? { newPath } : {}),
      oldMode: match[1],
      newMode: match[2],
      oldBlob: match[3],
      newBlob: match[4],
      binary: false
    });
  }
  return files;
}

function parseBinaryPaths(output: Buffer, projectPrefix: string): Set<string> {
  const tokens = splitNul(output);
  const binaries = new Set<string>();
  for (let index = 0; index < tokens.length;) {
    const record = tokens[index++];
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error("Malformed Git numstat output");
    const binary = record.slice(0, firstTab) === "-" && record.slice(firstTab + 1, secondTab) === "-";
    const inlinePath = record.slice(secondTab + 1);
    const finalPath = inlinePath || tokens[index + 1];
    if (!inlinePath) index += 2;
    const normalized = finalPath === undefined ? undefined : projectPath(finalPath, projectPrefix);
    if (binary && normalized !== undefined) binaries.add(normalized);
  }
  return binaries;
}

/** Compare two project Git trees and produce structured metadata plus a binary-capable patch. */
export async function compareGitTrees(before: GitTreeCaptureResult, after: GitTreeCaptureResult): Promise<GitTreeDiffResult> {
  if (!before.available) {
    return {
      metadata: {
        schemaVersion: 1,
        status: "unavailable",
        unavailableReason: before.reason,
        changedFiles: [],
        files: [],
        patchBytes: 0
      }
    };
  }
  if (!after.available) {
    return {
      metadata: {
        schemaVersion: 1,
        status: "unavailable",
        unavailableReason: after.reason,
        changedFiles: [],
        files: [],
        patchBytes: 0
      }
    };
  }
  if (before.snapshot.repositoryRoot !== after.snapshot.repositoryRoot || before.snapshot.projectRelativePath !== after.snapshot.projectRelativePath) {
    throw new Error("Cannot compare Git trees from different projects");
  }
  const args = [before.snapshot.tree, after.snapshot.tree];
  const [raw, numstat, patch] = await Promise.all([
    runGit(before.snapshot.repositoryRoot, ["diff", "--raw", "-z", "--abbrev=64", "--find-renames", ...args]),
    runGit(before.snapshot.repositoryRoot, ["diff", "--numstat", "-z", "--find-renames", ...args]),
    runGit(before.snapshot.repositoryRoot, ["diff", "--binary", "--full-index", "--find-renames", ...args])
  ]);
  const files = parseRawDiff(raw.stdout, before.snapshot.projectRelativePath);
  const binaries = parseBinaryPaths(numstat.stdout, before.snapshot.projectRelativePath);
  for (const file of files) file.binary = binaries.has(file.newPath ?? file.oldPath ?? "");
  const changedFiles = [...new Set(files.flatMap(file => [file.oldPath, file.newPath].filter((value): value is string => Boolean(value))))].sort();
  return {
    metadata: {
      schemaVersion: 1,
      status: "available",
      beforeTree: before.snapshot.tree,
      afterTree: after.snapshot.tree,
      changedFiles,
      files,
      patchBytes: patch.stdout.length
    },
    patch: patch.stdout
  };
}

/** Validate persisted invocation diff metadata before exposing it to the dashboard. */
export function validateInvocationFileDiff(value: unknown): InvocationFileDiff {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invocation diff must be an object");
  const item = value as Record<string, unknown>;
  if (item.schemaVersion !== 1 || (item.status !== "available" && item.status !== "unavailable")) throw new Error("Invocation diff envelope is invalid");
  if (!Array.isArray(item.changedFiles) || !Array.isArray(item.files)) throw new Error("Invocation diff file lists are invalid");
  const changedFiles = item.changedFiles.map((file, index) => persistedPath(file, `changedFiles[${index}]`));
  const files = item.files.map((entry, index): InvocationFileChange => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) throw new Error(`files[${index}] must be an object`);
    const file = entry as Record<string, unknown>;
    const status = requiredString(file.status, `files[${index}].status`);
    if (!/^[A-Z][0-9]{0,3}$/.test(status)) throw new Error(`files[${index}].status is invalid`);
    const binary = file.binary;
    if (typeof binary !== "boolean") throw new Error(`files[${index}].binary must be boolean`);
    return {
      status,
      ...(file.oldPath === undefined ? {} : { oldPath: persistedPath(file.oldPath, `files[${index}].oldPath`) }),
      ...(file.newPath === undefined ? {} : { newPath: persistedPath(file.newPath, `files[${index}].newPath`) }),
      oldMode: mode(file.oldMode, `files[${index}].oldMode`),
      newMode: mode(file.newMode, `files[${index}].newMode`),
      oldBlob: objectId(file.oldBlob, `files[${index}].oldBlob`),
      newBlob: objectId(file.newBlob, `files[${index}].newBlob`),
      binary
    };
  });
  const patchBytes = item.patchBytes;
  if (!Number.isSafeInteger(patchBytes) || (patchBytes as number) < 0) throw new Error("patchBytes must be a non-negative safe integer");
  const result: InvocationFileDiff = {
    schemaVersion: 1,
    status: item.status,
    ...(item.unavailableReason === undefined ? {} : { unavailableReason: requiredString(item.unavailableReason, "unavailableReason") }),
    ...(item.beforeTree === undefined ? {} : { beforeTree: objectId(item.beforeTree, "beforeTree") }),
    ...(item.afterTree === undefined ? {} : { afterTree: objectId(item.afterTree, "afterTree") }),
    changedFiles,
    files,
    ...(item.patchArtifact === undefined ? {} : { patchArtifact: artifactName(item.patchArtifact) }),
    patchBytes: patchBytes as number,
    ...(item.patchDigest === undefined ? {} : { patchDigest: digest(item.patchDigest) })
  };
  if (result.status === "available" && (!result.beforeTree || !result.afterTree)) throw new Error("Available invocation diff is missing tree IDs");
  if (result.status === "unavailable" && !result.unavailableReason) throw new Error("Unavailable invocation diff is missing its reason");
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function persistedPath(value: unknown, label: string): string {
  try {
    return normalizeRepositoryPath(requiredString(value, label));
  } catch (error) {
    throw new Error(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function mode(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^\d{6}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function objectId(value: unknown, label: string): string {
  const result = requiredString(value, label);
  if (!/^[0-9a-f]{40,64}$/.test(result)) throw new Error(`${label} is invalid`);
  return result;
}

function digest(value: unknown): string {
  const result = requiredString(value, "patchDigest");
  if (!/^[0-9a-f]{64}$/.test(result)) throw new Error("patchDigest is invalid");
  return result;
}

function artifactName(value: unknown): string {
  const result = requiredString(value, "patchArtifact");
  if (path.basename(result) !== result || result === "." || result === "..") throw new Error("patchArtifact is invalid");
  return result;
}
