import { describe, expect, it } from "vitest";
import { AgentSessionBuffer, MapSessionBuffer, MAX_EVENTS_PER_AGENT } from "./agent-session.js";
import type { AgentSessionEvent, ToolCallEvent, SystemEvent, AssistantDeltaEvent } from "./agent-session.js";

function assistantEvent(overrides: Partial<AssistantDeltaEvent> = {}): AssistantDeltaEvent {
  return { id: "a1", type: "assistant", timestamp: 1000, text: "Hello", streaming: true, ...overrides };
}

function toolRunning(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { id: "t1", type: "tool_call", timestamp: 2000, tool: "read", status: "running", startedAt: 2000, ...overrides };
}

function toolDone(overrides: Partial<ToolCallEvent> = {}): ToolCallEvent {
  return { id: "t1", type: "tool_call", timestamp: 3000, tool: "read", status: "succeeded", startedAt: 2000, durationMs: 1000, result: "OK", ...overrides };
}

function systemEvent(overrides: Partial<SystemEvent> = {}): SystemEvent {
  return { id: "s1", type: "system", timestamp: 500, text: "Agent started", kind: "agent_start", ...overrides };
}

describe("AgentSessionBuffer", () => {
  it("starts idle with no events", () => {
    const buf = new AgentSessionBuffer();
    const view = buf.getView("explorer" as any);
    expect(view.agent).toBe("explorer");
    expect(view.events).toHaveLength(0);
    expect(view.status).toBe("idle");
  });

  it("adds an assistant event and returns it in the view", () => {
    const buf = new AgentSessionBuffer();
    buf.add(assistantEvent());
    const view = buf.getView("explorer" as any);
    expect(view.events).toHaveLength(1);
    expect(view.events[0].type).toBe("assistant");
  });

  it("upserts streaming assistant events by id", () => {
    const buf = new AgentSessionBuffer();
    buf.add(assistantEvent({ id: "a1", text: "Hello ", streaming: true }));
    buf.add(assistantEvent({ id: "a1", text: "world", streaming: true }));
    const view = buf.getView("explorer" as any);
    expect(view.events).toHaveLength(1);
    const ev = view.events[0] as AssistantDeltaEvent;
    expect(ev.text).toBe("Hello world");
    expect(ev.streaming).toBe(true);
  });

  it("upserts non-streaming assistant events by id (replaces, not concatenates)", () => {
    const buf = new AgentSessionBuffer();
    buf.add(assistantEvent({ id: "a1", text: "First", streaming: false }));
    buf.add(assistantEvent({ id: "a1", text: "Second", streaming: false }));
    const view = buf.getView("explorer" as any);
    expect(view.events).toHaveLength(1);
    const ev = view.events[0] as AssistantDeltaEvent;
    expect(ev.text).toBe("Second");
  });

  it("upserts tool events by toolCallId", () => {
    const buf = new AgentSessionBuffer();
    buf.add(toolRunning());
    buf.add(toolDone());
    const view = buf.getView("explorer" as any);
    expect(view.events).toHaveLength(1);
    const ev = view.events[0] as ToolCallEvent;
    expect(ev.status).toBe("succeeded");
    expect(ev.durationMs).toBe(1000);
  });

  it("updates tool via updateTool method", () => {
    const buf = new AgentSessionBuffer();
    buf.add(toolRunning());
    buf.updateTool("t1", { status: "succeeded", result: "OK", durationMs: 500 });
    const view = buf.getView("explorer" as any);
    const ev = view.events[0] as ToolCallEvent;
    expect(ev.status).toBe("succeeded");
    expect(ev.durationMs).toBe(500);
  });

  it("adds system events", () => {
    const buf = new AgentSessionBuffer();
    buf.add(systemEvent());
    const view = buf.getView("explorer" as any);
    expect(view.events).toHaveLength(1);
    expect(view.events[0].type).toBe("system");
  });

  it("enforces MAX_EVENTS_PER_AGENT limit", () => {
    const buf = new AgentSessionBuffer();
    for (let i = 0; i < MAX_EVENTS_PER_AGENT + 50; i++) {
      buf.add(systemEvent({ id: `s${i}`, text: `Event ${i}` }));
    }
    const view = buf.getView("explorer" as any);
    expect(view.events.length).toBeLessThanOrEqual(MAX_EVENTS_PER_AGENT);
  });

  it("clears all events", () => {
    const buf = new AgentSessionBuffer();
    buf.add(systemEvent());
    buf.clear();
    const view = buf.getView("explorer" as any);
    expect(view.events).toHaveLength(0);
    expect(view.status).toBe("idle");
  });

  it("preserves startedAt and status", () => {
    const buf = new AgentSessionBuffer();
    buf.startedAt = 100;
    buf.status = "running";
    buf.add(assistantEvent());
    const view = buf.getView("explorer" as any);
    expect(view.startedAt).toBe(100);
    expect(view.status).toBe("running");
  });
});

describe("MapSessionBuffer", () => {
  it("creates buffers lazily per agent", () => {
    const mb = new MapSessionBuffer();
    mb.addEvent("explorer", assistantEvent());
    mb.addEvent("builder", toolRunning());
    const exp = mb.getView("explorer" as any)!;
    const bld = mb.getView("builder" as any)!;
    expect(exp.events).toHaveLength(1);
    expect(exp.events[0].type).toBe("assistant");
    expect(bld.events).toHaveLength(1);
    expect(bld.events[0].type).toBe("tool_call");
  });

  it("lists agent names", () => {
    const mb = new MapSessionBuffer();
    expect(mb.getAgentNames()).toEqual([]);
    mb.addEvent("explorer", assistantEvent());
    mb.addEvent("builder", systemEvent());
    const names = mb.getAgentNames();
    expect(names).toContain("explorer");
    expect(names).toContain("builder");
  });

  it("updates tool events across agents", () => {
    const mb = new MapSessionBuffer();
    mb.addEvent("explorer", toolRunning());
    mb.updateTool("explorer", "t1", { status: "succeeded" });
    const view = mb.getView("explorer" as any)!;
    const ev = view.events[0] as ToolCallEvent;
    expect(ev.status).toBe("succeeded");
  });

  it("clears all buffers", () => {
    const mb = new MapSessionBuffer();
    mb.addEvent("explorer", systemEvent());
    mb.clear();
    expect(mb.getAgentNames()).toEqual([]);
    expect(mb.getView("explorer" as any)).toBeUndefined();
  });

  it("returns undefined for unknown agent", () => {
    const mb = new MapSessionBuffer();
    expect(mb.getView("nobody" as any)).toBeUndefined();
  });
});
