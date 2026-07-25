import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { PlannerOutput } from "../agent-task-types.js";
import { createPlanReviewComponent } from "./plan-review-component.js";

function plan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    route: "implementation",
    summary: "Implement the requested change",
    assumptions: [],
    acceptanceCriteria: [],
    tasks: [],
    risks: [],
    ...overrides,
  };
}

function markerTheme(): Pick<Theme, "fg" | "bold" | "bg"> {
  const validColors = new Set(["accent", "muted", "dim", "text"]);
  return {
    fg: (color, text) => {
      if (!validColors.has(color)) throw new Error(`Unknown theme color: ${color}`);
      return `[${color}]${text}[/]`;
    },
    bold: text => `<b>${text}</b>`,
    bg: (color, text) => `[${color}]${text}[/]`,
  };
}

describe("createPlanReviewComponent", () => {
  it("renders the title with the theme's bold style", () => {
    const component = createPlanReviewComponent(
      { requestRender: vi.fn() },
      markerTheme(),
      vi.fn(),
      plan(),
      "Review implementation plan",
    );

    expect(() => component.render(80)).not.toThrow();
    expect(component.render(80)).toContain("<b>Review implementation plan</b>");
  });

  it("focuses Summary and toggles it with Enter", () => {
    const requestRender = vi.fn();
    const component = createPlanReviewComponent(
      { requestRender },
      markerTheme(),
      vi.fn(),
      plan(),
      "Review implementation plan",
    );

    const summaryHeader = component.render(80).find(line => line.includes("Summary"));
    expect(summaryHeader).toContain("[selectedBg]");
    expect(summaryHeader).toContain("[-] Summary");

    component.handleInput("\r");

    const collapsedLines = component.render(80);
    expect(collapsedLines.find(line => line.includes("Summary"))).toContain("[+] Summary");
    expect(collapsedLines).not.toContain("Implement the requested change");
    expect(requestRender).toHaveBeenCalledOnce();
  });

  it("uses arrow keys to focus visible sections and expands the selection", () => {
    const requestRender = vi.fn();
    const component = createPlanReviewComponent(
      { requestRender },
      markerTheme(),
      vi.fn(),
      plan({ assumptions: ["The API is stable"] }),
      "Review implementation plan",
    );

    component.handleInput("\x1b[B");

    const focusedLines = component.render(80);
    expect(focusedLines.find(line => line.includes("Assumptions"))).toContain("[selectedBg]");
    expect(focusedLines.find(line => line.includes("Summary"))).not.toContain("[selectedBg]");

    component.handleInput("\r");

    expect(component.render(80)).toContain("  • The API is stable");
    expect(requestRender).toHaveBeenCalledTimes(2);
  });
});
