import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { applyAgentModelUpdates, ConfigError, DEFAULT_CONFIG, configPath, inspectConfig, loadConfig } from "./config.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-config-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe("configuration", () => {
  it("creates a new config with explicit empty checks", async () => {
    const cwd = await temporaryDirectory();
    const config = await loadConfig(cwd);
    expect(config.checks).toEqual([]);
    expect(JSON.parse(await readFile(configPath(cwd), "utf8")).checks).toEqual([]);
  });

  it("merges new limits into a legacy config without rewriting it", async () => {
    const cwd = await temporaryDirectory();
    const file = configPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const legacy = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    delete legacy.schemaVersion;
    const limits = legacy.limits as Record<string, unknown>;
    delete limits.agentTimeoutMs;
    delete limits.checkTimeoutMs;
    delete limits.maxOutputBytes;
    legacy.checks = ["legacy check"];
    const original = JSON.stringify(legacy, null, 2) + "\n";
    await writeFile(file, original);

    const loaded = await loadConfig(cwd);
    expect(loaded.checks).toEqual(["legacy check"]);
    expect(loaded.limits.agentTimeoutMs).toBe(DEFAULT_CONFIG.limits.agentTimeoutMs);
    expect(await readFile(file, "utf8")).toBe(original);
  });

  it("preserves an explicitly omitted optional thinking level", async () => {
    const cwd = await temporaryDirectory();
    const file = configPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    delete config.agents.builder.thinking;
    await writeFile(file, JSON.stringify(config, null, 2) + "\n");
    expect((await loadConfig(cwd)).agents.builder.thinking).toBeUndefined();
  });

  it("defaults importantDecisions to true when missing", async () => {
    const cwd = await temporaryDirectory();
    const file = configPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
    const human = config.humanInTheLoop as Record<string, unknown>;
    delete human.importantDecisions;
    const saved = JSON.stringify(config, null, 2) + "\n";
    await writeFile(file, saved);
    const loaded = await loadConfig(cwd);
    expect(loaded.humanInTheLoop.importantDecisions).toBe(true);
  });

  it("preserves malformed config content", async () => {
    const cwd = await temporaryDirectory();
    const file = configPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{ broken\n");
    await expect(loadConfig(cwd)).rejects.toBeInstanceOf(ConfigError);
    expect(await readFile(file, "utf8")).toBe("{ broken\n");
  });

  it("reads a config status without creating a file when missing", async () => {
    const cwd = await temporaryDirectory();
    const summary = await inspectConfig(cwd);
    expect(summary.status).toBe("missing");
    expect(summary.checkCount).toBe(0);
    const file = configPath(cwd);
    await expect(readFile(file, "utf8")).rejects.toThrow();
  });

  it("reads a valid config status without modifying it", async () => {
    const cwd = await temporaryDirectory();
    const file = configPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["npm test"];
    const before = JSON.stringify(config, null, 2) + "\n";
    await writeFile(file, before);
    const summary = await inspectConfig(cwd);
    expect(summary.status).toBe("valid");
    expect(summary.checkCount).toBe(1);
    expect(await readFile(file, "utf8")).toBe(before);
  });

  it("reads an invalid config status without replacing it", async () => {
    const cwd = await temporaryDirectory();
    const file = configPath(cwd);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "{broken");
    const summary = await inspectConfig(cwd);
    expect(summary.status).toBe("invalid");
    expect(summary.message).toBeTruthy();
    expect(await readFile(file, "utf8")).toBe("{broken");
  });

  it("applies agent model updates without mutating unrelated settings", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.checks = ["custom check"];
    const original = structuredClone(config);
    const updated = applyAgentModelUpdates(config, {
      builder: { model: " openai/coder ", thinking: "max" },
      documenter: { model: "anthropic/fast" }
    });
    expect(updated.agents.builder).toMatchObject({ model: "openai/coder", thinking: "max" });
    expect(updated.agents.documenter.model).toBe("anthropic/fast");
    expect(updated.agents.documenter.thinking).toBeUndefined();
    expect(updated.agents.builder.tools).toEqual(original.agents.builder.tools);
    expect(updated.agents.builder.promptFile).toBe(original.agents.builder.promptFile);
    expect(updated.checks).toEqual(["custom check"]);
    expect(config).toEqual(original);
  });

  it("rejects custom extension tools with a precise migration error", async () => {
    const cwd = await temporaryDirectory();
    const file = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "config.json");
    await mkdir(path.dirname(file), { recursive: true });
    const config = structuredClone(DEFAULT_CONFIG) as unknown as { agents: Record<string, { tools: string[] }> };
    config.agents.explorer.tools.push("custom_tool");
    await writeFile(file, JSON.stringify(config));
    await expect(loadConfig(cwd)).rejects.toThrow("config.agents.explorer.tools[4]");
  });
});
