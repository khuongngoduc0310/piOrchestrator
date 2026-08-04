import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ensureChecksConfigured, ensureWorktreeSetupConfigured, normalizeCommands, suggestCheckConfigRepair } from "./check-setup.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "../config/config.js";
import type { CheckDiscoveryResult } from "../config-types.js";
import type { CheckResult } from "../workflow-types.js";

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

describe("isolated worktree setup", () => {
  it("persists user-approved lockfile-backed setup commands", async () => {
    const { cwd, config } = await setup();
    config.limits.worktreeIsolation = true;
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ packageManager: "npm@11" }));
    await writeFile(path.join(cwd, "package-lock.json"), "{}");
    await mkdir(path.join(cwd, "desktop"));
    await writeFile(path.join(cwd, "desktop", "package.json"), JSON.stringify({ packageManager: "npm@11" }));
    await writeFile(path.join(cwd, "desktop", "package-lock.json"), "{}");
    const ui = context({ selections: ["Approve suggested worktree setup"] });

    const result = await ensureWorktreeSetupConfigured(cwd, config, ui.ctx, {
      discover: async () => ({
        commands: [],
        scripts: [],
        diagnostics: [],
        worktreeSetupCandidates: [{ command: "npm ci", evidence: "Explorer confirms root lockfile" }]
      })
    });

    expect(result.worktreeSetup).toEqual({
      mode: "commands",
      commands: ["npm ci", "npm --prefix \"desktop\" ci"]
    });
    expect((await loadConfig(cwd)).worktreeSetup).toEqual(result.worktreeSetup);
    expect(ui.select.mock.calls[0][0]).toContain("Explorer confirms root lockfile");
  });

  it("persists manual mode without executing or inferring commands", async () => {
    const { cwd, config } = await setup();
    config.limits.worktreeIsolation = true;
    const ui = context({ selections: ["Use manual worktree setup"] });

    const result = await ensureWorktreeSetupConfigured(cwd, config, ui.ctx, {
      discover: async () => ({ commands: [], scripts: [], diagnostics: [] })
    });

    expect(result.worktreeSetup).toEqual({ mode: "manual", commands: [] });
    expect((await loadConfig(cwd)).worktreeSetup).toEqual(result.worktreeSetup);
  });
});

describe("check script validation", () => {
  async function projectWithScripts(scripts: Record<string, string>): Promise<string> {
    const { cwd } = await setup();
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts }));
    return cwd;
  }

  it("re-prompts when an edited check references a missing script and saves after re-edit", async () => {
    const cwd = await projectWithScripts({ "build:desktop": "npm --prefix desktop run build" });
    const ui = context({
      selections: ["Edit commands", "Edit commands"],
      edits: ["npm run build", "npm run build:desktop"]
    });
    const result = await ensureChecksConfigured(cwd, structuredClone(DEFAULT_CONFIG), ui.ctx, {
      discover: async () => ({ commands: [], scripts: [], diagnostics: [] })
    });
    expect(result?.checks).toEqual(["npm run build:desktop"]);
    expect((await loadConfig(cwd)).checks).toEqual(["npm run build:desktop"]);
  });

  it("honors use-anyway and cancel in the validation prompt", async () => {
    const cwd = await projectWithScripts({ "build:desktop": "build" });
    const config = structuredClone(DEFAULT_CONFIG);
    const anyway = context({ selections: ["Edit commands", "Use anyway"], edits: ["npm run build"] });
    const kept = await ensureChecksConfigured(cwd, config, anyway.ctx, {
      discover: async () => ({ commands: [], scripts: [], diagnostics: [] })
    });
    expect(kept?.checks).toEqual(["npm run build"]);

    const cancelled = context({ selections: ["Edit commands", "Cancel"], edits: ["npm run build"] });
    expect(await ensureChecksConfigured(cwd, config, cancelled.ctx, {
      discover: async () => ({ commands: [], scripts: [], diagnostics: [] })
    })).toBeUndefined();
    expect((await loadConfig(cwd)).checks).toEqual(["npm run build"]);
  });

  it("does not prompt when every script-backed check exists or no manifest is present", async () => {
    const cwd = await projectWithScripts({ build: "vite build" });
    const ui = context({ selections: ["Approve suggested checks"] });
    const result = await ensureChecksConfigured(cwd, structuredClone(DEFAULT_CONFIG), ui.ctx, {
      discover: async () => ({ commands: ["npm run build"], scripts: ["build"], diagnostics: [] })
    });
    expect(result?.checks).toEqual(["npm run build"]);
    expect(ui.select).toHaveBeenCalledTimes(1);

    const bare = await setup();
    const bareUi = context({ selections: ["Approve suggested checks"] });
    const bareResult = await ensureChecksConfigured(bare.cwd, structuredClone(DEFAULT_CONFIG), bareUi.ctx, {
      discover: async () => ({ commands: ["npx tsc --noEmit"], scripts: [], diagnostics: [] })
    });
    expect(bareResult?.checks).toEqual(["npx tsc --noEmit"]);
    expect(bareUi.select).toHaveBeenCalledTimes(1);
  });
});

