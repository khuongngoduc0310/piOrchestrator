import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { WORKFLOW_ROUTES } from "../agent-task-types.js";
import { collectWorkflowRequest, isWorkflowRoute, ORCHESTRATE_USAGE, selectWorkflowRoute, WORKFLOW_ROUTE_CHOICES } from "./route-selection.js";

function context(options: {
  hasUI?: boolean;
  selections?: Array<string | undefined>;
  requests?: Array<string | undefined>;
} = {}) {
  const selections = [...(options.selections ?? [])];
  const requests = [...(options.requests ?? [])];
  const select = vi.fn(async () => selections.shift());
  const input = vi.fn(async () => requests.shift());
  const notify = vi.fn();
  return {
    ctx: { hasUI: options.hasUI ?? true, ui: { select, input, notify } } as unknown as ExtensionCommandContext,
    select,
    input,
    notify
  };
}

describe("collectWorkflowRequest", () => {
  it.each(WORKFLOW_ROUTES)("collects the %s route and request", async route => {
    const choice = WORKFLOW_ROUTE_CHOICES.find(item => item.route === route)!;
    const ui = context({ selections: [choice.label], requests: ["  do the requested work  "] });

    await expect(collectWorkflowRequest(ui.ctx)).resolves.toEqual({
      route,
      request: "do the requested work"
    });
    expect(ui.select).toHaveBeenCalledWith("Select a workflow route", WORKFLOW_ROUTE_CHOICES.map(item => item.label));
    expect(ui.input).toHaveBeenCalledWith(`Describe the request for ${route}`);
  });

  it("re-prompts when the request is empty", async () => {
    const ui = context({ selections: [WORKFLOW_ROUTE_CHOICES[0].label], requests: ["   ", "build it"] });

    await expect(collectWorkflowRequest(ui.ctx)).resolves.toEqual({ route: "implementation", request: "build it" });
    expect(ui.input).toHaveBeenCalledTimes(2);
    expect(ui.notify).toHaveBeenCalledWith("Enter a request to start the workflow.", "warning");
  });

  it("stops when route selection is cancelled", async () => {
    const ui = context({ selections: [undefined] });

    await expect(collectWorkflowRequest(ui.ctx)).resolves.toBeUndefined();
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("stops when request entry is cancelled", async () => {
    const ui = context({ selections: [WORKFLOW_ROUTE_CHOICES[1].label], requests: [undefined] });

    await expect(collectWorkflowRequest(ui.ctx)).resolves.toBeUndefined();
  });

  it("fails closed for an unexpected route selection", async () => {
    const ui = context({ selections: ["unknown"] });

    await expect(collectWorkflowRequest(ui.ctx)).resolves.toBeUndefined();
    expect(ui.input).not.toHaveBeenCalled();
  });

  it("requires an interactive UI", async () => {
    const ui = context({ hasUI: false });

    await expect(collectWorkflowRequest(ui.ctx)).resolves.toBeUndefined();
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify).toHaveBeenCalledWith("The orchestrate command requires an interactive UI.", "error");
  });
});

describe("selectWorkflowRoute", () => {
  it("maps a selected choice label back to its route", async () => {
    const ui = context({ selections: [WORKFLOW_ROUTE_CHOICES[3].label] });

    await expect(selectWorkflowRoute(ui.ctx)).resolves.toBe(WORKFLOW_ROUTE_CHOICES[3].route);
    expect(ui.select).toHaveBeenCalledWith("Select a workflow route", WORKFLOW_ROUTE_CHOICES.map(item => item.label));
  });

  it("returns undefined when the selection is cancelled", async () => {
    const ui = context({ selections: [undefined] });

    await expect(selectWorkflowRoute(ui.ctx)).resolves.toBeUndefined();
  });

  it("returns undefined for an unrecognized choice", async () => {
    const ui = context({ selections: ["unknown"] });

    await expect(selectWorkflowRoute(ui.ctx)).resolves.toBeUndefined();
  });
});

describe("route selection metadata", () => {
  it("recognizes only supported routes", () => {
    for (const route of WORKFLOW_ROUTES) expect(isWorkflowRoute(route)).toBe(true);
    expect(isWorkflowRoute("unknown")).toBe(false);
  });

  it("gives every route a descriptive choice without changing its value", () => {
    expect(WORKFLOW_ROUTE_CHOICES.map(choice => choice.route)).toEqual([...WORKFLOW_ROUTES]);
    for (const choice of WORKFLOW_ROUTE_CHOICES) {
      expect(choice.label).toMatch(new RegExp(`^${choice.route} - .+`));
    }
  });

  it("documents the argument-free command", () => {
    expect(ORCHESTRATE_USAGE).toBe("/orchestrate");
  });
});
