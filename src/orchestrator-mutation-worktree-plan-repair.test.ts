import { mkdir, mkdtemp, readFile, readdir, writeFile, execFileSync, os, path, describe, expect, it, vi, Orchestrator, loadConfig, saveConfig, CheckpointStore, canonicalSha256, directories, defaultTestConfig, explorer, plan, approved, changes, tester, builder, baselineRepairBlocker, debuggerOutput, documenter, QueueAgent, check, checkCommand, scenario, json } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, AgentRunOptions, CheckRunner, AgentResult } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("mutation phase and worktree", () => {
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

  it("retries only failed isolated-worktree setup commands before mutation", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-worktree-readiness-"));
    directories.push(cwd);
    await mkdir(path.join(cwd, "src"), { recursive: true });
    await writeFile(path.join(cwd, "src", "index.ts"), "export const value = 1;\n");
    await writeFile(path.join(cwd, "README.md"), "# Project\n");
    await writeFile(path.join(cwd, ".gitignore"), "frontend/node_modules/\n");
    execFileSync("git", ["init"], { cwd, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd });
    execFileSync("git", ["config", "user.name", "Test"], { cwd });
    execFileSync("git", ["add", "."], { cwd });
    execFileSync("git", ["commit", "-m", "initial"], { cwd, stdio: "ignore" });
    await mkdir(path.join(cwd, "frontend", "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(cwd, "frontend", "node_modules", ".bin", "vite"), "source dependency\n");

    const config = defaultTestConfig();
    config.checks = ["check"];
    config.dashboard.enabled = false;
    config.limits.worktreeIsolation = true;
    config.worktreeSetup = { mode: "commands", commands: ["setup frontend", "setup desktop"] };
    await saveConfig(cwd, config);

    const quickPlan = json({
      route: "quick_implementation",
      summary: "implement",
      assumptions: [],
      acceptanceCriteria: ["check passes"],
      automatedAcceptanceCriteria: [0],
      tasks: [{ id: "one", description: "change", files: ["src/index.ts", "README.md"], dependencies: [], verification: ["check"] }],
      risks: []
    });
    const checkCwds: string[] = [];
    const setupCalls: string[] = [];
    const checkRunner = vi.fn(async (commands, checkCwd: string) => {
      checkCwds.push(checkCwd);
      const command = commands[0]!;
      if (command === "setup frontend") {
        setupCalls.push(command);
        return [{ ...check(true), command }];
      }
      if (command === "setup desktop") {
        setupCalls.push(command);
        if (setupCalls.filter(item => item === command).length === 1) return [{ ...check(false), command }];
        await mkdir(path.join(checkCwd, "frontend", "node_modules", ".bin"), { recursive: true });
        await writeFile(path.join(checkCwd, "frontend", "node_modules", ".bin", "vite"), "worktree dependency\n");
        return [{ ...check(true), command }];
      }
      const hasVite = await readFile(path.join(checkCwd, "frontend", "node_modules", ".bin", "vite"), "utf8")
        .then(() => true, () => false);
      return [check(hasVite)];
    }) as unknown as CheckRunner;
    const initialAgent = new QueueAgent([explorer, quickPlan, approved]);
    const pi = { appendEntry: vi.fn(), exec: vi.fn(), sendMessage: vi.fn() } as unknown as ExtensionAPI;
    const ctx = {
      cwd,
      hasUI: false,
      isProjectTrusted: () => true,
      ui: { notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: initialAgent, checkRunner });

    await engine.start({ route: "quick_implementation", request: "request" }, ctx);

    const paused = engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.latestCheckpoint?.cursor).toBe("mutation_ready");
    expect(paused.message).toContain("Isolated worktree setup commands failed");
    expect(paused.steps.find(step => step.label === "Provision isolated worktree dependencies")?.artifact)
      .toContain("worktree-setup");
    expect(initialAgent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer"]);
    expect(checkCwds[0]).toBe(cwd);
    expect(checkCwds[1]).not.toBe(cwd);

    const worktree = JSON.parse(await readFile(path.join(paused.runDir, "worktree.json"), "utf8"));

    class ResumedMutatingAgent extends QueueAgent {
      override async run(options: AgentRunOptions): Promise<AgentResult> {
        if (options.name === "builder") {
          await writeFile(path.join(options.cwd, "src", "index.ts"), "export const value = 2;\n");
        } else if (options.name === "documenter") {
          await writeFile(path.join(options.cwd, "README.md"), "# Project\n\nUpdated.\n");
        }
        return super.run(options);
      }
    }
    const resumedAgent = new ResumedMutatingAgent([builder, approved, documenter, approved]);
    const resumed = new Orchestrator(pi, path.resolve("."), { agentExecutor: resumedAgent, checkRunner });

    await resumed.resume(paused.runId, ctx);

    expect(resumed.getState()?.status).toBe("completed");
    expect(resumedAgent.calls.map(call => call.name)).toEqual(["builder", "reviewer", "documenter", "reviewer"]);
    expect(checkCwds.slice(1).every(checkCwd => checkCwd === worktree.effectiveCwd)).toBe(true);
    expect(setupCalls).toEqual(["setup frontend", "setup desktop", "setup desktop"]);
    expect(await readFile(path.join(cwd, "src", "index.ts"), "utf8")).toContain("value = 2");
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
  });

  describe("plan revision and baseline repair", () => {
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

  it("rejects an invalid initial baseline repair plan before approval", async () => {
    const invalidRepairPlan = JSON.parse(plan);
    invalidRepairPlan.tasks[0].testSupportFiles = ["test/fix.test.js"];
    const { engine, agent } = await scenario(
      [explorer, plan, approved, debuggerOutput, json(invalidRepairPlan)],
      [false]
    );

    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.message)
      .toContain("testSupportFiles may contain only classified test-support files: test/fix.test.js");
    expect(engine.getState()?.pendingDecision).toBeUndefined();
    expect(agent.calls.map(call => call.name)).toEqual(["explorer", "planner", "reviewer", "debugger", "planner"]);
  });

  it("rejects an invalid Builder-requested baseline repair plan before approval", async () => {
    const invalidRepairPlan = JSON.parse(plan);
    invalidRepairPlan.tasks[0].testSupportFiles = ["test/fix.test.js"];
    const { engine, agent } = await scenario(
      [explorer, plan, approved, tester, baselineRepairBlocker, debuggerOutput, json(invalidRepairPlan)],
      [true, true, true]
    );

    expect(engine.getState()?.status).toBe("failed");
    expect(engine.getState()?.message)
      .toContain("testSupportFiles may contain only classified test-support files: test/fix.test.js");
    expect(agent.calls.map(call => call.name)).toEqual([
      "explorer", "planner", "reviewer", "tester", "builder", "debugger", "planner"
    ]);
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

  it("replaces a missing-script baseline check and proceeds without the debugger", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-check-repair-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["npm run build"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "build:desktop": "vite build" } }));
    const agent = new QueueAgent([explorer, plan, approved, tester, builder, approved, documenter, approved]);
    const checkResults = [
      [checkCommand("npm run build", false)],
      [checkCommand("npm run build:desktop", true)],
      [check(true)],
      [check(true)],
      [check(true)]
    ];
    const checkRunner = vi.fn(async () => {
      const next = checkResults.shift();
      if (!next) throw new Error("Missing fake checks");
      return next;
    }) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn(async () => "Replace `npm run build` with `npm run build:desktop`");
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { select, editor: vi.fn(), input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    expect(engine.getState()?.status).toBe("completed");
    expect((await loadConfig(cwd)).checks).toEqual(["npm run build:desktop"]);
    expect(agent.calls.some(call => call.name === "debugger")).toBe(false);
  });

  it("keeps the checkpoint config digest aligned after a baseline check repair", async () => {
    const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-check-repair-digest-"));
    directories.push(cwd);
    const config = defaultTestConfig();
    config.checks = ["npm run build"];
    config.dashboard.enabled = false;
    await saveConfig(cwd, config);
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "build:desktop": "vite build" } }));
    const agent = new QueueAgent([explorer, plan, approved, debuggerOutput, plan]);
    const checkResults = [
      [checkCommand("npm run build", false)],
      [checkCommand("npm run build", false)]
    ];
    const checkRunner = vi.fn(async () => {
      const next = checkResults.shift();
      if (!next) throw new Error("Missing fake checks");
      return next;
    }) as unknown as CheckRunner;
    const pi = { appendEntry: vi.fn(), exec: vi.fn() } as unknown as ExtensionAPI;
    const select = vi.fn()
      .mockResolvedValueOnce("Replace `npm run build` with `npm run build:desktop`")
      .mockResolvedValueOnce(undefined);
    const ctx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: { select, editor: vi.fn(async () => "viewed"), input: vi.fn(), confirm: vi.fn(), notify: vi.fn(), setStatus: vi.fn(), setWidget: vi.fn() }
    } as unknown as ExtensionCommandContext;
    const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, enforceWorkspacePolicy: false });
    await engine.start({ route: "implementation", request: "request" }, ctx);
    const paused = engine.getState()!;
    expect(paused.status).toBe("paused");
    expect(paused.pendingDecision?.kind).toBe("baseline_repair_approval");
    expect((await loadConfig(cwd)).checks).toEqual(["npm run build:desktop"]);
    const checkpointStore = new CheckpointStore(paused.runDir, paused.runId);
    const latest = await checkpointStore.loadLatest();
    expect(canonicalSha256(await loadConfig(cwd))).toBe(latest!.configDigest);

    const resumedAgent = new QueueAgent([builder, tester, builder, approved, documenter, approved]);
    const checkQueue = [[check(true)], [check(true)], [check(true)], [check(true)]];
    const resumed = new Orchestrator(pi, path.resolve("."), {
      agentExecutor: resumedAgent,
      checkRunner: vi.fn(async () => checkQueue.shift() ?? [check(true)]) as unknown as CheckRunner,
      enforceWorkspacePolicy: false
    });
    const resumeCtx = {
      cwd,
      hasUI: true,
      isProjectTrusted: () => true,
      ui: {
        editor: vi.fn(async () => "viewed"),
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
    await resumed.resume(paused.runId, resumeCtx);
    expect(resumed.getState()?.status).toBe("completed");
    expect((await loadConfig(cwd)).checks).toEqual(["npm run build:desktop"]);
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
  });
});
