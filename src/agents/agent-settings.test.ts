import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { buildAvailableModelCatalog, configureAgentModels, supportedThinkingLevels } from "./agent-settings.js";
import { DEFAULT_CONFIG, configPath, saveConfig } from "../config/config.js";
import type { AgentModelUpdates, OrchestratorConfig } from "../types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-agent-settings-"));
  directories.push(cwd);
  await saveConfig(cwd, structuredClone(DEFAULT_CONFIG));
  return cwd;
}

function model(provider: string, id: string, options: Record<string, unknown> = {}) {
  return { provider, id, name: id, reasoning: false, ...options } as never;
}

type Selection = string | undefined | ((choices: string[]) => string | undefined);

function context(
  models: never[],
  selections: Selection[],
  options: { hasUI?: boolean; registryError?: string; refreshError?: Error } = {}
) {
  const notify = vi.fn();
  const refresh = vi.fn(async () => {
    if (options.refreshError) throw options.refreshError;
  });
  const select = vi.fn(async (_title: string, choices: string[]) => {
    const next = selections.shift();
    return typeof next === "function" ? next(choices) : next;
  });
  const confirm = vi.fn(async (_title: string, _message: string) => true);
  return {
    ctx: {
      hasUI: options.hasUI ?? true,
      ui: { select, confirm, notify },
      modelRegistry: {
        refresh,
        getError: () => options.registryError,
        getAvailable: () => models
      }
    } as unknown as ExtensionCommandContext,
    select,
    confirm,
    notify,
    refresh
  };
}

describe("agent model settings", () => {
  it("stages multiple roles, reviews, and saves once", async () => {
    const cwd = await project();
    const ui = context(
      [
        model("anthropic", "claude", { reasoning: true }),
        model("openai", "coder", { name: "Coder", reasoning: true, thinkingLevelMap: { max: "max" } })
      ],
      [
        choices => choices.find(choice => choice.startsWith("builder —")),
        "openai/coder — Coder",
        "max",
        choices => choices.find(choice => choice.startsWith("documenter —")),
        "anthropic/claude",
        "Use model default",
        "Save changes"
      ]
    );
    const save = vi.fn(async (_cwd: string, updates: AgentModelUpdates) => {
      const config = structuredClone(DEFAULT_CONFIG);
      for (const [agent, setting] of Object.entries(updates)) Object.assign(config.agents[agent as keyof typeof config.agents], setting);
      return config;
    });

    expect(await configureAgentModels(cwd, ui.ctx, { isRunning: () => false, save })).toBe("saved");
    expect(save).toHaveBeenCalledOnce();
    expect(save.mock.calls[0][1]).toEqual({
      builder: { model: "openai/coder", thinking: "max" },
      documenter: { model: "anthropic/claude" }
    });
    expect(ui.confirm.mock.calls[0][1]).toContain("builder:");
    expect(ui.confirm.mock.calls[0][1]).toContain("documenter:");
  });

  it("cancels without writing the config", async () => {
    const cwd = await project();
    const before = await readFile(configPath(cwd), "utf8");
    const ui = context([model("openai", "coder")], ["Cancel"]);
    const save = vi.fn(async () => structuredClone(DEFAULT_CONFIG));
    expect(await configureAgentModels(cwd, ui.ctx, { isRunning: () => false, save })).toBe("cancelled");
    expect(save).not.toHaveBeenCalled();
    expect(await readFile(configPath(cwd), "utf8")).toBe(before);
  });

  it("returns to the menu after a failed full save", async () => {
    const cwd = await project();
    const ui = context([model("openai", "coder", { reasoning: true })], [
      choices => choices.find(choice => choice.startsWith("builder —")),
      "openai/coder",
      "high",
      "Save changes",
      "Cancel"
    ]);
    const save = vi.fn(async (): Promise<OrchestratorConfig> => { throw new Error("preflight rejected"); });
    expect(await configureAgentModels(cwd, ui.ctx, { isRunning: () => false, save })).toBe("cancelled");
    expect(save).toHaveBeenCalledOnce();
    expect(ui.notify.mock.calls.some(call => String(call[0]).includes("preflight rejected"))).toBe(true);
  });

  it("does not refresh or prompt in non-UI mode or during a workflow", async () => {
    const cwd = await project();
    const nonUi = context([model("openai", "coder")], [], { hasUI: false });
    expect(await configureAgentModels(cwd, nonUi.ctx, { isRunning: () => false, save: vi.fn() })).toBe("unavailable");
    expect(nonUi.refresh).not.toHaveBeenCalled();
    const running = context([model("openai", "coder")], []);
    expect(await configureAgentModels(cwd, running.ctx, { isRunning: () => true, save: vi.fn() })).toBe("unavailable");
    expect(running.refresh).not.toHaveBeenCalled();
  });

  it("stops safely when no authenticated models are available", async () => {
    const cwd = await project();
    const ui = context([], []);
    expect(await configureAgentModels(cwd, ui.ctx, { isRunning: () => false, save: vi.fn() })).toBe("unavailable");
    expect(ui.select).not.toHaveBeenCalled();
  });

  it("stops without prompting when model refresh fails", async () => {
    const cwd = await project();
    const ui = context([], [], { refreshError: new Error("registry offline") });
    expect(await configureAgentModels(cwd, ui.ctx, { isRunning: () => false, save: vi.fn() })).toBe("unavailable");
    expect(ui.select).not.toHaveBeenCalled();
    expect(ui.notify.mock.calls[0][0]).toContain("registry offline");
  });
});

describe("model catalog and thinking support", () => {
  it("deduplicates and sorts canonical references including IDs with slashes", () => {
    const catalog = buildAvailableModelCatalog([
      model("zeta", "model"),
      model("openrouter", "anthropic/claude"),
      model("zeta", "model")
    ]);
    expect(catalog.map(item => item.reference)).toEqual(["openrouter/anthropic/claude", "zeta/model"]);
  });

  it("limits thinking choices to model capabilities", () => {
    expect(supportedThinkingLevels(model("local", "plain"))).toEqual(["off"]);
    expect(supportedThinkingLevels(model("test", "reasoning", {
      reasoning: true,
      thinkingLevelMap: { off: null, medium: null, xhigh: "xhigh", max: null }
    }))).toEqual(["minimal", "low", "high", "xhigh"]);
  });
});
