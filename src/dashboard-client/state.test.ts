import { describe, expect, it } from "vitest";
import type { OrchestratorViewModel, PendingDecisionInfo } from "../dashboard-types.js";
import { dashboardReducer, INITIAL_STATE, isSelectedLiveRun, isViewingLiveRun } from "./state.js";

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
  const decision: PendingDecisionInfo = {
    id: "decision-1",
    kind: "plan_approval",
    label: "Review plan",
    requestedAt: "2026-01-01T00:00:00.000Z",
    dashboardAvailable: false,
  };

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

  it("refreshes availability for a pending decision with the same ID", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "pendingDecisionUpdated",
      decision,
    });
    state = dashboardReducer(state, {
      type: "pendingDecisionUpdated",
      decision: { ...decision, dashboardAvailable: true },
    });

    expect(state.pendingDecision?.dashboardAvailable).toBe(true);
    expect(state.previewStatus).toBe("loading");
  });

  it("starts a fresh preview request when retrying", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "pendingDecisionUpdated",
      decision,
    });
    state = dashboardReducer(state, { type: "planPreviewError", decisionId: "decision-1", error: "HTTP 500" });
    state = dashboardReducer(state, { type: "planPreviewRetryRequested" });

    expect(state.previewStatus).toBe("loading");
    expect(state.previewError).toBeNull();
  });

  it("ignores a submission result from a superseded decision", () => {
    let state = dashboardReducer(INITIAL_STATE, { type: "pendingDecisionUpdated", decision });
    state = dashboardReducer(state, { type: "pendingDecisionUpdated", decision: { ...decision, id: "decision-2" } });
    state = dashboardReducer(state, { type: "decisionSubmitted", decisionId: "decision-1" });
    expect(state.currentDecisionId).toBe("decision-2");
    expect(state.submissionStatus).toBe("idle");
  });

  it("keeps an explicitly selected historical run when live state changes", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "liveSnapshotReceived",
      snapshot: snapshot("run-live"),
    });
    state = dashboardReducer(state, { type: "runSelected", runId: "run-old" });
    state = dashboardReducer(state, {
      type: "historicalSnapshotLoaded",
      runId: "run-old",
      snapshot: snapshot("run-old"),
    });
    state = dashboardReducer(state, {
      type: "liveSnapshotReceived",
      snapshot: { ...snapshot("run-live"), mode: "completed" },
    });

    expect(state.selectedRunId).toBe("run-old");
    expect(state.displayedSnapshot?.run?.id).toBe("run-old");
    expect(isViewingLiveRun(state)).toBe(false);
  });

  it("clears the prior snapshot while a different historical run loads", () => {
    let state = dashboardReducer(INITIAL_STATE, { type: "liveSnapshotReceived", snapshot: snapshot("run-live") });
    state = dashboardReducer(state, { type: "runSelected", runId: "run-old" });
    expect(state.displayedSnapshot).toBeNull();
    expect(state.selectedRunId).toBe("run-old");
  });

  it("does not treat agent history as the live run view", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "liveSnapshotReceived",
      snapshot: snapshot("run-live"),
    });
    state = dashboardReducer(state, { type: "viewSelected", view: "agent-history" });

    expect(isViewingLiveRun(state)).toBe(false);
    expect(isSelectedLiveRun(state)).toBe(true);
  });

  it("auto-opens a report when the live workflow completes and allows returning", () => {
    let state = dashboardReducer(INITIAL_STATE, { type: "liveSnapshotReceived", snapshot: snapshot("run-live") });
    state = dashboardReducer(state, { type: "liveSnapshotReceived", snapshot: { ...snapshot("run-live"), mode: "completed", run: { ...snapshot("run-live").run!, runStatus: "completed", stage: "completed" } } });
    expect(state.view).toBe("report");
    expect(isViewingLiveRun(state)).toBe(true);

    state = dashboardReducer(state, { type: "viewSelected", view: "run" });
    expect(state.view).toBe("run");
  });

  it("does not auto-open reports for historical snapshot loads", () => {
    let state = dashboardReducer(INITIAL_STATE, { type: "runSelected", runId: "old" });
    state = dashboardReducer(state, { type: "historicalSnapshotLoaded", runId: "old", snapshot: { ...snapshot("old"), mode: "completed", run: { ...snapshot("old").run!, runStatus: "completed", stage: "completed" } } });
    expect(state.view).toBe("run");
  });

  it("keeps an initially completed live run in report view when it is selected", () => {
    const completed = { ...snapshot("run-live"), mode: "completed" as const, run: { ...snapshot("run-live").run!, runStatus: "completed" as const, stage: "completed" as const } };
    let state = dashboardReducer(INITIAL_STATE, { type: "liveSnapshotReceived", snapshot: completed });
    state = dashboardReducer(state, { type: "runSelected", runId: "run-live" });
    expect(state.view).toBe("report");
  });
});
