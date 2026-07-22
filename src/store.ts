import { randomUUID } from "node:crypto";
import { appendFile, mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { AgentName, Stage, WorkflowState } from "./types.js";

export class RunStore {
  readonly runDir: string;
  private tail: Promise<void> = Promise.resolve();
  private firstError?: unknown;
  private eventSequence = 0;

  constructor(cwd: string, runId: string) {
    this.runDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "runs", runId);
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
      await appendFile(path.join(this.runDir, "events.jsonl"), line, "utf8");
    });
  }

  artifactName(options: {
    sequence: number;
    stage: Stage;
    agent?: AgentName;
    attempt?: number;
    revision?: number;
    kind?: string;
    extension?: "json" | "txt";
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

  private async atomicReplace(name: string, content: string): Promise<void> {
    await this.init();
    const target = path.join(this.runDir, name);
    const temporary = path.join(this.runDir, `.${name}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, content, "utf8");
      await rename(temporary, target);
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private assertArtifactName(name: string): void {
    if (!name || path.basename(name) !== name || name === "." || name === "..") {
      throw new Error(`Invalid artifact name: ${name}`);
    }
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function sanitize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "step";
}
