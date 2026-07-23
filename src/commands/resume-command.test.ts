import { mkdir, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { handleResumeCommand } from "./resume-command.js";
import { AGENT_NAMES, SCHEMA_VERSION, type WorkflowState } from "../types.js";

const roots: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<{ cwd: string; runsDir: string }> {
  const { mkdtemp } = await import("node:fs/promises");
  const cwd = await mkdtemp(path.join(os.tmpdir(), "resume-cmd-"));
  roots.push(cwd);
  const runsDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "runs");
  await mkdir(runsDir, { recursive: true });
  return { cwd, runsDir };
}

const CHECKPOINT = { number: 1, cursor: "plan_approved" as const, createdAt: "2026-07-22T10:30:00.000Z" };

function state(overrides: Partial<WorkflowState> & { runId: string; runDir: string }): WorkflowState {
  return {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: "test",
    request: "default request",
    route: "implementation",
    cwd: path.dirname(overrides.runDir),
    stage: "implementing",
    status: "running",
    attempt: 1,
    startedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:01:00.000Z",
    agents: Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle" as const, model: `test/${name}` }])) as WorkflowState["agents"],
    steps: [],
    ...overrides
  };
}

async function writeRun(runsDir: string, id: string, value: WorkflowState): Promise<string> {
  const runDir = path.join(runsDir, id);
  await mkdir(runDir);
  await writeFile(path.join(runDir, "state.json"), JSON.stringify(value), "utf8");
  return runDir;
}

function context(options: {
  hasUI?: boolean;
  select?: Array<string | undefined>;
  confirm?: Array<boolean | undefined>;
} = {}) {
  const selects = [...(options.select ?? [])];
  const confirms = [...(options.confirm ?? [])];
  const select = vi.fn(async () => selects.shift());
  const confirm = vi.fn(async () => confirms.shift());
  const notify = vi.fn();
  return {
    ctx: { hasUI: options.hasUI ?? true, ui: { select, confirm, notify, input: vi.fn() } } as unknown as ExtensionCommandContext,
    select,
    confirm,
    notify
  };
}

