import { describe, expect, it } from "vitest";
import { buildIdleViewModel, buildRequirementsViewModel, buildRunViewModel, elapsedText, interviewQaToDashboard, phaseProgress } from "./ui-model.js";
import type { ConfigSummary } from "../dashboard-types.js";
import type { WorkflowState, StepRecord } from "../workflow-types.js";
import { AGENT_NAMES } from "../agent-types.js";
import { SCHEMA_VERSION } from "../workflow-types.js";

const validConfig: ConfigSummary = {
  status: "valid",
  agentCount: AGENT_NAMES.length,
  checkCount: 2
};

const emptyConfig: ConfigSummary = {
  status: "missing",
  agentCount: AGENT_NAMES.length,
  checkCount: 0
};

const errorConfig: ConfigSummary = {
  status: "invalid",
  agentCount: AGENT_NAMES.length,
  checkCount: 0,
  message: "Could not parse config"
};

function agentDefaults(): Record<string, { status: "idle"; model: string }> {
  return Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle" as const, model: `provider/${name}` }]));
}

const baseSteps: StepRecord[] = [
  { id: "step-001", sequence: 1, stage: "preflight", label: "Preflight", status: "succeeded", startedAt: new Date().toISOString() },
  { id: "step-002", sequence: 2, stage: "exploring", label: "Explore repository", status: "running", startedAt: new Date().toISOString() }
];

const sampleState = (overrides: Partial<WorkflowState> = {}): WorkflowState => ({
  schemaVersion: SCHEMA_VERSION,
  extensionVersion: "0.0.0",
  runId: "run-abc-123",
  request: "add a simple feature",
  cwd: "/project",
  runDir: "/project/.pi/orchestrator/runs/run-abc-123",
  stage: "exploring",
  status: "running",
  attempt: 1,
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  agents: agentDefaults() as WorkflowState["agents"],
  steps: [...baseSteps],
  ...overrides
});

