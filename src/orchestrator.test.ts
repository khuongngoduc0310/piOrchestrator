import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AgentCancelledError,
  AgentIncompleteResponseError,
  type AgentExecutor,
  type AgentRunOptions
} from "./agents/agent-runner.js";
import type { CheckRunner, OrchestratorDependencies } from "./orchestrator.js";
import { Orchestrator } from "./orchestrator.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config/config.js";
import { MAX_EVIDENCE_DETAIL_BYTES } from "./memory/memory-types.js";
import { RunStore } from "./persistence/store.js";
import { CheckpointStore } from "./persistence/checkpoint-store.js";
import type { CheckpointWrite } from "./persistence/checkpoint-types.js";
import type { AgentResult, CheckResult, OrchestratorConfig, WorkflowRoute, WorkflowState } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

function defaultTestConfig(): OrchestratorConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.humanInTheLoop.planApproval = false;
  config.humanInTheLoop.planRevisionApproval = false;
  config.humanInTheLoop.confirmBeforeMutation = false;
  config.humanInTheLoop.importantDecisions = false;
  config.humanInTheLoop.finalDeliveryApproval = false;
  config.humanInTheLoop.diagnosisApproval = "never";
  config.limits.worktreeIsolation = false;
  return config;
}

const explorer = json({
  architecture: "small extension",
  relevantFiles: ["src/index.ts"],
  conventions: [],
  similarImplementations: [],
  commands: ["check"],
  risks: [],
  knownLessons: [],
  evidence: [{ path: "src/index.ts", detail: "entry point" }]
});
const plan = json({
  route: "implementation",
  summary: "implement",
  assumptions: [],
  acceptanceCriteria: ["check passes"],
  automatedAcceptanceCriteria: [0],
  tasks: [{ id: "one", description: "change", files: ["src/index.ts"], dependencies: [], verification: ["check"] }],
  risks: []
});
const reviewOnlyPlan = json({
  route: "review_only",
  summary: "review existing changes",
  assumptions: [],
  acceptanceCriteria: ["findings cite repository evidence"],
  automatedAcceptanceCriteria: [],
  tasks: [{ id: "review", description: "review changes", files: ["src/index.ts"], dependencies: [], verification: ["report findings"] }],
  risks: []
});
function routePlan(route: WorkflowRoute, files = ["src/index.ts"]): string {
  const automatedIndices = route === "documentation_only" || route === "review_only" || route === "investigation_only" || route === "planning_only" ? [] : [0];
  return json({
    route,
    summary: `${route} plan`,
    assumptions: [],
    acceptanceCriteria: ["check passes"],
    automatedAcceptanceCriteria: automatedIndices,
    tasks: [{ id: "one", description: "bounded work", files, dependencies: [], verification: ["check"] }],
    risks: []
  });
}
const approved = json({
  decision: "approved",
  blockingIssues: [],
  suggestions: [],
  evidence: [{ path: "src/index.ts", detail: "verified" }]
});
const changes = json({
  decision: "changes_requested",
  blockingIssues: ["fix required"],
  suggestions: [],
  evidence: [{ path: "src/index.ts", detail: "problem" }]
});
const tester = json({
  summary: "tests",
  changedFiles: ["test.ts"],
  testsAdded: ["behavior"],
  acceptanceCoverage: [{
    criterionIndex: 0,
    criterion: "check passes",
    status: "covered",
    tests: ["test.ts: behavior"],
    preImplementationResult: "failed_as_expected",
    evidence: "targeted test failed before implementation"
  }],
  commands: [],
  assumptions: [],
  unresolvedIssues: []
});
const builder = json({ summary: "built", changedFiles: ["src/index.ts"], commands: [], assumptions: [], unresolvedIssues: [] });
const debuggerOutput = json({
  category: "implementation_defect",
  rootCause: "missing implementation",
  evidence: [{ path: "src/index.ts", detail: "missing" }],
  recommendedFix: "implement",
  affectedFiles: ["src/index.ts"],
  confidence: "high"
});
const documenter = json({
  summary: "docs",
  changedFiles: ["README.md"],
  documentationChanges: ["documented"],
  proposedLessons: [{
    title: "lesson",
    lesson: "verify",
    scope: { roles: ["builder"], paths: ["src"], categories: ["correctness"], keywords: ["verify"] },
    evidence: [{ path: "README.md", detail: "documented" }]
  }],
  commands: [],
  unresolvedIssues: []
});
const documentationOnlyOutput = json({
  summary: "documentation updated",
  changedFiles: ["README.md"],
  documentationChanges: ["documented"],
  proposedLessons: [],
  commands: [],
  unresolvedIssues: []
});

class QueueAgent implements AgentExecutor {
  readonly calls: AgentRunOptions[] = [];
  readonly preflight = vi.fn(async (_config: OrchestratorConfig): Promise<void> => undefined);
  constructor(private readonly outputs: Array<string | Error>) {}
  async run(options: AgentRunOptions): Promise<AgentResult> {
    this.calls.push(options);
    const output = this.outputs.shift();
    if (!output) throw new Error(`Missing fake output for ${options.name}`);
    if (output instanceof Error) throw output;
    const transcript = {
      schemaVersion: 1 as const,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: options.task }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: output }], stopReason: "stop" }
      ],
      truncated: false
    };
    options.onTranscript?.(transcript);
    return { text: output, transcript };
  }
}

function check(passed: boolean): CheckResult {
  return {
    command: "check",
    exitCode: passed ? 0 : 1,
    stdout: "",
    stderr: passed ? "" : "failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    passed,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1
  };
}

async function scenario(
  outputs: Array<string | Error>,
  checkPasses: boolean[],
  configure?: (config: OrchestratorConfig) => void,
  dependencies: Partial<OrchestratorDependencies> = {},
  route: WorkflowRoute = "implementation"
): Promise<{ engine: Orchestrator; agent: QueueAgent; cwd: string; notifications: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-flow-"));
  directories.push(cwd);
  const config = defaultTestConfig();
  config.checks = ["check"];
  config.dashboard.enabled = false;
  configure?.(config);
  await saveConfig(cwd, config);
  const agent = new QueueAgent(outputs);
  const queues = checkPasses.map(value => [check(value)]);
  const checkRunner = vi.fn(async () => {
    const next = queues.shift();
    if (!next) throw new Error("Missing fake checks");
    return next;
  }) as unknown as CheckRunner;
  const notifications = vi.fn();
  const openBrowser = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    appendEntry: vi.fn(),
    exec: vi.fn(),
    sendMessage
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    ui: { notify: notifications, setStatus: vi.fn(), setWidget: vi.fn() }
  } as unknown as ExtensionCommandContext;
  const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, openBrowser, enforceWorkspacePolicy: false, ...dependencies });
  await engine.start({ route, request: "request" }, ctx);
  return { engine, agent, cwd, notifications, sendMessage };
}

