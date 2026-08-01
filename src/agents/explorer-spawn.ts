import type { AgentConfig } from "../types.js";
import type { AgentRunOptions } from "./agent-runner-contracts.js";

export const EXPLORER_SPAWN_PROMPT = "explorer-spawn.md";

/** Wall-clock budget left for an agent that must finish before a deadline. */
export function agentRemainingTimeoutMs(agentTimeoutMs: number, deadlineStartedAt: number): number {
  return Math.max(1_000, agentTimeoutMs - (Date.now() - deadlineStartedAt));
}

export function spawnExplorerRunOptions(options: {
  question: string;
  cwd: string;
  extensionRoot: string;
  explorerConfig: AgentConfig;
  timeoutMs: number;
  signal: AbortSignal;
  readRoots?: readonly string[];
  onEvent?: AgentRunOptions["onEvent"];
}): AgentRunOptions {
  return {
    name: "explorer",
    task: options.question,
    cwd: options.cwd,
    extensionRoot: options.extensionRoot,
    config: options.explorerConfig,
    promptFileOverride: EXPLORER_SPAWN_PROMPT,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    allowedWritePaths: [],
    ...(options.readRoots !== undefined ? { readRoots: options.readRoots } : {}),
    ...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {})
  };
}
