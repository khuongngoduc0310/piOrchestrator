import { execFileSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/config.js";
import { RunStore } from "../persistence/store.js";
import { AGENT_NAMES, SCHEMA_VERSION, type CheckResult, type StepRecord, type WorkflowState } from "../types.js";
import { createFileAttestations } from "../workspace/workspace-attestation.js";
import { compareWorkspaceSnapshots, createWorkspaceSnapshot } from "../workspace/workspace-guard.js";
import { createWorktree } from "../workspace/worktree.js";
import type { CheckRunner } from "./orchestrator-contracts.js";
import { runSpecializedMutationFinalization } from "./orchestrator-finalization.js";
import { OrchestratorRuntime } from "./orchestrator-runtime.js";
import {
  runCheckStep,
  validateFinalDirectWorkspace
} from "./orchestrator-workspace.js";
import type { SpecializedMutationResult, WorkflowContext } from "./orchestrator-context.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}

function checkResult(): CheckResult {
  return {
    command: "test-check",
    exitCode: 0,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    passed: true,
    timedOut: false,
    cancelled: false,
    startedAt: "2026-07-24T00:00:00.000Z",
    completedAt: "2026-07-24T00:00:01.000Z",
    durationMs: 1_000
  };
}

async function createRuntime(
  cwd: string,
  checkRunner?: CheckRunner
): Promise<{ runtime: OrchestratorRuntime; store: RunStore; ctx: ExtensionCommandContext }> {
  const runId = "workspace-safety-test";
  const store = new RunStore(cwd, runId);
  await store.init();
  const runtime = new OrchestratorRuntime({} as ExtensionAPI, cwd, { checkRunner });
  const config = structuredClone(DEFAULT_CONFIG);
  config.checks = ["test-check"];
  const now = "2026-07-24T00:00:00.000Z";
  const state: WorkflowState = {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: "test",
    runId,
    request: "exercise workspace boundaries",
    route: "tests_only",
    cwd,
    runDir: store.runDir,
    stage: "testing",
    status: "running",
    attempt: 0,
    startedAt: now,
    updatedAt: now,
    agents: Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle", model: "test" }])) as WorkflowState["agents"],
    steps: []
  };
  runtime.config = config;
  runtime.controller = new AbortController();
  runtime.state = state;
  runtime.store = store;
  const ctx = { cwd, hasUI: false, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;
  return { runtime, store, ctx };
}

async function attestChangedFile(runtime: OrchestratorRuntime, cwd: string, file: string, content: string): Promise<void> {
  const before = await createWorkspaceSnapshot(cwd);
  await writeFile(path.join(cwd, file), content);
  const after = await createWorkspaceSnapshot(cwd);
  const step: StepRecord = {
    id: "step-validated",
    sequence: 1,
    stage: "implementing",
    label: "Validated mutation",
    status: "succeeded",
    startedAt: "2026-07-24T00:00:00.000Z"
  };
  for (const attestation of createFileAttestations("builder", step, compareWorkspaceSnapshots(before, after), after)) {
    runtime.validatedChangedFiles.add(attestation.path);
    runtime.validatedFileAttestations.set(attestation.path, attestation);
  }
}

describe("orchestration workspace safety", () => {
  it("rejects configured checks that mutate project files", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "orchestrator-check-boundary-"));
    roots.push(cwd);
    await writeFile(path.join(cwd, "tracked.txt"), "before\n");
    const { runtime, store, ctx } = await createRuntime(cwd, async (_commands, checkCwd) => {
      await writeFile(path.join(checkCwd, "tracked.txt"), "mutated by check\n");
      return [checkResult()];
    });

    await expect(runCheckStep(runtime, "testing", "Mutating check", cwd, ctx, { requireGreen: true }))
      .rejects.toThrow("Configured checks changed project files: tracked.txt");

    const step = runtime.requireState().steps[0];
    expect(step).toMatchObject({ status: "failed", message: "Configured checks changed project files: tracked.txt" });
    expect(step.artifact).toContain("check-mutation");
    expect(JSON.parse(await readFile(path.join(store.runDir, step.artifact!), "utf8"))).toMatchObject({
      violations: ["tracked.txt"]
    });
  });

  it("rejects direct-workspace content changed after its final attestation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "orchestrator-direct-boundary-"));
    roots.push(cwd);
    await writeFile(path.join(cwd, "validated.txt"), "before\n");
    const { runtime } = await createRuntime(cwd);
    await attestChangedFile(runtime, cwd, "validated.txt", "validated\n");
    await writeFile(path.join(cwd, "validated.txt"), "unvalidated later change\n");

    await expect(validateFinalDirectWorkspace(runtime, cwd))
      .rejects.toThrow("Direct workspace changed after validation (validated.txt content changed after validation)");
  });

  it("retains an isolated worktree when final synchronization detects source drift", async () => {
    const repository = await mkdtemp(path.join(os.tmpdir(), "orchestrator-worktree-boundary-"));
    roots.push(repository);
    git(repository, "init");
    git(repository, "config", "user.email", "test@test.com");
    git(repository, "config", "user.name", "Test");
    await writeFile(path.join(repository, "README.md"), "initial\n");
    git(repository, "add", "README.md");
    git(repository, "commit", "-m", "initial");
    const handle = await createWorktree(repository, "final-sync-failure");
    const { runtime, store, ctx } = await createRuntime(repository);
    await attestChangedFile(runtime, handle.effectiveCwd, "README.md", "isolated change\n");
    await writeFile(path.join(repository, "README.md"), "concurrent source change\n");
    const workflow: WorkflowContext = {
      route: "tests_only",
      request: "exercise final synchronization",
      ctx,
      cwd: repository,
      mutationCwd: handle.effectiveCwd,
      runId: runtime.requireState().runId,
      store,
      config: runtime.requireConfig(),
      controller: runtime.requireController(),
      worktreeHandle: handle,
      worktreeSynced: false,
      retainWorktree: false,
      mutationConfirmed: true
    };

    await expect(runSpecializedMutationFinalization(
      runtime,
      workflow,
      { route: "tests_only" } as SpecializedMutationResult,
      [checkResult()]
    )).rejects.toThrow("source paths changed after creation or isolation: README.md");

    expect(workflow.worktreeSynced).toBe(false);
    expect(workflow.retainWorktree).toBe(true);
    expect(runtime.requireState().warning).toContain("Worktree synchronization failed; recovery worktree retained");
    await expect(access(handle.worktreeRoot)).resolves.toBeUndefined();
    expect(await readFile(path.join(repository, "README.md"), "utf8")).toBe("concurrent source change\n");
    expect(await readFile(path.join(handle.effectiveCwd, "README.md"), "utf8")).toBe("isolated change\n");
  });
});
