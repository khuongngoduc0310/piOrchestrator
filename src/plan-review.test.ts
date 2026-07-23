import { describe, expect, it } from "vitest";
import type { PlannerOutput } from "./types.js";
import { formatPlanForReview } from "./plan-review.js";

function plan(overrides: Partial<PlannerOutput> = {}): PlannerOutput {
  return {
    route: "implementation",
    summary: "Add pause/resume to the simulation",
    assumptions: ["UI element is the only change needed"],
    acceptanceCriteria: ["Pause preserves state", "Resume continues from same state"],
    tasks: [
      {
        id: "add-ui",
        description: "Add a Pause/Resume button next to the canvas",
        files: ["src/App.js", "src/App.css"],
        dependencies: [],
        verification: ["Button text reflects current state", "Pause state is passed to sketch"]
      },
      {
        id: "update-sketch",
        description: "Use noLoop/loop without reinitializing the simulation",
        files: ["src/sketches/sketch.js"],
        dependencies: ["add-ui"],
        verification: ["Pause does not reset birds", "Resume continues simulation"]
      }
    ],
    risks: ["Property updates must not trigger initialization"],
    ...overrides
  };
}

describe("formatPlanForReview", () => {
  it("labels review-only plans and displays their route", () => {
    const result = formatPlanForReview(plan({ route: "review_only" }));
    expect(result).toContain("# Review Plan");
    expect(result).toContain("**Route:** review_only");
  });

  it("renders a full plan with summary, criteria, tasks, assumptions, and risks", () => {
    const result = formatPlanForReview(plan());
    expect(result).toContain("# Implementation Plan");
    expect(result).toContain("## Summary");
    expect(result).toContain("Add pause/resume to the simulation");
    expect(result).toContain("## Acceptance Criteria");
    expect(result).toContain("- [ ] Pause preserves state");
    expect(result).toContain("- [ ] Resume continues from same state");
    expect(result).toContain("## Tasks");
    expect(result).toContain("### 1. add-ui");
    expect(result).toContain("Add a Pause/Resume button next to the canvas");
    expect(result).toContain("**Files:** src/App.js, src/App.css");
    expect(result).toContain("**Verification:**");
    expect(result).toContain("- Button text reflects current state");
    expect(result).toContain("### 2. update-sketch");
    expect(result).toContain("Use noLoop/loop without reinitializing the simulation");
    expect(result).toContain("**Depends on:** 1. add-ui");
    expect(result).toContain("## Assumptions");
    expect(result).toContain("- UI element is the only change needed");
    expect(result).toContain("## Risks");
    expect(result).toContain("- Property updates must not trigger initialization");
  });

  it("orders tasks topologically by dependencies", () => {
    const input = plan({
      tasks: [
        {
          id: "backend",
          description: "Add API endpoint",
          files: ["api.js"],
          dependencies: ["database"],
          verification: ["Endpoint returns data"]
        },
        {
          id: "database",
          description: "Create database schema",
          files: ["db.js"],
          dependencies: [],
          verification: ["Schema is migrated"]
        },
        {
          id: "frontend",
          description: "Connect UI to API",
          files: ["ui.js"],
          dependencies: ["backend"],
          verification: ["Page loads data"]
        }
      ]
    });
    const result = formatPlanForReview(input);
    const dbIdx = result.indexOf("### 1. database");
    const apiIdx = result.indexOf("### 2. backend");
    const uiIdx = result.indexOf("### 3. frontend");
    expect(dbIdx).toBeGreaterThanOrEqual(0);
    expect(apiIdx).toBeGreaterThan(dbIdx);
    expect(uiIdx).toBeGreaterThan(apiIdx);
  });

  it("skips acceptance criteria when empty", () => {
    const result = formatPlanForReview(plan({ acceptanceCriteria: [] }));
    expect(result).not.toContain("Acceptance Criteria");
  });

  it("skips assumptions when empty", () => {
    const result = formatPlanForReview(plan({ assumptions: [] }));
    expect(result).not.toContain("Assumptions");
  });

  it("skips risks when empty", () => {
    const result = formatPlanForReview(plan({ risks: [] }));
    expect(result).not.toContain("Risks");
  });

  it("omits Depends on when no dependencies", () => {
    const result = formatPlanForReview(plan({
      tasks: [{
        id: "solo",
        description: "Do the thing",
        files: ["x.js"],
        dependencies: [],
        verification: []
      }]
    }));
    expect(result).not.toContain("Depends on");
  });

  it("omits Files section when no files", () => {
    const result = formatPlanForReview(plan({
      tasks: [{
        id: "solo",
        description: "Do the thing",
        files: [],
        dependencies: [],
        verification: []
      }]
    }));
    expect(result).not.toContain("**Files:**");
  });

  it("omits Verification section when empty", () => {
    const result = formatPlanForReview(plan({
      tasks: [{
        id: "solo",
        description: "Do the thing",
        files: ["x.js"],
        dependencies: [],
        verification: []
      }]
    }));
    expect(result).not.toContain("**Verification:**");
  });

  it("handles multiline descriptions", () => {
    const result = formatPlanForReview(plan({
      tasks: [{
        id: "multi",
        description: "Line one\n\nLine two\nLine three",
        files: [],
        dependencies: [],
        verification: []
      }]
    }));
    expect(result).toContain("Line one\n\nLine two\nLine three");
  });

  it("renders a baseline repair plan the same way", () => {
    const baselineFix: PlannerOutput = {
      route: "implementation",
      summary: "Fix broken test assertion",
      assumptions: ["Only test file change needed"],
      acceptanceCriteria: ["Baseline checks pass"],
      tasks: [{
        id: "fix-test",
        description: "Update assertion in App.test.js",
        files: ["src/App.test.js"],
        dependencies: [],
        verification: ["npm test passes"]
      }],
      risks: []
    };
    const result = formatPlanForReview(baselineFix);
    expect(result).toContain("# Implementation Plan");
    expect(result).toContain("## Summary");
    expect(result).toContain("Fix broken test assertion");
    expect(result).toContain("### 1. fix-test");
    expect(result).toContain("**Files:** src/App.test.js");
  });
});
