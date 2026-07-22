import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverProjectChecks } from "./check-discovery.js";
import { configPath, saveConfig } from "./config.js";
import type { CheckDiscoveryResult, OrchestratorConfig } from "./types.js";

const APPROVE = "Approve suggested checks";
const EDIT = "Edit commands";
const CANCEL = "Cancel";

export interface CheckSetupDependencies {
  discover?: (cwd: string) => Promise<CheckDiscoveryResult>;
}

export async function ensureChecksConfigured(
  cwd: string,
  config: OrchestratorConfig,
  ctx: ExtensionCommandContext,
  dependencies: CheckSetupDependencies = {}
): Promise<OrchestratorConfig | undefined> {
  if (config.checks.length > 0) return config;
  const file = configPath(cwd);
  if (!ctx.hasUI) {
    ctx.ui.notify(`No project checks are configured. Edit ${file} before running the workflow.`, "error");
    return undefined;
  }

  const discovery = await (dependencies.discover ?? discoverProjectChecks)(cwd);
  const proposed = discovery.commands;
  while (true) {
    const choices = proposed.length > 0 ? [APPROVE, EDIT, CANCEL] : [EDIT, CANCEL];
    const action = await ctx.ui.select(buildTitle(cwd, discovery), choices);
    if (!action || action === CANCEL) {
      ctx.ui.notify(`Check setup cancelled. ${file} still has no configured checks.`, "warning");
      return undefined;
    }

    let checks: string[];
    if (action === APPROVE) {
      checks = [...proposed];
    } else {
      const edited = await ctx.ui.editor("Edit project checks (one command per line)", proposed.join("\n"));
      if (edited === undefined) {
        ctx.ui.notify(`Check setup cancelled. ${file} still has no configured checks.`, "warning");
        return undefined;
      }
      checks = normalizeCommands(edited);
      if (checks.length === 0) {
        ctx.ui.notify("Enter at least one check command or choose Cancel.", "warning");
        continue;
      }
    }

    const updated = structuredClone(config);
    updated.checks = checks;
    await saveConfig(cwd, updated);
    ctx.ui.notify(`Saved ${checks.length} approved project check${checks.length === 1 ? "" : "s"} to ${file}`, "info");
    return updated;
  }
}

function buildTitle(cwd: string, discovery: CheckDiscoveryResult): string {
  const manager = discovery.packageManager ? `Package manager: ${discovery.packageManager}` : "No package manager selected";
  const commands = discovery.commands.length > 0
    ? discovery.commands.map(command => `  ${command}`).join("\n")
    : "  No safe checks were discovered; choose Edit commands to enter them manually.";
  const diagnostics = discovery.diagnostics.length > 0
    ? `\n\nNotes:\n${discovery.diagnostics.map(item => `  ${item}`).join("\n")}`
    : "";
  return `Configure project checks for ${cwd}\n${manager}\n\nProposed commands:\n${commands}${diagnostics}`;
}

export function normalizeCommands(value: string): string[] {
  const commands = value.split(/\r?\n/).map(command => command.trim()).filter(Boolean);
  return [...new Set(commands)];
}
