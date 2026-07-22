import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ensureChecksConfigured, normalizeCommands } from "./check-setup.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config.js";
import type { CheckDiscoveryResult } from "./types.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function setup(): Promise<{ cwd: string; config: typeof DEFAULT_CONFIG }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-check-setup-"));
  directories.push(cwd);
  const config = structuredClone(DEFAULT_CONFIG);
  await saveConfig(cwd, config);
  return { cwd, config };
}

function context(options: { hasUI?: boolean; selections?: Array<string | undefined>; edits?: Array<string | undefined> } = {}) {
  const select = vi.fn(async (_title: string, _items: string[]) => options.selections?.shift());
  const editor = vi.fn(async (_title: string, _prefill?: string) => options.edits?.shift());
  const notify = vi.fn();
  return {
    ctx: { hasUI: options.hasUI ?? true, ui: { select, editor, notify } } as unknown as ExtensionCommandContext,
    select,
    editor,
    notify
  };
}

const discovery: CheckDiscoveryResult = {
  packageManager: "npm",
  scripts: ["test", "build"],
  commands: ["npm test", "npm run build"],
  diagnostics: []
};

describe("first-run check setup", () => {
  it("approves, persists, and returns discovered commands", async () => {
    const { cwd, config } = await setup();
    const ui = context({ selections: ["Approve suggested checks"] });
    const result = await ensureChecksConfigured(cwd, config, ui.ctx, { discover: async () => discovery });
    expect(result?.checks).toEqual(discovery.commands);
    expect((await loadConfig(cwd)).checks).toEqual(discovery.commands);
    expect(ui.editor).not.toHaveBeenCalled();
  });

  it("allows edited newline-delimited commands", async () => {
    const { cwd, config } = await setup();
    const ui = context({ selections: ["Edit commands"], edits: [" npm test \r\n\r\nnpm run build\n npm test "] });
    const result = await ensureChecksConfigured(cwd, config, ui.ctx, { discover: async () => discovery });
    expect(result?.checks).toEqual(["npm test", "npm run build"]);
    expect((await loadConfig(cwd)).checks).toEqual(["npm test", "npm run build"]);
  });

  it("leaves checks empty when cancelled", async () => {
    const { cwd, config } = await setup();
    const ui = context({ selections: ["Cancel"] });
    expect(await ensureChecksConfigured(cwd, config, ui.ctx, { discover: async () => discovery })).toBeUndefined();
    expect((await loadConfig(cwd)).checks).toEqual([]);
  });

  it("offers editing when no checks are discovered", async () => {
    const { cwd, config } = await setup();
    const ui = context({ selections: ["Edit commands"], edits: ["custom-check"] });
    const result = await ensureChecksConfigured(cwd, config, ui.ctx, {
      discover: async () => ({ commands: [], scripts: [], diagnostics: ["none"] })
    });
    expect(result?.checks).toEqual(["custom-check"]);
    expect(ui.select.mock.calls[0][1]).toEqual(["Edit commands", "Cancel"]);
  });

  it("does not discover, prompt, or rewrite existing checks", async () => {
    const { cwd, config } = await setup();
    config.checks = ["already configured"];
    await saveConfig(cwd, config);
    const ui = context();
    const discover = vi.fn(async () => discovery);
    const before = JSON.stringify(await loadConfig(cwd));
    const result = await ensureChecksConfigured(cwd, config, ui.ctx, { discover });
    expect(result).toBe(config);
    expect(discover).not.toHaveBeenCalled();
    expect(ui.select).not.toHaveBeenCalled();
    expect(JSON.stringify(await loadConfig(cwd))).toBe(before);
  });

  it("never auto-approves in non-UI modes", async () => {
    const { cwd, config } = await setup();
    const ui = context({ hasUI: false });
    const discover = vi.fn(async () => discovery);
    expect(await ensureChecksConfigured(cwd, config, ui.ctx, { discover })).toBeUndefined();
    expect(discover).not.toHaveBeenCalled();
    expect((await loadConfig(cwd)).checks).toEqual([]);
  });
});

describe("normalizeCommands", () => {
  it("trims blank lines and duplicates while preserving order", () => {
    expect(normalizeCommands(" a \n\n b\na\n")).toEqual(["a", "b"]);
  });
});
