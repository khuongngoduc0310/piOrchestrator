import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_ROUTES, type WorkflowRequest, type WorkflowRoute } from "../agent-task-types.js";
import { routeLabel } from "../orchestration/route-manifest.js";

export const ORCHESTRATE_USAGE = "/orchestrate";

export const WORKFLOW_ROUTE_CHOICES: ReadonlyArray<{ route: WorkflowRoute; label: string }> =
  WORKFLOW_ROUTES.map(route => ({ route, label: routeLabel(route) }));

export function isWorkflowRoute(value: unknown): value is WorkflowRoute {
  return typeof value === "string" && (WORKFLOW_ROUTES as readonly string[]).includes(value);
}

export async function selectWorkflowRoute(ctx: ExtensionCommandContext): Promise<WorkflowRoute | undefined> {
  const selectedLabel = await ctx.ui.select("Select a workflow route", WORKFLOW_ROUTE_CHOICES.map(choice => choice.label));
  return WORKFLOW_ROUTE_CHOICES.find(choice => choice.label === selectedLabel)?.route;
}

export async function collectWorkflowRequest(ctx: ExtensionCommandContext): Promise<WorkflowRequest | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The orchestrate command requires an interactive UI.", "error");
    return undefined;
  }

  const selectedRoute = await selectWorkflowRoute(ctx);
  if (!selectedRoute) return undefined;

  while (true) {
    const request = await ctx.ui.input(`Describe the request for ${selectedRoute}`);
    if (request === undefined) return undefined;
    if (request.trim()) return { route: selectedRoute, request: request.trim() };
    ctx.ui.notify("Enter a request to start the workflow.", "warning");
  }
}
