import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ExtensionAPI, ToolCallEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  assertCustomToolsAdmitted,
  createCapabilityGuard,
  resolveSessionToolAllowlist,
  shouldEnableSpawnTool
} from "./agent-session.js";
import type { AgentRunOptions } from "./agent-runner-contracts.js";
import { SPAWN_EXPLORER_TOOL } from "./agent-runner-contracts.js";
import { intersectRoleTools } from "./role-capabilities.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import type { AgentName } from "../agent-types.js";

function runOptions(name: AgentName, spawnExplorer?: AgentRunOptions["spawnExplorer"]): AgentRunOptions {
  return {
    name,
    task: "task",
    cwd: process.cwd(),
    extensionRoot: path.resolve("."),
    config: DEFAULT_CONFIG.agents[name],
    timeoutMs: 100,
    signal: new AbortController().signal,
    spawnExplorer
  };
}

describe("shouldEnableSpawnTool", () => {
  it("enables the spawn tool only for context-hungry roles with a callback", () => {
    const callback = async (): Promise<{ text: string }> => ({ text: "findings" });
    for (const name of ["planner", "reviewer", "debugger"] as const) {
      expect(shouldEnableSpawnTool(runOptions(name, callback))).toBe(true);
    }
    for (const name of ["explorer", "tester", "builder", "documenter"] as const) {
      expect(shouldEnableSpawnTool(runOptions(name, callback))).toBe(false);
    }
  });

  it("never enables the spawn tool without the orchestrator-supplied callback", () => {
    for (const name of ["planner", "reviewer", "debugger"] as const) {
      expect(shouldEnableSpawnTool(runOptions(name))).toBe(false);
    }
  });
});

function callback(): AgentRunOptions["spawnExplorer"] {
  return async () => ({ text: "findings" });
}

function toolCall(toolName: string, input: unknown): ToolCallEvent {
  return { type: "tool_call", toolCallId: "call-1", toolName, input } as ToolCallEvent;
}

function guardToolCallHandler(run: AgentRunOptions): (event: ToolCallEvent) => Promise<unknown> {
  let handler: ((event: ToolCallEvent) => Promise<unknown>) | undefined;
  const factory = createCapabilityGuard(run);
  const fakePi = {
    on: (event: string, listener: (event: ToolCallEvent) => Promise<unknown>) => {
      if (event === "tool_call") handler = listener;
    }
  } as unknown as ExtensionAPI;
  factory(fakePi);
  if (!handler) throw new Error("createCapabilityGuard did not register a tool_call handler");
  return handler;
}

describe("resolveSessionToolAllowlist", () => {
  it("adds the spawn tool only for context-hungry roles with a callback", () => {
    for (const name of ["planner", "reviewer", "debugger"] as const) {
      const expected = [...intersectRoleTools(name, DEFAULT_CONFIG.agents[name].tools), SPAWN_EXPLORER_TOOL];
      expect(resolveSessionToolAllowlist(runOptions(name, callback()))).toEqual(expected);
    }
    for (const name of ["explorer", "tester", "builder", "documenter"] as const) {
      expect(resolveSessionToolAllowlist(runOptions(name, callback()))).toEqual(
        intersectRoleTools(name, DEFAULT_CONFIG.agents[name].tools)
      );
    }
  });

  it("never includes the spawn tool without the orchestrator-supplied callback", () => {
    for (const name of ["planner", "reviewer", "debugger"] as const) {
      expect(resolveSessionToolAllowlist(runOptions(name))).not.toContain(SPAWN_EXPLORER_TOOL);
    }
  });

  it("preserves configured tool narrowing", () => {
    const narrowed = runOptions("planner", callback());
    narrowed.config = { ...narrowed.config, tools: DEFAULT_CONFIG.agents.planner.tools.filter(tool => tool === "read") };
    expect(resolveSessionToolAllowlist(narrowed)).toEqual(["read", SPAWN_EXPLORER_TOOL]);
    narrowed.spawnExplorer = undefined;
    expect(resolveSessionToolAllowlist(narrowed)).toEqual(["read"]);
  });
});

describe("createCapabilityGuard", () => {
  it("allows spawn_explorer for a spawning role with a callback", async () => {
    const handler = guardToolCallHandler(runOptions("planner", callback()));
    const result = await handler(toolCall(SPAWN_EXPLORER_TOOL, { question: "what is here?" }));
    expect(result).toBeUndefined();
  });

  it("blocks spawn_explorer for non-spawning roles", async () => {
    const handler = guardToolCallHandler(runOptions("explorer", callback()));
    const result = await handler(toolCall(SPAWN_EXPLORER_TOOL, { question: "what is here?" }));
    expect(result).toEqual({ block: true, reason: "explorer is not permitted to use spawn_explorer" });
  });

  it("blocks spawn_explorer without the callback", async () => {
    const handler = guardToolCallHandler(runOptions("planner"));
    const result = await handler(toolCall(SPAWN_EXPLORER_TOOL, { question: "what is here?" }));
    expect(result).toEqual({ block: true, reason: "planner is not permitted to use spawn_explorer" });
  });

  it("always blocks bash", async () => {
    const handler = guardToolCallHandler(runOptions("planner", callback()));
    const result = await handler(toolCall("bash", { command: "echo hi" }));
    expect(result).toEqual({ block: true, reason: "planner is not permitted to use bash" });
  });

  it("blocks writes outside the allowed mutation paths", async () => {
    const handler = guardToolCallHandler(runOptions("builder"));
    const result = await handler(toolCall("write", { path: "src/outside.ts" }));
    expect(result).toEqual({ block: true, reason: "builder may not modify src/outside.ts" });
  });

  it("blocks reads escaping the permitted roots", async () => {
    const handler = guardToolCallHandler(runOptions("planner", callback()));
    const result = await handler(toolCall("read", { path: "../secret.json" }));
    expect(result).toEqual({ block: true, reason: "Read path escapes permitted roots: ../secret.json" });
  });
});

describe("assertCustomToolsAdmitted", () => {
  it("accepts custom tools present in the allowlist", () => {
    expect(() => assertCustomToolsAdmitted(["read", SPAWN_EXPLORER_TOOL], [{ name: SPAWN_EXPLORER_TOOL } as unknown as ToolDefinition])).not.toThrow();
  });

  it("rejects custom tools missing from the allowlist", () => {
    expect(() => assertCustomToolsAdmitted(["read"], [{ name: SPAWN_EXPLORER_TOOL } as unknown as ToolDefinition])).toThrow(
      /spawn_explorer is not in the session allowlist; add it to resolveSessionToolAllowlist/
    );
  });

  it("accepts when no custom tools are registered", () => {
    expect(() => assertCustomToolsAdmitted(["read"])).not.toThrow();
  });
});
