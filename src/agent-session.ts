import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
  type ExtensionFactory,
  type ModelRuntime,
  type ToolCallEvent
} from "@earendil-works/pi-coding-agent";
import type { AgentRunOptions, AgentSessionLike, ResolvedAgent } from "./agent-runner-contracts.js";
import { normalizeRepositoryPath } from "./path-validation.js";
import { intersectRoleTools, ROLE_MUTATION_KINDS } from "./role-capabilities.js";
import type { AgentName } from "./types.js";

export async function createSdkSession(options: {
  run: AgentRunOptions;
  rolePrompt: string;
  resolved: ResolvedAgent;
  runtime: ModelRuntime;
}): Promise<AgentSessionLike> {
  if (!options.resolved.model) throw new Error(`Model was not resolved for ${options.run.name}`);
  const tools = intersectRoleTools(options.run.name, options.run.config.tools);
  if (tools.length === 0) throw new Error(`${options.run.name} has no tools permitted by its role policy`);
  const policyPrompt = rolePolicyPrompt(options.run.name, options.run.allowedWritePaths ?? []);
  const loader = new DefaultResourceLoader({
    cwd: options.run.cwd,
    agentDir: getAgentDir(),
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    appendSystemPromptOverride: () => [options.rolePrompt, policyPrompt],
    extensionFactories: [createCapabilityGuard(options.run, tools)]
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: options.run.cwd,
    model: options.resolved.model,
    thinkingLevel: options.resolved.thinkingLevel,
    tools,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(options.run.cwd),
    modelRuntime: options.runtime
  });
  return session;
}

function rolePolicyPrompt(name: AgentName, allowedWritePaths: readonly string[]): string {
  const mutation = ROLE_MUTATION_KINDS[name];
  const scope = mutation === "none"
    ? "You are read-only. Any repository mutation is a policy violation."
    : `You may write only these exact repository-relative paths: ${allowedWritePaths.length ? allowedWritePaths.join(", ") : "(none)"}.`;
  return `Runtime capability policy (authoritative): shell execution is disabled. ${scope}`;
}

function createCapabilityGuard(run: AgentRunOptions, tools: readonly string[]): ExtensionFactory {
  const allowedTools = new Set(tools);
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
