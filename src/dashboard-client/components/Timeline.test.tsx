// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { StepRecord } from "../../workflow-types.js";
import { Timeline } from "./Timeline.js";

describe("Timeline", () => {
  it("exposes textual step status while hiding the decorative icon", () => {
    const step = {
      id: "step-1",
      sequence: 1,
      stage: "planning",
      label: "Create plan",
      status: "failed",
      startedAt: "2026-01-01T12:00:00.000Z",
    } satisfies StepRecord;

    render(<Timeline steps={[step]} onOpenArtifact={vi.fn()} />);

    expect(screen.getByText("Failed")).not.toBeNull();
    expect(screen.getByText("!").getAttribute("aria-hidden")).toBe("true");
  });

  it("renders durable milestone titles and Markdown details", () => {
    render(
      <Timeline
        steps={[]}
        milestones={[{
          id: "workflow-completed",
          sequence: 1,
          kind: "completed",
          title: "Workflow completed",
          details: "**Result:** complete",
          occurredAt: "2026-07-28T10:00:00.000Z"
        }]}
        onOpenArtifact={vi.fn()}
      />
    );

    expect(screen.getByText("Workflow completed")).not.toBeNull();
    expect(screen.getByText("Result:").tagName).toBe("STRONG");
    expect(document.querySelector('[data-milestone-id="workflow-completed"]')).not.toBeNull();
  });
});