describe("handleResumeCommand", () => {
  it("passes the exact run ID to resume when one argument is supplied", async () => {
    const { ctx } = context();
    const resume = vi.fn();
    await handleResumeCommand("", "exact-run-id", ctx, resume);
    expect(resume).toHaveBeenCalledWith("exact-run-id");
    expect(resume).toHaveBeenCalledTimes(1);
    expect(ctx.ui.notify).not.toHaveBeenCalled();
  });

  it("shows usage for more than one argument", async () => {
    const { ctx } = context();
    const resume = vi.fn();
    await handleResumeCommand("", "a b c", ctx, resume);
    expect(resume).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /orchestrator-resume [exact-run-id]", "warning");
  });

  it("reports a resume failure when the one-argument path throws", async () => {
    const { ctx } = context();
    const resume = vi.fn(async () => { throw new Error("lease held by another process"); });
    await handleResumeCommand("", "run-id", ctx, resume);
    expect(resume).toHaveBeenCalledWith("run-id");
    expect(ctx.ui.notify).toHaveBeenCalledWith("Resume failed: lease held by another process", "error");
  });

  it("requires an interactive UI for browsing", async () => {
    const { ctx, notify } = context({ hasUI: false });
    const resume = vi.fn();
    await handleResumeCommand("/tmp", "", ctx, resume);
    expect(resume).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("The resume command requires an interactive UI to browse past runs.", "error");
  });

  it("notifies when no resumable runs exist", async () => {
    const { cwd } = await fixture();
    const { ctx, notify } = context();
    await handleResumeCommand(cwd, "", ctx, vi.fn());
    expect(notify).toHaveBeenCalledWith("No resumable workflow runs found", "info");
  });

  it("lists only failed/cancelled runs with a checkpoint and no blocked reason", async () => {
    const { cwd, runsDir } = await fixture();
    const dFailed = await writeRun(runsDir, "failed-with-checkpoint", state({ runId: "failed-with-checkpoint", runDir: path.join(runsDir, "failed-with-checkpoint"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const dCancelled = await writeRun(runsDir, "cancelled-with-checkpoint", state({ runId: "cancelled-with-checkpoint", runDir: path.join(runsDir, "cancelled-with-checkpoint"), status: "cancelled", latestCheckpoint: CHECKPOINT }));
    await writeRun(runsDir, "completed", state({ runId: "completed", runDir: path.join(runsDir, "completed"), status: "completed", latestCheckpoint: CHECKPOINT }));
    await writeRun(runsDir, "running", state({ runId: "running", runDir: path.join(runsDir, "running"), status: "running" }));
    await writeRun(runsDir, "no-checkpoint", state({ runId: "no-checkpoint", runDir: path.join(runsDir, "no-checkpoint"), status: "failed" }));
    await writeRun(runsDir, "blocked", state({ runId: "blocked", runDir: path.join(runsDir, "blocked"), status: "failed", latestCheckpoint: CHECKPOINT, resumeBlockedReason: "finalization started" }));
    await utimes(dFailed, new Date(2_000), new Date(2_000));
    await utimes(dCancelled, new Date(1_000), new Date(1_000));

    const { ctx, select } = context({ select: [undefined] });
    await handleResumeCommand(cwd, "", ctx, vi.fn());
    expect(select).toHaveBeenCalledTimes(1);
    const selectCall0 = select.mock.calls[0] as unknown as [string, string[]];
    expect(selectCall0[0]).toBe("Select a run to resume");
    const labels = selectCall0[1];
    const candidates = labels.filter(l => l !== "Cancel");
    expect(candidates.length).toBe(2);
    expect(candidates[0]).toContain("failed-with-checkpoint");
    expect(candidates[1]).toContain("cancelled-with-checkpoint");
    expect(candidates.join(" ")).not.toContain("completed");
    expect(candidates.join(" ")).not.toContain("running");
    expect(candidates.join(" ")).not.toContain("no-checkpoint");
    expect(candidates.join(" ")).not.toContain("blocked");
  });

  it("displays at most 20 eligible runs", async () => {
    const { cwd, runsDir } = await fixture();
    for (let i = 0; i < 30; i++) {
      const id = `run-${String(i).padStart(3, "0")}`;
      await writeRun(runsDir, id, state({ runId: id, runDir: path.join(runsDir, id), status: "failed", latestCheckpoint: CHECKPOINT }));
    }
    const { ctx, select } = context({ select: [undefined] });
    await handleResumeCommand(cwd, "", ctx, vi.fn());
    expect(select).toHaveBeenCalledTimes(1);
    const labels = (select.mock.calls[0] as unknown as [string, string[]])[1];
    const candidates = labels.filter(l => l !== "Cancel");
    expect(candidates.length).toBe(20);
  });

  it("resumes the exact run ID when selected and confirmed", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "run-id-value", state({ runId: "run-id-value", runDir: path.join(runsDir, "run-id-value"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const resume = vi.fn();
    const label = `run-id-value | failed | plan_approved | default request`;
    const { ctx, confirm } = context({ select: [label], confirm: [true] });
    await handleResumeCommand(cwd, "", ctx, resume);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledWith("run-id-value");
    expect(resume).toHaveBeenCalledTimes(1);
  });

  it("does not resume when confirmation is rejected", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "run-1", state({ runId: "run-1", runDir: path.join(runsDir, "run-1"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const resume = vi.fn();
    const label = `run-1 | failed | plan_approved | default request`;
    const { ctx, confirm } = context({ select: [label], confirm: [false] });
    await handleResumeCommand(cwd, "", ctx, resume);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not resume when selection is cancelled", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "run-1", state({ runId: "run-1", runDir: path.join(runsDir, "run-1"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const resume = vi.fn();
    const { ctx } = context({ select: ["Cancel"] });
    await handleResumeCommand(cwd, "", ctx, resume);
    expect(resume).not.toHaveBeenCalled();
  });

  it("does not resume when select returns undefined", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "run-1", state({ runId: "run-1", runDir: path.join(runsDir, "run-1"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const resume = vi.fn();
    const { ctx } = context({ select: [undefined] });
    await handleResumeCommand(cwd, "", ctx, resume);
    expect(resume).not.toHaveBeenCalled();
  });

  it("fails closed on an unexpected selection value", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "run-1", state({ runId: "run-1", runDir: path.join(runsDir, "run-1"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const resume = vi.fn();
    const { ctx, notify } = context({ select: ["not-an-offered-label"] });
    await handleResumeCommand(cwd, "", ctx, resume);
    expect(resume).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("Unexpected selection value; run not resumed.", "warning");
  });

  it("reports resume failures after selection and confirmation", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "run-1", state({ runId: "run-1", runDir: path.join(runsDir, "run-1"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const resume = vi.fn(async () => { throw new Error("workspace mismatch"); });
    const label = `run-1 | failed | plan_approved | default request`;
    const { ctx, notify } = context({ select: [label], confirm: [true] });
    await handleResumeCommand(cwd, "", ctx, resume);
    expect(resume).toHaveBeenCalledWith("run-1");
    expect(notify).toHaveBeenCalledWith("Resume failed: workspace mismatch", "error");
  });

  it("preserves newest-first ordering of eligible candidates", async () => {
    const { cwd, runsDir } = await fixture();
    const oldDir = await writeRun(runsDir, "old-run", state({ runId: "old-run", runDir: path.join(runsDir, "old-run"), status: "failed", latestCheckpoint: CHECKPOINT }));
    const newDir = await writeRun(runsDir, "new-run", state({ runId: "new-run", runDir: path.join(runsDir, "new-run"), status: "failed", latestCheckpoint: CHECKPOINT }));
    await utimes(oldDir, new Date(1_000), new Date(1_000));
    await utimes(newDir, new Date(2_000), new Date(2_000));

    const { ctx, select } = context({ select: [undefined] });
    await handleResumeCommand(cwd, "", ctx, vi.fn());
    const labels1 = (select.mock.calls[0] as unknown as [string, string[]])[1];
    expect(labels1[0]).toContain("new-run");
    expect(labels1[1]).toContain("old-run");
  });

  it("skips malformed run entries without breaking the browser", async () => {
    const { cwd, runsDir } = await fixture();
    await writeRun(runsDir, "good-run", state({ runId: "good-run", runDir: path.join(runsDir, "good-run"), status: "failed", latestCheckpoint: CHECKPOINT }));
    await writeFile(path.join(runsDir, "plain-file"), "not a run", "utf8");

    const { ctx, select } = context({ select: [undefined] });
    await handleResumeCommand(cwd, "", ctx, vi.fn());
    expect(select).toHaveBeenCalledTimes(1);
    const labels2 = (select.mock.calls[0] as unknown as [string, string[]])[1];
    const candidates = labels2.filter(l => l !== "Cancel");
    expect(candidates.length).toBe(1);
    expect(candidates[0]).toContain("good-run");
  });
});
