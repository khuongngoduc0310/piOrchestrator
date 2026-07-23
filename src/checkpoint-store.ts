import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CheckpointPointer, CheckpointWrite, WorkflowCheckpoint } from "./checkpoint-types.js";
import { CHECKPOINT_SCHEMA_VERSION } from "./checkpoint-types.js";
import { validateCheckpointPointer, validateWorkflowCheckpoint } from "./checkpoint-validation.js";

export const LATEST_CHECKPOINT_FILE = "checkpoint-latest.json";
export const MAX_CHECKPOINT_BYTES = 16 * 1024 * 1024;

export class CheckpointStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CheckpointStoreError";
  }
}

export function sha256Hex(value: string | NodeJS.ArrayBufferView): string {
  return createHash("sha256").update(value).digest("hex");
}

export function checkpointFileName(checkpointNumber: number): string {
  if (!Number.isSafeInteger(checkpointNumber) || checkpointNumber < 1 || checkpointNumber > 999_999) {
    throw new CheckpointStoreError("checkpoint number must be between 1 and 999999");
  }
  return `checkpoint-${String(checkpointNumber).padStart(6, "0")}.json`;
}

export class CheckpointStore {
  private tail: Promise<void> = Promise.resolve();

  constructor(readonly runDir: string, readonly runId: string, readonly maxBytes = MAX_CHECKPOINT_BYTES) {
    if (!runId) throw new CheckpointStoreError("runId must not be empty");
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new CheckpointStoreError("maxBytes must be a positive safe integer");
  }

  async save(value: CheckpointWrite): Promise<WorkflowCheckpoint> {
    const operation = this.tail.then(() => this.saveNow(value));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveNow(value: CheckpointWrite): Promise<WorkflowCheckpoint> {
    if (value.runId !== this.runId) throw new CheckpointStoreError("checkpoint runId does not match store runId");
    const previous = await this.loadPointer();
    let checkpointNumber = (previous?.checkpointNumber ?? 0) + 1;
    let checkpoint: WorkflowCheckpoint;
    let fileName: string;
    let json: string;
    for (;;) {
      checkpoint = validateWorkflowCheckpoint({
        ...value,
        schemaVersion: CHECKPOINT_SCHEMA_VERSION,
        checkpointNumber
      });
      fileName = checkpointFileName(checkpointNumber);
      json = serializeBounded(checkpoint, this.maxBytes);
      try {
        await writeFile(path.join(this.runDir, fileName), json, { encoding: "utf8", flag: "wx" });
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        checkpointNumber++;
      }
    }
    const digest = sha256Hex(json);
    const pointer: CheckpointPointer = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runId: this.runId,
      checkpointNumber,
      fileName,
      digest
    };
    await atomicReplace(this.runDir, LATEST_CHECKPOINT_FILE, serializeBounded(pointer, 16 * 1024));
    return checkpoint;
  }

  saveCheckpoint(value: CheckpointWrite): Promise<WorkflowCheckpoint> {
    return this.save(value);
  }

  async loadLatest(): Promise<WorkflowCheckpoint | undefined> {
    const pointer = await this.loadPointer();
    if (!pointer) return undefined;
    if (pointer.runId !== this.runId) throw new CheckpointStoreError("checkpoint pointer runId does not match store runId");
    const text = await readSafeArtifact(this.runDir, pointer.fileName, this.maxBytes);
    if (sha256Hex(text) !== pointer.digest) throw new CheckpointStoreError("checkpoint digest does not match pointer");
    const checkpoint = validateWorkflowCheckpoint(parseJson(text, pointer.fileName));
    if (checkpoint.runId !== this.runId || checkpoint.checkpointNumber !== pointer.checkpointNumber) {
      throw new CheckpointStoreError("checkpoint does not match latest pointer");
    }
    return checkpoint;
  }

  loadLatestCheckpoint(): Promise<WorkflowCheckpoint | undefined> {
    return this.loadLatest();
  }

  private async loadPointer(): Promise<CheckpointPointer | undefined> {
    let text: string;
    try {
      text = await readSafeArtifact(this.runDir, LATEST_CHECKPOINT_FILE, 16 * 1024);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    return validateCheckpointPointer(parseJson(text, LATEST_CHECKPOINT_FILE));
  }
}

export async function readSafeArtifact(directory: string, name: string, maxBytes: number): Promise<string> {
  assertBasename(name);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new CheckpointStoreError("maxBytes must be a positive safe integer");
  const file = path.join(directory, name);
  const before = await lstat(file);
  if (before.isSymbolicLink() || !before.isFile()) throw new CheckpointStoreError(`${name} must be a regular non-symlink file`);
  if (before.size > maxBytes) throw new CheckpointStoreError(`${name} exceeds ${maxBytes} bytes`);
  const handle = await open(file, constants.O_RDONLY);
  try {
    const current = await handle.stat();
    if (!current.isFile() || current.dev !== before.dev || current.ino !== before.ino) {
      throw new CheckpointStoreError(`${name} changed while opening`);
    }
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new CheckpointStoreError(`${name} exceeds ${maxBytes} bytes`);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function assertBasename(name: string): void {
  if (!name || path.basename(name) !== name || name === "." || name === "..") {
    throw new CheckpointStoreError(`invalid artifact basename: ${name}`);
  }
}

function parseJson(text: string, name: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CheckpointStoreError(`${name} contains invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function serializeBounded(value: unknown, maxBytes: number): string {
  const text = JSON.stringify(value, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new CheckpointStoreError(`serialized JSON exceeds ${maxBytes} bytes`);
  return text;
}

async function atomicReplace(directory: string, name: string, content: string): Promise<void> {
  assertBasename(name);
  const temporary = path.join(directory, `.${name}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
    await rename(temporary, path.join(directory, name));
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
