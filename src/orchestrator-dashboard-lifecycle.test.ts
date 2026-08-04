import { mkdtemp, readFile, writeFile, os, path, createServer, describe, expect, it, vi, Orchestrator, DEFAULT_CONFIG, loadConfig, saveConfig, RunStore, directories, defaultTestConfig, explorer, plan, routePlan, approved, tester, builder, debuggerOutput, documenter, QueueAgent, check, scenario, json } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, CheckRunner, WorkflowState } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("dashboard and browser", () => {
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
    try {
      await engine.start({ route: "implementation", request: "request" }, ctx);
      expect(engine.getState()?.status).toBe("completed");
      expect(engine.getState()?.dashboardUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(openBrowser).toHaveBeenCalledOnce();
      expect(openBrowser).toHaveBeenCalledWith(engine.getState()?.dashboardUrl);
    } finally {
      await engine.shutdown(ctx);
    }
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
    try {
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
      const engine2 = new Orchestrator(pi2, path.resolve("."), { agentExecutor: resumedAgent, checkRunner, openBrowser: openBrowser2, enforceWorkspacePolicy: false });
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
      try {
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
      } finally {
        await engine2.shutdown(ctx2);
      }
    } finally {
      await engine1.shutdown(ctx1);
      if (occupiedPort.listening) await new Promise<void>(resolve => occupiedPort.close(() => resolve()));
    }
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
  });

  describe("session messages", () => {
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
  });

  describe("lifecycle concurrency and settings", () => {
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
  });
});
