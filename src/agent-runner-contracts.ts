import type {
  AgentSession,
  ModelRuntime,
  ResolveCliModelResult
} from "@earendil-works/pi-coding-agent";
import type {
  AgentConfig,
  AgentName,
  AgentResult,
  AgentTranscript,
  AgentUsage,
  AgentUsageSnapshot,
  OrchestratorConfig,
  ThinkingLevel
} from "./types.js";

export interface AgentEventMetadata {
  type: string;
  toolName?: string;
  isError?: boolean;
  attempt?: number;
  maxAttempts?: number;
  errorMessage?: string;
  text?: string;
  args?: string;
  stopReason?: string;
  provider?: string;
  model?: string;
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
  onTranscript?: (transcript: AgentTranscript) => void;
  onUsage?: (snapshot: AgentUsageSnapshot) => void;
  allowedWritePaths?: readonly string[];
  readRoots?: readonly string[];
}

export interface AgentExecutor {
  preflight(
    config: OrchestratorConfig,
    cwd: string,
    extensionRoot: string,
    signal?: AbortSignal,
    timeoutMs?: number,
    agents?: readonly AgentName[]
  ): Promise<void>;
  run(options: AgentRunOptions): Promise<AgentResult>;
}

export interface ResolvedAgent {
  model: ResolveCliModelResult["model"];
  thinkingLevel?: ThinkingLevel;
  promptPath: string;
}

export type AgentSessionLike = Pick<AgentSession, "subscribe" | "prompt" | "abort" | "dispose" | "isStreaming">;

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

export type AgentIncompleteStopReason = "length" | "error" | "aborted";

export class AgentIncompleteResponseError extends Error {
  readonly agent: AgentName;
  readonly stopReason: AgentIncompleteStopReason;
  readonly provider?: string;
  readonly model?: string;
  readonly providerError?: string;
  readonly partialText?: string;
  readonly usage: AgentUsage;
  readonly transcript?: AgentTranscript;

  constructor(options: {
    agent: AgentName;
    stopReason: AgentIncompleteStopReason;
    provider?: string;
    model?: string;
    providerError?: string;
    partialText?: string;
    usage: AgentUsage;
    transcript?: AgentTranscript;
  }) {
    const reason = options.stopReason === "length" ? "output limit" : options.stopReason;
    const detail = options.providerError
      ?? (options.stopReason === "error" ? "provider did not supply error details" : undefined);
    super(`${options.agent} returned an incomplete response (${reason})${detail ? `: ${detail}` : ""}`);
    this.name = "AgentIncompleteResponseError";
    this.agent = options.agent;
    this.stopReason = options.stopReason;
    this.provider = options.provider;
    this.model = options.model;
    this.providerError = options.providerError;
    this.partialText = options.partialText;
    this.usage = { ...options.usage };
    this.transcript = options.transcript;
  }
}
