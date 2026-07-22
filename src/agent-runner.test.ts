import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentTimeoutError, PiSdkAgentExecutor } from "./agent-runner.js";
import { DEFAULT_CONFIG } from "./config.js";

const model = { provider: "test", id: "model" } as never;
const runtime = { getAvailable: async () => [model] } as unknown as ModelRuntime;
const resolved = { model, thinkingLevel: "low" as const, warning: undefined, error: undefined };

function assistantEvent(text: string): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "test",
      provider: "test",
      model: "model",
      usage: {
        input: 2,
        output: 3,
        cacheRead: 1,
        cacheWrite: 0,
        totalTokens: 6,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 }
      },
      stopReason: "stop",
      timestamp: Date.now()
    }
  } as AgentSessionEvent;
}

describe("PiSdkAgentExecutor", () => {
  it("bounds model preflight", async () => {
    const hangingRuntime = { getAvailable: async () => new Promise<never>(() => undefined) } as unknown as ModelRuntime;
    const executor = new PiSdkAgentExecutor({ runtime: async () => hangingRuntime, resolveModel: () => resolved });
    await expect(executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."), new AbortController().signal, 5))
      .rejects.toThrow("preflight timed out");
  });

  it("preflights models, captures bounded metadata/final usage, and disposes", async () => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const events: unknown[] = [];
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async options => {
        expect(options.rolePrompt).toContain("Explorer role");
        return {
          isStreaming: false,
          subscribe: callback => { listener = callback; return unsubscribe; },
          prompt: async () => {
            listener?.({ type: "agent_start" } as AgentSessionEvent);
            listener?.({ type: "tool_execution_start", toolCallId: "x", toolName: "read", args: { path: "test.txt" } } as AgentSessionEvent);
            listener?.(assistantEvent('{"ok":true}'));
          },
          abort: async () => undefined,
          dispose
        };
      }
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    const result = await executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 1000,
      signal: new AbortController().signal,
      onEvent: event => events.push(event)
    });
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toMatchObject({ input: 2, output: 3, cost: 0.3 });
    expect(events).toEqual([
      { type: "agent_start" },
      { type: "tool_execution_start", toolName: "read", args: '{"path":"test.txt"}' }
    ]);
    expect(JSON.stringify(events)).not.toContain("secret");
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("rejects an empty final assistant message instead of reusing stale text", async () => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: false,
        subscribe: callback => { listener = callback; return () => undefined; },
        prompt: async () => {
          listener?.(assistantEvent('{"stale":true}'));
          listener?.(assistantEvent(""));
        },
        abort: async () => undefined,
        dispose: () => undefined
      })
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    await expect(executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 100,
      signal: new AbortController().signal
    })).rejects.toThrow("no final assistant text");
  });

  it("disposes the session when subscription fails", async () => {
    const abort = vi.fn(async () => { throw new Error("abort failed"); });
    const dispose = vi.fn();
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: true,
        subscribe: () => { throw new Error("subscribe failed"); },
        prompt: async () => undefined,
        abort,
        dispose
      })
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    await expect(executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 100,
      signal: new AbortController().signal
    })).rejects.toThrow("subscribe failed");
    expect(abort).toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("aborts, unsubscribes, and disposes on timeout", async () => {
    const abort = vi.fn(async () => undefined);
    const unsubscribe = vi.fn();
    const dispose = vi.fn();
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: true,
        subscribe: () => unsubscribe,
        prompt: async () => new Promise<void>(() => undefined),
        abort,
        dispose
      })
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    await expect(executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 100,
      signal: new AbortController().signal
    })).rejects.toBeInstanceOf(AgentTimeoutError);
    expect(abort).toHaveBeenCalled();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });
});