describe("suggestCheckConfigRepair", () => {
  function failing(command: string): CheckResult {
    return {
      command,
      exitCode: 1,
      stdout: "",
      stderr: "npm error Missing script",
      stdoutTruncated: false,
      stderrTruncated: false,
      passed: false,
      timedOut: false,
      cancelled: false,
      startedAt: new Date(0).toISOString(),
      completedAt: new Date(1).toISOString(),
      durationMs: 1
    };
  }

  function passing(command: string): CheckResult {
    return { ...failing(command), exitCode: 0, stderr: "", passed: true };
  }

  it("replaces a missing-script check with a same-family candidate", async () => {
    const { cwd } = await setup();
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({
      scripts: { "build:desktop": "build", "build:renderer": "build" }
    }));
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["npm run build"];
    const ui = context({ selections: ["Replace `npm run build` with `npm run build:desktop`"] });
    const repaired = await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], ui.ctx);
    expect(repaired?.checks).toEqual(["npm run build:desktop"]);
    expect((await loadConfig(cwd)).checks).toEqual(["npm run build:desktop"]);
  });

  it("supports the edit path and rejects unknown choices", async () => {
    const { cwd } = await setup();
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "build:desktop": "build" } }));
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["npm run build"];
    const edited = context({ selections: ["Edit commands"], edits: ["npm run build:desktop"] });
    expect((await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], edited.ctx))?.checks)
      .toEqual(["npm run build:desktop"]);

    const cancelled = context({ selections: ["Cancel"] });
    expect(await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], cancelled.ctx)).toBeUndefined();

    const unknown = context({ selections: ["not an option"] });
    expect(await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], unknown.ctx)).toBeUndefined();
  });

  it("skips when no manifest, no same-family candidate, or no script-shaped failure", async () => {
    const { cwd } = await setup();
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["npm run build"];
    const ui = context();
    expect(await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], ui.ctx)).toBeUndefined();

    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { test: "vitest run" } }));
    expect(await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], ui.ctx)).toBeUndefined();
    expect(await suggestCheckConfigRepair(cwd, config, [passing("npm run build")], ui.ctx)).toBeUndefined();
    expect(await suggestCheckConfigRepair(cwd, config, [failing("python -m pytest")], ui.ctx)).toBeUndefined();
  });

  it("skips without UI", async () => {
    const { cwd } = await setup();
    await writeFile(path.join(cwd, "package.json"), JSON.stringify({ scripts: { "build:desktop": "build" } }));
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["npm run build"];
    expect(await suggestCheckConfigRepair(cwd, config, [failing("npm run build")], {
      hasUI: false,
      ui: { notify: vi.fn() }
    } as unknown as ExtensionCommandContext)).toBeUndefined();
  });
});
