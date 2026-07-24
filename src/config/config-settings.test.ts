import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.js";
import { DEFAULT_CONFIG } from "./config.js";
import { openSettings } from "./config-settings.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function setupConfig(overrides: Partial<typeof DEFAULT_CONFIG> = {}): Promise<string> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orch-settings-"));
  directories.push(cwd);
  const config = structuredClone(DEFAULT_CONFIG);
  Object.assign(config, overrides);
  await saveConfig(cwd, config);
  return cwd;
}

describe("config-settings", () => {
  it("returns unavailable when no UI", async () => {
    const cwd = await setupConfig();
    const ctx = { hasUI: false, ui: { notify: vi.fn() } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    expect(result).toBe("unavailable");
  });

  it("returns unavailable when workflow is running", async () => {
    const cwd = await setupConfig();
    const ctx = { hasUI: true, ui: { notify: vi.fn(), select: vi.fn(), confirm: vi.fn(), input: vi.fn() } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => true, save: vi.fn() });
    expect(result).toBe("unavailable");
  });

  it("cancels from top menu", async () => {
    const cwd = await setupConfig();
    const select = vi.fn(async () => "Cancel");
    const ctx = { hasUI: true, ui: { notify: vi.fn(), select, confirm: vi.fn(), input: vi.fn() } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    expect(result).toBe("cancelled");
    expect(select).toHaveBeenCalledOnce();
  });

  it("saves workflow settings changes", async () => {
    const cwd = await setupConfig();
    // Simulate: open settings → Workflow settings → Retry limits → edit → back → Save all → confirm
    let callCount = 0;
    const select = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "Workflow settings  — retries, timeouts, isolation, human review, dashboard";
      if (callCount === 2) return "Retry limits  — plan, implementation, and review cycles";
      if (callCount === 3) return "Plan revisions: 2";
      if (callCount === 4) return "Back to categories";
      if (callCount === 5) return "Save all changes";
      return "Cancel";
    });
    const input = vi.fn(async () => "5");
    const confirm = vi.fn(async () => true);
    const notify = vi.fn();
    const ctx = { hasUI: true, ui: { notify, select, confirm, input } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    expect(result).toBe("saved");
    // Verify config was saved to disk
    const saved = await loadConfig(cwd);
    expect(saved.limits.planRevisions).toBe(5);
    expect(notify.mock.calls.some(c => String(c[0]).includes("saved"))).toBe(true);
  });

  it("toggles mutation isolation", async () => {
    const cwd = await setupConfig();
    let callCount = 0;
    const select = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "Workflow settings  — retries, timeouts, isolation, human review, dashboard";
      if (callCount === 2) return "Mutation isolation  — verify the complete mutation phase in a git worktree";
      if (callCount === 3) return " Verify all mutations in a git worktree before synchronization";
      if (callCount === 4) return "Save all changes";
      return "Cancel";
    });
    const confirm = vi.fn(async () => true);
    const ctx = { hasUI: true, ui: { notify: vi.fn(), select, confirm, input: vi.fn() } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    expect(result).toBe("saved");
    const saved = await loadConfig(cwd);
    expect(saved.limits.worktreeIsolation).toBe(false);
  });

  it("toggles human review options", async () => {
    const cwd = await setupConfig();
    let callCount = 0;
    const select = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "Workflow settings  — retries, timeouts, isolation, human review, dashboard";
      if (callCount === 2) return "Human review  — plan approval, revision review, mutation guard, important decisions";
      if (callCount === 3) return " Review plan before approval";
      if (callCount === 4) return " Review plan revisions";  // second toggle
      if (callCount === 5) return "Back to categories";
      if (callCount === 6) return "Save all changes";
      return "Cancel";
    });
    const confirm = vi.fn(async () => true);
    const ctx = { hasUI: true, ui: { notify: vi.fn(), select, confirm, input: vi.fn() } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    expect(result).toBe("saved");
    const saved = await loadConfig(cwd);
    expect(saved.humanInTheLoop.planApproval).toBe(true);
    expect(saved.humanInTheLoop.planRevisionApproval).toBe(true);
    expect(saved.humanInTheLoop.confirmBeforeMutation).toBe(false);
  });

  it("toggles important decisions", async () => {
    const cwd = await setupConfig();
    let callCount = 0;
    const select = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "Workflow settings  — retries, timeouts, isolation, human review, dashboard";
      if (callCount === 2) return "Human review  — plan approval, revision review, mutation guard, important decisions";
      if (callCount === 3) return " Important decisions — scope expansion, review rejection, repair limits, final delivery";
      if (callCount === 4) return "Back to categories";
      if (callCount === 5) return "Save all changes";
      return "Cancel";
    });
    const confirm = vi.fn(async () => true);
    const ctx = { hasUI: true, ui: { notify: vi.fn(), select, confirm, input: vi.fn() } } as unknown as ExtensionCommandContext;
    const result = await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    expect(result).toBe("saved");
    const saved = await loadConfig(cwd);
    expect(saved.humanInTheLoop.importantDecisions).toBe(false); // was true by default, toggled off
  });

  it("edits dashboard settings", async () => {
    const cwd = await setupConfig();
    let callCount = 0;
    const select = vi.fn(async () => {
      callCount++;
      if (callCount === 1) return "Workflow settings  — retries, timeouts, isolation, human review, dashboard";
      if (callCount === 2) return "Dashboard  — enable/disable and port";
      if (callCount === 3) return "Port: 0";
      if (callCount === 4) return "Back to categories";
      if (callCount === 5) return "Save all changes";
      return "Cancel";
    });
    const input = vi.fn(async () => "8080");
    const confirm = vi.fn(async () => true);
    const ctx = { hasUI: true, ui: { notify: vi.fn(), select, confirm, input } } as unknown as ExtensionCommandContext;
    await openSettings(cwd, ctx, { isRunning: () => false, save: vi.fn() });
    const saved = await loadConfig(cwd);
    expect(saved.dashboard.port).toBe(8080);
  });
});
