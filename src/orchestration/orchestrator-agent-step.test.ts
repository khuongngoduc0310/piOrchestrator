import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AgentCancelledError, type AgentExecutor, type AgentRunOptions } from "../agents/agent-runner.js";
import type { SpawnExplorerResult } from "../agents/agent-runner-contracts.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { RunStore } from "../persistence/store.js";
import { AGENT_NAMES } from "../agent-types.js";
import { SCHEMA_VERSION, type WorkflowState } from "../workflow-types.js";
import { type PlannerOutput, type PlannerTask } from "../agent-task-types.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { OrchestratorRuntime } from "./orchestrator-runtime.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

const delay = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

const plannerOutput: PlannerOutput = {
  route: "implementation",
  summary: "planned",
  assumptions: [],
  acceptanceCriteria: ["works"],
  automatedAcceptanceCriteria: [0],
  tasks: [],
  risks: []
};

const plannerTask = {
  action: "create_plan",
  route: "implementation",
  request: "exercise spawning",
  exploration: {}
} as unknown as PlannerTask;

const transcript = { schemaVersion: 1 as const, truncated: false, messages: [] };

async function createRuntime(
  cwd: string,
  agentExecutor: AgentExecutor
): Promise<{ runtime: OrchestratorRuntime; store: RunStore; ctx: ExtensionCommandContext }> {
  const runId = "agent-step-spawn-test";
  const store = new RunStore(cwd, runId);
  await store.init();
  const runtime = new OrchestratorRuntime({} as ExtensionAPI, cwd, { agentExecutor, enforceWorkspacePolicy: false });
  const now = "2026-07-24T00:00:00.000Z";
  const state: WorkflowState = {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: "test",
    runId,
    request: "exercise spawning",
    route: "tests_only",
    cwd,
    runDir: store.runDir,
    stage: "planning",
    status: "running",
    attempt: 0,
    startedAt: now,
    updatedAt: now,
    agents: Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle", model: "test" }])) as WorkflowState["agents"],
    steps: []
  };
  runtime.config = structuredClone(DEFAULT_CONFIG);
  runtime.controller = new AbortController();
  runtime.state = state;
  runtime.store = store;
  const ctx = { cwd, hasUI: false, ui: { notify: () => undefined } } as unknown as ExtensionCommandContext;
  return { runtime, store, ctx };
}

async function spawnArtifacts(store: RunStore): Promise<string[]> {
  const names = await readdir(store.runDir);
  return names.filter(name => name.includes("spawn-1-transcript")).sort();
}

