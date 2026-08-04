import { path, describe, expect, it, vi, Orchestrator, explorer, plan, routePlan, approved, changes, tester, builder, debuggerOutput, documenter, QueueAgent, check, scenario, json } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, CheckRunner } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("scope revision", () => {
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
    const { engine, agent } = await scenario(
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
  });

  describe("final delivery and review fixes", () => {
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
  });



});
