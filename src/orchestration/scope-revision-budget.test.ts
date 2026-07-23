import { describe, expect, it } from "vitest";
import { consumeScopeRevision } from "./scope-revision-budget.js";

describe("scope revision budget", () => {
  it("treats zero as no revisions", () => {
    expect(() => consumeScopeRevision(0, 0, "during implementation")).toThrow("limit reached");
  });

  it("increments until the configured limit", () => {
    expect(consumeScopeRevision(0, 2, "during implementation")).toBe(1);
    expect(consumeScopeRevision(1, 2, "during review")).toBe(2);
    expect(() => consumeScopeRevision(2, 2, "during review")).toThrow("limit reached");
  });
});