describe("UiModel", () => {
  describe("buildIdleViewModel", () => {
    it("returns idle mode with valid config", () => {
      const vm = buildIdleViewModel("/project", validConfig);
      expect(vm.mode).toBe("idle");
      expect(vm.config.checkCount).toBe(2);
      expect(vm.config.status).toBe("valid");
      expect(vm.run).toBeUndefined();
      expect(vm.recentSteps).toEqual([]);
      expect(vm.milestones).toEqual([]);
      expect(vm.commands).toContain("/orchestrate");
      expect(vm.commands.join(" ")).not.toContain("--route");
    });

    it("returns idle mode with missing config", () => {
      const vm = buildIdleViewModel("/project", emptyConfig);
      expect(vm.mode).toBe("idle");
      expect(vm.config.status).toBe("missing");
    });

    it("returns config_error mode with invalid config", () => {
      const vm = buildIdleViewModel("/project", errorConfig);
      expect(vm.mode).toBe("config_error");
      expect(vm.config.message).toBe("Could not parse config");
    });
  });

  describe("buildRunViewModel", () => {
    it("returns running mode for an active workflow", () => {
      const vm = buildRunViewModel(sampleState(), validConfig, "/project", 5000, 3);
      expect(vm.mode).toBe("running");
      expect(vm.run).toBeDefined();
      expect(vm.run!.phaseIndex).toBe(1);
      expect(vm.run!.phaseCount).toBe(8);
      expect(vm.run!.runStatus).toBe("running");
      expect(vm.run!.elapsedMs).toBe(5000);
    });

    it("does not report fewer maximum attempts than have been used", () => {
      const vm = buildRunViewModel(sampleState({ attempt: 4 }), validConfig, "/project", 5000, 3);
      expect(vm.run!.attempt).toBe(4);
      expect(vm.run!.maxAttempts).toBe(4);
    });

    it("exposes review-only routing and maps repository review to the review phase", () => {
      const vm = buildRunViewModel(sampleState({
        route: "review_only",
        stage: "reviewing_repository",
        steps: [{ id: "step-003", sequence: 3, stage: "reviewing_repository", label: "Review repository", status: "running", startedAt: new Date().toISOString() }]
      }), validConfig, "/project", 5000, 3);
      expect(vm.run?.route).toBe("review_only");
      expect(vm.run?.phaseIndex).toBe(6);
      expect(vm.run?.skippedPhaseIndexes).toEqual([3, 4, 5]);
    });

    it("returns completed mode for a finished workflow", () => {
      const state = sampleState({
        status: "completed",
        stage: "completed",
        steps: [
          { id: "step-001", sequence: 1, stage: "preflight", label: "Preflight", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-002", sequence: 2, stage: "exploring", label: "Explore", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-003", sequence: 3, stage: "completed", label: "Completed", status: "succeeded", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 30000, 3);
      expect(vm.mode).toBe("completed");
      expect(vm.run!.phaseIndex).toBe(7);
    });

    it("includes dashboardUrl when present in state", () => {
      const state = sampleState({ dashboardUrl: "http://127.0.0.1:3456" });
      const vm = buildRunViewModel(state, validConfig, "/project", 5000, 3);
      expect(vm.run!.dashboardUrl).toBe("http://127.0.0.1:3456");
    });

    it("returns failed mode with failed artifact path and phase from failedStage", () => {
      const state = sampleState({
        status: "failed",
        stage: "failed",
        failedStage: "exploring",
        steps: [
          { id: "step-001", sequence: 1, stage: "exploring", label: "Explore", status: "failed", startedAt: new Date().toISOString(), rawArtifact: "001-exploring-invalid-output.txt", message: "invalid output" }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 15000, 3);
      expect(vm.mode).toBe("failed");
      expect(vm.run!.failedArtifact).toBe("001-exploring-invalid-output.txt");
      expect(vm.run!.phaseIndex).toBe(1);
    });

    it("offers the exact resume command for paused or terminal runs with a checkpoint", () => {
      const checkpoint = { number: 3, cursor: "implementation_verified" as const, createdAt: new Date().toISOString() };
      const failed = buildRunViewModel(sampleState({ status: "failed", stage: "failed", latestCheckpoint: checkpoint }), validConfig, "/project", 1, 3);
      const paused = buildRunViewModel(sampleState({ status: "paused", waitingFor: "Plan approval", latestCheckpoint: checkpoint }), validConfig, "/project", 1, 3);
      const running = buildRunViewModel(sampleState({ latestCheckpoint: checkpoint }), validConfig, "/project", 1, 3);
      expect(failed.run?.resumeCommand).toBe("/orchestrator-resume run-abc-123");
      expect(failed.commands).toContain("/orchestrator-resume run-abc-123");
      expect(paused.mode).toBe("paused");
      expect(paused.run?.resumeCommand).toBe("/orchestrator-resume run-abc-123");
      expect(running.run?.resumeCommand).toBeUndefined();
    });

    it("returns waiting mode when waitingFor is set", () => {
      const state = sampleState({ waitingFor: "User approval required" });
      const vm = buildRunViewModel(state, validConfig, "/project", 10000, 3);
      expect(vm.mode).toBe("waiting");
    });

    it.each(["completed", "failed", "cancelled"] as const)(
      "returns %s mode instead of waiting for a terminal workflow",
      status => {
        const state = sampleState({
          status,
          stage: status,
          waitingFor: "Stale human gate"
        });
        const vm = buildRunViewModel(state, validConfig, "/project", 10000, 3);
        expect(vm.mode).toBe(status);
      }
    );

    it("uses structurally available termination details without changing WorkflowState", () => {
      const state = {
        ...sampleState({ status: "failed", stage: "failed", message: "legacy reason" }),
        stoppedStage: "reviewing_code",
        termination: {
          kind: "capability_violation",
          message: "Builder attempted a disallowed tool"
        }
      } as WorkflowState;
      const vm = buildRunViewModel(state, validConfig, "/project", 10000, 3);
      expect(vm.run!.phaseIndex).toBe(6);
      expect(vm.run!.message).toBe("Builder attempted a disallowed tool");
    });
  });

  describe("stageToPhaseIndex — phase mapping", () => {
    const mapping: Array<{ stage: string; expected: number; label?: string }> = [
      { stage: "preflight", expected: 0 },
      { stage: "exploring", expected: 1 },
      { stage: "planning", expected: 2 },
      { stage: "reviewing_plan", expected: 2 },
      { stage: "human_review_plan", expected: 2 },
      { stage: "human_review_revision", expected: 2 },
      { stage: "baseline", expected: 3 },
      { stage: "creating_tests", expected: 4 },
      { stage: "human_confirm_mutation", expected: 4 },
      { stage: "implementing", expected: 5 },
      { stage: "debugging", expected: 5 },
      { stage: "reviewing_code", expected: 6 },
      { stage: "documenting", expected: 7 },
      { stage: "screening_lessons", expected: 7 },
      { stage: "human_review_lessons", expected: 7 },
      { stage: "promoting_memory", expected: 7 },
      { stage: "reviewing_lessons", expected: 7 },
    ];

    for (const { stage, expected } of mapping) {
      it(`maps ${stage} to phase ${expected}`, () => {
        const state = sampleState({ stage: stage as WorkflowState["stage"] });
        const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
        expect(vm.run!.phaseIndex).toBe(expected);
      });
    }

    it("maps investigation debugging to the read-only review phase", () => {
      const state = sampleState({ stage: "debugging", route: "investigation_only" });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.run!.phaseIndex).toBe(6);
      expect(vm.run!.skippedPhaseIndexes).not.toContain(6);
    });

    it("maps testing to phase 4 for after-test-creation checks", () => {
      const state = sampleState({
        stage: "testing",
        steps: [
          ...baseSteps,
          { id: "step-003", sequence: 3, stage: "testing", label: "Run checks after test creation", status: "running", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.run!.phaseIndex).toBe(4);
    });

    it("maps testing to phase 5 for implementation checks", () => {
      const state = sampleState({
        stage: "testing",
        steps: [
          ...baseSteps,
          { id: "step-003", sequence: 3, stage: "creating_tests", label: "Create tests", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-004", sequence: 4, stage: "implementing", label: "Implement plan", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-005", sequence: 5, stage: "testing", label: "Run implementation checks (attempt 1)", status: "running", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.run!.phaseIndex).toBe(5);
    });

    it("maps testing to phase 6 for review-fix checks", () => {
      const state = sampleState({
        stage: "testing",
        steps: [
          ...baseSteps,
          { id: "step-003", sequence: 3, stage: "creating_tests", label: "Create tests", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-004", sequence: 4, stage: "reviewing_code", label: "Code review", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-005", sequence: 5, stage: "testing", label: "Run checks after review fix 1", status: "running", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.run!.phaseIndex).toBe(6);
    });

    it("maps testing to phase 7 for final checks", () => {
      const state = sampleState({
        stage: "testing",
        steps: [
          ...baseSteps,
          { id: "step-003", sequence: 3, stage: "creating_tests", label: "Create tests", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-004", sequence: 4, stage: "reviewing_code", label: "Code review", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-005", sequence: 5, stage: "testing", label: "Run final checks after all agent sessions", status: "running", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.run!.phaseIndex).toBe(7);
    });

    it("maps testing to default phase 4 when label is unknown", () => {
      const state = sampleState({
        stage: "testing",
        steps: [
          ...baseSteps,
          { id: "step-003", sequence: 3, stage: "testing", label: "Some unknown test check", status: "running", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.run!.phaseIndex).toBe(4);
    });

    it("uses failedStage for failed workflows to avoid phase regression", () => {
      const state = sampleState({
        status: "failed",
        stage: "failed",
        failedStage: "reviewing_code",
        steps: [
          { id: "step-001", sequence: 1, stage: "preflight", label: "Preflight", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-002", sequence: 2, stage: "exploring", label: "Explore", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-003", sequence: 3, stage: "reviewing_code", label: "Code review", status: "failed", startedAt: new Date().toISOString(), message: "review failed" }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 15000, 3);
      expect(vm.mode).toBe("failed");
      expect(vm.run!.phaseIndex).toBe(6);
    });

    it("uses failedStage for cancelled workflows", () => {
      const state = sampleState({
        status: "cancelled",
        stage: "cancelled",
        failedStage: "implementing",
        steps: [
          { id: "step-001", sequence: 1, stage: "preflight", label: "Preflight", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-002", sequence: 2, stage: "exploring", label: "Explore", status: "succeeded", startedAt: new Date().toISOString() },
          { id: "step-003", sequence: 3, stage: "implementing", label: "Implement", status: "cancelled", startedAt: new Date().toISOString() }
        ]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 30000, 3);
      expect(vm.mode).toBe("cancelled");
      expect(vm.run!.phaseIndex).toBe(5);
    });

    it("returns mode cancelled for cancelled runs", () => {
      const state = sampleState({ status: "cancelled", stage: "cancelled", failedStage: "exploring" });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.mode).toBe("cancelled");
    });

    it("limits recent steps to 12", () => {
      const steps: StepRecord[] = [];
      for (let i = 1; i <= 20; i++) {
        steps.push({ id: `step-${i}`, sequence: i, stage: "preflight", label: `Step ${i}`, status: "succeeded", startedAt: new Date().toISOString() });
      }
      const state = sampleState({ steps, stage: "preflight" });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      expect(vm.recentSteps.length).toBe(12);
      expect(vm.recentSteps[0].id).toBe("step-9");
    });

    it("exposes every milestone without affecting the recent step cap", () => {
      const steps = Array.from({ length: 20 }, (_, index): StepRecord => ({
        id: `step-${index + 1}`,
        sequence: index + 1,
        stage: "preflight",
        label: `Step ${index + 1}`,
        status: "succeeded",
        startedAt: new Date().toISOString()
      }));
      const milestones = Array.from({ length: 15 }, (_, index) => ({
        id: `milestone-${index + 1}`,
        sequence: index + 1,
        kind: "plan.approved",
        title: `Milestone ${index + 1}`,
        details: `Details ${index + 1}`,
        occurredAt: "2026-07-28T10:00:00.000Z"
      }));

      const vm = buildRunViewModel(sampleState({ steps, milestones }), validConfig, "/project", 0, 3);

      expect(vm.recentSteps).toHaveLength(12);
      expect(vm.timelineSteps).toHaveLength(20);
      expect(vm.milestones).toEqual(milestones);
    });

    it("uses an empty milestone list for legacy states", () => {
      expect(buildRunViewModel(sampleState(), validConfig, "/project", 0, 3).milestones).toEqual([]);
    });

    it("copies all agent state fields", () => {
      const state = sampleState({
        agents: { ...agentDefaults(), builder: { status: "running" as const, model: "gpt-4", summary: "working", error: undefined } } as WorkflowState["agents"]
      });
      const vm = buildRunViewModel(state, validConfig, "/project", 0, 3);
      const builder = vm.agents.find(a => a.name === "builder")!;
      expect(builder.status).toBe("running");
      expect(builder.summary).toBe("working");
    });
  });

  describe("elapsedText", () => {
    it("formats seconds and minutes", () => {
      expect(elapsedText(0)).toBe("0:00");
      expect(elapsedText(5000)).toBe("0:05");
      expect(elapsedText(65000)).toBe("1:05");
      expect(elapsedText(3660000)).toBe("1h01m");
    });
  });

  describe("phaseProgress", () => {
    it("returns phase label with optional attempt suffix", () => {
      expect(phaseProgress(0)).toBe("Setup / preflight");
      expect(phaseProgress(5, "attempt 2/3")).toBe("Implementation · attempt 2/3");
    });
  });

  describe("buildRequirementsViewModel", () => {
    const base = {
      sessionId: "session-1",
      cwd: "/project",
      goal: "Build a CLI",
      status: "running" as const,
      round: 1,
      maxRounds: 6,
      interviewerStatus: "running" as const
    };

    it("surfaces the session as the live run with only the interviewer agent active", () => {
      const vm = buildRequirementsViewModel(base);
      expect(vm.mode).toBe("running");
      expect(vm.run?.id).toBe("session-1");
      expect(vm.run?.request).toBe("Build a CLI");
      expect(vm.run?.runStatus).toBe("running");
      expect(vm.run?.stage).toBe("exploring");
      expect(vm.run?.attempt).toBe(1);
      expect(vm.run?.maxAttempts).toBe(6);
      expect(vm.agents.find(agent => agent.name === "interviewer")?.status).toBe("running");
      for (const agent of vm.agents.filter(agent => agent.name !== "interviewer")) {
        expect(agent.status).toBe("idle");
      }
    });

    it("maps waiting to a paused stage and carries the pending decision", () => {
      const vm = buildRequirementsViewModel({
        ...base,
        status: "waiting",
        waitingFor: "Is the scope clear?",
        pendingDecision: { id: "d1", kind: "requirements_question", label: "Is the scope clear?", requestedAt: "2026-08-01T00:00:00.000Z", dashboardAvailable: true }
      });
      expect(vm.run?.runStatus).toBe("paused");
      expect(vm.run?.stage).toBe("paused");
      expect(vm.run?.waitingFor).toBe("Is the scope clear?");
      expect(vm.run?.pendingDecision?.kind).toBe("requirements_question");
      expect(vm.run?.pendingDecision?.dashboardAvailable).toBe(true);
    });

    it("exposes completion state with the artifact path and no commands", () => {
      const vm = buildRequirementsViewModel({ ...base, status: "completed", interviewerStatus: "succeeded", artifactPath: "/project/.pi/orchestrator/requirements/session-1" });
      expect(vm.run?.runStatus).toBe("completed");
      expect(vm.run?.artifactPath).toBe("/project/.pi/orchestrator/requirements/session-1");
      expect(vm.commands).toEqual([]);
      expect(vm.agents.find(agent => agent.name === "interviewer")?.status).toBe("succeeded");
    });

    it("offers cancel while the interview is active", () => {
      expect(buildRequirementsViewModel(base).commands).toEqual(["/orchestrator-cancel"]);
      expect(buildRequirementsViewModel({ ...base, status: "waiting" }).commands).toEqual(["/orchestrator-cancel"]);
      expect(buildRequirementsViewModel({ ...base, status: "failed" }).commands).toEqual([]);
    });

    it("carries the interviewer model, transcript revision, and active agent", () => {
      const vm = buildRequirementsViewModel({
        ...base,
        interviewerModel: "anthropic/claude-sonnet-4-5",
        transcriptRevision: 7
      });
      expect(vm.agents.find(agent => agent.name === "interviewer")?.model).toBe("anthropic/claude-sonnet-4-5");
      expect(vm.run?.transcriptRevision).toBe(7);
      expect(vm.run?.activeAgent).toBe("interviewer");
      const idle = buildRequirementsViewModel({ ...base, status: "completed", interviewerStatus: "succeeded" });
      expect(idle.run?.activeAgent).toBeUndefined();
    });

    it("publishes the answered Q&A record and openable artifact names", () => {
      const vm = buildRequirementsViewModel({
        ...base,
        status: "completed",
        interviewerStatus: "succeeded",
        qa: [
          {
            questionText: "Which platforms?",
            kind: "multiple",
            round: 1,
            options: [
              { id: "windows", text: "Windows", recommended: true, picked: true },
              { id: "macos", text: "macOS", recommended: false, picked: false }
            ],
            answerText: "Windows"
          },
          {
            questionText: "Any constraints?",
            kind: "single",
            round: 1,
            options: [{ id: "yes", text: "Yes", recommended: true, picked: false }],
            answerText: "",
            customText: "Keep it small"
          }
        ],
        artifactNames: ["requirements.md", "requirements.json"]
      });
      expect(vm.run?.qa).toEqual([
        {
          questionText: "Which platforms?",
          kind: "multiple",
          round: 1,
          options: [
            { id: "windows", text: "Windows", recommended: true, picked: true },
            { id: "macos", text: "macOS", recommended: false, picked: false }
          ],
          answerText: "Windows"
        },
        {
          questionText: "Any constraints?",
          kind: "single",
          round: 1,
          options: [{ id: "yes", text: "Yes", recommended: true, picked: false }],
          answerText: "",
          customText: "Keep it small"
        }
      ]);
      expect(vm.run?.artifactNames).toEqual(["requirements.md", "requirements.json"]);
    });

    it("carries the structured requirement report when provided", () => {
      const vm = buildRequirementsViewModel({
        ...base,
        status: "completed",
        interviewerStatus: "succeeded",
        requirement: {
          goal: "Build a CLI",
          summary: "A small CLI that prints help",
          scope: ["src"],
          constraints: ["No new dependencies"],
          acceptanceCriteria: ["CLI prints help"],
          openQuestions: []
        }
      });
      expect(vm.run?.requirement).toEqual({
        goal: "Build a CLI",
        summary: "A small CLI that prints help",
        scope: ["src"],
        constraints: ["No new dependencies"],
        acceptanceCriteria: ["CLI prints help"],
        openQuestions: []
      });
    });

    it("defaults the Q&A record to an empty list when no history is provided", () => {
      expect(buildRequirementsViewModel(base).run?.qa).toEqual([]);
      expect(buildRequirementsViewModel(base).run?.artifactNames).toBeUndefined();
      expect(buildRequirementsViewModel(base).run?.requirement).toBeUndefined();
    });
  });

  describe("interviewQaToDashboard", () => {
    const question = {
      id: "q1",
      kind: "multiple" as const,
      text: "Which platforms?",
      options: [
        { id: "windows", text: "Windows", recommended: true },
        { id: "macos", text: "macOS" },
        { id: "linux", text: "Linux" }
      ]
    };

    it("resolves picked option ids to labels and marks the picked options", () => {
      expect(interviewQaToDashboard([
        { question, answer: { questionId: "q1", selectedOptionIds: ["windows", "linux"] }, round: 2 }
      ])).toEqual([
        {
          questionText: "Which platforms?",
          kind: "multiple",
          round: 2,
          options: [
            { id: "windows", text: "Windows", recommended: true, picked: true },
            { id: "macos", text: "macOS", recommended: false, picked: false },
            { id: "linux", text: "Linux", recommended: false, picked: true }
          ],
          answerText: "Windows, Linux"
        }
      ]);
    });

    it("defaults the round to 1 when the history entry has none", () => {
      expect(interviewQaToDashboard([
        { question, answer: { questionId: "q1", selectedOptionIds: ["macos"] } }
      ])).toEqual([
        {
          questionText: "Which platforms?",
          kind: "multiple",
          round: 1,
          options: [
            { id: "windows", text: "Windows", recommended: true, picked: false },
            { id: "macos", text: "macOS", recommended: false, picked: true },
            { id: "linux", text: "Linux", recommended: false, picked: false }
          ],
          answerText: "macOS"
        }
      ]);
    });

    it("keeps the custom text and reports an empty answer text for custom answers", () => {
      expect(interviewQaToDashboard([
        { question, answer: { questionId: "q1", selectedOptionIds: [], customText: "All of them" } }
      ])).toEqual([
        {
          questionText: "Which platforms?",
          kind: "multiple",
          round: 1,
          options: [
            { id: "windows", text: "Windows", recommended: true, picked: false },
            { id: "macos", text: "macOS", recommended: false, picked: false },
            { id: "linux", text: "Linux", recommended: false, picked: false }
          ],
          answerText: "",
          customText: "All of them"
        }
      ]);
    });

    it("falls back to the raw option id when a label is unknown", () => {
      expect(interviewQaToDashboard([
        { question, answer: { questionId: "q1", selectedOptionIds: ["missing"] } }
      ])).toEqual([
        {
          questionText: "Which platforms?",
          kind: "multiple",
          round: 1,
          options: [
            { id: "windows", text: "Windows", recommended: true, picked: false },
            { id: "macos", text: "macOS", recommended: false, picked: false },
            { id: "linux", text: "Linux", recommended: false, picked: false }
          ],
          answerText: "missing"
        }
      ]);
    });

    it("returns an empty record for an empty history", () => {
      expect(interviewQaToDashboard([])).toEqual([]);
    });
  });
});
