import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { discoverProjectChecks, discoverWorktreeSetupCandidates, readPackageScripts } from "./check-discovery.js";
import { configPath, saveConfig } from "../config/config.js";
import type { CheckDiscoveryResult, OrchestratorConfig } from "../config-types.js";
import type { CheckResult } from "../workflow-types.js";

const APPROVE = "Approve suggested checks";
const EDIT = "Edit commands";
const USE_ANYWAY = "Use anyway";
const CANCEL = "Cancel";
const APPROVE_WORKTREE_SETUP = "Approve suggested worktree setup";
const EDIT_WORKTREE_SETUP = "Edit setup commands";
const MANUAL_WORKTREE_SETUP = "Use manual worktree setup";

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

    const confirmed = await confirmCheckScripts(cwd, checks, ctx, file);
    if (confirmed === undefined) return undefined;
    if (confirmed.length === 0) continue;
    checks = confirmed;

    const updated = structuredClone(config);
    updated.checks = checks;
    await saveConfig(cwd, updated);
    ctx.ui.notify(`Saved ${checks.length} approved project check${checks.length === 1 ? "" : "s"} to ${file}`, "info");
    return updated;
  }
}

/** Prompt once for lockfile-backed dependency setup commands used only in isolated worktrees. */
export async function ensureWorktreeSetupConfigured(
  cwd: string,
  config: OrchestratorConfig,
  ctx: ExtensionCommandContext,
  dependencies: CheckSetupDependencies = {}
): Promise<OrchestratorConfig> {
  if (!config.limits.worktreeIsolation || config.worktreeSetup.mode !== "prompt" || !ctx.hasUI) return config;

  const discovery = await (dependencies.discover ?? discoverProjectChecks)(cwd);
  const verified = await discoverWorktreeSetupCandidates(cwd);
  const agentEvidence = new Map((discovery.worktreeSetupCandidates ?? []).map(candidate => [candidate.command, candidate.evidence]));
  const candidates = verified.map(candidate => ({ ...candidate, evidence: agentEvidence.get(candidate.command) ?? candidate.evidence }));
  const suggestedCommands = candidates.map(candidate => candidate.command);

  while (true) {
    const details = candidates.length > 0
      ? candidates.map(candidate => `  ${candidate.command}  (${candidate.evidence})`).join("\n")
      : "  No lockfile-backed setup commands were found.";
    const choices = [
      ...(suggestedCommands.length > 0 ? [APPROVE_WORKTREE_SETUP] : []),
      EDIT_WORKTREE_SETUP,
      MANUAL_WORKTREE_SETUP,
      CANCEL
    ];
    const choice = await ctx.ui.select(
      `Configure isolated worktree dependency setup for ${cwd}\n\nSuggested commands:\n${details}\n\nCommands run only after mutation approval, inside an isolated worktree.`,
      choices
    );
    if (!choice || choice === CANCEL) return config;
    if (choice === MANUAL_WORKTREE_SETUP) return saveWorktreeSetup(cwd, config, "manual", []);
    if (choice === APPROVE_WORKTREE_SETUP) return saveWorktreeSetup(cwd, config, "commands", suggestedCommands);

    const edited = await ctx.ui.editor("Edit isolated worktree setup commands (one command per line)", suggestedCommands.join("\n"));
    if (edited === undefined) continue;
    const commands = normalizeCommands(edited);
    if (commands.length === 0) {
      ctx.ui.notify("Enter at least one setup command or choose manual setup.", "warning");
      continue;
    }
    return saveWorktreeSetup(cwd, config, "commands", commands);
  }
}

async function saveWorktreeSetup(
  cwd: string,
  config: OrchestratorConfig,
  mode: OrchestratorConfig["worktreeSetup"]["mode"],
  commands: string[]
): Promise<OrchestratorConfig> {
  const updated = structuredClone(config);
  updated.worktreeSetup = { mode, commands };
  await saveConfig(cwd, updated);
  return updated;
}

/** Re-prompt until every script-backed check exists in package.json, the user overrides, or setup is cancelled. */
async function confirmCheckScripts(
  cwd: string,
  checks: string[],
  ctx: ExtensionCommandContext,
  file: string
): Promise<string[] | undefined> {
  let current = checks;
  while (true) {
    const invalid = await missingScripts(cwd, current);
    if (invalid.length === 0) return current;
    const fix = await ctx.ui.select(
      `These configured check commands reference scripts missing from package.json:\n${invalid.map(command => `  ${command}`).join("\n")}\n\nChoose how to proceed.`,
      [EDIT, USE_ANYWAY, CANCEL]
    );
    if (!fix || fix === CANCEL) {
      ctx.ui.notify(`Check setup cancelled. ${file} still has no configured checks.`, "warning");
      return undefined;
    }
    if (fix === USE_ANYWAY) return current;
    const edited = await ctx.ui.editor("Edit project checks (one command per line)", current.join("\n"));
    if (edited === undefined) {
      ctx.ui.notify(`Check setup cancelled. ${file} still has no configured checks.`, "warning");
      return undefined;
    }
    current = normalizeCommands(edited);
    if (current.length === 0) ctx.ui.notify("Enter at least one check command or choose Cancel.", "warning");
  }
}

