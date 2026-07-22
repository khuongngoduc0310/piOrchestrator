import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig } from "./config.js";
import {
  AGENT_NAMES,
  THINKING_LEVELS,
  type AgentModelSelection,
  type AgentModelUpdates,
  type AgentName,
  type OrchestratorConfig,
  type ThinkingLevel
} from "./types.js";

export type SettingsResult = "saved" | "unchanged" | "cancelled" | "unavailable";

const BACK = "Back to categories";
const CANCEL = "Cancel";
const SAVE_ALL = "Save all changes";

type StagedConfig = { config: OrchestratorConfig };

/**
 * Open the settings wizard. Shows a top-level menu: Agent models | Workflow settings.
 */
export async function openSettings(
  cwd: string,
  ctx: ExtensionCommandContext,
  deps: { isRunning: () => boolean; save: (cwd: string, updates: AgentModelUpdates) => Promise<OrchestratorConfig> }
): Promise<SettingsResult> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/orchestrator-settings requires TUI or RPC mode", "error");
    return "unavailable";
  }
  if (deps.isRunning()) {
    ctx.ui.notify("Settings cannot be changed while a workflow is running", "error");
    return "unavailable";
  }

  const config = await loadConfig(cwd);
  const staged: StagedConfig = { config: structuredClone(config) };

  while (true) {
    const choice = await ctx.ui.select("Orchestrator settings", [
      "Agent models  — model and thinking level for each agent",
      "Workflow settings  — retries, timeouts, isolation, human review, dashboard",
      CANCEL
    ]);
    if (!choice || choice === CANCEL) {
      ctx.ui.notify("Settings were not changed", "info");
      return "cancelled";
    }
    if (choice.startsWith("Agent models")) {
      const result = await configureAgentModelsInline(cwd, ctx, deps);
      if (result === "saved") return "saved";
      // Otherwise continue: user cancelled or unchanged, go back to top menu
      continue;
    }
    if (choice.startsWith("Workflow settings")) {
      const result = await configureWorkflowSettings(cwd, ctx, staged);
      if (result === "saved") return "saved";
      continue;
    }
  }
}

// ─── Agent models (delegates to the existing logic) ────────────────────────

async function configureAgentModelsInline(
  cwd: string,
  ctx: ExtensionCommandContext,
  deps: { isRunning: () => boolean; save: (cwd: string, updates: AgentModelUpdates) => Promise<OrchestratorConfig> }
): Promise<SettingsResult> {
  // Dynamically import to avoid circular deps
  const { configureAgentModels } = await import("./agent-settings.js");
  return configureAgentModels(cwd, ctx, deps);
}

// ─── Workflow settings sub-wizard ──────────────────────────────────────────

async function configureWorkflowSettings(
  cwd: string,
  ctx: ExtensionCommandContext,
  staged: StagedConfig
): Promise<SettingsResult> {
  while (true) {
    const cfg = staged.config;
    const summary = buildSettingsSummary(cfg);
    const choice = await ctx.ui.select(`Workflow settings\n\n${summary}`, [
      "Retry limits  — plan, implementation, and review cycles",
      "Timeouts & output  — agent, check, and output size limits",
      "Mutation isolation  — verify the complete mutation phase in a git worktree",
      "Human review  — plan approval, revision review, mutation-phase guard",
      "Dashboard  — enable/disable and port",
      SAVE_ALL,
      BACK
    ]);
    if (!choice || choice === BACK) return "cancelled";
    if (choice === SAVE_ALL) {
      const changed = changedFields(cfg);
      if (changed.length === 0) {
        ctx.ui.notify("No changes to save", "info");
        return "unchanged";
      }
      const confirmed = await ctx.ui.confirm("Save workflow settings?", changed.join("\n"));
      if (!confirmed) continue;
      try {
        await saveConfig(cwd, cfg);
        ctx.ui.notify("Workflow settings saved", "info");
        return "saved";
      } catch (error) {
        ctx.ui.notify(`Settings were not saved: ${messageOf(error)}`, "error");
        continue;
      }
    }
    if (choice.startsWith("Retry limits")) {
      await editRetryLimits(ctx, staged);
    } else if (choice.startsWith("Timeouts")) {
      await editTimeouts(ctx, staged);
    } else if (choice.startsWith("Mutation isolation")) {
      await editIsolation(ctx, staged);
    } else if (choice.startsWith("Human review")) {
      await editHumanReview(ctx, staged);
    } else if (choice.startsWith("Dashboard")) {
      await editDashboard(ctx, staged);
    }
  }
}

