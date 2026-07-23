import {
  AGENT_NAMES,
  BUILT_IN_TOOLS,
  SCHEMA_VERSION,
  THINKING_LEVELS,
  type AgentConfig,
  type AgentName,
  type OrchestratorConfig
} from "../types.js";
import { RoleCapabilityError, validateRoleTools } from "../agents/role-capabilities.js";
import {
  ValidationError,
  array,
  boolean,
  boundedInteger,
  enumValue,
  integer,
  record,
  string,
  strings
} from "../validation-core.js";

function agentConfig(name: AgentName, value: unknown, path: string): AgentConfig {
  const item = record(value, path);
  const tools = array(item.tools, `${path}.tools`, (tool, toolPath) => {
    if (typeof tool === "string" && !BUILT_IN_TOOLS.includes(tool as (typeof BUILT_IN_TOOLS)[number])) {
      throw new ValidationError(toolPath, `custom extension tool ${JSON.stringify(tool)} is unsupported; migrate to a built-in-only SDK role session`);
    }
    return enumValue(tool, toolPath, BUILT_IN_TOOLS);
  });
  if (tools.length === 0) throw new ValidationError(`${path}.tools`, "must contain at least one built-in tool");
  try {
    validateRoleTools(name, tools);
  } catch (error) {
    if (error instanceof RoleCapabilityError) throw new ValidationError(`${path}.tools`, error.message);
    throw error;
  }
  const result: AgentConfig = {
    model: string(item.model, `${path}.model`),
    tools,
    promptFile: string(item.promptFile, `${path}.promptFile`)
  };
  if (item.thinking !== undefined) result.thinking = enumValue(item.thinking, `${path}.thinking`, THINKING_LEVELS);
  return result;
}

export function validateOrchestratorConfig(value: unknown, path = "config"): OrchestratorConfig {
  const item = record(value, path);
  const dashboard = record(item.dashboard, `${path}.dashboard`);
  const limits = record(item.limits, `${path}.limits`);
  const agentsValue = record(item.agents, `${path}.agents`);
  const agents = {} as Record<AgentName, AgentConfig>;
  for (const name of AGENT_NAMES) agents[name] = agentConfig(name, agentsValue[name], `${path}.agents.${name}`);
  const checks = strings(item.checks, `${path}.checks`);
  const schemaVersion = integer(item.schemaVersion, `${path}.schemaVersion`, 1);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ValidationError(`${path}.schemaVersion`, `unsupported future version ${schemaVersion}`);
  }
  const port = integer(dashboard.port, `${path}.dashboard.port`, 0);
  if (port > 65_535) throw new ValidationError(`${path}.dashboard.port`, "must be <= 65535");
  const humanInTheLoopValue = item.humanInTheLoop !== undefined ? record(item.humanInTheLoop, `${path}.humanInTheLoop`) : {};
  return {
    schemaVersion,
    checks,
    dashboard: {
      enabled: boolean(dashboard.enabled, `${path}.dashboard.enabled`),
      port
    },
    limits: {
      planRevisions: boundedInteger(limits.planRevisions, `${path}.limits.planRevisions`, 0, 1_000),
      implementationRetries: boundedInteger(limits.implementationRetries, `${path}.limits.implementationRetries`, 0, 1_000),
      reviewRevisions: boundedInteger(limits.reviewRevisions, `${path}.limits.reviewRevisions`, 0, 1_000),
      agentTimeoutMs: boundedInteger(limits.agentTimeoutMs, `${path}.limits.agentTimeoutMs`, 1, 2_147_483_647),
      checkTimeoutMs: boundedInteger(limits.checkTimeoutMs, `${path}.limits.checkTimeoutMs`, 1, 2_147_483_647),
      maxOutputBytes: boundedInteger(limits.maxOutputBytes, `${path}.limits.maxOutputBytes`, 1, 100_000_000),
      worktreeIsolation: boolean(limits.worktreeIsolation ?? false, `${path}.limits.worktreeIsolation`)
    },
    agents,
    humanInTheLoop: {
      planApproval: boolean(humanInTheLoopValue.planApproval ?? false, `${path}.humanInTheLoop.planApproval`),
      planRevisionApproval: boolean(humanInTheLoopValue.planRevisionApproval ?? false, `${path}.humanInTheLoop.planRevisionApproval`),
      confirmBeforeMutation: boolean(humanInTheLoopValue.confirmBeforeMutation ?? false, `${path}.humanInTheLoop.confirmBeforeMutation`),
      importantDecisions: boolean(humanInTheLoopValue.importantDecisions ?? true, `${path}.humanInTheLoop.importantDecisions`)
    }
  };
}
