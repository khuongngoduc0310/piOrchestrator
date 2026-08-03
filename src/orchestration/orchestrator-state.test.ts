import { describe, expect, it, vi } from "vitest";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { publishMilestone, recordMarkdownMilestone, recordMilestone } from "./orchestrator-state.js";
import type { WorkflowState } from "../workflow-types.js";

describe("recordMilestone", () => {
  it("records and publishes canonical milestone Markdown at separate durability boundaries", () => {
    const state = { runId: "run-1" } as WorkflowState;
    const sendMessage = vi.fn();
    const runtime = {
      state,
      requireState: () => state,
      timestamp: () => "2026-07-28T10:00:00.000Z",
      pi: { sendMessage }
    } as unknown as OrchestratorRuntime;

    const milestone = recordMilestone(runtime, {
      id: "plan-approved",
      kind: "plan.approved",
      title: "Plan approved",
      details: "Proceed with the approved implementation plan.",
      decisionId: "decision-1"
    });

    expect(milestone).toEqual({
      id: "plan-approved",
      sequence: 1,
      kind: "plan.approved",
      title: "Plan approved",
      details: "Proceed with the approved implementation plan.",
      occurredAt: "2026-07-28T10:00:00.000Z",
      decisionId: "decision-1"
    });
    expect(state.milestones).toEqual([milestone]);
    expect(sendMessage).not.toHaveBeenCalled();

    publishMilestone(runtime, milestone);
    expect(sendMessage).toHaveBeenCalledWith({
      customType: "pi-orchestrator",
      content: "## Plan approved\n\nProceed with the approved implementation plan.",
      display: true,
      details: {
        runId: "run-1",
        kind: "plan.approved",
        milestoneId: "plan-approved",
        milestoneKind: "plan.approved",
        decisionId: "decision-1"
      }
    });
  });

  it("records a structured milestone from canonical session Markdown", () => {
    const state = { runId: "run-1" } as WorkflowState;
    const runtime = {
      state,
      requireState: () => state,
      timestamp: () => "2026-07-28T10:00:00.000Z",
      pi: { sendMessage: vi.fn() }
    } as unknown as OrchestratorRuntime;

    expect(recordMarkdownMilestone(runtime, "review-complete", "review.complete", "## Code review complete\n\n**Decision:** approved")).toMatchObject({
      title: "Code review complete",
      details: "**Decision:** approved"
    });
  });

  it("deduplicates by stable id without publishing again", () => {
    const existing = {
      id: "plan-approved",
      sequence: 1,
      kind: "plan.approved",
      title: "Plan approved",
      details: "Original details",
      occurredAt: "2026-07-28T10:00:00.000Z"
    };
    const state = { runId: "run-1", milestones: [existing] } as WorkflowState;
    const sendMessage = vi.fn();
    const runtime = {
      state,
      requireState: () => state,
      timestamp: vi.fn(),
      pi: { sendMessage }
    } as unknown as OrchestratorRuntime;

    const result = recordMilestone(runtime, {
      id: "plan-approved",
      kind: "plan.reapproved",
      title: "Changed title",
      details: "Changed details"
    });

    expect(result).toBe(existing);
    expect(state.milestones).toEqual([existing]);
    expect(runtime.timestamp).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
