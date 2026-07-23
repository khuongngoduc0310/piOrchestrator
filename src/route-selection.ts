import { WORKFLOW_ROUTES, type WorkflowRequest, type WorkflowRoute } from "./agent-task-types.js";

export const ORCHESTRATE_USAGE = `/orchestrate --route <${WORKFLOW_ROUTES.join("|")}> <request>`;

export function isWorkflowRoute(value: unknown): value is WorkflowRoute {
  return typeof value === "string" && (WORKFLOW_ROUTES as readonly string[]).includes(value);
}

export function parseWorkflowRequest(args: string): WorkflowRequest {
  const match = args.trim().match(/^--route\s+(\S+)\s+([\s\S]+)$/);
  if (!match || !isWorkflowRoute(match[1]) || !match[2].trim()) {
    throw new Error(`Usage: ${ORCHESTRATE_USAGE}`);
  }
  return { route: match[1], request: match[2].trim() };
}
