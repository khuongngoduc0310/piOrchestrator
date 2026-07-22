import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  type AgentSession,
  type AgentSessionEvent,
  type ResolveCliModelResult
} from "@earendil-works/pi-coding-agent";
import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentConfig,
  AgentName,
  AgentResult,
  AgentUsage,
  OrchestratorConfig,
  ThinkingLevel
} from "./types.js";
import { intersectRoleTools, ROLE_MUTATION_KINDS } from "./role-capabilities.js";
import { normalizeRepositoryPath } from "./path-validation.js";

export interface AgentEventMetadata {
  type: string;
  toolName?: string;
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  text?: string;
  args?: string;
}

export interface AgentRunOptions {
  name: AgentName;
  task: string;
  cwd: string;
  extensionRoot: string;
  config: AgentConfig;
  timeoutMs: number;
  signal: AbortSignal;
  onEvent?: (event: AgentEventMetadata) => void;
  allowedWritePaths?: readonly string[];
  readRoots?: readonly string[];
}

export interface AgentExecutor {
  preflight(
    config: OrchestratorConfig,
    cwd: string,
    extensionRoot: string,
    signal?: AbortSignal,
    timeoutMs?: number
  ): Promise<void>;
  run(options: AgentRunOptions): Promise<AgentResult>;
}

export interface ResolvedAgent {
  model: ResolveCliModelResult["model"];
  thinkingLevel?: ThinkingLevel;
  promptPath: string;
}

type AgentSessionLike = Pick<AgentSession, "subscribe" | "prompt" | "abort" | "dispose" | "isStreaming">;

export interface PiSdkAgentExecutorDependencies {
  runtime?: () => Promise<ModelRuntime>;
  resolveModel?: (config: AgentConfig, runtime: ModelRuntime) => ResolveCliModelResult;
  createSession?: (options: {
    run: AgentRunOptions;
    rolePrompt: string;
    resolved: ResolvedAgent;
    runtime: ModelRuntime;
  }) => Promise<AgentSessionLike>;
}

export class AgentTimeoutError extends Error {
  constructor(agent: AgentName, timeoutMs: number) {
    super(`${agent} timed out after ${timeoutMs}ms`);
    this.name = "AgentTimeoutError";
  }
}

export class AgentCancelledError extends Error {
  constructor(agent: AgentName) {
    super(`${agent} cancelled`);
    this.name = "AgentCancelledError";
  }
}

export class PiSdkAgentExecutor implements AgentExecutor {
  private runtimePromise?: Promise<ModelRuntime>;
  private resolved = new Map<AgentName, ResolvedAgent>();
  private preflightGeneration = 0;
  private readonly runtimeFactory: () => Promise<ModelRuntime>;
  private readonly modelResolver: (config: AgentConfig, runtime: ModelRuntime) => ResolveCliModelResult;
  private readonly sessionFactory: NonNullable<PiSdkAgentExecutorDependencies["createSession"]>;

  constructor(dependencies: PiSdkAgentExecutorDependencies = {}) {
    this.runtimeFactory = dependencies.runtime ?? (() => ModelRuntime.create());
    this.modelResolver = dependencies.resolveModel ?? ((config, runtime) => resolveCliModel({
      cliModel: config.model,
      cliThinking: config.thinking,
      modelRuntime: runtime
    }));
    this.sessionFactory = dependencies.createSession ?? createSdkSession;
  }

