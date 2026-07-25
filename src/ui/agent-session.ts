import type { AgentName, BuilderOutput, DebuggerOutput, DocumenterOutput, ExplorerOutput, PlannerOutput, ReviewOutput, TesterOutput } from "../types.js";

export const MAX_EVENTS_PER_AGENT = 500;
export const MAX_BYTES_PER_AGENT = 1_000_000;

export interface AssistantDeltaEvent {
  id: string;
  type: "assistant";
  timestamp: number;
  text: string;
  streaming: boolean;
}

export interface ToolCallEvent {
  id: string;
  type: "tool_call";
  timestamp: number;
  tool: string;
  args?: string;
  status: "running" | "succeeded" | "failed";
  result?: string;
  startedAt: number;
  durationMs?: number;
}

export interface SystemEvent {
  id: string;
  type: "system";
  timestamp: number;
  text: string;
  kind?: "agent_start" | "agent_end" | "retry" | "error";
}

export type StructuredAgentResponse = {
  agent: "explorer"; output: ExplorerOutput;
} | {
  agent: "planner"; output: PlannerOutput;
} | {
  agent: "reviewer"; output: ReviewOutput;
} | {
  agent: "tester"; output: TesterOutput;
} | {
  agent: "builder"; output: BuilderOutput;
} | {
  agent: "debugger"; output: DebuggerOutput;
} | {
  agent: "documenter"; output: DocumenterOutput;
};

export interface StructuredResponseEvent {
  id: string;
  type: "structured_response";
  timestamp: number;
  response: StructuredAgentResponse;
}

export type AgentSessionEvent = AssistantDeltaEvent | ToolCallEvent | SystemEvent | StructuredResponseEvent;

export interface AgentSessionView {
  agent: AgentName;
  events: readonly AgentSessionEvent[];
  startedAt?: number;
  completedAt?: number;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
}

export interface ToolUpdate {
  status?: "running" | "succeeded" | "failed";
  result?: string;
  durationMs?: number;
}

/** Detect whether assistant text looks like role-output JSON. */
export function isAssistantJson(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") && (trimmed.includes('"summary"') || trimmed.includes('"architecture"') || trimmed.includes('"decision"') || trimmed.includes('"rootCause"'))) return true;
  if (trimmed.startsWith("```json")) return true;
  if (trimmed.startsWith("```") && trimmed.length > 20) return true;
  return false;
}

export class AgentSessionBuffer {
  private events: AgentSessionEvent[] = [];
  private estimatedBytes = 0;
  startedAt?: number;
  completedAt?: number;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled" = "idle";

  add(event: AgentSessionEvent): void {
    const existingIdx = this.findExisting(event);
    if (existingIdx !== -1) {
      const existing = this.events[existingIdx];
      this.estimatedBytes -= this.eventSize(existing);
      if (event.type === "assistant" && existing.type === "assistant" && existing.streaming) {
        this.events[existingIdx] = { ...event, text: existing.text + event.text };
      } else {
        this.events[existingIdx] = event;
      }
      this.estimatedBytes += this.eventSize(this.events[existingIdx]);
      return;
    }
    this.estimatedBytes += this.eventSize(event);
    this.events.push(event);
    this.enforceLimits();
  }

  updateTool(toolCallId: string, updates: ToolUpdate): void {
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i];
      if (e.type === "tool_call" && e.id === toolCallId) {
        const updated: ToolCallEvent = { ...e, ...updates };
        this.estimatedBytes -= this.eventSize(e);
        this.events[i] = updated;
        this.estimatedBytes += this.eventSize(updated);
        return;
      }
    }
  }

  private eventSize(event: AgentSessionEvent): number {
    switch (event.type) {
      case "assistant": return event.text.length * 2 + 64;
      case "tool_call": return ((event.args?.length ?? 0) + (event.result?.length ?? 0)) * 2 + 128;
      case "system": return event.text.length * 2 + 64;
      case "structured_response": return 512;
    }
  }

  private findExisting(event: AgentSessionEvent): number {
    if (event.type === "assistant") {
      for (let i = this.events.length - 1; i >= 0; i--) {
        const e = this.events[i];
        if (e.type === "assistant" && e.id === event.id) return i;
      }
    }
    if (event.type === "tool_call") {
      return this.events.findIndex(e => e.type === "tool_call" && e.id === event.id);
    }
    return -1;
  }

  private enforceLimits(): void {
    while (this.events.length > MAX_EVENTS_PER_AGENT || this.estimatedBytes > MAX_BYTES_PER_AGENT) {
      const removed = this.events.shift();
      if (removed) this.estimatedBytes -= this.eventSize(removed);
    }
  }

  getView(agent: AgentName): AgentSessionView {
    return {
      agent,
      events: this.events.slice(),
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      status: this.status,
    };
  }

  clear(): void {
    this.events = [];
    this.estimatedBytes = 0;
    this.startedAt = undefined;
    this.completedAt = undefined;
    this.status = "idle";
  }
}

export class MapSessionBuffer {
  private buffers = new Map<string, AgentSessionBuffer>();

  bufferFor(agent: string): AgentSessionBuffer {
    let buf = this.buffers.get(agent);
    if (!buf) {
      buf = new AgentSessionBuffer();
      this.buffers.set(agent, buf);
    }
    return buf;
  }

  addEvent(agent: string, event: AgentSessionEvent): void {
    this.bufferFor(agent).add(event);
  }

  updateTool(agent: string, toolCallId: string, updates: ToolUpdate): void {
    this.bufferFor(agent).updateTool(toolCallId, updates);
  }

  getView(agent: AgentName): AgentSessionView | undefined {
    return this.buffers.get(agent)?.getView(agent);
  }

  getAgentNames(): string[] {
    return Array.from(this.buffers.keys());
  }

  clear(): void {
    this.buffers.clear();
  }
}
