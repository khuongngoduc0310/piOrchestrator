import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  MEMORY_SCHEMA_VERSION,
  MAX_MEMORY_BYTES,
  type MemoryDocument,
  type MemoryLesson,
  type PromotionResult,
} from "./memory-types.js";
import {
  validateMemoryDocument,
} from "./memory-validation.js";

const STALE_LOCK_MS = 30_000;
const LOCK_RETRY_MS = 200;
const MAX_LOCK_RETRIES = 15;

export class MemoryStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryStoreError";
  }
}

function projectKey(cwd: string): string {
  const resolved = path.resolve(cwd);
  const normalized = resolved.replace(/\\/g, "/").toLowerCase();
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
}

function storeDir(): string {
  return path.join(getAgentDir(), "orchestrator", "memory");
}

export function getMemoryStorePath(cwd: string): string {
  return path.join(storeDir(), `${projectKey(cwd)}.json`);
}

function lockPath(cwd: string): string {
  return path.join(storeDir(), `${projectKey(cwd)}.lock`);
}

function lockOwnerPath(cwd: string): string {
  return path.join(lockPath(cwd), "owner.json");
}

interface LockOwner {
  token: string;
  pid: number;
  hostname: string;
  createdAt: string;
}

function lockOwner(): LockOwner {
  return {
    token: randomUUID(),
    pid: process.pid,
    hostname: hostname(),
    createdAt: new Date().toISOString(),
  };
}