  async preflight(
    config: OrchestratorConfig,
    _cwd: string,
    extensionRoot: string,
    signal: AbortSignal = new AbortController().signal,
    timeoutMs = config.limits.agentTimeoutMs
  ): Promise<void> {
    if (signal.aborted) throw new Error("Agent preflight cancelled");
    const generation = ++this.preflightGeneration;
    let timer: NodeJS.Timeout | undefined;
    let rejectStop!: (error: Error) => void;
    const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const onAbort = (): void => rejectStop(new Error("Agent preflight cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => rejectStop(new Error(`Agent preflight timed out after ${timeoutMs}ms`)), timeoutMs);
    const bounded = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stop]);
    try {
      const runtime = await bounded(this.runtime());
      const available = await bounded(runtime.getAvailable());
      const next = new Map<AgentName, ResolvedAgent>();
      for (const [name, agentConfig] of Object.entries(config.agents) as [AgentName, AgentConfig][]) {
        const resolved = this.modelResolver(agentConfig, runtime);
        if (!resolved.model || resolved.error) {
          throw new Error(`Invalid model for ${name}: ${resolved.error ?? agentConfig.model}`);
        }
        if (!available.some(model => model.provider === resolved.model?.provider && model.id === resolved.model.id)) {
          throw new Error(`Model for ${name} is not authenticated or available: ${resolved.model.provider}/${resolved.model.id}`);
        }
        next.set(name, {
          model: resolved.model,
          thinkingLevel: agentConfig.thinking ?? resolved.thinkingLevel,
          promptPath: await bounded(resolvePromptPath(extensionRoot, agentConfig.promptFile))
        });
      }
      if (generation !== this.preflightGeneration) throw new Error("Agent preflight was superseded by a newer request");
      this.resolved = next;
    } finally {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    }
  }

  async run(options: AgentRunOptions): Promise<AgentResult> {
    if (options.signal.aborted) throw new AgentCancelledError(options.name);
    let session: AgentSessionLike | undefined;
    let pendingSession: Promise<AgentSessionLike> | undefined;
    let unsubscribe = (): void => undefined;
    let timer: NodeJS.Timeout | undefined;
    let timedOut = false;
    let callerAborted = false;
    let stopped = false;
    let succeeded = false;
    let rejectStop!: (error: Error) => void;
    let abortPromise: Promise<void> | undefined;
    const stop = new Promise<never>((_resolve, reject) => { rejectStop = reject; });
    const requestAbort = (): void => {
      if (!session || abortPromise) return;
      abortPromise = Promise.resolve().then(() => session?.abort()).then(() => undefined).catch(() => undefined);
    };
    const onAbort = (): void => {
      if (callerAborted) return;
      callerAborted = true;
      stopped = true;
      requestAbort();
      rejectStop(new AgentCancelledError(options.name));
    };
    options.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => {
      timedOut = true;
      stopped = true;
      requestAbort();
      rejectStop(new AgentTimeoutError(options.name, options.timeoutMs));
    }, options.timeoutMs);
    const withinDeadline = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, stop]);

    let finalText = "";
    let finalStopReason: string | undefined;
    const usage: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

    try {
      const runtime = await withinDeadline(this.runtime());
      const resolved = this.resolved.get(options.name) ?? await withinDeadline(this.resolveOne(options, runtime));
      if (!resolved.model) throw new Error(`Model was not resolved for ${options.name}`);
      const rolePrompt = await withinDeadline(readFile(resolved.promptPath, "utf8"));
      const creation = this.sessionFactory({ run: options, rolePrompt, resolved, runtime });
      pendingSession = creation;
      void creation.then(lateSession => {
        if (!stopped || session === lateSession) return;
        void Promise.resolve().then(() => lateSession.abort()).catch(() => undefined);
        try { lateSession.dispose(); } catch { /* best-effort late cleanup */ }
      }).catch(() => undefined);
      session = await withinDeadline(creation);
      if (options.signal.aborted) throw new AgentCancelledError(options.name);
      unsubscribe = session.subscribe(event => {
        const metadata = sanitizeEvent(event);
        if (metadata) options.onEvent?.(metadata);
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        const text = event.message.content
          .filter(part => part.type === "text")
          .map(part => part.text)
          .join("\n")
          .trim();
        finalText = text;
        finalStopReason = event.message.stopReason;
        usage.input += event.message.usage.input;
        usage.output += event.message.usage.output;
        usage.cacheRead += event.message.usage.cacheRead;
        usage.cacheWrite += event.message.usage.cacheWrite;
        usage.cost += event.message.usage.cost.total;
      });
      if (options.signal.aborted) throw new AgentCancelledError(options.name);
      await withinDeadline(session.prompt(options.task, { expandPromptTemplates: false, source: "interactive" }));
      if (callerAborted || options.signal.aborted) throw new AgentCancelledError(options.name);
      if (timedOut) throw new AgentTimeoutError(options.name, options.timeoutMs);
      if (finalStopReason === "length") throw new Error(`${options.name} returned an incomplete response (output limit)`);
      if (finalStopReason === "error" || finalStopReason === "aborted") {
        throw new Error(`${options.name} returned an incomplete response (${finalStopReason})`);
      }
      if (!finalText.trim()) throw new Error(`${options.name} returned no final assistant text`);
      succeeded = true;
      return { text: finalText, usage };
    } catch (error) {
      if (callerAborted || options.signal.aborted) throw new AgentCancelledError(options.name);
      if (timedOut && !(error instanceof AgentTimeoutError)) throw new AgentTimeoutError(options.name, options.timeoutMs);
      throw error;
    } finally {
      stopped = true;
      if (timer) clearTimeout(timer);
      options.signal.removeEventListener("abort", onAbort);
      if (!session && pendingSession) {
        const late = await Promise.race([pendingSession, delay(250).then(() => undefined)]).catch(() => undefined);
        if (late) session = late;
      }
      if (session && (!succeeded || session.isStreaming)) requestAbort();
      if (abortPromise) await Promise.race([abortPromise, delay(1_000)]);
      try { unsubscribe(); } catch { /* cleanup must continue */ }
      try { session?.dispose(); } catch { /* cleanup must continue */ }
    }
  }

  private async runtime(): Promise<ModelRuntime> {
    this.runtimePromise ??= this.runtimeFactory();
    return this.runtimePromise;
  }

  private async resolveOne(options: AgentRunOptions, runtime: ModelRuntime): Promise<ResolvedAgent> {
    const resolved = this.modelResolver(options.config, runtime);
    if (!resolved.model || resolved.error) throw new Error(`Invalid model for ${options.name}: ${resolved.error ?? options.config.model}`);
    const result: ResolvedAgent = {
      model: resolved.model,
      thinkingLevel: options.config.thinking ?? resolved.thinkingLevel,
      promptPath: await resolvePromptPath(options.extensionRoot, options.config.promptFile)
    };
    this.resolved.set(options.name, result);
    return result;
  }
}

