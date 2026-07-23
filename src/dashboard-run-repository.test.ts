import { mkdir, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DashboardRunRepository } from "./dashboard-run-repository.js";
import { AGENT_NAMES, type AgentTranscriptArtifact, type WorkflowState } from "./types.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ cwd: string; runsDir: string }> {
  const { mkdtemp } = await import("node:fs/promises");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "dashboard-runs-"));
  roots.push(cwd);
  const runsDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "runs");
  await mkdir(runsDir, { recursive: true });
  return { cwd, runsDir };
}

function state(runId: string, runDir: string, request = runId): WorkflowState {
  return {
    schemaVersion: 1,
    extensionVersion: "test",
    runId,
    request,
    route: "implementation",
    cwd: path.dirname(runDir),
    runDir,
    stage: "implementing",
    status: "running",
    activeAgent: "builder",
    attempt: 1,
    startedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:01:00.000Z",
    currentTool: "read",
    agents: Object.fromEntries(AGENT_NAMES.map(name => [name, {
      status: name === "builder" ? "running" : "idle",
      model: `test/${name}`
    }])) as WorkflowState["agents"],
    steps: [{
      id: "step-001",
      sequence: 1,
      stage: "implementing",
      label: "Build",
      status: "running",
      agent: "builder",
      startedAt: "2026-07-22T10:00:30.000Z",
      artifact: "result.json",
      invocations: [{
        sequence: 1,
        mode: "execute",
        status: "succeeded",
        startedAt: "2026-07-22T10:00:30.000Z",
        completedAt: "2026-07-22T10:00:40.000Z",
        transcriptArtifact: "transcript.json",
        messageCount: 1,
        truncated: false
      }]
    }]
  };
}

async function writeRun(runsDir: string, id: string, value?: WorkflowState): Promise<string> {
  const runDir = path.join(runsDir, id);
  await mkdir(runDir);
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(value ?? state(id, runDir)), "utf8");
  return runDir;
}

describe("DashboardRunRepository", () => {
  it("lists valid regular runs newest-first and skips malformed entries", async () => {
    const { cwd, runsDir } = await fixture();
    const older = await writeRun(runsDir, "older", state("older", path.join(runsDir, "older"), "old request"));
    const newer = await writeRun(runsDir, "newer", state("newer", path.join(runsDir, "newer"), "new request"));
    await writeRun(runsDir, "bad", { broken: true } as unknown as WorkflowState);
    await writeFile(path.join(runsDir, "plain-file"), "not a run", "utf8");
    await utimes(older, new Date(1_000), new Date(1_000));
    await utimes(newer, new Date(2_000), new Date(2_000));

    await expect(new DashboardRunRepository(cwd).listRuns()).resolves.toMatchObject([
      { id: "newer", request: "new request", status: "running" },
      { id: "older", request: "old request", status: "running" }
    ]);
  });

  it("rejects traversal and symlink run directories without reading outside runs", async () => {
    const { cwd, runsDir } = await fixture();
    const outside = path.join(cwd, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "state.json"), JSON.stringify(state("linked", outside)), "utf8");
    await symlink(outside, path.join(runsDir, "linked"), "junction");
    const repository = new DashboardRunRepository(cwd);

    await expect(repository.loadRun("../outside")).rejects.toThrow("Invalid run ID");
    await expect(repository.loadRun("linked")).rejects.toThrow("non-symlink");
    await expect(repository.listRuns()).resolves.toEqual([]);
  });

  it("loads persisted inspection and a matching invocation transcript", async () => {
    const { cwd, runsDir } = await fixture();
    const runDir = await writeRun(runsDir, "run-1");
    const transcript: AgentTranscriptArtifact = {
      schemaVersion: 1,
      stepId: "step-001",
      agent: "builder",
      invocation: 1,
      mode: "execute",
      status: "succeeded",
      model: "test/builder",
      startedAt: "2026-07-22T10:00:30.000Z",
      completedAt: "2026-07-22T10:00:40.000Z",
      messages: [{ role: "assistant", content: [{ type: "text", text: "finished" }] }],
      truncated: false
    };
    await writeFile(path.join(runDir, "transcript.json"), JSON.stringify(transcript), "utf8");
    const repository = new DashboardRunRepository(cwd);

    await expect(repository.getAgentInspection("run-1", "builder")).resolves.toMatchObject({
      name: "builder",
      status: "running",
      currentTool: "read",
      hasArtifact: true
    });
    await expect(repository.getInvocationTranscript("run-1", "step-001", 1)).resolves.toEqual(transcript);
    await expect(repository.getInvocationTranscript("run-1", "step-001", 2)).resolves.toBeUndefined();
  });

  it("reports artifact sizes and UTF-8-safe truncation in bytes", async () => {
    const { cwd, runsDir } = await fixture();
    const runDir = await writeRun(runsDir, "run-1");
    await writeFile(path.join(runDir, "result.json"), "éabc", "utf8");
    const repository = new DashboardRunRepository(cwd, { artifactPreviewBytes: 3, maxArtifactBytes: 10 });

    await expect(repository.readArtifact("run-1", "result.json")).resolves.toEqual({
      name: "result.json",
      text: "éa",
      truncated: true,
      isJson: true,
      sizeBytes: 5,
      returnedBytes: 3
    });
    await expect(repository.readArtifact("run-1", "../state.json")).rejects.toThrow("invalid artifact basename");
    expect(await readFile(path.join(runDir, "result.json"), "utf8")).toBe("éabc");
  });

  it("enforces state and artifact read bounds", async () => {
    const { cwd, runsDir } = await fixture();
    const runDir = await writeRun(runsDir, "run-1");
    await writeFile(path.join(runDir, "large.txt"), "123456", "utf8");

    await expect(new DashboardRunRepository(cwd, { maxStateBytes: 10 }).loadRun("run-1")).rejects.toThrow("exceeds 10 bytes");
    await expect(new DashboardRunRepository(cwd, {
      maxArtifactBytes: 5,
      artifactPreviewBytes: 5
    }).readArtifact("run-1", "large.txt")).rejects.toThrow("exceeds 5 bytes");
  });
});
