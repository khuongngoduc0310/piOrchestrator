import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AgentIncompleteResponseError, AgentTimeoutError, normalizeAgentTranscript, PiSdkAgentExecutor } from "./agent-runner.js";
import { DEFAULT_CONFIG } from "../config/config.js";

const model = { provider: "test", id: "model" } as never;
const runtime = { getAvailable: async () => [model] } as unknown as ModelRuntime;
const resolved = { model, thinkingLevel: "low" as const, warning: undefined, error: undefined };

function assistantEvent(
  text: string,
  options: { stopReason?: "stop" | "length" | "error" | "aborted"; errorMessage?: string; reasoning?: number; cacheWrite1h?: number } = {}
): AgentSessionEvent {
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
        reasoning: options.reasoning,
        cacheWrite1h: options.cacheWrite1h,
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 }
      },
      stopReason: options.stopReason ?? "stop",
      errorMessage: options.errorMessage,
      timestamp: Date.now()
    }
  } as AgentSessionEvent;
}

describe("PiSdkAgentExecutor", () => {
  it("preflights only agents required by the selected route", async () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.agents.builder.model = "invalid/model";
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: agentConfig => agentConfig.model === "invalid/model"
        ? { model: undefined, thinkingLevel: undefined, warning: undefined, error: "invalid model" }
        : resolved
    });

    await expect(executor.preflight(
      config,
      process.cwd(),
      path.resolve("."),
      new AbortController().signal,
      100,
      ["explorer", "planner", "reviewer"]
    )).resolves.toBeUndefined();
    await expect(executor.preflight(config, process.cwd(), path.resolve(".")))
      .rejects.toThrow("Invalid model for builder");
  });

  it("normalizes Pi user, assistant, reasoning, tool call, and tool result messages", () => {
    const transcript = normalizeAgentTranscript([
      { role: "user", content: "Find the issue", timestamp: 1 },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect the source" },
          { type: "text", text: "I will inspect it." },
          { type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }
        ],
        stopReason: "toolUse",
        timestamp: 2
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3
      }
    ]);

    expect(transcript).toEqual({
      schemaVersion: 1,
      truncated: false,
      messages: [
        { role: "user", content: [{ type: "text", text: "Find the issue" }], timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "Inspect the source" },
            { type: "text", text: "I will inspect it." },
            { type: "toolCall", toolCallId: "call-1", toolName: "read", arguments: '{"path":"src/index.ts"}' }
          ],
          timestamp: 2,
          stopReason: "toolUse"
        },
        {
          role: "toolResult",
          content: [{ type: "text", text: "file contents" }],
          timestamp: 3,
          toolCallId: "call-1",
          toolName: "read",
          isError: false
        }
      ]
    });
  });

  it("uses the final agent message list as the authoritative transcript", async () => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const snapshots: unknown[] = [];
    const finalAssistant = (assistantEvent("final answer") as Extract<AgentSessionEvent, { type: "message_end" }>).message;
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: false,
        subscribe: callback => { listener = callback; return () => undefined; },
        prompt: async () => {
          listener?.(assistantEvent("final answer"));
          listener?.({
            type: "agent_end",
            messages: [
              { role: "user", content: "original task", timestamp: 1 },
              finalAssistant
            ],
            willRetry: false
          } as AgentSessionEvent);
        },
        abort: async () => undefined,
        dispose: () => undefined
      })
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    const result = await executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 100,
      signal: new AbortController().signal,
      onTranscript: transcript => snapshots.push(transcript)
    });

    expect(result.transcript?.messages.map(message => message.role)).toEqual(["user", "assistant"]);
    expect(result.transcript?.messages[0].content).toEqual([{ type: "text", text: "original task" }]);
    expect(snapshots.at(-1)).toEqual(result.transcript);
  });

  it("preserves the original conversation across an SDK continuation retry", async () => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const failed = assistantEvent("first attempt", { stopReason: "error", errorMessage: "temporary outage" });
    const succeeded = assistantEvent("second attempt");
    const failedMessage = (failed as Extract<AgentSessionEvent, { type: "message_end" }>).message;
    const succeededMessage = (succeeded as Extract<AgentSessionEvent, { type: "message_end" }>).message;
    failedMessage.timestamp = 2;
    succeededMessage.timestamp = 3;
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: false,
        subscribe: callback => { listener = callback; return () => undefined; },
        prompt: async () => {
          listener?.(failed);
          listener?.({
            type: "agent_end",
            messages: [{ role: "user", content: "task", timestamp: 1 }, failedMessage],
            willRetry: true
          } as AgentSessionEvent);
          listener?.(succeeded);
          listener?.({ type: "agent_end", messages: [succeededMessage], willRetry: false } as AgentSessionEvent);
        },
        abort: async () => undefined,
        dispose: () => undefined
      })
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    const result = await executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 100,
      signal: new AbortController().signal
    });

    expect(result.transcript?.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
    expect(result.transcript?.messages[1].content).toEqual([{ type: "text", text: "first attempt" }]);
    expect(result.transcript?.messages[2].content).toEqual([{ type: "text", text: "second attempt" }]);
  });

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
    const usageSnapshots: unknown[] = [];
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
            listener?.(assistantEvent('{"ok":true}', { reasoning: 2, cacheWrite1h: 0 }));
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
      onEvent: event => events.push(event),
      onUsage: snapshot => usageSnapshots.push(snapshot)
    });
    expect(result.text).toBe('{"ok":true}');
    expect(result.usage).toEqual({
      input: 2,
      output: 3,
      cacheRead: 1,
      cacheWrite: 0,
      totalTokens: 6,
      reasoning: 2,
      cacheWrite1h: 0,
      cost: 0.3,
      costBreakdown: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 }
    });
    expect(result.response).toEqual({ provider: "test", model: "model", api: "test", stopReason: "stop" });
    expect(usageSnapshots).toEqual([{ usage: result.usage, provider: "test", model: "model", api: "test", stopReason: "stop" }]);
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

  it("preserves bounded provider diagnostics for an incomplete response", async () => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const abort = vi.fn(async () => undefined);
    const dispose = vi.fn();
    const events: unknown[] = [];
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: false,
        subscribe: callback => { listener = callback; return () => undefined; },
        prompt: async () => listener?.(assistantEvent("partial", {
          stopReason: "error",
          errorMessage: `provider unavailable\u0000${"x".repeat(1_100)}`
        })),
        abort,
        dispose
      })
    });
    await executor.preflight(DEFAULT_CONFIG, process.cwd(), path.resolve("."));
    const failure = await executor.run({
      name: "explorer",
      task: "task",
      cwd: process.cwd(),
      extensionRoot: path.resolve("."),
      config: DEFAULT_CONFIG.agents.explorer,
      timeoutMs: 100,
      signal: new AbortController().signal,
      onEvent: event => events.push(event)
    }).catch(error => error);

    expect(failure).toBeInstanceOf(AgentIncompleteResponseError);
    expect(failure).toMatchObject({
      agent: "explorer",
      stopReason: "error",
      provider: "test",
      model: "model",
      partialText: "partial",
      usage: { input: 2, output: 3, cost: 0.3 }
    });
    expect(failure.message).toContain("provider unavailable");
    expect(failure.providerError).not.toContain("\u0000");
    expect(failure.providerError.length).toBeLessThanOrEqual(1_001);
    expect(events).toEqual([expect.objectContaining({
      type: "message_end",
      stopReason: "error",
      errorMessage: expect.stringContaining("provider unavailable")
    })]);
    expect(abort).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([
    ["error", "provider did not supply error details"],
    ["length", "output limit"],
    ["aborted", "(aborted)"]
  ] as const)("classifies an incomplete %s response", async (stopReason, expectedMessage) => {
    let listener: ((event: AgentSessionEvent) => void) | undefined;
    const executor = new PiSdkAgentExecutor({
      runtime: async () => runtime,
      resolveModel: () => resolved,
      createSession: async () => ({
        isStreaming: false,
        subscribe: callback => { listener = callback; return () => undefined; },
        prompt: async () => listener?.(assistantEvent("", { stopReason })),
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
    })).rejects.toThrow(expectedMessage);
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
