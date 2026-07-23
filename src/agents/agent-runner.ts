import { readFile } from "node:fs/promises";
import {
  ModelRuntime,
  resolveCliModel,
  type AgentSessionEvent,
  type ResolveCliModelResult
} from "@earendil-works/pi-coding-agent";
import {
  AgentCancelledError,
  AgentIncompleteResponseError,
  AgentTimeoutError,
  type AgentExecutor,
  type AgentRunOptions,
  type AgentSessionLike,
  type PiSdkAgentExecutorDependencies,
  type ResolvedAgent
} from "./agent-runner-contracts.js";
import { createSdkSession, resolvePromptPath } from "./agent-session.js";
import { normalizeAgentTranscript, updateTranscriptMessages } from "./agent-transcript.js";
import type {
  AgentConfig,
  AgentName,
  AgentResult,
  AgentTranscript,
  AgentUsage,
  OrchestratorConfig
} from "../types.js";

export {
  AgentCancelledError,
  AgentIncompleteResponseError,
  AgentTimeoutError
} from "./agent-runner-contracts.js";
export type {
  AgentEventMetadata,
  AgentExecutor,
  AgentIncompleteStopReason,
  AgentRunOptions,
  PiSdkAgentExecutorDependencies,
  ResolvedAgent
} from "./agent-runner-contracts.js";
export { normalizeAgentTranscript } from "./agent-transcript.js";

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
    timeoutMs = config.limits.agentTimeoutMs,
    agents?: readonly AgentName[]
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
      const selected = agents ?? (Object.keys(config.agents) as AgentName[]);
      for (const name of selected) {
        const agentConfig = config.agents[name];
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
    let finalErrorMessage: string | undefined;
    let finalProvider: string | undefined;
    let finalModel: string | undefined;
    let finalApi: string | undefined;
    let transcript: AgentTranscript | undefined;
    let transcriptMessages: unknown[] = [];
    let lastTranscriptEmitAt = 0;
    const usage: AgentUsage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      totalTokens: 0,
      costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
    };
    let hasReasoning = false;
    let hasCacheWrite1h = false;

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
        const nextTranscriptMessages = updateTranscriptMessages(transcriptMessages, event);
        const transcriptChanged = nextTranscriptMessages !== transcriptMessages;
        transcriptMessages = nextTranscriptMessages;
        const now = Date.now();
        const shouldEmitTranscript = transcriptChanged
          && (event.type !== "message_update" || now - lastTranscriptEmitAt >= 100);
        if (shouldEmitTranscript && transcriptMessages.length > 0) {
          transcript = normalizeAgentTranscript(transcriptMessages);
          lastTranscriptEmitAt = now;
          try { options.onTranscript?.(transcript); } catch { /* observers must not interrupt execution */ }
        }
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
        finalErrorMessage = sanitizeDiagnostic(event.message.errorMessage, 1_000);
        finalProvider = event.message.provider;
        finalModel = event.message.responseModel ?? event.message.model;
        finalApi = event.message.api;
        usage.input += event.message.usage.input;
        usage.output += event.message.usage.output;
        usage.cacheRead += event.message.usage.cacheRead;
        usage.cacheWrite += event.message.usage.cacheWrite;
        usage.totalTokens = (usage.totalTokens ?? 0) + event.message.usage.totalTokens;
        if (event.message.usage.reasoning !== undefined) {
          usage.reasoning = (usage.reasoning ?? 0) + event.message.usage.reasoning;
          hasReasoning = true;
        }
        if (event.message.usage.cacheWrite1h !== undefined) {
          usage.cacheWrite1h = (usage.cacheWrite1h ?? 0) + event.message.usage.cacheWrite1h;
          hasCacheWrite1h = true;
        }
        usage.costBreakdown!.input += event.message.usage.cost.input;
        usage.costBreakdown!.output += event.message.usage.cost.output;
        usage.costBreakdown!.cacheRead += event.message.usage.cost.cacheRead;
        usage.costBreakdown!.cacheWrite += event.message.usage.cost.cacheWrite;
        usage.cost += event.message.usage.cost.total;
        if (!hasReasoning) delete usage.reasoning;
        if (!hasCacheWrite1h) delete usage.cacheWrite1h;
        try {
          options.onUsage?.({
            usage: cloneUsage(usage),
            provider: finalProvider,
            model: finalModel,
            api: finalApi,
            stopReason: finalStopReason
          });
        } catch { /* observers must not interrupt execution */ }
      });
      if (options.signal.aborted) throw new AgentCancelledError(options.name);
      await withinDeadline(session.prompt(options.task, { expandPromptTemplates: false, source: "interactive" }));
      if (callerAborted || options.signal.aborted) throw new AgentCancelledError(options.name);
      if (timedOut) throw new AgentTimeoutError(options.name, options.timeoutMs);
      if (finalStopReason === "length" || finalStopReason === "error" || finalStopReason === "aborted") {
        throw new AgentIncompleteResponseError({
          agent: options.name,
          stopReason: finalStopReason,
          provider: finalProvider,
          model: finalModel,
          providerError: finalErrorMessage,
          partialText: truncate(finalText, 2_000),
          usage,
          transcript
        });
      }
      if (!finalText.trim()) throw new Error(`${options.name} returned no final assistant text`);
      succeeded = true;
      return {
        text: finalText,
        usage,
        transcript,
        response: finalProvider && finalModel && finalApi && finalStopReason
          ? { provider: finalProvider, model: finalModel, api: finalApi, stopReason: finalStopReason }
          : undefined
      };
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

function cloneUsage(usage: AgentUsage): AgentUsage {
  return {
    ...usage,
    costBreakdown: usage.costBreakdown ? { ...usage.costBreakdown } : undefined
  };
}

function sanitizeEvent(event: AgentSessionEvent): import("./agent-runner-contracts.js").AgentEventMetadata | undefined {
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
    case "message_end":
      if (event.message.role !== "assistant" || event.message.stopReason === "stop" || event.message.stopReason === "toolUse") {
        return undefined;
      }
      return {
        type: event.type,
        stopReason: event.message.stopReason,
        provider: event.message.provider,
        model: event.message.responseModel ?? event.message.model,
        errorMessage: sanitizeDiagnostic(event.message.errorMessage, 500)
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

function truncate(value: string | undefined, max: number): string | undefined {
  if (!value) return value;
  return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function sanitizeDiagnostic(value: string | undefined, max: number): string | undefined {
  if (!value) return undefined;
  return truncate(value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim(), max);
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
