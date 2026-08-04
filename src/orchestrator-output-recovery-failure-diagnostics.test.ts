import { mkdir, mkdtemp, readFile, readdir, writeFile, execFileSync, os, path, describe, expect, it, vi, AgentIncompleteResponseError, Orchestrator, saveConfig, MAX_EVIDENCE_DETAIL_BYTES, directories, defaultTestConfig, explorer, plan, approved, changes, tester, builder, documenter, QueueAgent, check, scenario, json } from "./orchestrator.test-support.js";
import type { ExtensionAPI, ExtensionCommandContext, AgentExecutor, AgentRunOptions, CheckRunner, AgentResult } from "./orchestrator.test-support.js";

describe("Orchestrator", () => {
  describe("malformed output recovery", () => {
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
  });

  describe("failure diagnostics", () => {
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
  });

});