describe("runAgentStep spawn integration", () => {
  it("runs a spawned explorer with bounded child options and a truthful transcript artifact", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-spawn-"));
    roots.push(cwd);
    const runs: AgentRunOptions[] = [];
    let spawnResult: SpawnExplorerResult | undefined;
    const executor: AgentExecutor = {
      preflight: async () => undefined,
      run: async options => {
        runs.push(options);
        if (options.name === "explorer") {
          await delay(5);
          return { text: "auth lives in src/auth.ts", usage: { input: 5, output: 7, cacheRead: 1, cacheWrite: 0, totalTokens: 13, cost: 1.5, costBreakdown: { input: 1, output: 0.5, cacheRead: 0, cacheWrite: 0 } }, transcript };
        }
        spawnResult = await options.spawnExplorer?.("Where is the auth flow?");
        return { text: JSON.stringify(plannerOutput), usage: { input: 2, output: 3, cacheRead: 1, cacheWrite: 0, totalTokens: 6, cost: 0.3, costBreakdown: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 } }, transcript };
      }
    };
    const { runtime, store, ctx } = await createRuntime(cwd, executor);

    const output = await runAgentStep(runtime, "planner", "planning", "Plan", plannerTask, cwd, ctx, text => JSON.parse(text) as PlannerOutput);

    expect(output.route).toBe("implementation");
    expect(runs.map(run => run.name)).toEqual(["planner", "explorer"]);
    expect(typeof runs[0].spawnExplorer).toBe("function");
    const child = runs[1];
    expect(child.promptFileOverride).toBe("explorer-spawn.md");
    expect(child.allowedWritePaths).toEqual([]);
    expect(child.readRoots).toEqual([store.runDir]);
    expect(child.config.model).toBe(DEFAULT_CONFIG.agents.explorer.model);
    expect(child.signal).toBe(runtime.controller!.signal);
    expect(child.timeoutMs).toBeGreaterThan(DEFAULT_CONFIG.limits.agentTimeoutMs - 5_000);
    expect(child.timeoutMs).toBeLessThanOrEqual(DEFAULT_CONFIG.limits.agentTimeoutMs);
    expect(spawnResult?.text).toBe("auth lives in src/auth.ts");
    expect(spawnResult?.usage?.input).toBe(5);

    const artifactNames = await spawnArtifacts(store);
    expect(artifactNames).toEqual(["001-planning-planner-spawn-1-transcript.json"]);
    const artifact = JSON.parse(await readFile(path.join(store.runDir, artifactNames[0]), "utf8"));
    expect(artifact).toMatchObject({
      stepId: "step-001",
      agent: "explorer",
      invocation: 0,
      mode: "execute",
      status: "succeeded",
      model: DEFAULT_CONFIG.agents.explorer.model
    });
    expect(Date.parse(artifact.startedAt)).toBeLessThan(Date.parse(artifact.completedAt));
  });

  it("omits the spawn tool from correct_output invocations", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-spawn-"));
    roots.push(cwd);
    const runs: AgentRunOptions[] = [];
    const executor: AgentExecutor = {
      preflight: async () => undefined,
      run: async options => {
        runs.push(options);
        const valid = JSON.stringify(plannerOutput);
        return options.name === "planner" && runs.filter(run => run.name === "planner").length === 1
          ? { text: "not valid output", usage: undefined, transcript }
          : { text: valid, usage: undefined, transcript };
      }
    };
    const { runtime, ctx } = await createRuntime(cwd, executor);

    const output = await runAgentStep(runtime, "planner", "planning", "Plan", plannerTask, cwd, ctx, text => JSON.parse(text) as PlannerOutput);

    expect(output.route).toBe("implementation");
    expect(runs.length).toBe(2);
    expect(runs[0].spawnExplorer).toBeDefined();
    expect("spawnExplorer" in runs[1]).toBe(false);
  });

  it("turns a failing explorer into failure text without failing the parent step", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-spawn-"));
    roots.push(cwd);
    let spawnResult: SpawnExplorerResult | undefined;
    const executor: AgentExecutor = {
      preflight: async () => undefined,
      run: async options => {
        if (options.name === "explorer") throw new Error("boom");
        spawnResult = await options.spawnExplorer?.("question");
        return { text: JSON.stringify(plannerOutput), usage: undefined, transcript };
      }
    };
    const { runtime, store, ctx } = await createRuntime(cwd, executor);

    const output = await runAgentStep(runtime, "planner", "planning", "Plan", plannerTask, cwd, ctx, text => JSON.parse(text) as PlannerOutput);

    expect(output.route).toBe("implementation");
    expect(spawnResult?.text).toBe("Explorer sub-agent failed: boom");
    expect(spawnResult?.usage).toBeUndefined();
    expect(await spawnArtifacts(store)).toEqual([]);
  });

  it("propagates explorer cancellation instead of converting it to failure text", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-spawn-"));
    roots.push(cwd);
    const executor: AgentExecutor = {
      preflight: async () => undefined,
      run: async options => {
        if (options.name === "explorer") throw new AgentCancelledError("explorer");
        await options.spawnExplorer?.("question");
        return { text: JSON.stringify(plannerOutput), usage: undefined, transcript };
      }
    };
    const { runtime, ctx } = await createRuntime(cwd, executor);

    await expect(runAgentStep(runtime, "planner", "planning", "Plan", plannerTask, cwd, ctx, text => JSON.parse(text) as PlannerOutput))
      .rejects.toBeInstanceOf(AgentCancelledError);
    expect(runtime.state!.steps[0].status).toBe("cancelled");
  });
});
