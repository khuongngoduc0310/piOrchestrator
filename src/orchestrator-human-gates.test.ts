import { mkdtemp, writeFile, os, path, describe, expect, it, vi, AgentCancelledError, Orchestrator, DEFAULT_CONFIG, saveConfig, RunStore, directories, defaultTestConfig, explorer, plan, approved, tester, builder, documenter, QueueAgent, check, scenario } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, AgentExecutor, CheckRunner } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("human gates", () => {
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
    config.worktreeSetup = { mode: "manual", commands: [] };
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
  });

});
