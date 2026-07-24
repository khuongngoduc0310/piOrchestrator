import { describe, expect, it } from "vitest";
import type { OrchestratorViewModel } from "../dashboard-types.js";
import { dashboardReducer, INITIAL_STATE } from "./state.js";

function snapshot(runId: string): OrchestratorViewModel {
  return {
    mode: "running",
    cwd: "C:/repo",
    config: { status: "valid", agentCount: 7, checkCount: 1 },
    run: {
      id: runId,
      request: "test",
      route: "implementation",
      stage: "planning",
      phaseIndex: 2,
      phaseCount: 8,
      runStatus: "running",
      attempt: 0,
      maxAttempts: 1,
      elapsedMs: 0,
      artifactPath: "C:/repo/.pi/orchestrator/runs/run",
      transcriptRevision: 0
    },
    agents: [],
    recentSteps: [],
    commands: []
  };
}

describe("dashboard state", () => {
  it("ignores a historical response for a run that is no longer selected", () => {
    let state = dashboardReducer(INITIAL_STATE, { type: "runSelected", runId: "run-a" });
    state = dashboardReducer(state, { type: "runSelected", runId: "run-b" });
    const next = dashboardReducer(state, {
      type: "historicalSnapshotLoaded",
      runId: "run-a",
      snapshot: snapshot("run-a")
    });
    expect(next.displayedSnapshot).toBeNull();
    expect(next.selectedRunId).toBe("run-b");
  });

  it("keeps automatic agent selection in auto mode", () => {
    const state = dashboardReducer(INITIAL_STATE, {
      type: "agentAutoSelected",
      agent: "builder"
    });
    expect(state.agentMode).toBe("auto");
    expect(state.selectedAgent).toBe("builder");
  });
});
