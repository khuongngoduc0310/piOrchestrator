import { AGENT_NAMES, type AgentName } from "../agent-types.js";
import { type OrchestratorConfig } from "../config-types.js";
import { type WorkflowRoute } from "../workflow-shared.js";
import type { CheckpointCursorKind } from "../persistence/checkpoint-types.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";
import { ROUTE_ADDITIONAL_AGENTS } from "./route-manifest.js";

export function requiredAgentsForRoute(route: WorkflowRoute, config: OrchestratorConfig): AgentName[] {
  const required = new Set<AgentName>(["explorer", "planner"]);
  const policy = resolveParticipationPolicy(config);
  if (!requiresHumanDecision(policy, "initial_plan")
    || (config.limits.planRevisions > 0 && !requiresHumanDecision(policy, "plan_revision"))) {
    required.add("reviewer");
  }

  for (const agent of ROUTE_ADDITIONAL_AGENTS[route]) {
    required.add(agent);
  }

  return AGENT_NAMES.filter(agent => required.has(agent));
}

export function requiredAgentsForResume(
  route: WorkflowRoute,
  config: OrchestratorConfig,
  cursor: CheckpointCursorKind
): AgentName[] {
  if (cursor === "repository_reviewed" || cursor === "investigation_completed") return [];
  if (route === "planning_only" && cursor === "plan_approved") return [];
  if (cursor === "documenter_completed" || cursor === "lessons_screened" || cursor === "final_checks_passed") return [];
  return requiredAgentsForRoute(route, config);
}
