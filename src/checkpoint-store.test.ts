import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CheckpointStore, LATEST_CHECKPOINT_FILE, readSafeArtifact } from "./checkpoint-store.js";
import type { WorkflowState } from "./types.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<{ directory: string; state: WorkflowState }> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-checkpoint-"));
  directories.push(directory);
  return {
    directory,
    state: {
      schemaVersion: 1,
      extensionVersion: "0.1.0",
      runId: "run-1",
      request: "continue",
      route: "implementation",
      cwd: directory,
      runDir: directory,
      stage: "planning",
      status: "running",
      attempt: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      agents: Object.fromEntries(["explorer", "planner", "reviewer", "tester", "builder", "debugger", "documenter"]
        .map(name => [name, { status: "idle", model: "test" }])) as WorkflowState["agents"],
      steps: []
    }
  };
}

describe("CheckpointStore", () => {
  it("writes immutable numbered checkpoints and advances an atomic pointer", async () => {
    const { directory, state } = await fixture();
    const store = new CheckpointStore(directory, state.runId);
    const base = {
      runId: state.runId,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceDigest: "b".repeat(64),
      state,
      workspaceRoot: directory,
      config: config(),
      configDigest: "c".repeat(64),
      memoryMode: "disabled" as const,
      memoryRevision: 0,
      memoryDigest: "d".repeat(64),
      selectedMemoryIds: [],
      validatedChangedFiles: [],
      baselineRepaired: false,
      baselineContext: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] },
      baselineReviewContext: { summary: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] }, artifacts: { baselineJson: "baseline.json" } },
      lessonStatus: "skipped" as const,
      cursor: { kind: "plan_approved" as const, continuation: { next: "review" } },
      bindings: {}
    };
    expect((await store.save(base)).checkpointNumber).toBe(1);
    expect((await store.save(base)).checkpointNumber).toBe(2);
    expect((await store.loadLatest())?.cursor).toEqual(base.cursor);
    const pointer = JSON.parse(await readFile(path.join(directory, LATEST_CHECKPOINT_FILE), "utf8"));
    expect(pointer.fileName).toBe("checkpoint-000002.json");
    expect(await readFile(path.join(directory, "checkpoint-000001.json"), "utf8")).toContain('"checkpointNumber": 1');
  });

  it("serializes concurrent writes and skips a crash-orphaned number", async () => {
    const { directory, state } = await fixture();
    const store = new CheckpointStore(directory, state.runId);
    await writeFile(path.join(directory, "checkpoint-000001.json"), "orphan\n");
    const base = {
      runId: state.runId,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceDigest: "b".repeat(64),
      state,
      workspaceRoot: directory,
      config: config(),
      configDigest: "c".repeat(64),
      memoryMode: "disabled" as const,
      memoryRevision: 0,
      memoryDigest: "d".repeat(64),
      selectedMemoryIds: [],
      validatedChangedFiles: [],
      baselineRepaired: false,
      baselineContext: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] },
      baselineReviewContext: { summary: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] }, artifacts: { baselineJson: "baseline.json" } },
      lessonStatus: "skipped" as const,
      cursor: { kind: "plan_approved" as const, continuation: null },
      bindings: {}
    };
    const saved = await Promise.all([store.save(base), store.save(base)]);
    expect(saved.map(checkpoint => checkpoint.checkpointNumber)).toEqual([2, 3]);
    expect((await store.loadLatest())?.checkpointNumber).toBe(3);
  });

  it("detects pointer digest tampering", async () => {
    const { directory, state } = await fixture();
    const store = new CheckpointStore(directory, state.runId);
    await store.save({
      runId: state.runId,
      createdAt: "2026-01-01T00:00:00.000Z",
      workspaceDigest: "b".repeat(64),
      state,
      workspaceRoot: directory,
      config: config(),
      configDigest: "c".repeat(64),
      memoryMode: "disabled",
      memoryRevision: 0,
      memoryDigest: "d".repeat(64),
      selectedMemoryIds: [],
      validatedChangedFiles: [],
      baselineRepaired: false,
      baselineContext: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] },
      baselineReviewContext: { summary: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] }, artifacts: { baselineJson: "baseline.json" } },
      lessonStatus: "skipped",
      cursor: { kind: "plan_approved", continuation: null },
      bindings: {}
    });
    await writeFile(path.join(directory, "checkpoint-000001.json"), "{}\n");
    await expect(store.loadLatest()).rejects.toThrow("digest does not match");
  });

  it("bounds reads and rejects non-basename and symlink artifacts", async () => {
    const { directory } = await fixture();
    await writeFile(path.join(directory, "large.json"), "12345");
    await expect(readSafeArtifact(directory, "large.json", 4)).rejects.toThrow("exceeds 4 bytes");
    await expect(readSafeArtifact(directory, "../large.json", 100)).rejects.toThrow("invalid artifact basename");
    await mkdir(path.join(directory, "target"));
    await writeFile(path.join(directory, "target", "data.json"), "{}");
    await symlink(path.join(directory, "target"), path.join(directory, "link.json"), process.platform === "win32" ? "junction" : "dir");
    await expect(readSafeArtifact(directory, "link.json", 100)).rejects.toThrow("non-symlink");
  });
});

function config() {
  return {
    schemaVersion: 1,
    checks: ["check"],
    dashboard: { enabled: false, port: 0 },
    limits: { planRevisions: 1, implementationRetries: 1, reviewRevisions: 1, agentTimeoutMs: 1, checkTimeoutMs: 1, maxOutputBytes: 1, worktreeIsolation: false },
    agents: Object.fromEntries(["explorer", "planner", "reviewer", "tester", "builder", "debugger", "documenter"].map(name => [name, { model: "test/model", tools: name === "tester" || name === "builder" || name === "documenter" ? ["read", "write"] : ["read"], promptFile: `${name}.md` }])),
    humanInTheLoop: { planApproval: false, planRevisionApproval: false, confirmBeforeMutation: false }
  } as any;
}
