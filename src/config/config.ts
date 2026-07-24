import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import {
  AGENT_NAMES,
  BUILT_IN_TOOLS,
  SCHEMA_VERSION,
  THINKING_LEVELS,
  type AgentModelUpdates,
  type AgentName,
  type ConfigSummary,
  type OrchestratorConfig,
  type ThinkingLevel
} from "../types.js";
import { ValidationError, isRecord, validateOrchestratorConfig } from "../validation.js";
import { intersectRoleTools } from "../agents/role-capabilities.js";

export const DEFAULT_CONFIG: OrchestratorConfig = {
  schemaVersion: SCHEMA_VERSION,
  checks: [],
  dashboard: { enabled: true, port: 0 },
  limits: {
    planRevisions: 2,
    implementationRetries: 3,
    reviewRevisions: 2,
    agentTimeoutMs: 20 * 60 * 1000,
    checkTimeoutMs: 10 * 60 * 1000,
    maxOutputBytes: 256 * 1024,
    worktreeIsolation: true
  },
  agents: {
    explorer: { model: "anthropic/claude-sonnet-4-5", thinking: "low", tools: ["read", "grep", "find", "ls"], promptFile: "explorer.md" },
    planner: { model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: ["read", "grep", "find", "ls"], promptFile: "planner.md" },
    reviewer: { model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: ["read", "grep", "find", "ls"], promptFile: "reviewer.md" },
    tester: { model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: ["read", "write", "edit", "grep", "find", "ls"], promptFile: "tester.md" },
    builder: { model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: ["read", "write", "edit", "grep", "find", "ls"], promptFile: "builder.md" },
    debugger: { model: "anthropic/claude-sonnet-4-5", thinking: "high", tools: ["read", "grep", "find", "ls"], promptFile: "debugger.md" },
    documenter: { model: "anthropic/claude-sonnet-4-5", thinking: "medium", tools: ["read", "write", "edit", "grep", "find", "ls"], promptFile: "documenter.md" }
  },
  humanInTheLoop: {
    planApproval: false,
    planRevisionApproval: false,
    confirmBeforeMutation: false,
    importantDecisions: true
  }
};

export class ConfigError extends Error {
  constructor(public readonly file: string, message: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options);
    this.name = "ConfigError";
  }
}

export function configPath(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "config.json");
}

function mergeDefaults(defaultValue: unknown, configuredValue: unknown): unknown {
  if (configuredValue === undefined) return structuredClone(defaultValue);
  if (isRecord(defaultValue) && isRecord(configuredValue)) {
    const result: Record<string, unknown> = { ...configuredValue };
    for (const [key, value] of Object.entries(defaultValue)) {
      result[key] = mergeDefaults(value, configuredValue[key]);
    }
    return result;
  }
  return configuredValue;
}

function parseConfigText(text: string, file: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(file, `invalid JSON (${detail}); the file was not changed`, { cause: error });
  }
}

function validateConfig(value: unknown, file: string): OrchestratorConfig {
  try {
    return validateOrchestratorConfig(value);
  } catch (error) {
    if (error instanceof ValidationError) {
      throw new ConfigError(file, `${error.message}; the file was not changed`, { cause: error });
    }
    throw error;
  }
}

export async function loadConfig(cwd: string): Promise<OrchestratorConfig> {
  const file = configPath(cwd);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      const fresh = structuredClone(DEFAULT_CONFIG);
      await saveConfig(cwd, fresh);
      return fresh;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ConfigError(file, `could not read config (${detail}); the file was not changed`, { cause: error });
  }
  const parsed = parseConfigText(text, file);
  const merged = mergeDefaults(DEFAULT_CONFIG, parsed);
  preserveOptionalThinking(parsed, merged);
  migrateRoleTools(merged);
  return validateConfig(merged, file);
}

export async function saveConfig(cwd: string, config: OrchestratorConfig): Promise<void> {
  const file = configPath(cwd);
  const validated = validateConfig(config, file);
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(validated, null, 2) + "\n", "utf8");
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function applyAgentModelUpdates(config: OrchestratorConfig, updates: AgentModelUpdates): OrchestratorConfig {
  const updated = structuredClone(config);
  for (const [agent, selection] of Object.entries(updates) as [AgentName, NonNullable<AgentModelUpdates[AgentName]>][]) {
    const model = selection.model.trim();
    if (!model) throw new ConfigError("config.agents", `${agent} model must not be empty`);
    if (selection.thinking !== undefined && !THINKING_LEVELS.includes(selection.thinking)) {
      throw new ConfigError("config.agents", `${agent} thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
    }
    updated.agents[agent].model = model;
    if (selection.thinking === undefined) delete updated.agents[agent].thinking;
    else updated.agents[agent].thinking = selection.thinking;
  }
  return updated;
}

export async function updateAgentModel(
  cwd: string,
  agent: AgentName,
  model: string,
  thinking?: ThinkingLevel | null
): Promise<void> {
  if (!model.trim()) throw new ConfigError(configPath(cwd), "model must not be empty");
  if (thinking !== undefined && thinking !== null && !THINKING_LEVELS.includes(thinking)) {
    throw new ConfigError(configPath(cwd), `thinking must be one of: ${THINKING_LEVELS.join(", ")}`);
  }
  const config = await loadConfig(cwd);
  const updated = structuredClone(config);
  updated.agents[agent].model = model.trim();
  if (thinking === null) delete updated.agents[agent].thinking;
  else if (thinking !== undefined) updated.agents[agent].thinking = thinking;
  await saveConfig(cwd, updated);
}

export async function inspectConfig(cwd: string): Promise<ConfigSummary> {
  const file = configPath(cwd);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") {
      return { status: "missing", agentCount: AGENT_NAMES.length, checkCount: 0 };
    }
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "invalid", agentCount: AGENT_NAMES.length, checkCount: 0, message: `Cannot read config: ${detail}` };
  }
  try {
    const parsed = JSON.parse(text);
    const merged = mergeDefaults(DEFAULT_CONFIG, parsed);
    preserveOptionalThinking(parsed, merged);
    migrateRoleTools(merged);
    const validated = validateOrchestratorConfig(merged);
    return {
      status: "valid",
      agentCount: AGENT_NAMES.length,
      checkCount: validated.checks.length,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { status: "invalid", agentCount: AGENT_NAMES.length, checkCount: 0, message: detail };
  }
}

function preserveOptionalThinking(configured: unknown, merged: unknown): void {
  if (!isRecord(configured) || !isRecord(configured.agents) || !isRecord(merged) || !isRecord(merged.agents)) return;
  for (const agent of AGENT_NAMES) {
    const configuredAgent = configured.agents[agent];
    const mergedAgent = merged.agents[agent];
    if (isRecord(configuredAgent) && isRecord(mergedAgent) && !Object.hasOwn(configuredAgent, "thinking")) {
      delete mergedAgent.thinking;
    }
  }
}

function migrateRoleTools(config: unknown): void {
  if (!isRecord(config) || !isRecord(config.agents)) return;
  for (const agent of AGENT_NAMES) {
    const entry = config.agents[agent];
    if (!isRecord(entry) || !Array.isArray(entry.tools)) continue;
    entry.tools = entry.tools.filter(tool => {
      if (typeof tool !== "string") return true;
      if (!BUILT_IN_TOOLS.includes(tool as (typeof BUILT_IN_TOOLS)[number])) return true;
      return intersectRoleTools(agent, [tool as (typeof BUILT_IN_TOOLS)[number]]).length > 0;
    });
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
