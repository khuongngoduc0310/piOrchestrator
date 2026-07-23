import { describe, expect, it } from "vitest";
import { buildIdleViewModel, buildRunViewModel, elapsedText, phaseProgress } from "./ui-model.js";
import type { ConfigSummary, WorkflowState, StepRecord } from "./types.js";
import { AGENT_NAMES, SCHEMA_VERSION } from "./types.js";

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

    it("offers the exact resume command only for terminal runs with a checkpoint", () => {
      const checkpoint = { number: 3, cursor: "implementation_verified" as const, createdAt: new Date().toISOString() };
      const failed = buildRunViewModel(sampleState({ status: "failed", stage: "failed", latestCheckpoint: checkpoint }), validConfig, "/project", 1, 3);
      const running = buildRunViewModel(sampleState({ latestCheckpoint: checkpoint }), validConfig, "/project", 1, 3);
      expect(failed.run?.resumeCommand).toBe("/orchestrator-resume run-abc-123");
      expect(failed.commands).toContain("/orchestrator-resume run-abc-123");
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
});
