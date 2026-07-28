// @vitest-environment jsdom

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { getCurrentState, listRuns } from "../api.js";
import type { DashboardAction } from "../state.js";
import { useDashboardStream } from "./useDashboardStream.js";

vi.mock("../api.js", () => ({
  getCurrentState: vi.fn(() => Promise.resolve(null)),
  listRuns: vi.fn(() => Promise.resolve([])),
}));

class TestEventSource {
  static current: TestEventSource;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor() {
    TestEventSource.current = this;
  }

  close() {}
}

describe("useDashboardStream", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("refreshes same-ID decisions without selecting the live run on status updates", () => {
    vi.stubGlobal("EventSource", TestEventSource);
    const dispatch = vi.fn<(action: DashboardAction) => void>();
    renderHook(() => useDashboardStream(dispatch));

    const first = snapshot(false);
    const second = { ...snapshot(true), mode: "waiting" as const };
    act(() => TestEventSource.current.onmessage?.(message(first)));
    act(() => TestEventSource.current.onmessage?.(message(second)));

    const actions = dispatch.mock.calls.map(([action]) => action);
    expect(actions.filter((action) => action.type === "pendingDecisionUpdated")).toHaveLength(2);
    expect(actions.some((action) => action.type === "runSelected")).toBe(false);
    expect(listRuns).toHaveBeenCalled();
    expect(getCurrentState).toHaveBeenCalled();
  });
});

function snapshot(dashboardAvailable: boolean): OrchestratorViewModel {
  return {
    mode: "running",
    cwd: "C:/repo",
    config: { status: "valid", agentCount: 1, checkCount: 1 },
    run: {
      id: "run-live",
      request: "test",
      stage: "planning",
      phaseIndex: 2,
      phaseCount: 8,
      runStatus: "running",
      attempt: 0,
      maxAttempts: 1,
      elapsedMs: 0,
      artifactPath: "C:/repo/run-live",
      pendingDecision: {
        id: "decision-1",
        kind: "plan_approval",
        label: "Review plan",
        requestedAt: "2026-01-01T00:00:00.000Z",
        dashboardAvailable,
      },
    },
    agents: [],
    recentSteps: [],
    commands: [],
  };
}

function message(data: OrchestratorViewModel): MessageEvent<string> {
  return { data: JSON.stringify(data) } as MessageEvent<string>;
}
