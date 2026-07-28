import { describe, expect, it } from "vitest";
import type { TimelineStepSummary } from "../dashboard-types.js";
import { derivePreviousAgent, isNarrowWorkspace, preferredInvocationKey } from "./workspace.js";

function step(sequence: number, agent: "explorer" | "planner" | "builder", status: "running" | "succeeded" = "succeeded"): TimelineStepSummary {
  return { id: `step-${sequence}`, sequence, stage: "planning", label: agent, status, agent, startedAt: `2026-01-01T00:00:0${sequence}.000Z` };
}

describe("mission workspace derivation", () => {
  it("derives the immediately previous distinct agent from timeline order", () => {
    expect(derivePreviousAgent([step(1, "explorer"), step(2, "planner"), step(3, "builder", "running")], "builder")).toBe("planner");
  });

  it("does not treat repeated active-agent steps as the previous handoff", () => {
    expect(derivePreviousAgent([step(1, "explorer"), step(2, "builder"), step(3, "builder", "running")], "builder")).toBe("explorer");
  });

  it("uses the 1280 pixel breakpoint for drawer state", () => {
    expect(isNarrowWorkspace(1279)).toBe(true);
    expect(isNarrowWorkspace(1280)).toBe(false);
  });

  it("prefers the latest running invocation while preserving an explicit selection", () => {
    const invocations = [
      { key: "step-1:1", status: "succeeded" },
      { key: "step-2:1", status: "running" },
    ];
    expect(preferredInvocationKey(invocations, null)).toBe("step-2:1");
    expect(preferredInvocationKey(invocations, "step-1:1")).toBe("step-1:1");
    expect(preferredInvocationKey(invocations, "step-1:1", false)).toBe("step-2:1");
  });
});