/**
 * Offer to replace baseline check commands that reference scripts missing from package.json with
 * existing same-family scripts (e.g. `npm run build` -> `npm run build:desktop`). Returns the
 * updated config when applied, undefined otherwise. Deterministic and non-durable; the caller
 * re-runs the baseline and persists a fresh checkpoint when a repair is applied.
 */
export async function suggestCheckConfigRepair(
  cwd: string,
  config: OrchestratorConfig,
  baseline: CheckResult[],
  ctx: ExtensionCommandContext
): Promise<OrchestratorConfig | undefined> {
  if (!ctx.hasUI) return undefined;
  const scripts = await readPackageScripts(cwd);
  const scriptNames = new Set(Object.keys(scripts));
  if (scriptNames.size === 0) return undefined;

  const options: Array<{ command: string; replacement: string }> = [];
  for (const result of baseline) {
    if (result.passed) continue;
    const script = scriptOf(result.command);
    if (script === undefined || scriptNames.has(script)) continue;
    for (const candidate of Object.keys(scripts)) {
      if (!candidate.startsWith(`${script}:`)) continue;
      const replacement = replacementFor(result.command, script, candidate);
      if (replacement) options.push({ command: result.command, replacement });
    }
  }
  if (options.length === 0) return undefined;

  const file = configPath(cwd);
  const labels = options.slice(0, 8).map(({ command, replacement }) => `Replace \`${command}\` with \`${replacement}\``);
  const choice = await ctx.ui.select(
    `Configured baseline check commands reference scripts missing from package.json:\n${[...new Set(options.map(option => `  ${option.command}`))].join("\n")}\n\nReplace them with existing scripts, edit commands manually, or leave them for automated diagnosis.`,
    [...labels, EDIT, CANCEL]
  );
  if (!choice || choice === CANCEL) return undefined;

  if (choice === EDIT) {
    const edited = await ctx.ui.editor("Edit project checks (one command per line)", config.checks.join("\n"));
    if (edited === undefined) return undefined;
    const checks = normalizeCommands(edited);
    if (checks.length === 0) {
      ctx.ui.notify("Enter at least one check command or choose Cancel.", "warning");
      return undefined;
    }
    const stillInvalid = await missingScripts(cwd, checks);
    if (stillInvalid.length > 0) {
      ctx.ui.notify(`Still missing from package.json: ${stillInvalid.join(", ")}`, "warning");
    }
    const updated = structuredClone(config);
    updated.checks = checks;
    await saveConfig(cwd, updated);
    ctx.ui.notify(`Saved ${checks.length} project check${checks.length === 1 ? "" : "s"} to ${file}`, "info");
    return updated;
  }

  const selected = options[labels.indexOf(choice)];
  if (!selected) return undefined;
  const updated = structuredClone(config);
  updated.checks = config.checks.map(command => (command === selected.command ? selected.replacement : command));
  await saveConfig(cwd, updated);
  ctx.ui.notify(`Replaced \`${selected.command}\` with \`${selected.replacement}\` in ${file}`, "info");
  return updated;
}

/** Extract the package.json script name from common package-manager check commands; null for anything else. */
function scriptOf(command: string): string | undefined {
  const run = /^(?:npm|pnpm|bun) run (\S+)$/.exec(command);
  if (run) return run[1];
  if (/^npm test$/.test(command)) return "test";
  const yarn = /^yarn (?:run )?(\S+)$/.exec(command);
  if (yarn) return yarn[1];
  return undefined;
}

function replacementFor(command: string, script: string, candidate: string): string | undefined {
  const run = /^(npm|pnpm|bun) run (\S+)$/.exec(command);
  if (run && run[2] === script) return `${run[1]} run ${candidate}`;
  if (/^npm test$/.test(command) && script === "test") return `npm run ${candidate}`;
  const yarn = /^yarn (?:run )?(\S+)$/.exec(command);
  if (yarn && yarn[1] === script) return `yarn ${candidate}`;
  return undefined;
}

/** Script-backed checks whose script is absent from package.json; empty when no manifest exists to validate against. */
async function missingScripts(cwd: string, checks: string[]): Promise<string[]> {
  const scripts = await readPackageScripts(cwd);
  if (Object.keys(scripts).length === 0) return [];
  const names = new Set(Object.keys(scripts));
  return checks.filter(check => {
    const script = scriptOf(check);
    return script !== undefined && !names.has(script);
  });
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
