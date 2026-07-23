import { describe, expect, it } from "vitest";
import { ROLE_CAPABILITIES, ROLE_MAXIMUM_TOOLS, intersectRoleTools, validateRoleTools } from "./role-capabilities.js";
import { AGENT_NAMES } from "../types.js";

describe("role capabilities", () => {
  it("has immutable role maxima with no shell access", () => {
    for (const role of AGENT_NAMES) expect(ROLE_MAXIMUM_TOOLS[role]).not.toContain("bash");
    expect(Object.isFrozen(ROLE_CAPABILITIES)).toBe(true);
    expect(Object.isFrozen(ROLE_MAXIMUM_TOOLS.builder)).toBe(true);
  });

  it("assigns only the intended mutation kinds", () => {
    expect(Object.fromEntries(AGENT_NAMES.map(role => [role, ROLE_CAPABILITIES[role].mutation]))).toEqual({
      explorer: "none",
      planner: "none",
      reviewer: "none",
      tester: "tests",
      builder: "plan_files",
      debugger: "none",
      documenter: "documentation"
    });
  });

  it("allows configuration to narrow but not widen a role", () => {
    expect(validateRoleTools("builder", ["read", "edit"])).toEqual(["read", "edit"]);
    expect(() => validateRoleTools("builder", ["read", "bash"])).toThrow("builder may not use tool: bash");
    expect(() => validateRoleTools("reviewer", ["write"])).toThrow("reviewer may not use tool: write");
    expect(() => validateRoleTools("builder", ["read", "read"])).toThrow("duplicate tool");
  });

  it("intersects configured tools in stable order", () => {
    expect(intersectRoleTools("tester", ["bash", "edit", "read", "edit"])).toEqual(["edit", "read"]);
  });
});
