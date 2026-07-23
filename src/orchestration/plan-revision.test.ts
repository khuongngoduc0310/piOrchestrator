import { describe, expect, it } from "vitest";
import type { PlannerOutput } from "../types.js";
import { filesOutsidePlan, validateFailureScopeRevision } from "./plan-revision.js";

const plan: PlannerOutput = {
  route: "quick_implementation",
  summary: "change component",
  assumptions: [],
  acceptanceCriteria: ["A sixth card is displayed"],
  tasks: [{
    id: "change",
    description: "change component and unit test",
    files: ["src/Card.tsx", "src/Card.test.tsx"],
    dependencies: [],
    verification: ["run tests"]
  }],
  risks: []
};

describe("failure scope revisions", () => {
  it("accepts exactly the diagnosed additions", () => {
    const revised = structuredClone(plan);
    revised.tasks.push({
      id: "update-integration",
      description: "update the stale integration assertion",
      files: ["src/App.test.tsx"],
      dependencies: ["change"],
      verification: ["run integration tests"]
    });
    expect(validateFailureScopeRevision(plan, revised, ["src/App.test.tsx"])).toBe(revised);
    expect(filesOutsidePlan(plan, ["src/Card.tsx", "src/App.test.tsx"])).toEqual(["src/App.test.tsx"]);
  });

  it.each([
    ["route", (revised: PlannerOutput) => { revised.route = "implementation"; }],
    ["acceptance criteria", (revised: PlannerOutput) => { revised.acceptanceCriteria = ["different"]; }],
    ["existing files", (revised: PlannerOutput) => { revised.tasks[0].files = ["src/Card.tsx"]; }],
    ["unrelated files", (revised: PlannerOutput) => { revised.tasks[0].files.push("src/Other.ts"); }]
  ])("rejects a revision that changes %s", (_name, mutate) => {
    const revised = structuredClone(plan);
    revised.tasks.push({
      id: "update-integration",
      description: "update integration",
      files: ["src/App.test.tsx"],
      dependencies: [],
      verification: ["run tests"]
    });
    mutate(revised);
    expect(() => validateFailureScopeRevision(plan, revised, ["src/App.test.tsx"])).toThrow();
  });
});
