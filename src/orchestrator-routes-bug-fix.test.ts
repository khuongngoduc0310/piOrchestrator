import { mkdtemp, readFile, readdir, writeFile, os, path, describe, expect, it, vi, Orchestrator, loadConfig, saveConfig, CheckpointStore, directories, defaultTestConfig, explorer, checkDiscovery, plan, reviewOnlyPlan, routePlan, approved, changes, tester, builder, debuggerOutput, documenter, documentationOnlyOutput, QueueAgent, check, scenario, json } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, CheckRunner, CheckpointWrite } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("route execution", () => {
  it("approves discovered checks and continues the same invocation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-setup-"));
    directories.push(cwd);
    await saveConfig(cwd, { ...defaultTestConfig(), dashboard: { enabled: false, port: 0 } });
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    const agent = new QueueAgent([explorer, plan, approved, checkDiscovery, tester, builder, approved, documenter, approved]);
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
    const discoveryTask = JSON.parse(agent.calls.filter(call => call.name === "explorer")[1].task).task;
    expect(discoveryTask).toEqual({ action: "discover_checks" });
  });

  it("cancels an implementation route when deferred check setup is declined", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-setup-cancel-"));
    directories.push(cwd);
    await saveConfig(cwd, { ...defaultTestConfig(), dashboard: { enabled: false, port: 0 } });
    const agent = new QueueAgent([explorer, plan, approved, checkDiscovery]);
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

  it("rejects invalid Tester support before running a quick implementation baseline", async () => {
    const invalidPlan = JSON.parse(routePlan("quick_implementation"));
    invalidPlan.tasks[0].testSupportFiles = ["test/theme.test.js"];
    const { engine, agent } = await scenario(
      [explorer, json(invalidPlan), approved],
      [],
      undefined,
      {},
      "quick_implementation"
    );

    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.message)
      .toContain("testSupportFiles may contain only classified test-support files: test/theme.test.js");
    expect(engine.getState()?.steps.map(step => step.stage)).toEqual(["exploring", "planning", "reviewing_plan"]);
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer"]);
  });

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
    let reader: { read(): Promise<unknown>; cancel(): Promise<void> } | undefined;
    try {
      const dashboardUrl = await engine.startDashboard(cwd);
      const events = await fetch(`${dashboardUrl}/events`);
      reader = events.body!.getReader();
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
      await reader?.cancel();
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
  });

  describe("bug fix route", () => {
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
    let reader: { read(): Promise<unknown>; cancel(): Promise<void> } | undefined;
    try {
      const dashboardUrl = await engine.startDashboard(cwd);
      const events = await fetch(`${dashboardUrl}/events`);
      reader = events.body!.getReader();
      await reader.read();

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
      await reader?.cancel();
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
  });
});
