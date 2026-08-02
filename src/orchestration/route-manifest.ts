import type { AgentName, WorkflowRoute } from "../types.js";

export type RouteKind = "mutation" | "read_only" | "planning_only";

export const ROUTE_KINDS: Readonly<Record<WorkflowRoute, RouteKind>> = {
  implementation: "mutation",
  bug_fix: "mutation",
  quick_implementation: "mutation",
  documentation_only: "mutation",
  tests_only: "mutation",
  review_only: "read_only",
  investigation_only: "read_only",
  planning_only: "planning_only"
};

export const ROUTE_DESCRIPTIONS: Readonly<Record<WorkflowRoute, string>> = {
  implementation: "Full test-first implementation and review",
  review_only: "Read-only repository review",
  documentation_only: "Documentation changes only",
  tests_only: "Test and test-support changes only",
  investigation_only: "Read-only diagnosis and evidence",
  bug_fix: "Diagnose and fix a confirmed bug",
  quick_implementation: "Implementation without test-first generation",
  planning_only: "Read-only exploration and planning"
};

export const ROUTE_ADDITIONAL_AGENTS: Readonly<Record<WorkflowRoute, readonly AgentName[]>> = {
  implementation: ["tester", "builder", "debugger", "reviewer", "documenter"],
  bug_fix: ["tester", "builder", "debugger", "reviewer", "documenter"],
  quick_implementation: ["builder", "debugger", "reviewer", "documenter"],
  documentation_only: ["debugger", "documenter"],
  tests_only: ["tester", "debugger"],
  review_only: ["reviewer"],
  investigation_only: ["debugger"],
  planning_only: []
};

export function routeLabel(route: WorkflowRoute): string {
  return `${route} - ${ROUTE_DESCRIPTIONS[route]}`;
}

export function isReadOnlyRoute(route: WorkflowRoute): boolean {
  return ROUTE_KINDS[route] !== "mutation";
}
