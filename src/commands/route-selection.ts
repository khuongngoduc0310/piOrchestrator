import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_ROUTES, type WorkflowRequest, type WorkflowRoute } from "../agent-task-types.js";

export const ORCHESTRATE_USAGE = "/orchestrate";

export const WORKFLOW_ROUTE_CHOICES: ReadonlyArray<{ route: WorkflowRoute; label: string }> = [
  { route: "implementation", label: "implementation - Full test-first implementation and review" },
  { route: "review_only", label: "review_only - Read-only repository review" },
  { route: "documentation_only", label: "documentation_only - Documentation changes only" },
  { route: "tests_only", label: "tests_only - Test and test-support changes only" },
  { route: "investigation_only", label: "investigation_only - Read-only diagnosis and evidence" },
  { route: "bug_fix", label: "bug_fix - Diagnose and fix a confirmed bug" },
  { route: "quick_implementation", label: "quick_implementation - Implementation without test-first generation" },
  { route: "planning_only", label: "planning_only - Read-only exploration and planning" }
];

export function isWorkflowRoute(value: unknown): value is WorkflowRoute {
  return typeof value === "string" && (WORKFLOW_ROUTES as readonly string[]).includes(value);
}

export async function collectWorkflowRequest(ctx: ExtensionCommandContext): Promise<WorkflowRequest | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The orchestrate command requires an interactive UI.", "error");
    return undefined;
  }

  const selectedLabel = await ctx.ui.select("Select a workflow route", WORKFLOW_ROUTE_CHOICES.map(choice => choice.label));
  const selectedRoute = WORKFLOW_ROUTE_CHOICES.find(choice => choice.label === selectedLabel)?.route;
  if (!selectedRoute) return undefined;

  while (true) {
    const request = await ctx.ui.input(`Describe the request for ${selectedRoute}`);
    if (request === undefined) return undefined;
    if (request.trim()) return { route: selectedRoute, request: request.trim() };
    ctx.ui.notify("Enter a request to start the workflow.", "warning");
  }
}
