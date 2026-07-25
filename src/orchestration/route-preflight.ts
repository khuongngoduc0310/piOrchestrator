import { AGENT_NAMES, type AgentName, type OrchestratorConfig, type WorkflowRoute } from "../types.js";
import type { CheckpointCursorKind } from "../persistence/checkpoint-types.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";

export function requiredAgentsForRoute(route: WorkflowRoute, config: OrchestratorConfig): AgentName[] {
  const required = new Set<AgentName>(["explorer", "planner"]);
  const policy = resolveParticipationPolicy(config);
  if (!requiresHumanDecision(policy, "initial_plan")
    || (config.limits.planRevisions > 0 && !requiresHumanDecision(policy, "plan_revision"))) {
    required.add("reviewer");
  }

  switch (route) {
    case "implementation":
    case "bug_fix":
      required.add("tester");
      required.add("builder");
      required.add("debugger");
      required.add("reviewer");
      required.add("documenter");
      break;
    case "quick_implementation":
      required.add("builder");
      required.add("debugger");
      required.add("reviewer");
      required.add("documenter");
      break;
    case "tests_only":
      required.add("tester");
      required.add("debugger");
      break;
    case "documentation_only":
      required.add("debugger");
      required.add("documenter");
      break;
    case "review_only":
      required.add("reviewer");
      break;
    case "investigation_only":
      required.add("debugger");
      break;
    case "planning_only":
      break;
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
