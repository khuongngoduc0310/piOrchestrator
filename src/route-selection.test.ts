import { describe, expect, it } from "vitest";
import { ORCHESTRATE_USAGE, parseWorkflowRequest } from "./route-selection.js";
import { WORKFLOW_ROUTES } from "./agent-task-types.js";

describe("parseWorkflowRequest", () => {
  it.each(WORKFLOW_ROUTES)("accepts %s", route => {
    expect(parseWorkflowRequest(`--route ${route} do the requested work`)).toEqual({
      route,
      request: "do the requested work"
    });
  });

  it.each(["", "request only", "--route", "--route unknown request", "--route implementation"])(
    "rejects invalid input %j",
    input => expect(() => parseWorkflowRequest(input)).toThrow(`Usage: ${ORCHESTRATE_USAGE}`)
  );

  it("treats later option-looking text as request content", () => {
    expect(parseWorkflowRequest("--route implementation add --route handling").request).toBe("add --route handling");
  });
});
