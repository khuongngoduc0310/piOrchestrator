import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../config/config.js";
import { requiredAgentsForResume, requiredAgentsForRoute } from "./route-preflight.js";

describe("requiredAgentsForRoute", () => {
  it("includes every role reachable by full mutation workflows", () => {
    expect(requiredAgentsForRoute("implementation", DEFAULT_CONFIG)).toEqual([
      "explorer", "planner", "reviewer", "tester", "builder", "debugger", "documenter"
    ]);
    expect(requiredAgentsForRoute("bug_fix", DEFAULT_CONFIG)).toEqual([
      "explorer", "planner", "reviewer", "tester", "builder", "debugger", "documenter"
    ]);
  });

  it("keeps specialized and quick routes within their role scopes", () => {
    expect(requiredAgentsForRoute("quick_implementation", DEFAULT_CONFIG)).toEqual([
      "explorer", "planner", "reviewer", "builder", "debugger", "documenter"
    ]);
    expect(requiredAgentsForRoute("tests_only", DEFAULT_CONFIG)).toEqual([
      "explorer", "planner", "reviewer", "tester", "debugger"
    ]);
    expect(requiredAgentsForRoute("documentation_only", DEFAULT_CONFIG)).toEqual([
      "explorer", "planner", "reviewer", "debugger", "documenter"
    ]);
  });

  it("preflights the route-specific read-only agent even with human plan approval", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.humanInTheLoop.planApproval = true;
    config.humanInTheLoop.planRevisionApproval = true;

    expect(requiredAgentsForRoute("review_only", config)).toEqual(["explorer", "planner", "reviewer"]);
    expect(requiredAgentsForRoute("investigation_only", config)).toEqual(["explorer", "planner", "debugger"]);
    expect(requiredAgentsForRoute("planning_only", config)).toEqual(["explorer", "planner"]);
  });
});

describe("requiredAgentsForResume", () => {
  it("skips preflight when a read-only checkpoint can only finalize", () => {
    expect(requiredAgentsForResume("review_only", DEFAULT_CONFIG, "repository_reviewed")).toEqual([]);
    expect(requiredAgentsForResume("investigation_only", DEFAULT_CONFIG, "investigation_completed")).toEqual([]);
    expect(requiredAgentsForResume("planning_only", DEFAULT_CONFIG, "plan_approved")).toEqual([]);
  });

  it("keeps full route preflight when continuation can still invoke agents", () => {
    expect(requiredAgentsForResume("implementation", DEFAULT_CONFIG, "scope_revision_approved"))
      .toEqual(requiredAgentsForRoute("implementation", DEFAULT_CONFIG));
  });

  it("skips preflight for finalization cursors", () => {
    expect(requiredAgentsForResume("implementation", DEFAULT_CONFIG, "final_checks_passed")).toEqual([]);
    expect(requiredAgentsForResume("implementation", DEFAULT_CONFIG, "documenter_completed")).toEqual([]);
    expect(requiredAgentsForResume("implementation", DEFAULT_CONFIG, "lessons_screened")).toEqual([]);
  });
});