// ─── Sub-wizards ───────────────────────────────────────────────────────────

async function editRetryLimits(ctx: ExtensionCommandContext, staged: StagedConfig): Promise<void> {
  const cfg = staged.config;
  const labels: Record<string, string> = {
    planRevisions: `Plan revisions: ${cfg.limits.planRevisions}`,
    implementationRetries: `Implementation retries: ${cfg.limits.implementationRetries}`,
    reviewRevisions: `Code review revisions: ${cfg.limits.reviewRevisions}`
  };
  while (true) {
    const choice = await ctx.ui.select("Retry limits", [...Object.values(labels), BACK]);
    if (!choice || choice === BACK) return;
    const field = Object.entries(labels).find(([, label]) => label === choice)?.[0];
    if (!field) continue;
    const current = String(cfg.limits[field as keyof typeof cfg.limits]);
    const raw = await ctx.ui.input(`Enter new value for ${field}`, current);
    if (raw === undefined) continue;
    const value = parseInt(raw, 10);
    if (isNaN(value) || value < 0 || value > 1000) {
      ctx.ui.notify("Must be a number between 0 and 1000", "warning");
      continue;
    }
    (cfg.limits as Record<string, unknown>)[field] = value;
    labels[field] = `${field}: ${value}`;
    ctx.ui.notify(`${field} set to ${value}`, "info");
  }
}

async function editTimeouts(ctx: ExtensionCommandContext, staged: StagedConfig): Promise<void> {
  const cfg = staged.config;
  const labels: Record<string, string> = {
    agentTimeoutMs: `Agent timeout: ${fmtMs(cfg.limits.agentTimeoutMs)}`,
    checkTimeoutMs: `Check timeout: ${fmtMs(cfg.limits.checkTimeoutMs)}`,
    maxOutputBytes: `Max output: ${fmtBytes(cfg.limits.maxOutputBytes)}`
  };
  while (true) {
    const choice = await ctx.ui.select("Timeouts & output limits", [...Object.values(labels), BACK]);
    if (!choice || choice === BACK) return;
    const field = Object.entries(labels).find(([, label]) => label === choice)?.[0];
    if (!field) continue;
    if (field === "maxOutputBytes") {
      const current = String(cfg.limits.maxOutputBytes);
      const raw = await ctx.ui.input(`Enter max output in bytes (current: ${fmtBytes(cfg.limits.maxOutputBytes)})`, current);
      if (raw === undefined) continue;
      const value = parseInt(raw, 10);
      if (isNaN(value) || value < 1 || value > 100_000_000) {
        ctx.ui.notify("Must be a number between 1 and 100,000,000", "warning");
        continue;
      }
      cfg.limits.maxOutputBytes = value;
      labels[field] = `Max output: ${fmtBytes(value)}`;
    } else {
      const current = String(cfg.limits[field as keyof typeof cfg.limits]);
      const raw = await ctx.ui.input(`Enter timeout in seconds (current: ${fmtMs(cfg.limits[field as keyof typeof cfg.limits] as number)})`, String(Math.round((cfg.limits[field as keyof typeof cfg.limits] as number) / 1000)));
      if (raw === undefined) continue;
      const seconds = parseInt(raw, 10);
      if (isNaN(seconds) || seconds < 1 || seconds > 2_147_483) {
        ctx.ui.notify("Must be a number between 1 and 2,147,483 seconds", "warning");
        continue;
      }
      (cfg.limits as Record<string, unknown>)[field] = seconds * 1000;
      labels[field] = `${field === "agentTimeoutMs" ? "Agent timeout" : "Check timeout"}: ${fmtMs(seconds * 1000)}`;
    }
    ctx.ui.notify(`${field} updated`, "info");
  }
}

async function editIsolation(ctx: ExtensionCommandContext, staged: StagedConfig): Promise<void> {
  const cfg = staged.config;
  const current = cfg.limits.worktreeIsolation;
  const choice = await ctx.ui.select("Mutation workspace isolation", [
    `${current ? "✓" : " "} Verify all mutations in a git worktree before synchronization`,
    BACK
  ]);
  if (!choice || choice === BACK) return;
  cfg.limits.worktreeIsolation = !current;
  ctx.ui.notify(`Mutation isolation ${cfg.limits.worktreeIsolation ? "enabled" : "disabled"}`, "info");
}

