import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolCallEvent,
  type ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type {
  AgentRunOptions,
  AgentSessionLike,
  ResolvedAgent,
  SpawnExplorerResult
} from "./agent-runner-contracts.js";
import { SPAWN_EXPLORER_TOOL, isSpawningRole } from "./agent-runner-contracts.js";
import { normalizeRepositoryPath } from "../workspace/path-validation.js";
import { intersectRoleTools, ROLE_MUTATION_KINDS } from "./role-capabilities.js";
import type { AgentName } from "../types.js";

export async function createSdkSession(options: {
  run: AgentRunOptions;
  rolePrompt: string;
  resolved: ResolvedAgent;
  runtime: ModelRuntime;
}): Promise<AgentSessionLike> {
  if (!options.resolved.model) throw new Error(`Model was not resolved for ${options.run.name}`);
  const tools = resolveSessionToolAllowlist(options.run);
  if (tools.length === 0) throw new Error(`${options.run.name} has no tools permitted by its role policy`);
  const canSpawn = shouldEnableSpawnTool(options.run);
  const customTools = canSpawn ? [spawnExplorerTool(options.run)] : undefined;
  assertCustomToolsAdmitted(tools, customTools);
  const policyPrompt = rolePolicyPrompt(options.run.name, options.run.allowedWritePaths ?? []);
  const loader = new DefaultResourceLoader({
    cwd: options.run.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPromptOverride: () => [options.rolePrompt, policyPrompt],
    extensionFactories: [createCapabilityGuard(options.run)]
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: options.run.cwd,
    model: options.resolved.model,
    thinkingLevel: options.resolved.thinkingLevel,
    tools,
    customTools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.run.cwd),
    modelRuntime: options.runtime
  });
  return session;
}

/** A role may spawn explorers only when the orchestrator supplied the callback for this run. */
export function shouldEnableSpawnTool(run: AgentRunOptions): boolean {
  return run.spawnExplorer !== undefined && isSpawningRole(run.name);
}

/**
 * Single definition of the tool allowlist for a run's session. Both the session
 * and the capability guard derive their lists from here, so a tool can never be
 * registered without being admitted. Add any new custom tool to this function.
 */
export function resolveSessionToolAllowlist(run: AgentRunOptions): string[] {
  const roleTools = intersectRoleTools(run.name, run.config.tools);
  return shouldEnableSpawnTool(run) ? [...roleTools, SPAWN_EXPLORER_TOOL] : roleTools;
}

/** Fail fast: every registered custom tool must be admitted by the allowlist. */
export function assertCustomToolsAdmitted(tools: readonly string[], customTools?: readonly ToolDefinition[]): void {
  const allowlist = new Set(tools);
  for (const tool of customTools ?? []) {
    if (!allowlist.has(tool.name)) {
      throw new Error(`Custom tool ${tool.name} is not in the session allowlist; add it to resolveSessionToolAllowlist`);
    }
  }
}

function spawnExplorerTool(run: AgentRunOptions): ToolDefinition {
  return defineTool({
    name: SPAWN_EXPLORER_TOOL,
    label: "Spawn explorer",
    description:
      "Spawn a read-only explorer sub-agent to investigate one focused question in the repository and report findings as plain text. Use sparingly and only when your own read tools cannot determine the answer; the reply is advisory context, not evidence you observed.",
    promptSnippet: "spawn_explorer({ question }) — investigate a focused question via a read-only sub-agent",
    parameters: Type.Object({
      question: Type.String({ minLength: 1 })
    }),
    execute: async (_toolCallId, params): Promise<{ content: { type: "text"; text: string }[]; details: { question: string } }> => {
      const spawn = run.spawnExplorer;
      if (!spawn) throw new Error("Explorer spawning is not available in this run");
      const result: SpawnExplorerResult = await spawn(params.question);
      return {
        content: [{ type: "text", text: result.text }],
        details: { question: params.question }
      };
    }
  });
}

function rolePolicyPrompt(name: AgentName, allowedWritePaths: readonly string[]): string {
  const mutation = ROLE_MUTATION_KINDS[name];
  const scope = mutation === "none"
    ? "You are read-only. Any repository mutation is a policy violation."
    : `You may write only these exact repository-relative paths: ${allowedWritePaths.length ? allowedWritePaths.join(", ") : "(none)"}.`;
  return `Runtime capability policy (authoritative): shell execution is disabled. ${scope}`;
}

export function createCapabilityGuard(run: AgentRunOptions): ExtensionFactory {
  const allowedTools = new Set(resolveSessionToolAllowlist(run));
  const writePaths = new Set((run.allowedWritePaths ?? []).map(file => normalizeRepositoryPath(file)));
  const readRoots = [run.cwd, ...(run.readRoots ?? [])].map(root => path.resolve(root));
  return pi => {
    pi.on("tool_call", async event => {
      if (!allowedTools.has(event.toolName) || event.toolName === "bash") {
        return { block: true, reason: `${run.name} is not permitted to use ${event.toolName}` };
      }
      const inputPath = toolPath(event);
      if (!inputPath) return;
      if (event.toolName === "write" || event.toolName === "edit") {
        if (path.isAbsolute(inputPath)) return { block: true, reason: "Mutation paths must be repository-relative" };
        let normalized: string;
        try { normalized = normalizeRepositoryPath(inputPath); }
        catch (error) { return { block: true, reason: messageOf(error) }; }
        if (!writePaths.has(normalized)) return { block: true, reason: `${run.name} may not modify ${normalized}` };
        const safe = await resolvesWithin(path.resolve(run.cwd), inputPath, [path.resolve(run.cwd)]);
        if (!safe) return { block: true, reason: `Mutation path escapes the workspace: ${inputPath}` };
        return;
      }
      const candidate = path.isAbsolute(inputPath) ? inputPath : path.resolve(run.cwd, inputPath);
      if (!await resolvesWithin(path.dirname(candidate), path.basename(candidate), readRoots)) {
        return { block: true, reason: `Read path escapes permitted roots: ${inputPath}` };
      }
    });
  };
}

// Tools whose input.path must be path-checked. Any future tool with a path
// argument must be added here or its paths silently skip validation.
function toolPath(event: ToolCallEvent): string | undefined {
  if (!["read", "write", "edit", "grep", "find", "ls"].includes(event.toolName)) return undefined;
  const value = (event.input as { path?: unknown }).path;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function resolvesWithin(base: string, inputPath: string, roots: readonly string[]): Promise<boolean> {
  const candidate = path.resolve(base, inputPath);
  if (!roots.some(root => isWithin(root, candidate))) return false;
  let existing = candidate;
  while (true) {
    try {
      await lstat(existing);
      const resolved = await realpath(existing);
      return roots.some(root => isWithin(root, resolved));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) return false;
      const parent = path.dirname(existing);
      if (parent === existing) return false;
      existing = parent;
    }
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function resolvePromptPath(extensionRoot: string, promptFile: string): Promise<string> {
  const promptRoot = await realpath(path.join(extensionRoot, "prompts"));
  const candidate = await realpath(path.resolve(promptRoot, promptFile));
  const relative = path.relative(promptRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Prompt file must remain under ${promptRoot}: ${promptFile}`);
  }
  return candidate;
}