async function createSdkSession(options: {
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

function sanitizeEvent(event: AgentSessionEvent): AgentEventMetadata | undefined {
  switch (event.type) {
    case "agent_start":
    case "agent_settled":
    case "turn_start":
      return { type: event.type };
    case "tool_execution_start":
      return {
        type: event.type,
        toolName: event.toolName,
        args: truncate(JSON.stringify(event.args), 200)
      };
    case "tool_execution_end":
      return { type: event.type, toolName: event.toolName, isError: event.isError };
    case "auto_retry_start":
      return {
        type: event.type,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        errorMessage: truncate(event.errorMessage, 500)
      };
    case "auto_retry_end":
      return { type: event.type, attempt: event.attempt, errorMessage: truncate(event.finalError, 500) };
    case "message_update":
      return {
        type: event.type,
        text: extractLatestText(event)
      };
    default:
      return undefined;
  }
}

/** Extract the latest text delta from a message_update event. */
function extractLatestText(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_update") return undefined;
  const assistantEvent = (event as any).assistantMessageEvent;
  if (!assistantEvent?.delta?.text) return undefined;
  return String(assistantEvent.delta.text).slice(0, 200);
}

async function resolvePromptPath(extensionRoot: string, promptFile: string): Promise<string> {
  const promptRoot = await realpath(path.join(extensionRoot, "prompts"));
  const candidate = await realpath(path.resolve(promptRoot, promptFile));
  const relative = path.relative(promptRoot, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Prompt file must remain under ${promptRoot}: ${promptFile}`);
  }
  return candidate;
}

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