async function acquireLock(cwd: string): Promise<LockOwner> {
  const lock = lockPath(cwd);
  await mkdir(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < MAX_LOCK_RETRIES; attempt++) {
    const owner = lockOwner();
    try {
      await mkdir(lock);
      try {
        await writeFile(lockOwnerPath(cwd), JSON.stringify(owner), { flag: "wx" });
      } catch (error) {
        await rm(lock, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return owner;
    } catch (error: unknown) {
      if (!isFsError(error) || error.code !== "EEXIST") throw error;
      try {
        const age = Date.now() - (await stat(lock)).mtimeMs;
        if (age > STALE_LOCK_MS) {
          await rm(lock, { recursive: true, force: true }).catch(() => undefined);
          continue;
        }
      } catch (lockError) {
        if (!isFsError(lockError) || lockError.code !== "ENOENT") throw lockError;
      }
      if (attempt < MAX_LOCK_RETRIES - 1) {
        await new Promise(r => setTimeout(r, LOCK_RETRY_MS));
      }
    }
  }
  throw new MemoryStoreError("Could not acquire file lock after 3s");
}

async function releaseLock(cwd: string, owner: LockOwner): Promise<void> {
  try {
    const current = JSON.parse(await readFile(lockOwnerPath(cwd), "utf8")) as Partial<LockOwner>;
    if (current.token !== owner.token) return;
    await rm(lockPath(cwd), { recursive: true, force: true });
  } catch {
  }
}

function isFsError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadMemory(cwd: string): Promise<{ document: MemoryDocument | null; error?: string }> {
  const file = getMemoryStorePath(cwd);
  try {
    const text = await readFile(file, "utf8");
    if (Buffer.byteLength(text, "utf8") > MAX_MEMORY_BYTES) {
      return { document: null, error: `Memory file exceeds ${MAX_MEMORY_BYTES} bytes; cannot load` };
    }
    const parsed = JSON.parse(text);
    const validated = validateMemoryDocument(parsed);
    const expectedProjectPath = path.resolve(cwd);
    if (!sameProjectPath(validated.projectPath, expectedProjectPath)) {
      return {
        document: null,
        error: `Memory projectPath mismatch: expected ${expectedProjectPath}, got ${validated.projectPath}`,
      };
    }
    return { document: validated };
  } catch (error) {
    if (isFsError(error) && error.code === "ENOENT") {
      return { document: null, error: undefined };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { document: null, error: `Memory file is invalid: ${message}` };
  }
}

export async function promoteLessons(
  cwd: string,
  lessons: MemoryLesson[],
  expectedRevision: number
): Promise<PromotionResult> {
  if (lessons.length === 0) return { promoted: [], duplicates: [], failed: [], revision: expectedRevision };
  const owner = await acquireLock(cwd);
  try {
    const { document: existing, error: loadError } = await loadMemory(cwd);
    if (loadError) {
      return { promoted: [], duplicates: [], failed: [], revision: 0, error: loadError };
    }
    const doc = existing ?? {
      schemaVersion: MEMORY_SCHEMA_VERSION,
      revision: 0,
      updatedAt: new Date().toISOString(),
      projectPath: path.resolve(cwd),
      lessons: [],
    };
    if (doc.revision !== expectedRevision) {
      return { promoted: [], duplicates: [], failed: [], revision: doc.revision, error: `Revision mismatch: expected ${expectedRevision}, got ${doc.revision}`, retryable: true };
    }
    const working: MemoryDocument = structuredClone(doc);
    const existingDigests = new Set(working.lessons.map(l => l.contentDigest));
    const promoted: string[] = [];
    const duplicates: string[] = [];
    const failed: Array<{ candidateId: string; error: string }> = [];
    for (const lesson of lessons) {
      if (existingDigests.has(lesson.contentDigest)) {
        duplicates.push(lesson.id);
        continue;
      }
      try {
        const candidate = validateMemoryDocument({ ...working, lessons: [...working.lessons, lesson] });
        const finalShape = { ...candidate, revision: working.revision + 1, updatedAt: new Date().toISOString() };
        serializeMemory(finalShape);
      } catch (error) {
        failed.push({ candidateId: lesson.provenance.candidateId, error: error instanceof Error ? error.message : String(error) });
        continue;
      }
      working.lessons.push(lesson);
      existingDigests.add(lesson.contentDigest);
      promoted.push(lesson.id);
    }
    if (promoted.length === 0) {
      return { promoted, duplicates, failed, revision: working.revision };
    }
    working.revision++;
    working.updatedAt = new Date().toISOString();
    await writeMemory(cwd, working);
    return { promoted, duplicates, failed, revision: working.revision };
  } finally {
    await releaseLock(cwd, owner);
  }
}

export async function removeLesson(cwd: string, lessonId: string, expectedRevision: number): Promise<{ removed: boolean; revision: number; error?: string }> {
  const owner = await acquireLock(cwd);
  try {
    const { document: existing, error } = await loadMemory(cwd);
    if (!existing || error) {
      return { removed: false, revision: 0, error: error ?? "No memory document found" };
    }
    if (existing.revision !== expectedRevision) {
      return { removed: false, revision: existing.revision, error: `Revision mismatch: expected ${expectedRevision}, got ${existing.revision}` };
    }
    const index = existing.lessons.findIndex(l => l.id === lessonId);
    if (index === -1) {
      return { removed: false, revision: expectedRevision, error: `Lesson not found: ${lessonId}` };
    }
    existing.lessons.splice(index, 1);
    existing.revision++;
    existing.updatedAt = new Date().toISOString();
    await writeMemory(cwd, existing);
    return { removed: true, revision: existing.revision };
  } finally {
    await releaseLock(cwd, owner);
  }
}

function serializeMemory(document: MemoryDocument): string {
  const json = JSON.stringify(document, null, 2) + "\n";
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > MAX_MEMORY_BYTES) {
    throw new MemoryStoreError(`Serialized memory would exceed ${MAX_MEMORY_BYTES} bytes`);
  }
  return json;
}

async function writeMemory(cwd: string, document: MemoryDocument): Promise<void> {
  const validated = validateMemoryDocument(document);
  const expectedProjectPath = path.resolve(cwd);
  if (!sameProjectPath(validated.projectPath, expectedProjectPath)) {
    throw new MemoryStoreError(`Memory projectPath mismatch: expected ${expectedProjectPath}, got ${validated.projectPath}`);
  }
  const json = serializeMemory(validated);
  const dir = storeDir();
  await mkdir(dir, { recursive: true });
  const temporary = path.join(dir, `.${projectKey(cwd)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, json, "utf8");
    await rename(temporary, getMemoryStorePath(cwd));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function getMemoryRevision(cwd: string): Promise<number> {
  const { document } = await loadMemory(cwd);
  return document?.revision ?? 0;
}

function sameProjectPath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = path.resolve(value).replace(/\\/g, "/");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