async function editHumanReview(ctx: ExtensionCommandContext, staged: StagedConfig): Promise<void> {
  const cfg = staged.config;
  while (true) {
    const h = cfg.humanInTheLoop;
    const choices = [
      `${h.planApproval ? "✓" : " "} Review plan before approval`,
      `${h.planRevisionApproval ? "✓" : " "} Review plan revisions`,
      `${h.confirmBeforeMutation ? "✓" : " "} Confirm before entering the mutation phase`,
      BACK
    ];
    const choice = await ctx.ui.select("Human-in-the-loop review", choices);
    if (!choice || choice === BACK) return;
    if (choice.includes("Review plan before approval")) {
      cfg.humanInTheLoop.planApproval = !cfg.humanInTheLoop.planApproval;
    } else if (choice.includes("Review plan revisions")) {
      cfg.humanInTheLoop.planRevisionApproval = !cfg.humanInTheLoop.planRevisionApproval;
    } else if (choice.includes("Confirm before entering the mutation phase")) {
      cfg.humanInTheLoop.confirmBeforeMutation = !cfg.humanInTheLoop.confirmBeforeMutation;
    }
  }
}

async function editDashboard(ctx: ExtensionCommandContext, staged: StagedConfig): Promise<void> {
  const cfg = staged.config;
  while (true) {
    const d = cfg.dashboard;
    const choices = [
      `${d.enabled ? "✓" : " "} Enable dashboard`,
      `Port: ${d.port}`,
      BACK
    ];
    const choice = await ctx.ui.select("Dashboard settings", choices);
    if (!choice || choice === BACK) return;
    if (choice.includes("Enable dashboard")) {
      cfg.dashboard.enabled = !cfg.dashboard.enabled;
    } else if (choice.startsWith("Port:")) {
      const raw = await ctx.ui.input("Enter port number (0 = OS-assigned, 1024-65535 for custom)", String(d.port));
      if (raw === undefined) continue;
      const port = parseInt(raw, 10);
      if (isNaN(port) || port < 0 || port > 65_535) {
        ctx.ui.notify("Must be a number between 0 and 65535", "warning");
        continue;
      }
      cfg.dashboard.port = port;
    }
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function buildSettingsSummary(cfg: OrchestratorConfig): string {
  const h = cfg.humanInTheLoop;
  const humanReview = [h.planApproval && "plan", h.planRevisionApproval && "revisions", h.confirmBeforeMutation && "mutation"]
    .filter(Boolean)
    .join(", ") || "none";
  return [
    `Retries: plan=${cfg.limits.planRevisions} impl=${cfg.limits.implementationRetries} review=${cfg.limits.reviewRevisions}`,
    `Timeouts: agent=${fmtMs(cfg.limits.agentTimeoutMs)} · check=${fmtMs(cfg.limits.checkTimeoutMs)} · output=${fmtBytes(cfg.limits.maxOutputBytes)}`,
    `Isolation: ${cfg.limits.worktreeIsolation ? "worktree" : "off"}`,
    `Human review: ${humanReview}`,
    `Dashboard: ${cfg.dashboard.enabled ? `on (port ${cfg.dashboard.port})` : "off"}`
  ].join("\n");
}

function changedFields(cfg: OrchestratorConfig): string[] {
  // Compare against defaults — any non-default value is shown as changed
  // Since we start from loaded config and mutate in place, any mutation is a change.
  // We trust the user saved intentionally; just return a human-readable diff summary.
  const h = cfg.humanInTheLoop;
  const changes: string[] = [];
  changes.push(`Retries: ${cfg.limits.planRevisions} / ${cfg.limits.implementationRetries} / ${cfg.limits.reviewRevisions}`);
  changes.push(`Timeouts: agent=${fmtMs(cfg.limits.agentTimeoutMs)} · check=${fmtMs(cfg.limits.checkTimeoutMs)}`);
  changes.push(`Output: ${fmtBytes(cfg.limits.maxOutputBytes)}`);
  changes.push(`Worktree: ${cfg.limits.worktreeIsolation ? "on" : "off"}`);
  const humanFlags = [h.planApproval && "plan", h.planRevisionApproval && "revisions", h.confirmBeforeMutation && "mutation"].filter(Boolean).join(", ") || "none";
  changes.push(`Human review: ${humanFlags}`);
  changes.push(`Dashboard: ${cfg.dashboard.enabled ? `port ${cfg.dashboard.port}` : "off"}`);
  return changes;
}

function fmtMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds >= 3600) return `${(seconds / 3600).toFixed(1)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

function fmtBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
