import { mkdtemp, writeFile, os, path, describe, expect, it, vi, Orchestrator, DEFAULT_CONFIG, loadConfig, saveConfig, CheckpointStore, directories, defaultTestConfig, explorer, plan, approved, changes, tester, builder, documenter, QueueAgent, check, scenario, checkWithCommand, json } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, CheckRunner } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("review limit extra fixes", () => {
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
  });

  describe("resume from checkpoints", () => {
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
});
