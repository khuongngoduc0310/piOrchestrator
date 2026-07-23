import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type {
  AgentTranscript,
  AgentTranscriptMessage,
  AgentTranscriptPart
} from "../types.js";

export function updateTranscriptMessages(current: unknown[], event: AgentSessionEvent): unknown[] {
  if (event.type === "agent_end") {
    if (event.messages.some(message => isTranscriptRole(message) && message.role === "user")) return [...event.messages];
    return mergeTranscriptMessages(current, event.messages);
  }
  if (event.type !== "message_start" && event.type !== "message_update" && event.type !== "message_end") return current;
  const message = event.message as unknown;
  if (!isTranscriptRole(message)) return current;
  const next = [...current];
  const key = transcriptMessageKey(message);
  let existing = -1;
  for (let index = next.length - 1; index >= 0; index--) {
    const candidate = next[index];
    if (isTranscriptRole(candidate) && transcriptMessageKey(candidate) === key) {
      existing = index;
      break;
    }
  }
  if (existing >= 0) next[existing] = message;
  else next.push(message);
  return next;
}

function mergeTranscriptMessages(current: unknown[], additions: readonly unknown[]): unknown[] {
  const next = [...current];
  for (const message of additions) {
    if (!isTranscriptRole(message)) continue;
    const key = transcriptMessageKey(message);
    const existing = next.findIndex(candidate => isTranscriptRole(candidate) && transcriptMessageKey(candidate) === key);
    if (existing >= 0) next[existing] = message;
    else next.push(message);
  }
  return next;
}

function isTranscriptRole(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object") return false;
  const role = (value as Record<string, unknown>).role;
  return role === "user" || role === "assistant" || role === "toolResult";
}

function transcriptMessageKey(message: Record<string, unknown>): string {
  return [message.role, message.timestamp, message.toolCallId].map(value => String(value ?? "")).join(":");
}

export function normalizeAgentTranscript(messages: readonly unknown[]): AgentTranscript {
  const selected = messages.length <= 200 ? messages : [messages[0], ...messages.slice(-199)];
  const budget = { remaining: 2_000_000, truncated: messages.length > selected.length };
  const normalized = selected.flatMap(message => normalizeTranscriptMessage(message, budget));
  return { schemaVersion: 1, messages: normalized, truncated: budget.truncated };
}

function normalizeTranscriptMessage(
  value: unknown,
  budget: { remaining: number; truncated: boolean }
): AgentTranscriptMessage[] {
  if (!isTranscriptRole(value)) return [];
  const role = value.role as AgentTranscriptMessage["role"];
  const content = normalizeTranscriptContent(value.content, budget);
  const message: AgentTranscriptMessage = {
    role,
    content,
    ...(typeof value.timestamp === "number" ? { timestamp: value.timestamp } : {})
  };
  if (role === "assistant") {
    if (typeof value.stopReason === "string") message.stopReason = value.stopReason;
    if (typeof value.errorMessage === "string") message.errorMessage = takeTranscriptText(value.errorMessage, budget).text;
  }
  if (role === "toolResult") {
    if (typeof value.toolCallId === "string") message.toolCallId = value.toolCallId;
    if (typeof value.toolName === "string") message.toolName = value.toolName;
    if (typeof value.isError === "boolean") message.isError = value.isError;
  }
  return [message];
}

function normalizeTranscriptContent(value: unknown, budget: { remaining: number; truncated: boolean }): AgentTranscriptPart[] {
  const values = typeof value === "string" ? [{ type: "text", text: value }] : Array.isArray(value) ? value : [];
  const parts: AgentTranscriptPart[] = [];
  for (const candidate of values) {
    if (!candidate || typeof candidate !== "object") continue;
    const part = candidate as Record<string, unknown>;
    if (part.type === "text" && typeof part.text === "string") {
      const text = takeTranscriptText(part.text, budget);
      parts.push({ type: "text", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      const text = takeTranscriptText(part.thinking, budget);
      parts.push({ type: "thinking", text: text.text, ...(text.truncated ? { truncated: true } : {}) });
    } else if (part.type === "toolCall") {
      const args = safeJson(part.arguments);
      const text = takeTranscriptText(args, budget);
      parts.push({
        type: "toolCall",
        toolCallId: typeof part.id === "string" ? part.id : "",
        toolName: typeof part.name === "string" ? part.name : "unknown",
        arguments: text.text,
        ...(text.truncated ? { truncated: true } : {})
      });
    } else if (part.type === "image") {
      parts.push({ type: "image", ...(typeof part.mimeType === "string" ? { mimeType: part.mimeType } : {}) });
    }
  }
  return parts;
}

function takeTranscriptText(value: string, budget: { remaining: number; truncated: boolean }): { text: string; truncated: boolean } {
  const allowed = Math.min(128_000, Math.max(0, budget.remaining));
  if (value.length <= allowed) {
    budget.remaining -= value.length;
    return { text: value, truncated: false };
  }
  budget.truncated = true;
  budget.remaining -= allowed;
  return { text: value.slice(0, allowed), truncated: true };
}

function safeJson(value: unknown): string {
  try { return JSON.stringify(value ?? {}); }
  catch { return "[unserializable arguments]"; }
}
