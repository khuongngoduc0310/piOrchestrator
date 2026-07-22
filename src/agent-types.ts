export const AGENT_NAMES = [
  "explorer",
  "planner",
  "reviewer",
  "tester",
  "builder",
  "debugger",
  "documenter"
] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export const BUILT_IN_TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls"] as const;
export type BuiltInToolName = (typeof BUILT_IN_TOOLS)[number];

export interface AgentConfig {
  model: string;
  thinking?: ThinkingLevel;
  tools: BuiltInToolName[];
  promptFile: string;
}

export interface AgentModelSelection {
  model: string;
  thinking?: ThinkingLevel;
}

export type AgentModelUpdates = Partial<Record<AgentName, AgentModelSelection>>;

export interface AgentStatus {
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  model: string;
  summary?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export type AgentInvocationMode = "execute" | "correct_output";

export interface AgentInvocationRecord {
  sequence: number;
  mode: AgentInvocationMode;
  status: "running" | "succeeded" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  transcriptArtifact?: string;
  messageCount: number;
  truncated: boolean;
}

export type AgentTranscriptPart =
  | { type: "text"; text: string; truncated?: boolean }
  | { type: "thinking"; text: string; truncated?: boolean }
  | { type: "toolCall"; toolCallId: string; toolName: string; arguments: string; truncated?: boolean }
  | { type: "image"; mimeType?: string };

export interface AgentTranscriptMessage {
  role: "user" | "assistant" | "toolResult";
  content: AgentTranscriptPart[];
  timestamp?: number;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  stopReason?: string;
  errorMessage?: string;
}

export interface AgentTranscript {
  schemaVersion: 1;
  messages: AgentTranscriptMessage[];
  truncated: boolean;
}

export interface AgentTranscriptArtifact extends AgentTranscript {
  stepId: string;
  agent: AgentName;
  invocation: number;
  mode: AgentInvocationMode;
  status: AgentInvocationRecord["status"];
  model: string;
  startedAt: string;
  completedAt: string;
}

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

export interface AgentResult {
  text: string;
  usage?: AgentUsage;
  transcript?: AgentTranscript;
}
