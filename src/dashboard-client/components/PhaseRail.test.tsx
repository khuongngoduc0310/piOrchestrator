// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RunSummary } from "../../dashboard-types.js";
import { PhaseRail } from "./PhaseRail.js";

function run(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "run-1",
    request: "test",
    runStatus: "running",
    stage: "documenting",
    phaseIndex: 7,
    phaseCount: 8,
    attempt: 1,
    maxAttempts: 1,
    elapsedMs: 0,
    artifactPath: "/tmp/run-1",
    ...overrides,
  };
}

describe("PhaseRail", () => {
  it("renders the final phase as complete for a completed run", () => {
    render(<PhaseRail run={run({ runStatus: "completed", stage: "completed" })} />);

    const finalPhase = screen.getByLabelText("Completed: Finalize");
    expect(finalPhase.classList.contains("done")).toBe(true);
    expect(finalPhase.hasAttribute("aria-current")).toBe(false);
    expect(finalPhase.textContent).toContain("✓");
  });

  it.each([
    ["failed", "Failed: Finalize"],
    ["cancelled", "Cancelled: Finalize"],
  ] as const)("does not mark a %s run phase as current", (runStatus, label) => {
    render(<PhaseRail run={run({ runStatus, stage: runStatus })} />);

    const finalPhase = screen.getByLabelText(label);
    expect(finalPhase.classList.contains("active")).toBe(false);
    expect(finalPhase.classList.contains(runStatus)).toBe(true);
    expect(finalPhase.hasAttribute("aria-current")).toBe(false);
  });
});
