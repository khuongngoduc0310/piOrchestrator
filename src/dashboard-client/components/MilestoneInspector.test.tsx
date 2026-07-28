// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MilestoneInspector } from "./MilestoneInspector.js";

describe("MilestoneInspector", () => {
  it("renders the selected milestone's complete Markdown", () => {
    render(<MilestoneInspector milestone={{ id: "approved", sequence: 2, kind: "decision", title: "Plan approved", details: "## Evidence\n\n**Accepted** with details.", occurredAt: "2026-07-28T10:00:00.000Z" }} />);
    expect(screen.getByRole("heading", { name: "Evidence" })).not.toBeNull();
    expect(screen.getByText("Accepted").tagName).toBe("STRONG");
    expect(document.querySelector('[data-inspected-milestone="approved"]')).not.toBeNull();
  });
});