describe("Orchestrator", () => {
  it("approves discovered checks and continues the same invocation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-setup-"));
    directories.push(cwd);
    await saveConfig(cwd, { ...defaultTestConfig(), dashboard: { enabled: false, port: 0 } });
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const agent = new QueueAgent([explorer, plan, approved, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn(async () => "Approve suggested checks");
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect((await loadConfig(cwd)).checks).toEqual(["npm test"]);
    expect(checkRunner).toHaveBeenCalled();
    expect(agent.preflight).toHaveBeenCalled();
  });

  it("cancels an implementation route when deferred check setup is declined", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-setup-cancel-"));
    directories.push(cwd);
    await saveConfig(cwd, { ...defaultTestConfig(), dashboard: { enabled: false, port: 0 } });
    const agent = new QueueAgent([explorer, plan, approved]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select: vi.fn(async () => "Cancel"), editor: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("cancelled");
    expect(engine.getState()?.route).toBe("implementation");
    expect(agent.preflight).toHaveBeenCalledTimes(2);
    expect((await loadConfig(cwd)).checks).toEqual([]);
  });

  it("routes review-only plans directly to repository review without checks or mutations", async () => {
    const { engine, agent, cwd } = await scenario(
      [explorer, reviewOnlyPlan, approved, changes],
      [],
      config => { config.checks = []; },
      {},
      "review_only"
    );

    const state = engine.getState()!;
    expect(state.status).toBe("completed");
    expect(state.route).toBe("review_only");
    expect(state.steps.map(step => step.stage)).toEqual([
      "exploring",
      "planning",
      "reviewing_plan",
      "reviewing_repository"
    ]);
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "reviewer"]);
    expect((agent.preflight.mock.calls[0] as unknown[])[5]).toEqual(["explorer", "planner", "reviewer"]);
    expect(agent.preflight).toHaveBeenCalledOnce();
    expect(agent.calls.some(call => ["tester", "builder", "debugger", "documenter"].includes(call.name))).toBe(false);
    const repositoryTask = JSON.parse(agent.calls.at(-1)!.task).task;
    expect(repositoryTask.reviewType).toBe("repository");
    expect(repositoryTask).not.toHaveProperty("tester");
    expect(repositoryTask).not.toHaveProperty("builderOutputs");
    const completion = JSON.parse(await readFile(path.join(state.runDir, "completion-summary.json"), "utf8"));
    expect(completion).toMatchObject({
      route: "review_only",
      changedFiles: [],
      testsAdded: [],
      checks: [],
      review: { outcome: "findings_reported", blockingIssues: ["fix required"] }
    });
    expect((await loadConfig(cwd)).checks).toEqual([]);
  });

  it("runs investigation-only as a read-only diagnostic route", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("investigation_only"), approved, debuggerOutput],
      [],
      config => { config.checks = []; },
      {},
      "investigation_only"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(engine.getState()?.steps.map(step => step.stage)).toEqual(["exploring", "planning", "reviewing_plan", "debugging"]);
    expect(engine.getState()?.latestCheckpoint?.cursor).toBe("investigation_completed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "debugger"]);
    expect(JSON.parse(agent.calls.at(-1)!.task).task).toMatchObject({
      action: "diagnose_investigation",
      request: "request"
    });
    expect((agent.preflight.mock.calls[0] as unknown[])[5]).toEqual(["explorer", "planner", "reviewer", "debugger"]);
  });

  it("completes planning-only without checks or execution agents", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("planning_only"), approved],
      [],
      config => { config.checks = []; },
      {},
      "planning_only"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer"]);
  });

  it.each([
    { route: "planning_only" as const, outputs: [explorer, routePlan("planning_only"), approved], cursor: "plan_approved" },
    { route: "review_only" as const, outputs: [explorer, reviewOnlyPlan, approved, changes], cursor: "repository_reviewed" }
  ])("resumes $route from its terminal checkpoint without preflighting or running agents", async ({ route, outputs, cursor }) => {
    const initial = await scenario(outputs, [], config => { config.checks = []; }, {}, route);
    const completed = initial.engine.getState()!;
    expect(completed.latestCheckpoint?.cursor).toBe(cursor);
    const persisted = JSON.parse(await readFile(path.join(completed.runDir, "state.json"), "utf8"));
    persisted.status = "failed";
    persisted.stage = "failed";
    persisted.message = "Simulated interruption after terminal checkpoint";
    delete persisted.completedAt;
    await writeFile(path.join(completed.runDir, "state.json"), JSON.stringify(persisted));

    const resumedAgent = new QueueAgent([]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: resumedAgent, enforceWorkspacePolicy: false });

    await resumed.resume(completed.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls).toHaveLength(0);
    expect(resumedAgent.preflight).not.toHaveBeenCalled();
  });

  it("runs tests-only without Builder or Documenter", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("tests_only", ["test.ts"]), approved, tester],
      [true, true],
      undefined,
      {},
      "tests_only"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "tester"]);
  });

  it("stops tests-only before mutation when the baseline is red", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("tests_only", ["test.ts"]), approved],
      [false],
      undefined,
      {},
      "tests_only"
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.message).toContain("requires a green baseline before mutation");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer"]);
  });

  it.each(["quick_implementation", "bug_fix", "documentation_only"] as const)(
    "rejects a red baseline before route mutation for %s",
    async route => {
      const files = route === "documentation_only" ? ["README.md"] : ["src/index.ts"];
      const { engine, agent } = await scenario(
        [explorer, routePlan(route, files), approved],
        [false],
        undefined,
        {},
        route
      );

      expect(engine.getState()?.status).toBe("failed");
      expect(engine.getState()?.message).toContain(`${route} requires a green baseline before mutation`);
      expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer"]);
    }
  );

  it("resumes final delivery approval for a tests-only route", async () => {
    const initial = await scenario(
      [explorer, routePlan("tests_only", ["test.ts"]), approved, tester],
      [true, true],
      config => { config.humanInTheLoop.importantDecisions = true; config.humanInTheLoop.finalDeliveryApproval = true; },
      {},
      "tests_only"
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("final_delivery");

    const resumedAgent = new QueueAgent([]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select: vi.fn(async () => "Finish delivery"),
        input: vi.fn(),
        editor: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls).toHaveLength(0);
    expect(resumedAgent.preflight).toHaveBeenCalledOnce();
    expect((resumedAgent.preflight.mock.calls[0] as unknown[])[5]).toEqual([
      "explorer", "planner", "reviewer", "tester", "debugger"
    ]);
  });

  it("resumes a canonical dashboard approval at an exhausted final-change limit", async () => {
    const initial = await scenario(
      [explorer, routePlan("tests_only", ["test.ts"]), approved, tester],
      [true, true],
      config => {
        config.limits.planRevisions = 0;
        config.humanInTheLoop.importantDecisions = true;
        config.humanInTheLoop.finalDeliveryApproval = true;
      },
      {},
      "tests_only"
    );
    const paused = initial.engine.getState()!;
    const checkpointStore = new CheckpointStore(paused.runDir, paused.runId);
    const checkpoint = (await checkpointStore.loadLatest())!;
    expect(checkpoint.cursor.kind).toBe("human_decision_pending");
    if (checkpoint.cursor.kind !== "human_decision_pending") throw new Error("Expected a pending final-delivery decision");
    const request = checkpoint.cursor.continuation.request;
    const { schemaVersion: _schemaVersion, checkpointNumber: _checkpointNumber, ...checkpointWrite } = checkpoint;
    await checkpointStore.save({
      ...checkpointWrite,
      cursor: {
        kind: "human_decision_recorded",
        continuation: {
          request,
          recorded: {
            schemaVersion: 1,
            requestId: request.id,
            decidedAt: new Date().toISOString(),
            source: "dashboard",
            action: "finish"
          }
        }
      }
    });

    const resumedAgent = new QueueAgent([]);
    const resumedChecks = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: resumedChecks,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls).toHaveLength(0);
    expect(resumedChecks).not.toHaveBeenCalled();
  });

  it("runs documentation-only without Tester or Builder", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("documentation_only", ["README.md"]), approved, documentationOnlyOutput],
      [true, true],
      undefined,
      {},
      "documentation_only"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "documenter"]);
  });

  it.each([
    {
      route: "tests_only" as const,
      files: ["test.ts"],
      routeOutput: tester,
      diagnosis: json({
        category: "test_defect",
        rootCause: "new test has a stale assertion",
        evidence: [{ path: "test.ts", detail: "assertion uses the old value" }],
        recommendedFix: "repair the assertion",
        affectedFiles: ["test.ts"],
        confidence: "high"
      }),
      role: "tester"
    },
    {
      route: "documentation_only" as const,
      files: ["README.md"],
      routeOutput: documentationOnlyOutput,
      diagnosis: json({
        category: "implementation_defect",
        rootCause: "documentation check rejects a malformed example",
        evidence: [{ path: "README.md", detail: "example syntax is invalid" }],
        recommendedFix: "repair the example",
        affectedFiles: ["README.md"],
        confidence: "high"
      }),
      role: "documenter"
    }
  ])("repairs $route final-check failures with its specialized agent", async ({ route, files, routeOutput, diagnosis, role }) => {
    const { engine, agent } = await scenario(
      [explorer, routePlan(route, files), approved, routeOutput, diagnosis, routeOutput],
      [true, false, true],
      undefined,
      {},
      route
    );

    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", role, "debugger", role]);
    const repairTask = JSON.parse(agent.calls.at(-1)!.task).task;
    expect(repairTask).toMatchObject({ action: "repair_checks", attempt: 1 });
    expect(repairTask.diagnosis.affectedFiles).toEqual(files);
  });

  it("resumes a tests-only final change request through specialized planning and execution", async () => {
    const initial = await scenario(
      [explorer, routePlan("tests_only", ["test.ts"]), approved, tester],
      [true, true],
      config => { config.humanInTheLoop.importantDecisions = true; config.humanInTheLoop.finalDeliveryApproval = true; },
      {},
      "tests_only"
    );
    const paused = initial.engine.getState()!;
    expect(paused.pendingDecision?.kind).toBe("final_delivery");

    const revisedPlan = json({
      ...JSON.parse(routePlan("tests_only", ["test.ts"])),
      summary: "tighten the requested tests"
    });
    const resumedAgent = new QueueAgent([revisedPlan, tester]);
    const select = vi.fn()
      .mockResolvedValueOnce("Request changes")
      .mockResolvedValueOnce("Approve revised plan")
      .mockResolvedValueOnce("Finish delivery");
    const input = vi.fn(async () => "Add the missing edge-case assertion");
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select,
        input,
        editor: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["planner", "tester"]);
    expect(JSON.parse(resumedAgent.calls[0].task).task).toMatchObject({
      action: "revise_plan",
      route: "tests_only",
      feedback: { source: "human", text: "Add the missing edge-case assertion" }
    });
    expect(JSON.parse(resumedAgent.calls[1].task).task.action).toBe("create_tests");
    expect(select).toHaveBeenCalledTimes(3);
  });

  it("handles a tests-only final change request through the dashboard", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-dashboard-final-changes-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = true;
    config.humanInTheLoop.finalDeliveryApproval = true;
    await saveConfig(cwd, config);
    const revisedPlan = json({
      ...JSON.parse(routePlan("tests_only", ["test.ts"])),
      summary: "tighten the requested tests"
    });
    const agent = new QueueAgent([
      explorer,
      routePlan("tests_only", ["test.ts"]),
      approved,
      tester,
      revisedPlan,
      tester
    ]);
    const checkQueue = [[check(true)], [check(true)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const piPromptSignals: AbortSignal[] = [];
    const select = vi.fn((_title: string, _options: string[], interactionOptions?: { signal?: AbortSignal }) => new Promise<string | undefined>((_resolve, reject) => {
      const signal = interactionOptions?.signal;
      if (!signal) return;
      piPromptSignals.push(signal);
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, input: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: agent,
      checkRunner,
      openBrowser: vi.fn(),
      enforceWorkspacePolicy: false
    });
    const dashboardUrl = await engine.startDashboard(cwd);
    const events = await fetch(`${dashboardUrl}/events`);
    const reader = events.body!.getReader();
    await reader.read();

    const submit = async (action: "approve" | "request_changes" | "finish", feedback?: string): Promise<void> => {
      await vi.waitFor(() => expect(engine.getState()?.pendingDecision?.id).toBeTruthy(), { timeout: 10_000 });
      const id = engine.getState()!.pendingDecision!.id;
      await vi.waitFor(async () => {
        expect((await fetch(`${dashboardUrl}/api/decisions/${encodeURIComponent(id)}/preview`)).status).toBe(200);
      }, { timeout: 10_000 });
      const response = await fetch(`${dashboardUrl}/api/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action, feedback })
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() => expect(engine.getState()?.pendingDecision?.id).not.toBe(id), { timeout: 10_000 });
    };

    try {
      const running = engine.start({ route: "tests_only", request: "request" }, ctx);
      await submit("request_changes", "Add the missing edge-case assertion");
      await vi.waitFor(() => expect(engine.getState()?.pendingDecision?.kind).toBe("final_revision_approval"), { timeout: 10_000 });
      await submit("approve");
      await vi.waitFor(() => expect(engine.getState()?.pendingDecision?.kind).toBe("final_delivery"), { timeout: 10_000 });
      await submit("finish");
      await running;

      expect(engine.getState()?.status).toBe("completed");
      expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "tester", "planner", "tester"]);
      expect(JSON.parse(agent.calls.filter(call => call.name === "planner")[1].task).task).toMatchObject({
        action: "revise_plan",
        feedback: { source: "human", text: "Add the missing edge-case assertion" }
      });
      const checkpointFiles = (await readdir(engine.getState()!.runDir)).filter(file => /^checkpoint-\d+\.json$/.test(file));
      const recordedActions: string[] = [];
      for (const file of checkpointFiles) {
        const checkpoint = JSON.parse(await readFile(path.join(engine.getState()!.runDir, file), "utf8")) as {
          cursor?: { kind?: string; continuation?: { recorded?: { action?: string; source?: string } } };
        };
        if (checkpoint.cursor?.kind === "human_decision_recorded" && checkpoint.cursor.continuation?.recorded?.source === "dashboard") {
          recordedActions.push(checkpoint.cursor.continuation.recorded.action ?? "");
        }
      }
      expect(recordedActions).toEqual(expect.arrayContaining(["request_changes", "approve", "finish"]));
      expect(recordedActions).not.toContain("revise");
      expect(piPromptSignals).toHaveLength(3);
      expect(piPromptSignals.every(signal => signal.aborted)).toBe(true);
    } finally {
      await reader.cancel();
      await engine.shutdown(ctx);
    }
  });

  it("skips test-first generation for quick implementation", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("quick_implementation"), approved, builder, approved, documenter, approved],
      [true, true, true],
      undefined,
      {},
      "quick_implementation"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).not.toContain("tester");
  });

  it("diagnoses a bug before regression tests and implementation", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput, tester, builder, approved, documenter, approved],
      [true, false, true, true],
      undefined,
      {},
      "bug_fix"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual([
      "explorer", "planner", "reviewer", "debugger", "tester", "builder", "reviewer", "documenter", "reviewer"
    ]);
  });

  it("finishes bug-fix delivery when the dashboard approves", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-dashboard-final-delivery-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = true;
    config.humanInTheLoop.finalDeliveryApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([
      explorer,
      routePlan("bug_fix"),
      approved,
      debuggerOutput,
      tester,
      builder,
      approved,
      documenter,
      approved
    ]);
    const checkQueue = [[check(true)], [check(false)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: agent,
      checkRunner,
      openBrowser: vi.fn(),
      enforceWorkspacePolicy: false
    });
    const dashboardUrl = await engine.startDashboard(cwd);
    const events = await fetch(`${dashboardUrl}/events`);
    const reader = events.body!.getReader();
    await reader.read();

    try {
      const running = engine.start({ route: "bug_fix", request: "request" }, ctx);
      await vi.waitFor(() => {
        expect(engine.getState()?.pendingDecision?.kind).toBe("final_delivery");
        expect(engine.getState()?.pendingDecision?.id).toBeTruthy();
      }, { timeout: 10_000 });
      const decisionId = engine.getState()!.pendingDecision!.id;
      await vi.waitFor(async () => {
        expect((await fetch(`${dashboardUrl}/api/decisions/${encodeURIComponent(decisionId)}/preview`)).status).toBe(200);
      }, { timeout: 10_000 });
      const response = await fetch(`${dashboardUrl}/api/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: decisionId, action: "finish" })
      });
      expect(response.status).toBe(200);
      await running;

      expect(engine.getState()?.status).toBe("completed");
      expect(agent.calls.filter(call => call.name === "planner")).toHaveLength(1);
      expect(engine.getState()?.steps.some(step => step.label === "Plan requested final changes")).toBe(false);
      const checkpointFiles = (await readdir(engine.getState()!.runDir)).filter(file => /^checkpoint-\d+\.json$/.test(file));
      const recordedActions: string[] = [];
      for (const file of checkpointFiles) {
        const checkpoint = JSON.parse(await readFile(path.join(engine.getState()!.runDir, file), "utf8")) as {
          cursor?: { kind?: string; continuation?: { recorded?: { action?: string; source?: string } } };
        };
        if (checkpoint.cursor?.kind === "human_decision_recorded" && checkpoint.cursor.continuation?.recorded?.source === "dashboard") {
          recordedActions.push(checkpoint.cursor.continuation.recorded.action ?? "");
        }
      }
      expect(recordedActions).toContain("finish");
      expect(recordedActions).not.toContain("approve");
    } finally {
      await reader.cancel();
      await engine.shutdown(ctx);
    }
  });

  it("pauses for required bug diagnosis approval before mutation", async () => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput],
      [true],
      config => { config.humanInTheLoop.diagnosisApproval = "always"; },
      {},
      "bug_fix"
    );

    const state = engine.getState()!;
    expect(state.status).toBe("paused");
    expect(state.pendingDecision?.kind).toBe("bug_diagnosis_approval");
    expect(state.pendingDecision?.resume).toEqual({ point: "bug_diagnosis_decision", scopeRevisionCount: 0 });
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "debugger"]);
  });

  it("resumes approved bug diagnosis without rerunning Debugger or baseline checks", async () => {
    const initial = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput],
      [true],
      config => { config.humanInTheLoop.diagnosisApproval = "always"; },
      {},
      "bug_fix"
    );
    const paused = initial.engine.getState()!;
    const resumedAgent = new QueueAgent([tester, builder, approved, documenter, approved]);
    const checkQueues = [[check(false)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => checkQueues.shift() ?? [check(true)]) as unknown as CheckRunner;
    const select = vi.fn(async () => "Approve diagnosis");
    const editor = vi.fn(async () => "reviewed");
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: { select, editor, input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, enforceWorkspacePolicy: false });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["tester", "builder", "reviewer", "documenter", "reviewer"]);
    expect(resumedAgent.calls.filter(call => call.name === "debugger")).toHaveLength(0);
    expect(checkRunner).toHaveBeenCalledTimes(3);
    const testerTask = JSON.parse(resumedAgent.calls.find(call => call.name === "tester")!.task).task;
    expect(testerTask.diagnosis).toEqual(JSON.parse(debuggerOutput));
    expect(editor).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledOnce();
    expect(resumedAgent.preflight).toHaveBeenCalledOnce();
  });

  it("resumes from the diagnosis-ready checkpoint without rerunning Debugger", async () => {
    const initial = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput],
      [true],
      config => { config.humanInTheLoop.diagnosisApproval = "always"; },
      {},
      "bug_fix"
    );
    const paused = initial.engine.getState()!;
    const checkpointFiles = (await readdir(paused.runDir)).filter(file => /^checkpoint-\d+\.json$/.test(file));
    let diagnosisReady: Record<string, unknown> | undefined;
    for (const file of checkpointFiles) {
      const checkpoint = JSON.parse(await readFile(path.join(paused.runDir, file), "utf8")) as Record<string, unknown>;
      const cursor = checkpoint.cursor as { kind?: string } | undefined;
      if (cursor?.kind === "bug_diagnosis_ready") diagnosisReady = checkpoint;
    }
    expect(diagnosisReady).toBeDefined();
    const { schemaVersion: _schemaVersion, checkpointNumber: _checkpointNumber, ...checkpointWrite } = diagnosisReady!;
    await new CheckpointStore(paused.runDir, paused.runId).save(checkpointWrite as CheckpointWrite);

    const resumedAgent = new QueueAgent([]);
    resumedAgent.preflight.mockRejectedValue(new Error("mutation agents are unavailable"));
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select: vi.fn(async () => "Cancel workflow"),
        editor: vi.fn(async () => "reviewed"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("cancelled");
    expect(resumedAgent.calls.filter(call => call.name === "debugger")).toHaveLength(0);
    expect(resumedAgent.preflight).not.toHaveBeenCalled();
  });

  it("consumes a recorded diagnosis approval without reopening the prompt", async () => {
    const diagnosis = json({
      ...JSON.parse(debuggerOutput),
      affectedFiles: ["src/index.ts", "src/App.test.ts"]
    });
    const initial = await scenario(
      [explorer, routePlan("bug_fix"), approved, diagnosis],
      [true],
      config => { config.humanInTheLoop.diagnosisApproval = "always"; },
      {},
      "bug_fix"
    );
    const paused = initial.engine.getState()!;
    const firstResumeAgent = new QueueAgent([]);
    const firstPi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const firstCtx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select: vi.fn(async () => "Approve diagnosis"),
        editor: vi.fn(async () => "reviewed"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const firstResume = new Orchestrator(firstPi, path.resolve("."), {
      agentExecutor: firstResumeAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await firstResume.resume(paused.runId, firstCtx);

    expect(firstResume.getState()?.status).toBe("failed");
    expect(firstResume.getState()?.latestCheckpoint?.cursor).toBe("human_decision_recorded");

    const basePlan = JSON.parse(routePlan("bug_fix"));
    const revisedPlan = json({
      ...basePlan,
      tasks: [
        ...basePlan.tasks,
        {
          id: "update-integration-test",
          description: "update the stale integration assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const resumedAgent = new QueueAgent([revisedPlan, approved, tester, builder, approved, documenter, approved]);
    const checks = [[check(false)], [check(true)], [check(true)]];
    const select = vi.fn(async () => "Cancel workflow");
    const editor = vi.fn(async () => "reviewed");
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: { select, editor, input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checks.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.filter(call => call.name === "debugger")).toHaveLength(0);
    expect(select).not.toHaveBeenCalled();
    expect(editor).not.toHaveBeenCalled();
  });

  it("cancels bug diagnosis approval before mutation agents run", async () => {
    const initial = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput],
      [true],
      config => { config.humanInTheLoop.diagnosisApproval = "always"; },
      {},
      "bug_fix"
    );
    const paused = initial.engine.getState()!;
    const resumedAgent = new QueueAgent([]);
    resumedAgent.preflight.mockRejectedValue(new Error("mutation agents are unavailable"));
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select: vi.fn(async () => "Cancel workflow"),
        editor: vi.fn(async () => "reviewed"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("cancelled");
    expect(resumedAgent.calls).toHaveLength(0);
    expect(resumedAgent.preflight).not.toHaveBeenCalled();
  });

  it("keeps mutation confirmation separate from bug diagnosis approval", async () => {
    const initial = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput],
      [true],
      config => {
        config.humanInTheLoop.diagnosisApproval = "always";
        config.humanInTheLoop.confirmBeforeMutation = true;
      },
      {},
      "bug_fix"
    );
    const paused = initial.engine.getState()!;
    const resumedAgent = new QueueAgent([]);
    const select = vi.fn()
      .mockResolvedValueOnce("Approve diagnosis")
      .mockResolvedValueOnce("Cancel workflow");
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select,
        editor: vi.fn(async () => "reviewed"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("cancelled");
    expect(select).toHaveBeenCalledTimes(2);
    expect(resumedAgent.calls).toHaveLength(0);
  });

  it("requires balanced diagnosis approval only for low confidence", async () => {
    const lowConfidenceDiagnosis = json({ ...JSON.parse(debuggerOutput), confidence: "low" });
    const low = await scenario(
      [explorer, routePlan("bug_fix"), approved, lowConfidenceDiagnosis],
      [true],
      config => { config.humanInTheLoop.diagnosisApproval = "low_confidence"; },
      {},
      "bug_fix"
    );
    expect(low.engine.getState()?.pendingDecision?.kind).toBe("bug_diagnosis_approval");

    const high = await scenario(
      [explorer, routePlan("bug_fix"), approved, debuggerOutput, tester, builder, approved, documenter, approved],
      [true, false, true, true],
      config => { config.humanInTheLoop.diagnosisApproval = "low_confidence"; },
      {},
      "bug_fix"
    );
    expect(high.engine.getState()?.status).toBe("completed");
  });

  it.each([
    json({
      category: "environment_error",
      rootCause: "required service is unavailable",
      evidence: [{ path: "src/index.ts", detail: "connection refused" }],
      recommendedFix: "restore the service",
      affectedFiles: ["src/index.ts"],
      confidence: "high"
    }),
    json({
      category: "unknown",
      rootCause: "no repository cause was identified",
      evidence: [{ path: "src/index.ts", detail: "evidence is inconclusive" }],
      recommendedFix: "gather more evidence",
      affectedFiles: [],
      confidence: "low"
    })
  ])("rejects a non-actionable bug diagnosis before Tester or Builder", async diagnosis => {
    const { engine, agent } = await scenario(
      [explorer, routePlan("bug_fix"), approved, diagnosis],
      [true],
      undefined,
      {},
      "bug_fix"
    );

    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.message).toContain("Bug diagnosis is not actionable as a repository mutation");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "debugger"]);
  });

  it("expands bug-fix scope from the initial diagnosis before mutation", async () => {
    const diagnosis = json({
      category: "test_defect",
      rootCause: "integration assertion still encodes the old behavior",
      evidence: [{ path: "src/App.test.ts", detail: "assertion expects the old value" }],
      recommendedFix: "update the integration assertion",
      affectedFiles: ["src/index.ts", "src/App.test.ts"],
      confidence: "high"
    });
    const bugPlan = JSON.parse(routePlan("bug_fix"));
    const revisedPlan = json({
      ...bugPlan,
      tasks: [
        ...bugPlan.tasks,
        {
          id: "update-integration-test",
          description: "update the stale integration assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const { engine, agent } = await scenario(
      [explorer, routePlan("bug_fix"), approved, diagnosis, revisedPlan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true],
      config => { config.humanInTheLoop.importantDecisions = false; },
      {},
      "bug_fix"
    );

    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual([
      "explorer", "planner", "reviewer", "debugger", "planner", "reviewer", "tester", "builder", "reviewer", "documenter", "reviewer"
    ]);
    const revisionTask = JSON.parse(agent.calls.filter(call => call.name === "planner")[1].task).task;
    expect(revisionTask).toMatchObject({ action: "revise_for_failure", requiredFiles: ["src/App.test.ts"] });
    const testerTask = JSON.parse(agent.calls.find(call => call.name === "tester")!.task).task;
    expect(testerTask.diagnosis.affectedFiles).toEqual(["src/index.ts", "src/App.test.ts"]);
    expect(testerTask.plan.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ files: ["src/App.test.ts"] })
    ]));
  });

  it("fails before checks when Planner changes the user-selected route", async () => {
    const { engine, agent } = await scenario(
      [explorer, reviewOnlyPlan],
      [],
      config => { config.checks = []; },
      {},
      "implementation"
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner"]);
  });

  it("completes an immediate first-pass flow with ordered unique artifacts", async () => {
    const { engine, cwd } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true]
    );
    const state = engine.getState()!;
    expect(state.status).toBe("completed");
    expect(state.steps.map(step => step.sequence)).toEqual(state.steps.map((_, index) => index + 1));
    const artifacts = state.steps.flatMap(step => step.artifact ? [step.artifact] : []);
    expect(new Set(artifacts).size).toBe(artifacts.length);
    expect(await readdir(state.runDir)).toEqual(expect.arrayContaining(["state.json", "manifest.json", "plan.json"]));
    expect(state.runDir.startsWith(cwd)).toBe(true);
  });

  it("runs the complete mutation phase in a worktree and syncs only after final checks", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-isolation-"));
    directories.push(cwd);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(cwd, "README.md"), "# Project\n");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });

    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.worktreeIsolation = true;
    await saveConfig(cwd, config);

    class MutatingAgent extends QueueAgent {
      override async run(options: AgentRunOptions): Promise<AgentResult> {
        if (options.name === "tester") {
          await mkdir(path.join(options.cwd, "tests"), { recursive: true });
          await writeFile(path.join(options.cwd, "tests", "index.test.ts"), "test('value', () => {});\n");
        } else if (options.name === "builder") {
          expect(await readFile(path.join(cwd, "src", "index.ts"), "utf8")).toContain("value = 1");
          await writeFile(path.join(options.cwd, "src", "index.ts"), "export const value = 2;\n");
        } else if (options.name === "documenter") {
          await writeFile(path.join(options.cwd, "README.md"), "# Project\n\nUpdated.\n");
        }
        return super.run(options);
      }
    }
    const isolatedPlan = json({
      route: "implementation",
      summary: "implement",
      assumptions: [],
      acceptanceCriteria: ["check passes"],
      automatedAcceptanceCriteria: [0],
      tasks: [{ id: "one", description: "change", files: ["src/index.ts", "tests/index.test.ts", "README.md"], dependencies: [], verification: ["check"] }],
      risks: []
    });
    const isolatedTester = json({
      ...JSON.parse(tester),
      changedFiles: ["tests/index.test.ts"]
    });
    const isolatedDocumenter = json({
      ...JSON.parse(documenter),
      changedFiles: ["README.md"]
    });
    const agent = new MutatingAgent([explorer, isolatedPlan, approved, isolatedTester, builder, approved, isolatedDocumenter, approved]);
    const checkCwds: string[] = [];
    const checkRunner = vi.fn(async (_commands, checkCwd: string) => {
      checkCwds.push(checkCwd);
      return [check(true)];
    }) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner });
    await engine.start({ route: "implementation", request: "request" }, ctx);

    expect(engine.getState()?.status).toBe("completed");
    expect(await readFile(path.join(cwd, "src", "index.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(path.join(cwd, "tests", "index.test.ts"), "utf8")).toContain("value");
    expect(agent.calls.filter(call => ["tester", "builder", "documenter"].includes(call.name)).every(call => call.cwd !== cwd)).toBe(true);
    expect(checkCwds[0]).toBe(cwd);
    expect(checkCwds.slice(1).every(checkCwd => checkCwd !== cwd)).toBe(true);
    const builderStep = engine.getState()!.steps.find(step => step.agent === "builder")!;
    const builderInvocation = builderStep.invocations![0];
    expect(builderInvocation).toMatchObject({ changedFileCount: 1 });
    const builderDiff = JSON.parse(await readFile(path.join(engine.getState()!.runDir, builderInvocation.fileDiffArtifact!), "utf8"));
    expect(builderDiff).toMatchObject({ status: "available", changedFiles: ["src/index.ts"] });
    expect(await readFile(path.join(engine.getState()!.runDir, builderInvocation.filePatchArtifact!), "utf8")).toContain("value = 2");
  }, 20_000);

  it("corrects a Documenter report that copies Builder changed files without rerunning mutation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-documenter-correction-"));
    directories.push(cwd);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, "tests"), { recursive: true });
    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(cwd, "tests", "index.test.ts"), "test('value', () => {});\n");
    await writeFile(path.join(cwd, "README.md"), "# Project\n");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });

    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.worktreeIsolation = true;
    await saveConfig(cwd, config);

    const correctionPlan = json({
      route: "quick_implementation",
      summary: "implement",
      assumptions: [],
      acceptanceCriteria: ["check passes"],
      automatedAcceptanceCriteria: [0],
      tasks: [{ id: "one", description: "change", files: ["src/index.ts", "README.md"], dependencies: [], verification: ["check"] }],
      risks: []
    });
    const incorrectDocumenter = json({
      ...JSON.parse(documenter),
      changedFiles: ["src/index.ts"]
    });
    const correctedDocumenter = json({
      ...JSON.parse(documenter),
      changedFiles: []
    });

    class ReportingAgent extends QueueAgent {
      override async run(options: AgentRunOptions): Promise<AgentResult> {
        const envelope = JSON.parse(options.task);
        if (options.name === "builder" && envelope.mode === "execute") {
          await writeFile(path.join(options.cwd, "src", "index.ts"), "export const value = 2;\n");
        }
        return super.run(options);
      }
    }
    const agent = new ReportingAgent([
      explorer,
      correctionPlan,
      approved,
      builder,
      approved,
      incorrectDocumenter,
      correctedDocumenter,
      approved
    ]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner });
    await engine.start({ route: "quick_implementation", request: "request" }, ctx);

    expect(engine.getState()?.status).toBe("completed");
    const documenterCalls = agent.calls.filter(call => call.name === "documenter");
    expect(documenterCalls).toHaveLength(2);
    expect(JSON.parse(documenterCalls[1].task)).toMatchObject({
      mode: "correct_output",
      correction: {
        attempt: 1,
        reason: "reported_changed_files_mismatch",
        fieldPath: "changedFiles",
        expectedChangedFiles: []
      }
    });
    expect(documenterCalls[1].config.tools).not.toContain("write");
    expect(documenterCalls[1].config.tools).not.toContain("edit");
    const documenterStep = engine.getState()!.steps.find(step => step.agent === "documenter")!;
    const mutation = JSON.parse(await readFile(path.join(engine.getState()!.runDir, documenterStep.mutationArtifact!), "utf8"));
    expect(mutation).toMatchObject({
      reported: [],
      actual: { changedFiles: [] },
      violations: [],
      correction: {
        attempted: true,
        initialReported: ["src/index.ts"],
        expectedChangedFiles: []
      }
    });
    expect(await readFile(path.join(cwd, "src", "index.ts"), "utf8")).toContain("value = 2");
  }, 20_000);

  it("sends every role a stable version-4 task envelope", async () => {
    const { agent } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true]
    );
    const envelopes = agent.calls.map(call => ({ name: call.name, envelope: JSON.parse(call.task) }));
    expect(envelopes.every(({ envelope }) => envelope.taskSchemaVersion === 4 && envelope.mode === "execute")).toBe(true);
    expect(envelopes.every(({ envelope }) => Object.hasOwn(envelope, "memoryContext"))).toBe(true);
    expect(envelopes.every(({ envelope }) => Object.hasOwn(envelope, "task"))).toBe(true);

    expect(envelopes.find(({ name }) => name === "planner")?.envelope.task.action).toBe("create_plan");
    const testerTask = envelopes.find(({ name }) => name === "tester")!.envelope.task;
    expect(testerTask.acceptanceCriteria).toEqual([{ index: 0, text: "check passes" }]);
    expect(testerTask.baselineChecks).toHaveLength(1);

    const codeReview = envelopes.find(({ name, envelope }) => name === "reviewer" && envelope.task.reviewType === "code")!.envelope.task;
    expect(codeReview.tester.acceptanceCoverage).toHaveLength(1);
    expect(codeReview.baseline.artifacts.baselineJson).toMatch(/\.pi\/orchestrator\/runs\/.+\/baseline\.json$/);

    const documenterTask = envelopes.find(({ name }) => name === "documenter")!.envelope.task;
    expect(documenterTask.approvalSource).toBe("reviewer");
    expect(documenterTask.action).toBe("document");
  });

  it("exhausts plan revisions without mutating agents", async () => {
    const { engine, agent } = await scenario([explorer, plan, changes], [], config => { config.limits.planRevisions = 0; });
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.failedStage).toBe("reviewing_plan");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("pauses for red baseline repair approval before tester or builder mutation", async () => {
    const { engine, agent } = await scenario([explorer, plan, approved, debuggerOutput, plan], [false]);
    expect(engine.getState()?.status).toBe("paused");
    expect(engine.getState()?.pendingDecision?.kind).toBe("baseline_repair_approval");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("proposes a baseline repair plan and continues after human approval", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-baseline-repair-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([
      explorer, plan, approved,
      debuggerOutput, plan,
      builder, tester, builder, approved, documenter, approved
    ]);
    const checkResults = [[check(false)], [check(true)], [check(true)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => {
      const next = checkResults.shift();
      if (!next) throw new Error("Missing fake checks");
      return next;
    }) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const editor = vi.fn(async () => "viewed");
    const select = vi.fn()
      .mockResolvedValueOnce("Approve plan")
      .mockResolvedValueOnce("Defer all");
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { select, editor, input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(2); // repair + feature
    expect(agent.calls.filter(c => c.name === "debugger")).toHaveLength(1);
    expect(editor).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2); // baseline repair + memory approval
  });

  it("resumes pending baseline repair approval without regenerating its plan", async () => {
    const initial = await scenario(
      [explorer, plan, approved, debuggerOutput, plan],
      [false]
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("baseline_repair_approval");

    const resumedAgent = new QueueAgent([builder, tester, builder, approved, documenter, approved]);
    const checkQueue = [[check(true)], [check(true)], [check(true)], [check(true)]];
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const editor = vi.fn(async () => "viewed");
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        editor,
        select: vi.fn()
          .mockResolvedValueOnce("Approve plan")
          .mockResolvedValueOnce("Finish delivery"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(editor).not.toHaveBeenCalled();
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["builder", "tester", "builder", "reviewer", "documenter", "reviewer"]);
  });

  it("opens browser dashboard when enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-dashboard-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, approved, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const openBrowser = vi.fn();
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, openBrowser, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(engine.getState()?.dashboardUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(openBrowser).toHaveBeenCalledOnce();
    expect(openBrowser).toHaveBeenCalledWith(engine.getState()?.dashboardUrl);
  });

  it("does not open browser when dashboard is disabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-no-dashboard-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, approved, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const openBrowser = vi.fn();
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, openBrowser, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(engine.getState()?.dashboardUrl).toBeUndefined();
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("resumes a paused run and starts the dashboard and opens the browser when enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-resume-dashboard-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    const occupiedPort = createServer();
    await new Promise<void>((resolve, reject) => {
      occupiedPort.once("error", reject);
      occupiedPort.listen(0, "127.0.0.1", resolve);
    });
    const occupiedAddress = occupiedPort.address();
    if (!occupiedAddress || typeof occupiedAddress === "string") throw new Error("Expected occupied TCP port");
    config.dashboard.enabled = true;
    config.dashboard.port = occupiedAddress.port;
    config.humanInTheLoop.importantDecisions = true;
    config.humanInTheLoop.finalDeliveryApproval = true;
    await saveConfig(cwd, config);

    const agent = new QueueAgent([explorer, routePlan("tests_only", ["test.ts"]), approved, tester]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const openBrowser1 = vi.fn();
    const pi1 = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx1 = { cwd, hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    const engine1 = new Orchestrator(pi1, path.resolve("."), { agentExecutor: agent, checkRunner, openBrowser: openBrowser1, enforceWorkspacePolicy: false });
    await engine1.start({ route: "tests_only", request: "request" }, ctx1);

    const paused = engine1.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("final_delivery");
    expect(paused.dashboardUrl).toBeUndefined();
    expect(openBrowser1).not.toHaveBeenCalled();

    await engine1.shutdown();
    await new Promise<void>(resolve => occupiedPort.close(() => resolve()));

    const resumedAgent = new QueueAgent([]);
    const openBrowser2 = vi.fn();
    const pi2 = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    let resumedDecisionId: string | undefined;
    let engine2: Orchestrator;
    const ctx2 = {
      cwd,
      hasUI: true,
      ui: {
        select: vi.fn(async () => {
          resumedDecisionId = engine2.getState()?.pendingDecision?.id;
          return "Finish delivery";
        }),
        input: vi.fn(),
        editor: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    engine2 = new Orchestrator(pi2, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, openBrowser: openBrowser2, enforceWorkspacePolicy: false });
    await engine2.resume(paused.runId, ctx2);

    expect(engine2.getState()?.status).toBe("completed");
    expect(resumedAgent.calls).toHaveLength(0);

    const resumedUrl = engine2.getState()?.dashboardUrl;
    expect(resumedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(openBrowser2).toHaveBeenCalledOnce();
    expect(openBrowser2).toHaveBeenCalledWith(resumedUrl);
    expect(resumedDecisionId).toBeTruthy();
    const staleResponse = await fetch(`${resumedUrl}/api/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: resumedDecisionId, action: "finish" }),
    });
    expect(staleResponse.status).toBe(409);
  });

  it("clears stale dashboardUrl and does not open browser when dashboard is disabled on resume", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-resume-no-dashboard-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.importantDecisions = true;
    config.humanInTheLoop.finalDeliveryApproval = true;
    await saveConfig(cwd, config);

    const agent = new QueueAgent([explorer, routePlan("tests_only", ["test.ts"]), approved, tester]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const openBrowser1 = vi.fn();
    const pi1 = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx1 = { cwd, hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    const engine1 = new Orchestrator(pi1, path.resolve("."), { agentExecutor: agent, checkRunner, openBrowser: openBrowser1, enforceWorkspacePolicy: false });
    await engine1.start({ route: "tests_only", request: "request" }, ctx1);

    const paused = engine1.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.dashboardUrl).toBeUndefined();

    await engine1.shutdown();

    const statePath = path.join(paused.runDir, "state.json");
    const stateJson = JSON.parse(await readFile(statePath, "utf8"));
    stateJson.dashboardUrl = "http://127.0.0.1:9999";
    await writeFile(statePath, JSON.stringify(stateJson));

    const resumedAgent = new QueueAgent([]);
    const openBrowser2 = vi.fn();
    const pi2 = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx2 = {
      cwd,
      hasUI: true,
      ui: {
        select: vi.fn(async () => "Finish delivery"),
        input: vi.fn(),
        editor: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const engine2 = new Orchestrator(pi2, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, openBrowser: openBrowser2, enforceWorkspacePolicy: false });
    await engine2.resume(paused.runId, ctx2);

    expect(engine2.getState()?.status).toBe("completed");
    expect(engine2.getState()?.dashboardUrl).toBeUndefined();
    expect(openBrowser2).not.toHaveBeenCalled();
  });

  it("publishes curated session messages on a successful run", async () => {
    const { engine, sendMessage } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, true, true, true, true]
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(sendMessage).toHaveBeenCalled();
    const calls = sendMessage.mock.calls.map((c: unknown[]) => c[0] as { customType: string; details?: Record<string, unknown> });
    const kinds = calls.map(c => c.details?.kind);
    expect(kinds).toContain("started");
    expect(kinds).toContain("plan_approved");
    expect(kinds).toContain("implementation_verified");
    expect(kinds).toContain("review_approved");
    expect(kinds).toContain("documentation_updated");
    expect(kinds).toContain("completed");
    expect(engine.getState()?.milestones?.map(milestone => milestone.title)).toEqual(expect.arrayContaining([
      "Plan approved",
      "Code review complete",
      "Documentation updated",
      "Workflow completed"
    ]));
  });

  it("publishes session failure message on failed run", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-fail-message-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, json({ bad: "plan" })]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const sendMessage = vi.fn();
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx).catch(() => undefined);
    expect(engine.getState()?.status).toBe("failed");
    expect(sendMessage).toHaveBeenCalled();
    const calls = sendMessage.mock.calls.map((c: unknown[]) => c[0] as { details?: Record<string, unknown> });
    const kinds = calls.map(c => c.details?.kind);
    expect(kinds).toContain("failed");
  });

  it("recovers on a later implementation attempt without an untested extra builder", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, debuggerOutput, builder, approved, documenter, approved],
      [true, false, false, true, true],
      config => { config.limits.implementationRetries = 2; }
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(2);
    expect(agent.calls.filter(call => call.name === "debugger")).toHaveLength(1);
  });

  it("revises approved scope when diagnosis identifies an omitted integration test", async () => {
    const diagnosis = json({
      category: "test_defect",
      rootCause: "integration assertion still expects the old card count",
      evidence: [{ path: "src/App.test.ts", detail: "expected five cards but receives six" }],
      recommendedFix: "update the stale integration assertion",
      affectedFiles: ["src/App.test.ts"],
      confidence: "high"
    });
    const revisedPlan = json({
      ...JSON.parse(plan),
      tasks: [
        ...JSON.parse(plan).tasks,
        {
          id: "update-integration-test",
          description: "update the stale card-count assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, diagnosis, revisedPlan, approved, builder, approved, documenter, approved],
      [true, false, false, true, true],
      config => { config.limits.implementationRetries = 2; config.humanInTheLoop.importantDecisions = false; }
    );

    expect(engine.getState()?.status).toBe("completed");
    const plannerTasks = agent.calls.filter(call => call.name === "planner").map(call => JSON.parse(call.task).task);
    expect(plannerTasks[1]).toMatchObject({ action: "revise_for_failure", requiredFiles: ["src/App.test.ts"] });
    const secondBuilder = agent.calls.filter(call => call.name === "builder")[1];
    expect(JSON.parse(secondBuilder.task).task.plan.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ files: ["src/App.test.ts"] })
    ]));
  });

  it("expands scope and retries the same attempt when Builder reports a scope blocker", async () => {
    const blocked = json({
      summary: "blocked by omitted integration test",
      changedFiles: [],
      commands: [],
      assumptions: [],
      unresolvedIssues: ["src/App.test.ts must be updated"],
      blocker: { kind: "scope", reason: "integration assertion is stale", requiredFiles: ["src/App.test.ts"] }
    });
    const quickPlan = JSON.parse(routePlan("quick_implementation"));
    const revisedQuickPlan = json({
      ...quickPlan,
      tasks: [
        ...quickPlan.tasks,
        {
          id: "update-integration-test",
          description: "update stale integration assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const { engine, agent } = await scenario(
      [explorer, routePlan("quick_implementation"), approved, blocked, revisedQuickPlan, approved, builder, approved, documenter, approved],
      [true, true, true],
      config => { config.humanInTheLoop.importantDecisions = false; },
      {},
      "quick_implementation"
    );

    expect(engine.getState()?.status).toBe("completed");
    const builders = agent.calls.filter(call => call.name === "builder");
    expect(builders).toHaveLength(2);
    expect(JSON.parse(builders[0].task).task.attempt).toBe(1);
    expect(JSON.parse(builders[1].task).task.attempt).toBe(1);
    expect(engine.getState()?.steps.filter(step => step.stage === "testing")).toHaveLength(2);
  });

  it("corrects a failure scope revision that changes approved acceptance criteria", async () => {
    const blocked = json({
      summary: "blocked by omitted integration test",
      changedFiles: [],
      commands: [],
      assumptions: [],
      unresolvedIssues: ["src/App.test.ts must be updated"],
      blocker: { kind: "scope", reason: "integration assertion is stale", requiredFiles: ["src/App.test.ts"] }
    });
    const quickPlan = JSON.parse(routePlan("quick_implementation"));
    const revisedQuickPlan = {
      ...quickPlan,
      tasks: [
        ...quickPlan.tasks,
        {
          id: "update-integration-test",
          description: "update stale integration assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    };
    const changedCriteriaPlan = {
      ...revisedQuickPlan,
      acceptanceCriteria: [...quickPlan.acceptanceCriteria, "The integration test is updated"]
    };
    const { engine, agent } = await scenario(
      [explorer, routePlan("quick_implementation"), approved, blocked, json(changedCriteriaPlan), json(revisedQuickPlan), approved, builder, approved, documenter, approved],
      [true, true, true],
      config => { config.humanInTheLoop.importantDecisions = false; },
      {},
      "quick_implementation"
    );

    expect(engine.getState()?.status).toBe("completed");
    const plannerCalls = agent.calls.filter(call => call.name === "planner");
    expect(plannerCalls).toHaveLength(3);
    expect(JSON.parse(plannerCalls[2].task)).toMatchObject({
      mode: "correct_output",
      task: { action: "revise_for_failure", requiredFiles: ["src/App.test.ts"] },
      correction: { attempt: 1, reason: "schema_validation_failed" }
    });
    const secondBuilder = agent.calls.filter(call => call.name === "builder")[1];
    expect(JSON.parse(secondBuilder.task).task.plan.acceptanceCriteria).toEqual(quickPlan.acceptanceCriteria);
  });

  it("resumes a pending scope expansion at the blocked implementation attempt", async () => {
    const blocked = json({
      summary: "blocked by omitted integration test",
      changedFiles: [],
      commands: [],
      assumptions: [],
      unresolvedIssues: ["src/App.test.ts must be updated"],
      blocker: { kind: "scope", reason: "integration assertion is stale", requiredFiles: ["src/App.test.ts"] }
    });
    const quickPlan = JSON.parse(routePlan("quick_implementation"));
    const revisedQuickPlan = json({
      ...quickPlan,
      tasks: [
        ...quickPlan.tasks,
        {
          id: "update-integration-test",
          description: "update stale integration assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const initial = await scenario(
      [explorer, routePlan("quick_implementation"), approved, blocked, revisedQuickPlan],
      [true],
      config => { config.humanInTheLoop.importantDecisions = true; },
      {},
      "quick_implementation"
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("scope_expansion");

    const resumedAgent = new QueueAgent([builder, approved, documenter, approved]);
    const checks = [[check(true)], [check(true)]];
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const editor = vi.fn(async () => "viewed");
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        editor,
        select: vi.fn()
          .mockResolvedValueOnce("Approve plan")
          .mockResolvedValueOnce("Finish delivery"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checks.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(editor).not.toHaveBeenCalled();
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["builder", "reviewer", "documenter", "reviewer"]);
    expect(JSON.parse(resumedAgent.calls[0].task).task.attempt).toBe(1);
  });

  it("expands scope from debugger diagnosis for quick_implementation when integration test is omitted from plan", async () => {
    const quickPlan = JSON.parse(routePlan("quick_implementation"));
    const diagnosis = json({
      category: "test_defect",
      rootCause: "integration assertion still expects the old card count",
      evidence: [{ path: "src/App.test.ts", detail: "expected five cards but receives six" }],
      recommendedFix: "update the stale integration assertion",
      affectedFiles: ["src/App.test.ts"],
      confidence: "high"
    });
    const revisedPlan = json({
      ...quickPlan,
      tasks: [
        ...quickPlan.tasks,
        {
          id: "update-integration-test",
          description: "update the stale card-count assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const { engine, agent, notifications } = await scenario(
      [explorer, routePlan("quick_implementation"), approved, builder, diagnosis, revisedPlan, approved, builder, approved, documenter, approved],
      [true, false, true, true],
      config => { config.limits.implementationRetries = 2; config.humanInTheLoop.importantDecisions = false; },
      {},
      "quick_implementation"
    );

    expect(engine.getState()?.status).toBe("completed");
    const plannerTasks = agent.calls.filter(call => call.name === "planner").map(call => JSON.parse(call.task).task);
    expect(plannerTasks[1]).toMatchObject({ action: "revise_for_failure", requiredFiles: ["src/App.test.ts"] });
    const builders = agent.calls.filter(call => call.name === "builder");
    expect(builders).toHaveLength(2);
    const secondBuilderTask = JSON.parse(builders[1].task).task;
    expect(secondBuilderTask.plan.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ files: ["src/App.test.ts"] })
    ]));
  });

  it("fails immediately when a legacy Builder reports unresolved work without a structured blocker", async () => {
    const unresolved = json({
      summary: "blocked",
      changedFiles: [],
      commands: [],
      assumptions: [],
      unresolvedIssues: ["src/App.test.ts is outside the approved plan"]
    });
    const { engine, agent } = await scenario(
      [explorer, routePlan("quick_implementation"), approved, unresolved],
      [true],
      undefined,
      {},
      "quick_implementation"
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.message).toContain("Builder did not complete");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(1);
  });

  it("diagnoses the final failed implementation attempt", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder],
      [true, false, false],
      config => { config.limits.implementationRetries = 0; config.humanInTheLoop.importantDecisions = true; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(1);
    expect(agent.calls.filter(call => call.name === "debugger")).toHaveLength(1);
  });

  it("diagnoses after first failure and fails on the retry", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, debuggerOutput, builder],
      [true, false, false, false],
      config => { config.limits.implementationRetries = 1; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(2);
    expect(agent.calls.filter(call => call.name === "debugger")).toHaveLength(2);
  });

  it("resumes an approved extra implementation repair after budget exhaustion", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, debuggerOutput],
      [true, false, false],
      config => { config.limits.implementationRetries = 0; config.humanInTheLoop.importantDecisions = true; config.humanInTheLoop.finalDeliveryApproval = true; }
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("repair_budget_exhausted");

    const resumedAgent = new QueueAgent([builder, approved, documenter, approved]);
    const checks = [[check(true)], [check(true)]];
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn()
      .mockResolvedValueOnce("Allow one more repair")
      .mockResolvedValueOnce("Finish delivery");
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select,
        editor: vi.fn(),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checks.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(select).toHaveBeenCalledTimes(2);
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["builder", "reviewer", "documenter", "reviewer"]);
    expect(JSON.parse(resumedAgent.calls[0].task).task.attempt).toBe(2);
  });

  it("routes a final delivery change request through planning, implementation, checks, and review", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true],
      config => { config.humanInTheLoop.importantDecisions = true; config.humanInTheLoop.finalDeliveryApproval = true; }
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("final_delivery");

    const resumedAgent = new QueueAgent([plan, tester, builder, approved, documenter, approved]);
    const checks = [[check(true)], [check(true)]];
    const select = vi.fn()
      .mockResolvedValueOnce("Request changes")
      .mockResolvedValueOnce("Approve revised plan")
      .mockResolvedValueOnce("Finish delivery");
    const input = vi.fn(async () => "Tighten the final behavior before delivery");
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select,
        input,
        editor: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checks.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(select).toHaveBeenCalledTimes(3);
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["planner", "tester", "builder", "reviewer", "documenter", "reviewer"]);
    const plannerTask = JSON.parse(resumedAgent.calls[0].task).task;
    expect(plannerTask).toMatchObject({
      action: "revise_plan",
      feedback: { source: "human", text: "Tighten the final behavior before delivery" }
    });
  });

  it("checks a review fix and re-reviews before approval", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, changes, builder, approved, documenter, approved],
      [true, false, true, true, true],
      config => { config.limits.reviewRevisions = 1; }
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(call => call.name === "reviewer")).toHaveLength(4);
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(2);
  });

  it("pauses when code review revisions are exhausted", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, changes],
      [true, false, true],
      config => { config.limits.reviewRevisions = 0; config.humanInTheLoop.importantDecisions = true; }
    );
    expect(engine.getState()?.status).toBe("paused");
    expect(engine.getState()?.pendingDecision?.kind).toBe("code_review_rejection");
    expect(engine.getState()?.latestCheckpoint?.cursor).toBe("human_decision_pending");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(1);
  });

  it("resumes a pending code review decision without rerunning Reviewer", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, changes],
      [true, false, true],
      config => { config.limits.reviewRevisions = 0; config.humanInTheLoop.importantDecisions = true; config.humanInTheLoop.finalDeliveryApproval = true; }
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");

    const resumedAgent = new QueueAgent([documenter, approved]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn()
      .mockResolvedValueOnce("Accept current implementation")
      .mockResolvedValueOnce("Finish delivery");
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select,
        editor: vi.fn(),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["documenter", "reviewer"]);
    expect(select).toHaveBeenCalledTimes(2);
  });

  it("stores malformed agent output separately and fails the stage", async () => {
    const { engine, agent } = await scenario([explorer, "not json", "not json"], []);
    const state = engine.getState()!;
    expect(state.status).toBe("failed");
    expect(state.failedStage).toBe("planning");
    expect(state.steps[1].rawArtifact).toMatch(/invalid-output-attempt-2\.txt$/);
    expect(agent.calls.filter(c => c.name === "planner")).toHaveLength(2);
    expect(await readdir(state.runDir)).toEqual(expect.arrayContaining([
      expect.stringMatching(/invalid-output-attempt-1\.txt$/),
      expect.stringMatching(/invalid-output-attempt-2\.txt$/)
    ]));
  });

  it("recovers from malformed output on single correction retry", async () => {
    const { engine, agent } = await scenario(
      [explorer, "not json", plan, approved, tester, builder, approved, documenter, approved],
      [true, true, true, true]
    );
    const state = engine.getState()!;
    expect(state.status).toBe("completed");
    expect(state.steps[1].rawArtifact).toMatch(/invalid-output-attempt-1\.txt$/);
    expect(agent.calls.filter(c => c.name === "planner")).toHaveLength(2);
    const correctionCall = agent.calls.filter(c => c.name === "planner")[1];
    const correctionEnvelope = JSON.parse(correctionCall.task);
    expect(correctionEnvelope).toMatchObject({
      taskSchemaVersion: 4,
      mode: "correct_output",
      correction: { attempt: 1, reason: "schema_validation_failed" }
    });
    expect(correctionCall.task).not.toContain("previousOutput");
    expect(correctionCall.task).not.toContain("not json");
    const plannerStep = state.steps[1];
    expect(plannerStep.invocations).toMatchObject([
      { sequence: 1, mode: "execute", status: "succeeded", messageCount: 2 },
      { sequence: 2, mode: "correct_output", status: "succeeded", messageCount: 2 }
    ]);
    const correctionTranscript = JSON.parse(await readFile(
      path.join(state.runDir, plannerStep.invocations![1].transcriptArtifact!),
      "utf8"
    ));
    expect(correctionTranscript).toMatchObject({
      stepId: plannerStep.id,
      agent: "planner",
      invocation: 2,
      mode: "correct_output",
      status: "succeeded"
    });
  });

  it("recovers when Explorer corrects an oversized evidence detail", async () => {
    const oversizedDetail = "x".repeat(MAX_EVIDENCE_DETAIL_BYTES + 1);
    const oversizedExplorer = json({
      architecture: "small extension",
      relevantFiles: ["src/index.ts"],
      conventions: [],
      similarImplementations: [],
      commands: ["check"],
      risks: [],
      knownLessons: [],
      evidence: [{ path: "src/index.ts", detail: oversizedDetail }]
    });
    const { engine, agent } = await scenario(
      [oversizedExplorer, explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, true, true, true]
    );

    expect(engine.getState()?.status).toBe("completed");
    const explorerCalls = agent.calls.filter(call => call.name === "explorer");
    expect(explorerCalls).toHaveLength(2);
    expect(JSON.parse(explorerCalls[1].task)).toMatchObject({
      taskSchemaVersion: 4,
      mode: "correct_output",
      correction: {
        attempt: 1,
        reason: "schema_validation_failed",
        fieldPath: "explorer.evidence[0].detail"
      }
    });
    expect(explorerCalls[1].task).not.toContain("previousOutput");
    expect(explorerCalls[1].task).not.toContain(oversizedDetail);
  });

  it("strips bash from a reviewer output-correction retry", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, "not json", approved, tester, builder, approved, documenter, approved],
      [true, false, true, true]
    );
    expect(engine.getState()?.status).toBe("completed");
    const reviewerCalls = agent.calls.filter(call => call.name === "reviewer");
    expect(JSON.parse(reviewerCalls[1].task).mode).toBe("correct_output");
    expect(reviewerCalls[1].config.tools).not.toContain("bash");
  });

  it("does not rerun Tester after malformed output", async () => {
    const { engine, agent } = await scenario([explorer, plan, approved, "not json"], [true]);
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "tester")).toHaveLength(1);
  });

  it("corrects invalid Tester metadata after auditing authorized test edits", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-tester-output-correction-"));
    directories.push(cwd);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await mkdir(path.join(cwd, "tests"), { recursive: true });
    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(cwd, "tests", "index.test.ts"), "test('old', () => {});\n");
    await writeFile(path.join(cwd, "README.md"), "# Project\n");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });

    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.worktreeIsolation = false;
    await saveConfig(cwd, config);
    const correctionPlan = json({
      route: "implementation",
      summary: "implement",
      assumptions: [],
      acceptanceCriteria: ["check passes"],
      automatedAcceptanceCriteria: [0],
      tasks: [{
        id: "one",
        description: "change source, tests, and documentation",
        files: ["src/index.ts", "tests/index.test.ts", "README.md"],
        dependencies: [],
        verification: ["check"]
      }],
      risks: []
    });
    const invalidTester = json({
      ...JSON.parse(tester),
      changedFiles: ["tests/index.test.ts"],
      blocker: {
        kind: "role_handoff",
        reason: "Builder still needs to change source",
        requestedRole: "implementer",
        requestedCapability: "edit source",
        question: "Implement the production fix",
        evidence: [{ path: "src/index.ts", detail: "Current behavior is missing" }]
      }
    });
    const correctedTester = json({
      ...JSON.parse(tester),
      changedFiles: ["tests/index.test.ts"],
      blocker: null
    });
    const correctedDocumenter = json({ ...JSON.parse(documenter), changedFiles: ["README.md"] });

    class CorrectingMutatingAgent extends QueueAgent {
      override async run(options: AgentRunOptions): Promise<AgentResult> {
        const envelope = JSON.parse(options.task);
        if (options.name === "tester" && envelope.mode === "execute") {
          await writeFile(path.join(options.cwd, "tests", "index.test.ts"), "test('value', () => {});\n");
        } else if (options.name === "builder" && envelope.mode === "execute") {
          await writeFile(path.join(options.cwd, "src", "index.ts"), "export const value = 2;\n");
        } else if (options.name === "documenter" && envelope.mode === "execute") {
          await writeFile(path.join(options.cwd, "README.md"), "# Project\n\nUpdated.\n");
        }
        return super.run(options);
      }
    }

    const agent = new CorrectingMutatingAgent([
      explorer, correctionPlan, approved, invalidTester, correctedTester,
      builder, approved, correctedDocumenter, approved
    ]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner });

    await engine.start({ route: "implementation", request: "request" }, ctx);

    expect(engine.getState()?.status).toBe("completed");
    const testerCalls = agent.calls.filter(call => call.name === "tester");
    expect(testerCalls).toHaveLength(2);
    expect(JSON.parse(testerCalls[1].task)).toMatchObject({
      mode: "correct_output",
      correction: {
        reason: "schema_validation_failed",
        fieldPath: "tester.blocker.requestedRole",
        expectedChangedFiles: ["tests/index.test.ts"]
      }
    });
    expect(testerCalls[1].config.tools).not.toContain("write");
    expect(testerCalls[1].config.tools).not.toContain("edit");
    expect(await readFile(path.join(cwd, "tests", "index.test.ts"), "utf8")).toContain("value");
  }, 20_000);

  it("resolves a Tester Planner handoff once and reruns the automated subset", async () => {
    const initialPlan = json({
      ...JSON.parse(plan),
      acceptanceCriteria: ["check passes", "README is updated"],
      automatedAcceptanceCriteria: [0, 1]
    });
    const revisedPlan = json({
      ...JSON.parse(initialPlan),
      automatedAcceptanceCriteria: [0]
    });
    const blockedTester = json({
      ...JSON.parse(tester),
      acceptanceCoverage: [
        ...JSON.parse(tester).acceptanceCoverage,
        {
          criterionIndex: 1,
          criterion: "README is updated",
          status: "not_covered",
          tests: [],
          preImplementationResult: "not_run",
          evidence: "Documentation-only outcome"
        }
      ],
      unresolvedIssues: ["Criterion 2 is not automated"],
      blocker: {
        kind: "role_handoff",
        reason: "Criterion 2 is documentation-only",
        requestedRole: "planner",
        requestedCapability: "Reclassify criterion 2 as non-automated",
        question: "Remove criterion 2 from automatedAcceptanceCriteria",
        evidence: [{ path: "README.md", detail: "The criterion only requires documentation content" }]
      }
    });
    const { engine, agent } = await scenario(
      [explorer, initialPlan, approved, blockedTester, revisedPlan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true]
    );

    expect(engine.getState()?.status, engine.getState()?.message).toBe("completed");
    expect(agent.calls.filter(call => call.name === "planner")).toHaveLength(2);
    const testerCalls = agent.calls.filter(call => call.name === "tester");
    expect(testerCalls).toHaveLength(2);
    expect(JSON.parse(testerCalls[1].task).task.acceptanceCriteria).toEqual([{ index: 0, text: "check passes" }]);
  });

  it("does not rerun Builder after malformed output", async () => {
    const { engine, agent } = await scenario([explorer, plan, approved, tester, "not json"], [true, false]);
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(1);
  });

  it("gives Documenter one correction retry after malformed output", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, approved, "not json"],
      [true, false, true]
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "documenter")).toHaveLength(2);
  });

  it("treats a valid rejected lesson review as a warning", async () => {
    const { engine } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, changes],
      [true, false, true, true]
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(engine.getState()?.warning).toContain("lessons were rejected");
  });

  it("marks a failed agent and its step accurately", async () => {
    const { engine } = await scenario([new Error("explorer crashed")], []);
    const state = engine.getState()!;
    expect(state.status).toBe("failed");
    expect(state.agents.explorer.status).toBe("failed");
    expect(state.steps[0]).toMatchObject({ stage: "exploring", status: "failed" });
  });

  it("persists structured diagnostics for an incomplete agent response", async () => {
    const failure = new AgentIncompleteResponseError({
      agent: "explorer",
      stopReason: "error",
      provider: "test-provider",
      model: "test-model",
      providerError: "quota exhausted",
      partialText: "partial response",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 }
    });
    const { engine } = await scenario([failure], []);
    const state = engine.getState()!;
    const artifact = JSON.parse(await readFile(path.join(state.runDir, state.steps[0].artifact!), "utf8"));

    expect(artifact).toEqual({
      kind: "agent_incomplete_response",
      error: "explorer returned an incomplete response (error): quota exhausted",
      agent: "explorer",
      stopReason: "error",
      provider: "test-provider",
      model: "test-model",
      providerError: "quota exhausted",
      partialText: "partial response",
      usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.1 }
    });
    expect(state.steps[0].invocations?.[0]).toMatchObject({
      status: "failed",
      provider: "test-provider",
      model: "test-model",
      stopReason: "error",
      usage: { input: 10, output: 2, cost: 0.1 }
    });
  });

  it("persists the partial conversation when an agent invocation fails", async () => {
    const partialTranscript = {
      schemaVersion: 1 as const,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: "task" }] },
        { role: "assistant" as const, content: [{ type: "thinking" as const, text: "working" }] }
      ],
      truncated: false
    };
    const failingAgent: AgentExecutor = {
      preflight: async () => undefined,
      run: async options => {
        options.onTranscript?.(partialTranscript);
        throw new Error("provider disconnected");
      }
    };
    const previousCeiling = process.env.GIT_CEILING_DIRECTORIES;
    process.env.GIT_CEILING_DIRECTORIES = os.tmpdir().replace(/\\/g, "/");
    let engine: Orchestrator;
    try {
      ({ engine } = await scenario([], [], undefined, { agentExecutor: failingAgent }));
    } finally {
      if (previousCeiling === undefined) delete process.env.GIT_CEILING_DIRECTORIES;
      else process.env.GIT_CEILING_DIRECTORIES = previousCeiling;
    }
    const state = engine.getState()!;
    const invocation = state.steps[0].invocations![0];
    const transcript = JSON.parse(await readFile(path.join(state.runDir, invocation.transcriptArtifact!), "utf8"));

    expect(invocation).toMatchObject({ status: "failed", messageCount: 2, truncated: false });
    expect(invocation.fileDiffArtifact).toBeTruthy();
    expect(JSON.parse(await readFile(path.join(state.runDir, invocation.fileDiffArtifact!), "utf8"))).toMatchObject({
      status: "unavailable",
      changedFiles: []
    });
    expect(transcript).toMatchObject({
      stepId: "step-001",
      agent: "explorer",
      invocation: 1,
      status: "failed",
      messages: partialTranscript.messages
    });
  });

  it("rejects concurrent starts before either can replace shared state", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-concurrent-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const enteredPreflight = new Promise<void>(resolve => { entered = resolve; });
    const agent = new QueueAgent([explorer]);
    agent.preflight.mockImplementation(async () => { entered(); await blocked; });
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const ctx = { cwd, hasUI: false, ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() } } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, enforceWorkspacePolicy: false });
    const first = engine.start({ route: "implementation", request: "first" }, ctx);
    await expect(engine.start({ route: "implementation", request: "second" }, ctx)).rejects.toThrow("already running");
    await expect(engine.saveAgentSettings(cwd, { builder: { model: "test/model", thinking: "high" } }))
      .rejects.toThrow("while a workflow is running");
    await enteredPreflight;
    expect(engine.cancel()).toBe(true);
    release();
    await first;
    expect(engine.getState()?.request).toBe("first");
    expect(engine.getState()?.status).toBe("cancelled");
  });

  it("preflights and atomically saves a complete agent settings candidate", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-agent-settings-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["preserved check"];
    await saveConfig(cwd, config);
    const agent = new QueueAgent([]);
    const engine = new Orchestrator({ appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI, path.resolve("."), {
      agentExecutor: agent
    });
    const saved = await engine.saveAgentSettings(cwd, {
      builder: { model: "openai/coder", thinking: "max" },
      documenter: { model: "anthropic/fast" }
    });
    expect(agent.preflight).toHaveBeenCalledOnce();
    expect(agent.preflight.mock.calls[0][0].agents.builder).toMatchObject({ model: "openai/coder", thinking: "max" });
    expect(saved.checks).toEqual(["preserved check"]);
    const onDisk = await loadConfig(cwd);
    expect(onDisk.agents.builder.model).toBe("openai/coder");
    expect(onDisk.agents.documenter.thinking).toBeUndefined();
  });

  it("retains or clears thinking through the direct single-agent shortcut", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-agent-model-"));
    directories.push(cwd);
    await saveConfig(cwd, structuredClone(DEFAULT_CONFIG));
    const agent = new QueueAgent([]);
    const engine = new Orchestrator({ appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI, path.resolve("."), {
      agentExecutor: agent
    });
    await engine.saveAgentModel(cwd, "builder", "openai/coder", undefined);
    expect((await loadConfig(cwd)).agents.builder).toMatchObject({ model: "openai/coder", thinking: "high" });
    await engine.saveAgentModel(cwd, "builder", "openai/coder", null);
    expect((await loadConfig(cwd)).agents.builder.thinking).toBeUndefined();
  });

  it("does not write any settings when full preflight fails", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-agent-settings-fail-"));
    directories.push(cwd);
    await saveConfig(cwd, structuredClone(DEFAULT_CONFIG));
    const before = JSON.stringify(await loadConfig(cwd));
    const agent = new QueueAgent([]);
    agent.preflight.mockRejectedValueOnce(new Error("unavailable model"));
    const engine = new Orchestrator({ appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI, path.resolve("."), {
      agentExecutor: agent
    });
    await expect(engine.saveAgentSettings(cwd, { builder: { model: "missing/model" } }))
      .rejects.toThrow("unavailable model");
    expect(JSON.stringify(await loadConfig(cwd))).toBe(before);
  });

  it("blocks workflow starts while settings are being validated", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-agent-settings-lock-"));
    directories.push(cwd);
    await saveConfig(cwd, structuredClone(DEFAULT_CONFIG));
    let entered!: () => void;
    let release!: () => void;
    const enteredPreflight = new Promise<void>(resolve => { entered = resolve; });
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const agent = new QueueAgent([]);
    agent.preflight.mockImplementation(async () => { entered(); await blocked; });
    const engine = new Orchestrator({ appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI, path.resolve("."), {
      agentExecutor: agent
    });
    const saving = engine.saveAgentSettings(cwd, { builder: { model: "openai/coder", thinking: "high" } });
    await enteredPreflight;
    const ctx = { cwd, hasUI: false, ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext;
    await expect(engine.start({ route: "implementation", request: "request" }, ctx)).rejects.toThrow("being validated and saved");
    release();
    await saving;
  });

  it("does not report completion when the authoritative store cannot flush", async () => {
    class FailingFlushStore extends RunStore {
      private failCompletedFlush = false;
      override saveState(state: WorkflowState): Promise<void> {
        if (state.status === "completed") this.failCompletedFlush = true;
        return super.saveState(state);
      }
      override async flush(): Promise<void> {
        await super.flush();
        if (this.failCompletedFlush) {
          this.failCompletedFlush = false;
          throw new Error("disk flush failed");
        }
      }
    }
    const { engine, notifications, sendMessage } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true],
      undefined,
      { storeFactory: (cwd, runId) => new FailingFlushStore(cwd, runId) }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(notifications.mock.calls.some(call => String(call[0]).includes("workflow completed"))).toBe(false);
    expect(sendMessage.mock.calls.some(call => String(call[0]?.content).startsWith("## Workflow completed"))).toBe(false);
  });

  it("human approves plan when planApproval is enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-approve-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const editor = vi.fn(async () => "viewed");
    const select = vi.fn()
      .mockResolvedValueOnce("Approve plan")
      .mockResolvedValueOnce("Defer all");
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { select, editor, input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(c => c.name === "reviewer")).toHaveLength(2); // code + lessons review only, not plan
    expect(editor).not.toHaveBeenCalled();
    expect(select).toHaveBeenCalledTimes(2); // plan approval + memory approval
  });

  it("pauses when plan approval is required without an interactive UI", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan],
      [],
      config => { config.humanInTheLoop.planApproval = true; }
    );
    expect(engine.getState()?.status).toBe("paused");
    expect(engine.getState()?.latestCheckpoint?.cursor).toBe("human_decision_pending");
    expect(engine.getState()?.pendingDecision?.kind).toBe("plan_approval");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("pauses instead of approving when the workspace changes during a human gate", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-drift-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan]);
    const select = vi.fn(async () => {
      await writeFile(path.join(cwd, "drift.txt"), "changed while awaiting approval");
      return "Approve plan";
    });
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        select,
        editor: vi.fn(async () => "viewed"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent });

    await engine.start({ route: "implementation", request: "request" }, ctx);

    expect(engine.getState()?.status).toBe("paused");
    expect(engine.getState()?.warning).toContain("workspace changed while awaiting");
    expect(agent.calls).toHaveLength(2);
  });

  it("pauses before mutation when confirmation requires an interactive UI", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved],
      [true],
      config => { config.humanInTheLoop.confirmBeforeMutation = true; }
    );
    expect(engine.getState()?.status).toBe("paused");
    expect(engine.getState()?.pendingDecision?.kind).toBe("mutation_confirmation");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("human requests changes to plan and planner revises", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-changes-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = true;
    config.humanInTheLoop.planRevisionApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, plan, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const editor = vi.fn(async () => "viewed");
    const select = vi.fn()
      .mockResolvedValueOnce("Request changes")
      .mockResolvedValueOnce("Approve plan");
    const input = vi.fn(async () => "Add error handling to the login task");
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor, input, confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(c => c.name === "planner")).toHaveLength(2); // initial + revision
    const revisionCall = agent.calls.filter(c => c.name === "planner")[1];
    const envelope = JSON.parse(revisionCall.task);
    expect(envelope.task.feedback).toEqual({ source: "human", text: "Add error handling to the login task" });
  });

  it("human cancels during plan review", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-cancel-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const editor = vi.fn(async () => "viewed");
    const select = vi.fn(async () => "Cancel workflow");
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor, input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("cancelled");
    expect(engine.getState()?.message).toContain("cancelled");
  });

  it("resumes a deferred plan decision without rerunning exploration or planning", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-resume-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = true;
    await saveConfig(cwd, config);

    const initialAgent = new QueueAgent([explorer, plan]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const initialContext = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        editor: vi.fn(async () => undefined),
        select: vi.fn(),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const initial = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: initialAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });
    await initial.start({ route: "implementation", request: "request" }, initialContext);
    const paused = initial.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.latestCheckpoint?.cursor).toBe("human_decision_pending");

    const resumedAgent = new QueueAgent([tester, builder, approved, documenter, approved]);
    const checkQueue = [[check(true)], [check(false)], [check(true)], [check(true)]];
    const select = vi.fn()
      .mockResolvedValueOnce("Approve plan")
      .mockResolvedValueOnce("Defer all");
    const resumedContext = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        editor: vi.fn(async () => "viewed"),
        select,
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, resumedContext);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumed.getState()?.resumeCount).toBe(1);
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["tester", "builder", "reviewer", "documenter", "reviewer"]);
  });

  it("consumes a recorded plan decision after interruption without prompting again", async () => {
    class FailFirstPlanWriteStore extends RunStore {
      private failed = false;
      override saveJson(name: string, value: unknown): Promise<string> {
        if (name === "plan.json" && !this.failed) {
          this.failed = true;
          return Promise.reject(new Error("interrupted after decision recording"));
        }
        return super.saveJson(name, value);
      }
    }

    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-recorded-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = true;
    await saveConfig(cwd, config);

    const initialAgent = new QueueAgent([explorer, plan]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const initialContext = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        editor: vi.fn(async () => "viewed"),
        select: vi.fn(async () => "Approve plan"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const initial = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: initialAgent,
      checkRunner: vi.fn(async () => [check(true)]) as unknown as CheckRunner,
      storeFactory: (project, runId) => new FailFirstPlanWriteStore(project, runId),
      enforceWorkspacePolicy: false
    });
    await initial.start({ route: "implementation", request: "request" }, initialContext);
    const failed = initial.getState()!;
    expect(failed.status).toBe("failed");
    expect(failed.latestCheckpoint?.cursor).toBe("human_decision_recorded");

    const resumedAgent = new QueueAgent([tester, builder, approved, documenter, approved]);
    const checkQueue = [[check(true)], [check(false)], [check(true)], [check(true)]];
    const editor = vi.fn(async () => "unexpected prompt");
    const resumedContext = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        editor,
        select: vi.fn(async () => "Defer all"),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(failed.runId, resumedContext);

    expect(resumed.getState()?.status).toBe("completed");
    expect(editor).not.toHaveBeenCalled();
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["tester", "builder", "reviewer", "documenter", "reviewer"]);
  });

  it("human confirms mutation before builder runs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-confirm-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.confirmBeforeMutation = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, approved, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn()
      .mockResolvedValueOnce("Enter mutation phase")
      .mockResolvedValueOnce("Defer all");
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(select).toHaveBeenCalled();
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(1);
  });

  it("resumes pending mutation confirmation without rerunning preparation", async () => {
    const initial = await scenario(
      [explorer, plan, approved],
      [true],
      config => { config.humanInTheLoop.confirmBeforeMutation = true; }
    );
    const paused = initial.engine.getState()!;
    expect(paused.status).toBe("paused");

    const resumedAgent = new QueueAgent([tester, builder, approved, documenter, approved]);
    const checkQueue = [[check(false)], [check(true)], [check(true)]];
    const select = vi.fn()
      .mockResolvedValueOnce("Enter mutation phase")
      .mockResolvedValueOnce("Defer all");
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: true,
      ui: {
        select,
        editor: vi.fn(),
        input: vi.fn(),
        confirm: vi.fn(),
        notify: vi.fn(),
        setStatus: vi.fn(),
        setWidget: vi.fn()
      }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(select).toHaveBeenCalled();
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["tester", "builder", "reviewer", "documenter", "reviewer"]);
  });

  it("human denies the mutation phase before any mutating agent runs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-deny-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.planApproval = false;
    config.humanInTheLoop.planRevisionApproval = false;
    config.humanInTheLoop.confirmBeforeMutation = true;
    config.humanInTheLoop.finalDeliveryApproval = false;
    config.humanInTheLoop.diagnosisApproval = "never";
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn(async () => "Cancel workflow");
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("cancelled");
    expect(engine.getState()?.message).toContain("cancelled");
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(0);
    expect(agent.calls.filter(c => c.name === "tester")).toHaveLength(0);
  });

  it("human touchpoints disabled does not affect existing behavior", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true]
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(c => c.name === "reviewer").length).toBeGreaterThanOrEqual(2); // plan + code + lessons
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(1);
  });

  it("cancels an active agent idempotently", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-cancel-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    let started!: () => void;
    const startedPromise = new Promise<void>(resolve => { started = resolve; });
    const agent: AgentExecutor = {
      preflight: async () => undefined,
      run: async options => {
        started();
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(new AgentCancelledError(options.name)), { once: true });
        });
      }
    };
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const setStatus = vi.fn();
    const setWidget = vi.fn();
    const ctx = { cwd, hasUI: true, ui: { notify: vi.fn(), setStatus, setWidget } } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, enforceWorkspacePolicy: false });
    const running = engine.start({ route: "implementation", request: "request" }, ctx);
    await startedPromise;
    expect(engine.cancel()).toBe(true);
    expect(engine.cancel()).toBe(false);
    await engine.shutdown(ctx);
    await running;
    expect(engine.getState()?.status).toBe("cancelled");
    expect(engine.getState()?.steps[0].status).toBe("cancelled");
    expect(engine.getState()?.agents.explorer.status).toBe("cancelled");
    expect(setStatus).toHaveBeenLastCalledWith("pi-orchestrator", undefined);
    expect(setWidget).toHaveBeenLastCalledWith("pi-orchestrator", undefined);
  });

  it("builds after user grants one more targeted fix when review limit is exhausted", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-extra-fix-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.worktreeIsolation = false;
    config.limits.reviewRevisions = 0;
    config.humanInTheLoop.importantDecisions = true;
    config.humanInTheLoop.finalDeliveryApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([
      explorer, plan, approved, tester, builder, changes, builder, approved, documenter, approved
    ]);
    const checkResults = [[check(true)], [check(false)], [check(true)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => {
      const next = checkResults.shift();
      if (!next) throw new Error("Missing fake checks");
      return next;
    }) as unknown as CheckRunner;
    let selectCalls = 0;
    const select = vi.fn(async () => {
      selectCalls++;
      if (selectCalls === 1) return "Allow one more targeted fix";
      if (selectCalls === 2) return "Finish delivery";
      return "Skip all (decline)";
    });
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(2);
    expect(agent.calls.filter(c => c.name === "reviewer")).toHaveLength(4);
    const addressTasks = agent.calls.filter(c => c.name === "builder" && c.task.includes("address_review"));
    expect(addressTasks).toHaveLength(1);
    expect(addressTasks[0].task).toContain("fix required");
  });

  it("allows multiple extra targeted fixes without running consecutive reviews", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-multi-extra-fix-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.worktreeIsolation = false;
    config.limits.reviewRevisions = 0;
    config.humanInTheLoop.planApproval = false;
    config.humanInTheLoop.confirmBeforeMutation = false;
    config.humanInTheLoop.finalDeliveryApproval = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([
      explorer, plan, approved, tester, builder, changes, builder, changes, builder, approved, documenter, approved
    ]);
    const checkResults = [[check(true)], [check(false)], [check(true)], [check(true)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => {
      const next = checkResults.shift();
      if (!next) throw new Error("Missing fake checks");
      return next;
    }) as unknown as CheckRunner;
    let selectCalls = 0;
    const select = vi.fn(async () => {
      selectCalls++;
      if (selectCalls <= 2) return "Allow one more targeted fix";
      if (selectCalls === 3) return "Finish delivery";
      return "Skip all (decline)";
    });
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select, editor: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(3);
    expect(agent.calls.filter(c => c.name === "reviewer")).toHaveLength(5);
    // Verify no consecutive reviewer calls between code reviews
    const builderIndices = agent.calls
      .map((c, i) => ({ name: c.name, index: i }))
      .filter(c => c.name === "builder");
    const reviewerIndices = agent.calls
      .map((c, i) => ({ name: c.name, index: i }))
      .filter(c => c.name === "reviewer");
    // Builder 1 (address_review) must run between reviewer 2 (rev 0) and reviewer 3 (rev 1)
    expect(builderIndices[1].index).toBeGreaterThan(reviewerIndices[1].index);
    expect(builderIndices[1].index).toBeLessThan(reviewerIndices[2].index);
    // Builder 2 (address_review) must run between reviewer 3 (rev 1) and reviewer 4 (rev 2)
    expect(builderIndices[2].index).toBeGreaterThan(reviewerIndices[2].index);
    expect(builderIndices[2].index).toBeLessThan(reviewerIndices[3].index);
  });

  it("revises scope when a code-review fix requires an omitted file", async () => {
    const blocked = json({
      summary: "review fix blocked",
      changedFiles: [],
      commands: [],
      assumptions: [],
      unresolvedIssues: ["src/App.test.ts must be updated"],
      blocker: { kind: "scope", reason: "review found a stale integration test", requiredFiles: ["src/App.test.ts"] }
    });
    const basePlan = JSON.parse(plan);
    const revisedPlan = json({
      ...basePlan,
      tasks: [
        ...basePlan.tasks,
        {
          id: "update-integration-test",
          description: "update stale integration assertion",
          files: ["src/App.test.ts"],
          dependencies: ["one"],
          verification: ["run integration tests"]
        }
      ]
    });
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, changes, blocked, revisedPlan, approved, builder, approved, documenter, approved],
      [true, false, true, true, true],
      config => { config.limits.reviewRevisions = 1; }
    );

    expect(engine.getState()?.status).toBe("completed");
    const addressReviewBuilders = agent.calls.filter(call => call.name === "builder" && call.task.includes("address_review"));
    expect(addressReviewBuilders).toHaveLength(2);
    expect(JSON.parse(addressReviewBuilders[1].task).task.plan.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ files: ["src/App.test.ts"] })
    ]));
  });

  it("updates implementationChecks after each successful review fix", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-fresh-checks-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["lint", "test"];
    config.dashboard.enabled = false;
    config.limits.reviewRevisions = 1;
    await saveConfig(cwd, config);
    const initialChecks = [checkWithCommand(true, "lint-initial"), checkWithCommand(true, "test-initial")];
    const fix1Checks = [checkWithCommand(true, "lint-fix-1"), checkWithCommand(true, "test-fix-1")];
    const agent = new QueueAgent([
      explorer, plan, approved, tester, builder, changes, builder, approved, documenter, approved
    ]);
    const checkQueue = [
      [check(true), check(true)],       // baseline (2 checks)
      [check(false), check(true)],      // after-tests (2 checks)
      initialChecks,                    // impl attempt 1 (2 checks)
      fix1Checks,                       // review-fix 1 (2 checks)
      [check(true), check(true)],       // final (2 checks)
    ];
    const checkRunner = vi.fn(async () => {
      const next = checkQueue.shift();
      if (!next) throw new Error("Missing fake checks");
      return next;
    }) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    const reviewerCalls = agent.calls.filter(c => c.name === "reviewer").map(c => {
      try { return JSON.parse(c.task); }
      catch { return null; }
    }).filter(Boolean);
    // reviewer[1] is code review rev 0; reviewer[2] is code review rev 1
    const codeReviewTasks = reviewerCalls.map(t => t.task).filter(t => t.reviewType === "code");
    expect(codeReviewTasks).toHaveLength(2);
    expect(codeReviewTasks[0].implementationChecks).toEqual(initialChecks);
    expect(codeReviewTasks[1].implementationChecks).toEqual(fix1Checks);
  });

  it("resumes after verified implementation without replaying completed mutation agents", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, new Error("review service unavailable")],
      [true, false, true]
    );
    const failed = initial.engine.getState()!;
    expect(failed.status).toBe("failed");
    expect(failed.latestCheckpoint?.cursor).toBe("implementation_verified");

    const resumedAgent = new QueueAgent([approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, enforceWorkspacePolicy: false });

    await resumed.resume(failed.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumed.getState()?.resumeCount).toBe(1);
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["reviewer", "documenter", "reviewer"]);
    expect(resumed.getState()!.steps.length).toBeGreaterThan(failed.steps.length);
  });

  it("resumes after Tester without invoking Tester a second time", async () => {
    const initial = await scenario([explorer, plan, approved, tester], [true, false]);
    const failed = initial.engine.getState()!;
    expect(failed.status).toBe("failed");
    expect(failed.latestCheckpoint?.cursor).toBe("tester_completed");

    const resumedAgent = new QueueAgent([builder, approved, documenter, approved]);
    const queues = [[check(false)], [check(true)], [check(true)]];
    const checkRunner = vi.fn(async () => queues.shift() ?? [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, enforceWorkspacePolicy: false });

    await resumed.resume(failed.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["builder", "reviewer", "documenter", "reviewer"]);
  });

  it("refuses resume when the project workspace changed after the checkpoint", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, new Error("review service unavailable")],
      [true, false, true]
    );
    const failed = initial.engine.getState()!;
    await writeFile(path.join(initial.cwd, "unexpected.txt"), "external edit");
    const agent = new QueueAgent([approved]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, enforceWorkspacePolicy: false });

    await expect(resumed.resume(failed.runId, ctx)).rejects.toThrow("Workspace differs from the latest safe checkpoint");
    expect(agent.calls).toHaveLength(0);
  });

  it("refuses resume when workflow configuration changed after the checkpoint", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, new Error("review service unavailable")],
      [true, false, true]
    );
    const failed = initial.engine.getState()!;
    const changedConfig = await loadConfig(initial.cwd);
    changedConfig.limits.reviewRevisions++;
    await saveConfig(initial.cwd, changedConfig);
    const agent = new QueueAgent([approved]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, enforceWorkspacePolicy: false });

    await expect(resumed.resume(failed.runId, ctx)).rejects.toThrow("configuration changed");
    expect(agent.calls).toHaveLength(0);
  });

  it("resumes after Documenter without invoking Documenter a second time", async () => {
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, new Error("lesson review unavailable")],
      [true, false, true]
    );
    const failed = initial.engine.getState()!;
    expect(failed.latestCheckpoint?.cursor).toBe("documenter_completed");
    const agent = new QueueAgent([approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });

    await resumed.resume(failed.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual(["reviewer"]);
  });

  it.each([
    { format: "owner-aware", legacy: false },
    { format: "legacy", legacy: true }
  ])("resumes a $format pending Documenter scope blocker through scope revision", async ({ legacy }) => {
    const blockedDocumenter = json({
      summary: "README scope is missing",
      changedFiles: [],
      documentationChanges: [],
      proposedLessons: [],
      commands: [],
      unresolvedIssues: ["README.md must document the change"],
      blocker: {
        kind: "scope",
        reason: "README.md must document the change",
        requiredFiles: ["README.md"]
      }
    });
    const revisedPlan = json({
      ...JSON.parse(plan),
      tasks: [
        ...JSON.parse(plan).tasks,
        {
          id: "document-change",
          description: "document the implemented behavior",
          files: ["README.md"],
          dependencies: ["one"],
          verification: ["inspect README"]
        }
      ]
    });
    const initial = await scenario(
      [explorer, plan, approved, tester, builder, approved, blockedDocumenter, new Error("planner unavailable")],
      [true, false, true]
    );
    const failed = initial.engine.getState()!;
    expect(failed.status).toBe("failed");
    expect(failed.latestCheckpoint?.cursor).toBe("resolution_pending");

    const checkpointStore = new CheckpointStore(failed.runDir, failed.runId);
    const checkpoint = (await checkpointStore.loadLatest())!;
    expect(checkpoint.cursor.kind).toBe("resolution_pending");
    if (checkpoint.cursor.kind !== "resolution_pending") throw new Error("Expected resolution checkpoint");
    expect(checkpoint.cursor.continuation).toMatchObject({
      scopeOwner: "finalization_initial_documentation",
      output: { blocker: { kind: "scope", requiredFiles: ["README.md"] } }
    });

    if (legacy) {
      const legacyContinuation = structuredClone(checkpoint.cursor.continuation);
      delete legacyContinuation.output;
      delete legacyContinuation.scopeOwner;
      delete legacyContinuation.scopeContext;
      const { schemaVersion: _schemaVersion, checkpointNumber: _checkpointNumber, ...checkpointWrite } = checkpoint;
      await checkpointStore.save({
        ...checkpointWrite,
        createdAt: new Date().toISOString(),
        cursor: { kind: "resolution_pending", continuation: legacyContinuation }
      });
    }

    const resumedAgent = new QueueAgent([revisedPlan, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd: initial.cwd,
      hasUI: false,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, enforceWorkspacePolicy: false });

    await resumed.resume(failed.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["planner", "reviewer", "documenter", "reviewer"]);
    expect(JSON.parse(resumedAgent.calls[0].task).task).toMatchObject({
      action: "revise_for_failure",
      requiredFiles: ["README.md"]
    });
    expect(JSON.parse(resumedAgent.calls[2].task).task.plan.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ files: ["README.md"] })
    ]));
  });
});

function checkWithCommand(passed: boolean, command: string): CheckResult {
  return {
    command,
    exitCode: passed ? 0 : 1,
    stdout: "",
    stderr: passed ? "" : "failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    passed,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1
  };
}

function json(value: unknown): string { return JSON.stringify(value); }
