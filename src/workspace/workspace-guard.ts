import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createReadStream } from "node:fs";
import { lstat, opendir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { AgentName, PlannerOutput, WorkflowRoute } from "../types.js";
import { normalizeRepositoryPath } from "./path-validation.js";
import { ROLE_MUTATION_KINDS, type MutationKind } from "../agents/role-capabilities.js";

const execFileAsync = promisify(execFile);
const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const GIT_OUTPUT_LIMIT = 16 * 1024 * 1024;

export interface WorkspaceSnapshotOptions {
  readonly excludedRoots?: readonly string[];
  /** Exact repository-relative paths that must be monitored even when Git ignores them. */
  readonly requiredPaths?: readonly string[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface WorkspaceFileSnapshot {
  readonly hash: string;
  readonly mode: number;
  readonly symlinkTarget?: string;
}

export interface WorkspaceSnapshot {
  readonly root: string;
  readonly kind: "git" | "filesystem";
  readonly files: Readonly<Record<string, WorkspaceFileSnapshot>>;
  readonly fileCount: number;
  readonly totalBytes: number;
}

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new WorkspaceGuardError("cannot hash a cyclic value");
    seen.add(value);
    const result = `[${value.map(item => canonicalJson(item, seen)).join(",")}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === "object") {
    if (seen.has(value)) throw new WorkspaceGuardError("cannot hash a cyclic value");
    seen.add(value);
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object).sort().map(key => {
      if (object[key] === undefined) throw new WorkspaceGuardError("cannot hash undefined values");
      return `${JSON.stringify(key)}:${canonicalJson(object[key], seen)}`;
    });
    seen.delete(value);
    return `{${entries.join(",")}}`;
  }
  throw new WorkspaceGuardError(`cannot hash ${typeof value} values`);
}

/** Hash a JSON-compatible value independently of object insertion order. */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

/** Stable content identity; the machine-specific absolute root is intentionally excluded. */
export function workspaceSnapshotDigest(snapshot: WorkspaceSnapshot): string {
  return canonicalSha256({
    kind: snapshot.kind,
    files: Object.keys(snapshot.files).sort().map(file => ({ file, ...snapshot.files[file] }))
  });
}

export interface WorkspaceDelta {
  readonly added: readonly string[];
  readonly modified: readonly string[];
  readonly deleted: readonly string[];
  readonly changedFiles: readonly string[];
}

export interface MutationPathScope {
  readonly planFiles: readonly string[];
  readonly testFiles: readonly string[];
  readonly documentationFiles: readonly string[];
  readonly testSupportFiles: readonly string[];
}

export class WorkspaceGuardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceGuardError";
  }
}

function normalizedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths.map(file => normalizeRepositoryPath(file)))].sort();
}

function normalizedExcludedRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map(root => normalizeRepositoryPath(root, true)))].sort();
}

export function isTestPath(file: string): boolean {
  const normalized = normalizeRepositoryPath(file).toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  return segments.slice(0, -1).some(segment => ["test", "tests", "__test__", "__tests__", "spec", "specs"].includes(segment))
    || /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)/.test(basename);
}

export function isDocumentationPath(file: string): boolean {
  const normalized = normalizeRepositoryPath(file).toLowerCase();
  const segments = normalized.split("/");
  const basename = segments.at(-1) ?? "";
  const stem = basename.replace(/\.[^.]+$/, "");
  return segments.slice(0, -1).some(segment => ["doc", "docs", "documentation"].includes(segment))
    || [".md", ".mdx", ".rst", ".adoc", ".asciidoc"].some(extension => basename.endsWith(extension))
    || /^(?:readme|changelog|changes|contributing|code_of_conduct|security|license|notice)(?:[._-].*)?$/.test(stem);
}

/** Derive exact file sets from plan task declarations; no directory or glob expansion occurs. */
export function deriveMutationPathScope(plan: PlannerOutput): MutationPathScope {
  if (!["implementation", "bug_fix", "quick_implementation", "tests_only", "documentation_only"].includes(plan.route)) {
    throw new WorkspaceGuardError(`Workflow route ${JSON.stringify(plan.route)} does not authorize mutations`);
  }
  const testSupportFiles = normalizedUnique(plan.tasks.flatMap(task => task.testSupportFiles ?? []));
  const planFiles = normalizedUnique(plan.tasks.flatMap(task => [...task.files, ...(task.testSupportFiles ?? [])]));
  const testSupportSet = new Set(testSupportFiles);
  if (plan.route === "tests_only" && planFiles.some(file => !isTestPath(file) && !testSupportSet.has(file))) {
    throw new WorkspaceGuardError("tests_only plans may contain only test-classified files");
  }
  if (plan.route === "documentation_only" && planFiles.some(file => !isDocumentationPath(file))) {
    throw new WorkspaceGuardError("documentation_only plans may contain only documentation-classified files");
  }
  return Object.freeze({
    planFiles: Object.freeze(planFiles),
    testFiles: Object.freeze(planFiles.filter(file => isTestPath(file) || testSupportSet.has(file))),
    documentationFiles: Object.freeze(planFiles.filter(isDocumentationPath)),
    testSupportFiles: Object.freeze(testSupportFiles)
  });
}

export function mutationPathsForKind(scope: MutationPathScope, kind: MutationKind): readonly string[] {
  switch (kind) {
    case "none": return [];
    case "tests": return scope.testFiles;
    case "plan_files": return scope.planFiles;
    case "documentation": return scope.documentationFiles;
  }
}

export function deriveRoleMutationPaths(role: AgentName, plan: PlannerOutput): readonly string[] {
  if (!routeAuthorizesRole(plan.route, role)) {
    throw new WorkspaceGuardError(`Workflow route ${JSON.stringify(plan.route)} does not authorize ${role} mutations`);
  }
  return mutationPathsForKind(deriveMutationPathScope(plan), ROLE_MUTATION_KINDS[role]);
}

function routeAuthorizesRole(route: WorkflowRoute, role: AgentName): boolean {
  if (ROLE_MUTATION_KINDS[role] === "none") return true;
  if (route === "tests_only") return role === "tester";
  if (route === "documentation_only") return role === "documenter";
  if (route === "implementation" || route === "bug_fix" || route === "quick_implementation") {
    return role === "tester" || role === "builder" || role === "documenter";
  }
  return false;
}

function positiveBound(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new WorkspaceGuardError(`${name} must be a positive safe integer`);
  return value;
}

function isExcluded(file: string, excludedRoots: readonly string[]): boolean {
  return excludedRoots.some(root => file === root || file.startsWith(`${root}/`));
}

async function gitFileList(root: string): Promise<string[] | undefined> {
  try {
    const probe = await execFileAsync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true
    });
    if (probe.stdout.trim() !== "true") return undefined;
    const result = await execFileAsync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: GIT_OUTPUT_LIMIT,
      windowsHide: true
    });
    // Git reports an untracked nested worktree as a directory entry ending in `/`.
    // Workspace snapshots hash files only; excluded directory trees are handled later.
    return result.stdout.split("\0").filter(file => file && !/[\\/]$/.test(file)).map(file => normalizeRepositoryPath(file));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || (error instanceof Error && /not a git repository/i.test(error.message))) return undefined;
    throw new WorkspaceGuardError(`could not enumerate Git workspace: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function filesystemFileList(root: string, excludedRoots: readonly string[], maxFiles: number): Promise<string[]> {
  const files: string[] = [];
  const directories = [""];
  while (directories.length > 0) {
    const relativeDirectory = directories.pop()!;
    const directory = await opendir(path.join(root, ...relativeDirectory.split("/").filter(Boolean)));
    for await (const entry of directory) {
      const relative = normalizeRepositoryPath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      if (isExcluded(relative, excludedRoots)) continue;
      if (entry.isDirectory()) directories.push(relative);
      else {
        files.push(relative);
        if (files.length > maxFiles) throw new WorkspaceGuardError(`workspace contains more than ${maxFiles} files`);
      }
    }
  }
  return files;
}

async function hashFile(file: string, remainingBytes: number): Promise<{ hash: string; bytes: number }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = chunk as Buffer;
    bytes += buffer.length;
    if (bytes > remainingBytes) throw new WorkspaceGuardError("workspace content exceeds maxBytes");
    hash.update(buffer);
  }
  return { hash: hash.digest("hex"), bytes };
}

export async function createWorkspaceSnapshot(
  workspaceRoot: string,
  options: WorkspaceSnapshotOptions = {}
): Promise<WorkspaceSnapshot> {
  const root = await realpath(workspaceRoot);
  const maxFiles = positiveBound(options.maxFiles, DEFAULT_MAX_FILES, "maxFiles");
  const maxBytes = positiveBound(options.maxBytes, DEFAULT_MAX_BYTES, "maxBytes");
  const excludedRoots = normalizedExcludedRoots(options.excludedRoots ?? []);
  const requiredPaths = normalizedUnique(options.requiredPaths ?? []);
  const gitFiles = await gitFileList(root);
  const candidates = gitFiles
    ? [...gitFiles, ...requiredPaths]
    : await filesystemFileList(root, excludedRoots, maxFiles);
  const files = normalizedUnique(candidates).filter(file => !isExcluded(file, excludedRoots));
  if (files.length > maxFiles) throw new WorkspaceGuardError(`workspace contains more than ${maxFiles} files`);

  const snapshots: Record<string, WorkspaceFileSnapshot> = {};
  let totalBytes = 0;
  for (const relative of files) {
    const absolute = path.join(root, ...relative.split("/"));
    let stats;
    try {
      stats = await lstat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    const mode = stats.mode & 0o7777;
    if (stats.isSymbolicLink()) {
      const symlinkTarget = await readlink(absolute);
      const bytes = Buffer.byteLength(symlinkTarget);
      if (totalBytes + bytes > maxBytes) throw new WorkspaceGuardError("workspace content exceeds maxBytes");
      totalBytes += bytes;
      snapshots[relative] = Object.freeze({
        hash: createHash("sha256").update(symlinkTarget).digest("hex"),
        mode,
        symlinkTarget
      });
    } else if (stats.isFile()) {
      const result = await hashFile(absolute, maxBytes - totalBytes);
      totalBytes += result.bytes;
      snapshots[relative] = Object.freeze({ hash: result.hash, mode });
    } else {
      snapshots[relative] = Object.freeze({ hash: createHash("sha256").update("").digest("hex"), mode });
    }
  }

  return Object.freeze({
    root,
    kind: gitFiles ? "git" : "filesystem",
    files: Object.freeze(snapshots),
    fileCount: Object.keys(snapshots).length,
    totalBytes
  });
}

function sameFile(left: WorkspaceFileSnapshot, right: WorkspaceFileSnapshot): boolean {
  return left.hash === right.hash && left.mode === right.mode && left.symlinkTarget === right.symlinkTarget;
}

export function compareWorkspaceSnapshots(before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDelta {
  if (before.root !== after.root) throw new WorkspaceGuardError("cannot compare snapshots from different workspace roots");
  const beforePaths = new Set(Object.keys(before.files));
  const afterPaths = new Set(Object.keys(after.files));
  const added = [...afterPaths].filter(file => !beforePaths.has(file)).sort();
  const deleted = [...beforePaths].filter(file => !afterPaths.has(file)).sort();
  const modified = [...beforePaths]
    .filter(file => afterPaths.has(file) && !sameFile(before.files[file], after.files[file]))
    .sort();
  return Object.freeze({
    added: Object.freeze(added),
    modified: Object.freeze(modified),
    deleted: Object.freeze(deleted),
    changedFiles: Object.freeze([...added, ...modified, ...deleted].sort())
  });
}

function deltaFileSet(delta: WorkspaceDelta): string[] {
  return normalizedUnique([...delta.added, ...delta.modified, ...delta.deleted]);
}

export function validateRoleDelta(role: AgentName, plan: PlannerOutput, delta: WorkspaceDelta): void {
  const allowed = new Set(deriveRoleMutationPaths(role, plan));
  const disallowed = deltaFileSet(delta).filter(file => !allowed.has(file));
  if (disallowed.length > 0) {
    throw new WorkspaceGuardError(`${role} changed files outside its ${ROLE_MUTATION_KINDS[role]} scope: ${disallowed.join(", ")}`);
  }
}

/** Require a mutation agent's report to equal the actual delta, not merely contain it. */
export function validateReportedFileSet(
  reportedFiles: readonly string[],
  actualFiles: readonly string[] | WorkspaceDelta
): void {
  const reported = normalizedUnique(reportedFiles);
  if (reported.length !== reportedFiles.length) throw new WorkspaceGuardError("reported changed files must not contain duplicates");
  const actual = Array.isArray(actualFiles)
    ? normalizedUnique(actualFiles)
    : deltaFileSet(actualFiles as WorkspaceDelta);
  const reportedSet = new Set(reported);
  const actualSet = new Set(actual);
  const unreported = actual.filter(file => !reportedSet.has(file));
  const notActuallyChanged = reported.filter(file => !actualSet.has(file));
  if (unreported.length > 0 || notActuallyChanged.length > 0) {
    const details = [
      unreported.length > 0 ? `unreported: ${unreported.join(", ")}` : "",
      notActuallyChanged.length > 0 ? `not actually changed: ${notActuallyChanged.join(", ")}` : ""
    ].filter(Boolean).join("; ");
    throw new WorkspaceGuardError(`reported changed files do not match workspace delta (${details})`);
  }
}
