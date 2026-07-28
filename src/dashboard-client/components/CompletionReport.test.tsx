// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { CompletionReport } from "./CompletionReport.js";

afterEach(() => vi.unstubAllGlobals());

describe("CompletionReport", () => {
  it("gracefully uses the workflow-completed milestone when summary artifact is unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const snapshot = { mode: "completed", cwd: "/repo", config: { status: "valid", agentCount: 1, checkCount: 1 }, run: { id: "run-1", request: "Ship it", runStatus: "completed", stage: "completed", phaseIndex: 7, phaseCount: 8, attempt: 1, maxAttempts: 1, elapsedMs: 1, artifactPath: "/tmp" }, agents: [], recentSteps: [], commands: [], milestones: [{ id: "workflow-completed", sequence: 1, kind: "completed", title: "Workflow completed", details: "## Result\n\nAll checks passed.", occurredAt: "2026-01-01T00:00:00.000Z" }] } satisfies OrchestratorViewModel;
    render(<CompletionReport snapshot={snapshot} runId="run-1" onConsole={vi.fn()} onArtifacts={vi.fn()} onHistory={vi.fn()} />);
    expect(await screen.findByRole("heading", { name: "Result" })).not.toBeNull();
    expect(screen.getByRole("button", { name: "Back to workspace and console" })).not.toBeNull();
  });
});
