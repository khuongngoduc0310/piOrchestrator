import { randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AgentName, Stage, WorkflowState } from "../types.js";
import { readSafeArtifact } from "./checkpoint-store.js";

const EVENTS_FILE = "events.jsonl";
const LEASE_FILE = "run-lease.json";
const MAX_EVENTS_BYTES = 32 * 1024 * 1024;

export interface RunLease {
  readonly token: string;
  release(): Promise<boolean>;
}

export interface AcquireLeaseOptions {
  recoverStale?: boolean;
}

export class RunStore {
  readonly runDir: string;
  private tail: Promise<void> = Promise.resolve();
  private firstError?: unknown;
  private eventSequence = 0;

  constructor(readonly cwd: string, readonly runId: string) {
    assertBasename(runId, "runId");
    this.runDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "runs", runId);
  }

  static async open(cwd: string, runId: string): Promise<RunStore> {
    const store = new RunStore(cwd, runId);
    const stats = await lstat(store.runDir);
    if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Run directory is not a regular directory: ${store.runDir}`);
    await store.restoreEventSequence();
    return store;
  }

  static openExisting(cwd: string, runId: string): Promise<RunStore> {
    return RunStore.open(cwd, runId);
  }

  async init(): Promise<void> {
    await mkdir(this.runDir, { recursive: true });
  }

  saveState(state: WorkflowState): Promise<void> {
    const json = serializeJson(state);
    return this.enqueue(async () => {
      await this.atomicReplace("state.json", json);
      await this.atomicReplace("manifest.json", json);
    });
  }

  saveJson(name: string, value: unknown): Promise<string> {
    this.assertArtifactName(name);
    const json = serializeJson(value);
    return this.enqueue(async () => this.atomicReplace(name, json)).then(() => name);
  }

  saveRaw(name: string, value: string): Promise<string> {
    this.assertArtifactName(name);
    return this.enqueue(async () => this.atomicReplace(name, value.endsWith("\n") ? value : `${value}\n`)).then(() => name);
  }

  saveBuffer(name: string, value: Buffer): Promise<string> {
    this.assertArtifactName(name);
    return this.enqueue(async () => this.atomicReplace(name, value)).then(() => name);
  }

  event(type: string, payload: unknown): Promise<void> {
    const sequence = ++this.eventSequence;
    const line = JSON.stringify({
      id: `event-${String(sequence).padStart(6, "0")}`,
      sequence,
      at: new Date().toISOString(),
      type,
      payload
    }) + "\n";
    return this.enqueue(async () => {
      await this.init();
      await appendFile(path.join(this.runDir, EVENTS_FILE), line, "utf8");
    });
  }

  async acquireLease(options: AcquireLeaseOptions = {}): Promise<RunLease> {
    await this.init();
    const token = randomUUID();
    const lease = { token, pid: process.pid, hostname: os.hostname(), createdAt: new Date().toISOString() };
    try {
      await writeFile(path.join(this.runDir, LEASE_FILE), serializeJson(lease), { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST" && options.recoverStale) {
        const existing = JSON.parse(await readSafeArtifact(this.runDir, LEASE_FILE, 16 * 1024)) as { pid?: unknown; hostname?: unknown };
        if (existing.hostname === os.hostname() && Number.isSafeInteger(existing.pid) && !processExists(existing.pid as number)) {
          const stale = path.join(this.runDir, `.run-lease.stale.${randomUUID()}.json`);
          await rename(path.join(this.runDir, LEASE_FILE), stale);
          await writeFile(path.join(this.runDir, LEASE_FILE), serializeJson(lease), { encoding: "utf8", flag: "wx" });
          await rm(stale, { force: true });
        } else {
          throw new Error(`Run ${this.runId} is already leased`);
        }
      } else if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run ${this.runId} is already leased`);
      else throw error;
    }
    let released = false;
    return Object.freeze({
      token,
      release: async (): Promise<boolean> => {
        if (released) return false;
        let current: unknown;
        try {
          current = JSON.parse(await readSafeArtifact(this.runDir, LEASE_FILE, 16 * 1024)) as unknown;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        }
        if (typeof current !== "object" || current === null || (current as { token?: unknown }).token !== token) return false;
        await rm(path.join(this.runDir, LEASE_FILE));
        released = true;
        return true;
      }
    });
  }

  artifactName(options: {
    sequence: number;
    stage: Stage;
    agent?: AgentName;
    attempt?: number;
    revision?: number;
    kind?: string;
    extension?: "json" | "txt" | "patch";
  }): string {
    const parts = [
      String(options.sequence).padStart(3, "0"),
      options.stage,
      options.agent,
      options.attempt === undefined ? undefined : `attempt-${options.attempt}`,
      options.revision === undefined ? undefined : `revision-${options.revision}`,
      options.kind
    ].filter((part): part is string => Boolean(part));
    return `${parts.map(sanitize).join("-")}.${options.extension ?? "json"}`;
  }

  async flush(): Promise<void> {
    await this.tail;
    if (this.firstError) throw this.firstError;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.tail.then(operation);
    this.tail = next.then(() => undefined, error => {
      this.firstError ??= error;
    });
    return next;
  }

  private async atomicReplace(name: string, content: string | Buffer): Promise<void> {
    await this.init();
    const target = path.join(this.runDir, name);
    const temporary = path.join(this.runDir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content);
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private assertArtifactName(name: string): void {
    assertBasename(name, "artifact name");
  }

  private async restoreEventSequence(): Promise<void> {
    let text: string;
    try {
      text = await readSafeArtifact(this.runDir, EVENTS_FILE, MAX_EVENTS_BYTES);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let prior = 0;
    for (const [index, line] of text.split("\n").entries()) {
      if (!line.trim()) continue;
      let value: unknown;
      try {
        value = JSON.parse(line) as unknown;
      } catch {
        throw new Error(`Invalid event JSON at line ${index + 1}`);
      }
      const sequence = typeof value === "object" && value !== null ? (value as { sequence?: unknown }).sequence : undefined;
      if (!Number.isSafeInteger(sequence) || (sequence as number) <= prior) {
        throw new Error(`Invalid event sequence at line ${index + 1}`);
      }
      prior = sequence as number;
    }
    this.eventSequence = prior;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function assertBasename(value: string, label: string): void {
  if (!value || path.basename(value) !== value || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}
