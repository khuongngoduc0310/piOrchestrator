import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/config.js";
import { CheckpointStore } from "../persistence/checkpoint-store.js";
import { AGENT_NAMES } from "../agent-types.js";
import { SCHEMA_VERSION, type WorkflowState } from "../workflow-types.js";
import { OrchestratorRuntime } from "./orchestrator-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function state(cwd: string, runId: string, attempt: number): WorkflowState {
  const runDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "runs", runId);
  return {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: "test",
    runId,
    request: `request for ${runId}`,
    route: "implementation",
    cwd,
    runDir,
    stage: "failed",
    status: "failed",
    failedStage: "implementing",
    attempt,
    startedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:05:00.000Z",
    agents: Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle", model: `test/${name}` }])) as WorkflowState["agents"],
    steps: []
  };
}

async function writeHistoricalRun(cwd: string, runId: string, attempt: number): Promise<WorkflowState> {
  const historicalState = state(cwd, runId, attempt);
  await mkdir(historicalState.runDir, { recursive: true });
  await writeFile(path.join(historicalState.runDir, "state.json"), JSON.stringify(historicalState), "utf8");
  return historicalState;
}

async function saveCheckpoint(historicalState: WorkflowState, checks: string[], implementationRetries: number): Promise<void> {
  const config = structuredClone(DEFAULT_CONFIG);
  config.checks = checks;
  config.limits.implementationRetries = implementationRetries;
  await new CheckpointStore(historicalState.runDir, historicalState.runId).save({
    runId: historicalState.runId,
    createdAt: "2026-07-22T10:04:00.000Z",
    workspaceDigest: "b".repeat(64),
    workspaceRoot: historicalState.cwd,
    config,
    configDigest: "c".repeat(64),
    memoryMode: "disabled",
    memoryRevision: 0,
    memoryDigest: "d".repeat(64),
    selectedMemoryIds: [],
    validatedChangedFiles: [],
    validatedFileAttestations: [],
    baselineRepaired: false,
    baselineContext: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] },
    baselineReviewContext: { summary: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] }, artifacts: { baselineJson: "baseline.json" } },
    lessonStatus: "skipped",
    mutationConfirmed: false,
    state: historicalState,
    cursor: { kind: "plan_approved", continuation: null },
    bindings: {}
  });
}

describe("OrchestratorRuntime historical dashboard view models", () => {
  it("uses the historical checkpoint config for check and retry counts", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "orchestrator-runtime-history-"));
    roots.push(cwd);
    const historicalState = await writeHistoricalRun(cwd, "historical", 2);
    await saveCheckpoint(historicalState, ["lint", "test"], 5);
    const runtime = new OrchestratorRuntime({} as ExtensionAPI, cwd);
    runtime.state = state(cwd, "active", 1);
    runtime.config = structuredClone(DEFAULT_CONFIG);
    runtime.config.checks = ["current check"];
    runtime.config.limits.implementationRetries = 1;

    const model = await runtime.getRunViewModel("historical");

    expect(model?.config).toMatchObject({ status: "valid", checkCount: 2 });
    expect(model?.run).toMatchObject({ attempt: 2, maxAttempts: 6 });
  });

  it("returns a conservative view model when a historical run has no checkpoint", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "orchestrator-runtime-legacy-"));
    roots.push(cwd);
    await writeHistoricalRun(cwd, "legacy", 4);
    const runtime = new OrchestratorRuntime({} as ExtensionAPI, cwd);
    runtime.state = state(cwd, "active", 1);
    runtime.config = structuredClone(DEFAULT_CONFIG);
    runtime.config.checks = ["unrelated current check"];
    runtime.config.limits.implementationRetries = 9;

    const model = await runtime.getRunViewModel("legacy");

    expect(model?.config).toMatchObject({ status: "missing", checkCount: 0 });
    expect(model?.run).toMatchObject({ attempt: 4, maxAttempts: 4 });
  });
});

describe("OrchestratorRuntime cancellation boundary", () => {
  it("rejects cancellation after durable finalization begins", () => {
    const runtime = new OrchestratorRuntime({} as ExtensionAPI, ".");
    runtime.controller = new AbortController();
    runtime.activeRun = new Promise<void>(() => undefined);

    expect(runtime.cancel()).toBe(true);

    runtime.controller = new AbortController();
    runtime.finalizationStarted = true;
    expect(runtime.cancel()).toBe(false);
    expect(runtime.controller.signal.aborted).toBe(false);
  });
});
