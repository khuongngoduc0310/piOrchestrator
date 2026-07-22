import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configureAgentModels } from "./agent-settings.js";
import { openSettings } from "./config-settings.js";
import { inspectRun } from "./inspect.js";
import { handleMemoryCommand } from "./memory-commands.js";
import { openBrowser } from "./open-browser.js";
import { Orchestrator } from "./orchestrator.js";
import { UiController } from "./ui-controller.js";
import { AGENT_NAMES, THINKING_LEVELS, type AgentName, type ThinkingLevel } from "./types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agents = new Set<AgentName>(AGENT_NAMES);

export default function piOrchestrator(pi: ExtensionAPI): void {
  const engine = new Orchestrator(pi, root);
  const ui = new UiController({
    isRunning: () => engine.isRunning(),
    elapsedMs: () => {
      const state = engine.getState();
      if (!state?.startedAt) return 0;
      return Date.now() - new Date(state.startedAt).getTime();
    }
  });

  engine.setOnStateChange((state, config, ctx) => {
    ui.updateRun(state, config, ctx);
  });

  pi.on("session_start", async (_event, ctx) => {
    await ui.attach(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    ui.detach(ctx);
    await engine.shutdown(ctx);
  });

  pi.registerCommand("orchestrate", {
    description: "Run the multi-agent coding workflow",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /orchestrate <request>", "warning");
        return;
      }
      try {
        await engine.start(args.trim(), ctx);
      } catch (error) {
        ctx.ui.notify(messageOf(error), "error");
      }
    }
  });

  pi.registerCommand("orchestrator-status", {
    description: "Show the current workflow status",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const state = engine.getState();
      if (!state) {
        ctx.ui.notify("No workflow has run yet", "info");
        return;
      }
      const failed = state.failedStage ? ` · failed at ${state.failedStage}` : "";
      const lastFailed = [...state.steps].reverse().find(step => step.status === "failed" || step.status === "cancelled");
      const artifact = lastFailed?.artifact ?? lastFailed?.rawArtifact;
      const location = artifact ? ` · ${path.join(state.runDir, artifact)}` : ` · ${state.runDir}`;
      ctx.ui.notify(`${state.stage} · ${state.status}${failed}${location}${state.dashboardUrl ? ` · ${state.dashboardUrl}` : ""}`, state.status === "failed" ? "error" : "info");
    }
  });

  pi.registerCommand("orchestrator-cancel", {
    description: "Cancel the active workflow",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const requested = engine.cancel();
      ctx.ui.notify(requested ? "Cancellation requested" : "No active workflow to cancel", requested ? "warning" : "info");
    }
  });

  pi.registerCommand("orchestrator-ui", {
    description: "Start or display the browser dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      try {
        const cwd = ctx.cwd ?? process.cwd();
        const url = await engine.startDashboard(cwd);
        openBrowser(url);
        ctx.ui.notify(url, "info");
      } catch (error) {
        ctx.ui.notify(`Dashboard failed: ${messageOf(error)}`, "error");
      }
    }
  });

  pi.registerCommand("orchestrator-settings", {
    description: "Configure agent models, retry limits, timeouts, isolation, human review, and dashboard",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd ?? process.cwd();
      try {
        const result = await openSettings(cwd, ctx, {
          isRunning: () => engine.isRunning(),
          save: (projectCwd, updates) => engine.saveAgentSettings(projectCwd, updates)
        });
        if (result === "saved") await ui.refreshConfig(ctx);
      } catch (error) {
        ctx.ui.notify(`Could not open orchestrator settings: ${messageOf(error)}`, "error");
      }
    }
  });

  pi.registerCommand("agent-model", {
    description: "Set an agent model: /agent-model builder provider/model high|retain|clear",
    getArgumentCompletions: prefix => {
      if (prefix.includes(" ")) return null;
      const matches = AGENT_NAMES.filter(name => name.startsWith(prefix));
      return matches.length ? matches.map(name => ({ value: name, label: name })) : null;
    },
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const [agentRaw, model, thinkingRaw] = parts;
      const agent = agentRaw as AgentName;
      if (!agents.has(agent) || !model || parts.length > 3) {
        ctx.ui.notify("Usage: /agent-model <agent> <provider/model> [off|minimal|low|medium|high|xhigh|max|retain|clear]", "warning");
        return;
      }
      let thinking: ThinkingLevel | null | undefined;
      if (!thinkingRaw || thinkingRaw === "retain") thinking = undefined;
      else if (thinkingRaw === "clear") thinking = null;
      else if (THINKING_LEVELS.includes(thinkingRaw as ThinkingLevel)) thinking = thinkingRaw as ThinkingLevel;
      else {
        ctx.ui.notify(`Invalid thinking level: ${thinkingRaw}`, "warning");
        return;
      }
      const cwd = ctx.cwd ?? process.cwd();
      try {
        await engine.saveAgentModel(cwd, agent, model, thinking);
        const suffix = thinking === null ? " (thinking cleared)" : thinking ? ` (${thinking})` : " (thinking retained)";
        ctx.ui.notify(`${agent} now uses ${model}${suffix}`, "info");
      } catch (error) {
        ctx.ui.notify(`Model was not updated: ${messageOf(error)}`, "error");
      }
    }
  });

  pi.registerCommand("orchestrator-inspect", {
    description: "Inspect agent outputs from previous runs. Optionally: <run-id> <step-name>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd ?? process.cwd();
      try {
        await inspectRun(cwd, args.trim(), ctx);
      } catch (error) {
        ctx.ui.notify(`Inspect failed: ${messageOf(error)}`, "error");
      }
    }
  });

  pi.registerCommand("orchestrator-memory", {
    description: "Manage trusted project memory: inspect [id] | pending [run-id] | approve <run-id> <candidate-id> | decline <run-id> <candidate-id> | remove <id>",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const cwd = ctx.cwd ?? process.cwd();
      const isActive = () => engine.isRunning();
      try {
        await handleMemoryCommand(args.trim(), cwd, ctx, isActive);
      } catch (error) {
        ctx.ui.notify(`Memory command failed: ${messageOf(error)}`, "error");
      }
    }
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
