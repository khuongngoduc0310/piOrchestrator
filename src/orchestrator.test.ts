import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AgentCancelledError,
  AgentIncompleteResponseError,
  type AgentExecutor,
  type AgentRunOptions
} from "./agent-runner.js";
import type { CheckRunner, OrchestratorDependencies } from "./orchestrator.js";
import { Orchestrator } from "./orchestrator.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import { RunStore } from "./store.js";
import type { AgentResult, CheckResult, OrchestratorConfig, WorkflowRoute } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

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
  tasks: [{ id: "one", description: "change", files: ["src/index.ts"], dependencies: [], verification: ["check"] }],
  risks: []
});
const reviewOnlyPlan = json({
  route: "review_only",
  summary: "review existing changes",
  assumptions: [],
  acceptanceCriteria: ["findings cite repository evidence"],
  tasks: [{ id: "review", description: "review changes", files: ["src/index.ts"], dependencies: [], verification: ["report findings"] }],
  risks: []
});
function routePlan(route: WorkflowRoute, files = ["src/index.ts"]): string {
  return json({
    route,
    summary: `${route} plan`,
    assumptions: [],
    acceptanceCriteria: ["check passes"],
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
  const config = structuredClone(DEFAULT_CONFIG);
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
    await saveConfig(cwd, { ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: false, port: 0 } });
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
    await saveConfig(cwd, { ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: false, port: 0 } });
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
      [explorer, routePlan("investigation_only"), approved, changes],
      [],
      config => { config.checks = []; },
      {},
      "investigation_only"
    );
    expect(engine.getState()?.status).toBe("completed");
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "reviewer"]);
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

    const config = structuredClone(DEFAULT_CONFIG);
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

  it("sends every role a stable version-3 task envelope", async () => {
    const { agent } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true]
    );
    const envelopes = agent.calls.map(call => ({ name: call.name, envelope: JSON.parse(call.task) }));
    expect(envelopes.every(({ envelope }) => envelope.taskSchemaVersion === 3 && envelope.mode === "execute")).toBe(true);
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

  it("rejects a red baseline before tester or builder mutation", async () => {
    const { engine, agent } = await scenario([explorer, plan, approved, debuggerOutput, plan], [false]);
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.failedStage).toBe("baseline");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("proposes a baseline repair plan and continues after human approval", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-baseline-repair-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
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
    expect(editor).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(2); // baseline repair + memory approval
  });

  it("opens browser dashboard when enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-dashboard-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
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
    const config = structuredClone(DEFAULT_CONFIG);
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

  it("fails when the only implementation attempt fails without diagnosing", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder],
      [true, false, false],
      config => { config.limits.implementationRetries = 0; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(1);
    expect(agent.calls.filter(call => call.name === "debugger")).toHaveLength(0);
  });

  it("diagnoses after first failure and fails on the retry", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, debuggerOutput, builder],
      [true, false, false, false],
      config => { config.limits.implementationRetries = 1; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(2);
    expect(agent.calls.filter(call => call.name === "debugger")).toHaveLength(1);
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

  it("fails when code review revisions are exhausted", async () => {
    const { engine } = await scenario(
      [explorer, plan, approved, tester, builder, changes],
      [true, false, true],
      config => { config.limits.reviewRevisions = 0; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.failedStage).toBe("reviewing_code");
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
      taskSchemaVersion: 3,
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

  it("does not rerun Builder after malformed output", async () => {
    const { engine, agent } = await scenario([explorer, plan, approved, tester, "not json"], [true, false]);
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "builder")).toHaveLength(1);
  });

  it("does not rerun Documenter after malformed output", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, builder, approved, "not json"],
      [true, false, true]
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(agent.calls.filter(call => call.name === "documenter")).toHaveLength(1);
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
    const { engine } = await scenario([], [], undefined, { agentExecutor: failingAgent });
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
      override async flush(): Promise<void> { throw new Error("disk flush failed"); }
    }
    const { engine, notifications } = await scenario(
      [explorer, plan, approved, tester, builder, approved, documenter, approved],
      [true, false, true, true],
      undefined,
      { storeFactory: (cwd, runId) => new FailingFlushStore(cwd, runId) }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(notifications.mock.calls.some(call => String(call[0]).includes("workflow completed"))).toBe(false);
  });

  it("human approves plan when planApproval is enabled", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-approve-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
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
    expect(editor).toHaveBeenCalledOnce();
    expect(select).toHaveBeenCalledTimes(2); // plan approval + memory approval
  });

  it("fails closed when plan approval is required without an interactive UI", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan],
      [],
      config => { config.humanInTheLoop.planApproval = true; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.termination?.code).toBe("human_gate_unavailable");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("fails closed before mutation when confirmation is required without an interactive UI", async () => {
    const { engine, agent } = await scenario(
      [explorer, plan, approved],
      [true],
      config => { config.humanInTheLoop.confirmBeforeMutation = true; }
    );
    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.termination?.code).toBe("human_gate_unavailable");
    expect(agent.calls.some(call => call.name === "tester" || call.name === "builder")).toBe(false);
  });

  it("human requests changes to plan and planner revises", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-changes-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
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

  it("human confirms mutation before builder runs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-confirm-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.confirmBeforeMutation = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, approved, tester, builder, approved, documenter, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const confirm = vi.fn(async () => true);
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select: vi.fn(async () => "Approve suggested checks"), editor: vi.fn(), input: vi.fn(), confirm, notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect(confirm).toHaveBeenCalled(); // at least the builder confirmation
    expect(agent.calls.filter(c => c.name === "builder")).toHaveLength(1);
  });

  it("human denies the mutation phase before any mutating agent runs", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-human-deny-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.humanInTheLoop.confirmBeforeMutation = true;
    await saveConfig(cwd, config);
    const agent = new QueueAgent([explorer, plan, approved]);
    const checkRunner = vi.fn(async () => [check(true)]) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const confirm = vi.fn(async () => false);
    const ctx = {
      cwd,
      hasUI: true,
      ui: { select: vi.fn(async () => "Approve suggested checks"), editor: vi.fn(), input: vi.fn(), confirm, notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
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
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.reviewRevisions = 0;
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
    config.limits.reviewRevisions = 0;
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

  it("updates implementationChecks after each successful review fix", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-fresh-checks-"));
    directories.push(cwd);
    const config = structuredClone(DEFAULT_CONFIG);
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
