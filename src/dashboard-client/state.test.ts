import { describe, expect, it } from "vitest";
import type { OrchestratorViewModel, PendingDecisionInfo, PendingQuestionInfo } from "../dashboard-types.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";
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

function questionInfo(questionId: string, decisionId: string): PendingQuestionInfo {
  return {
    decisionId,
    questionId,
    kind: "single",
    label: `Question ${questionId}?`,
    content: "**Goal:** Build a CLI",
    actions: [{ value: `opt:${questionId}:yes` as HumanDecisionAction, label: "Yes", requiresFeedback: false }],
    question: {
      id: questionId,
      kind: "single",
      options: [{ id: "yes", text: "Yes", recommended: true, picked: false }],
    },
    answered: false,
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

  it("resets the question focus to the first question when a new set arrives", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    expect(state.questionSet.map(question => question.questionId)).toEqual(["q1", "q2", "q3"]);
    expect(state.questionFocusIndex).toBe(0);
    expect(state.questionSetUpdated).toBe(1);
  });

  it("keeps the focus on the same question when the set is re-presented", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 2 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    expect(state.questionFocusIndex).toBe(2);
  });

  it("auto-advances focus to the entry that follows an answered focused question", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 1 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q3", "d3")],
    });
    expect(state.questionFocusIndex).toBe(1);
    expect(state.questionSet[1].questionId).toBe("q3");
  });

  it("follows the focused question to its new index when earlier questions are answered", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 2 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    expect(state.questionFocusIndex).toBe(1);
    expect(state.questionSet[1].questionId).toBe("q3");
  });

  it("clears the question set state when the round ends", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1")],
    });
    state = dashboardReducer(state, { type: "questionError", decisionId: "d1", error: "HTTP 500" });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [],
    });
    expect(state.questionSet).toEqual([]);
    expect(state.questionFocusIndex).toBeNull();
    expect(state.questionSubmissions).toEqual({});
    expect(state.questionErrors).toEqual({});
    expect(state.questionSetUpdated).toBe(2);
  });

  it("tracks submission status per question decision", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1")],
    });
    state = dashboardReducer(state, { type: "questionSubmitting", decisionId: "d1" });
    expect(state.questionSubmissions).toEqual({ d1: "submitting" });
    state = dashboardReducer(state, { type: "questionSubmitted", decisionId: "d1" });
    expect(state.questionSubmissions).toEqual({ d1: "submitted" });
  });

  it("drops submission state for decisions that leave the set", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1")],
    });
    state = dashboardReducer(state, { type: "questionError", decisionId: "d1", error: "HTTP 500" });
    state = dashboardReducer(state, { type: "questionDismissed", decisionId: "d1" });
    expect(state.questionSubmissions).toEqual({});
    expect(state.questionErrors).toEqual({});
  });

  it("prunes submissions for answered decisions while keeping live ones", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2")],
    });
    state = dashboardReducer(state, { type: "questionError", decisionId: "d1", error: "HTTP 500" });
    state = dashboardReducer(state, { type: "questionSubmitting", decisionId: "d2" });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q2", "d2")],
    });
    expect(state.questionSubmissions).toEqual({ d2: "submitting" });
    expect(state.questionErrors).toEqual({});
    expect(state.questionFocusIndex).toBe(0);
  });

  it("tracks whether the questions panel was dismissed and reopens it", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1")],
    });
    state = dashboardReducer(state, { type: "questionPanelDismissed" });
    expect(state.questionPanelDismissed).toBe(true);
    state = dashboardReducer(state, { type: "questionPanelOpened" });
    expect(state.questionPanelDismissed).toBe(false);
  });

  it("resets the dismissed flag when the question set empties", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1")],
    });
    state = dashboardReducer(state, { type: "questionPanelDismissed" });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [],
    });
    expect(state.questionPanelDismissed).toBe(false);
  });

  it("jumps focus to the commit question when it first appears after the last real question", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 2 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3"), questionInfo("commit", "d-commit")],
    });
    expect(state.questionFocusIndex).toBe(3);
    expect(state.questionSet[3].questionId).toBe("commit");
  });

  it("does not jump focus to the commit question when it sits elsewhere", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 0 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3"), questionInfo("commit", "d-commit")],
    });
    expect(state.questionFocusIndex).toBe(0);
  });

  it("does not re-jump focus on later updates once the commit question is present", () => {
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 2 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3"), questionInfo("commit", "d-commit")],
    });
    expect(state.questionFocusIndex).toBe(3);
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 1 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), questionInfo("q3", "d3"), questionInfo("commit", "d-commit")],
    });
    expect(state.questionFocusIndex).toBe(1);
  });

  it("keeps focus on a multi-select last question when the commit question appears", () => {
    const multi = { ...questionInfo("q-multi", "d-multi"), kind: "multiple" as const };
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), multi],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 2 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [questionInfo("q1", "d1"), questionInfo("q2", "d2"), multi, questionInfo("commit", "d-commit")],
    });
    expect(state.questionFocusIndex).toBe(2);
    expect(state.questionSet[2].questionId).toBe("q-multi");
  });

  it("still jumps focus to the commit question after a single-choice last question", () => {
    const multi = { ...questionInfo("q-multi", "d-multi"), kind: "multiple" as const };
    let state = dashboardReducer(INITIAL_STATE, {
      type: "questionSetUpdated",
      questions: [multi, questionInfo("q2", "d2"), questionInfo("q3", "d3")],
    });
    state = dashboardReducer(state, { type: "questionFocusMoved", index: 2 });
    state = dashboardReducer(state, {
      type: "questionSetUpdated",
      questions: [multi, questionInfo("q2", "d2"), questionInfo("q3", "d3"), questionInfo("commit", "d-commit")],
    });
    expect(state.questionFocusIndex).toBe(3);
  });
});
