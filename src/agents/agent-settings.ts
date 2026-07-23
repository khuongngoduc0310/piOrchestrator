import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import {
  AGENT_NAMES,
  THINKING_LEVELS,
  type AgentModelSelection,
  type AgentModelUpdates,
  type AgentName,
  type OrchestratorConfig,
  type ThinkingLevel
} from "../types.js";

type RegistryModel = ReturnType<ExtensionCommandContext["modelRegistry"]["getAvailable"]>[number];

export interface AvailableModelOption {
  reference: string;
  label: string;
  model: RegistryModel;
}

export interface AgentSettingsDependencies {
  isRunning: () => boolean;
  save: (cwd: string, updates: AgentModelUpdates) => Promise<OrchestratorConfig>;
}

export type AgentSettingsResult = "saved" | "unchanged" | "cancelled" | "unavailable";

const SAVE = "Save changes";
const CANCEL = "Cancel";
const MODEL_DEFAULT = "Use model default";

export async function configureAgentModels(
  cwd: string,
  ctx: ExtensionCommandContext,
  dependencies: AgentSettingsDependencies
): Promise<AgentSettingsResult> {
  if (!ctx.hasUI) {
    ctx.ui.notify("/orchestrator-settings requires TUI or RPC mode", "error");
    return "unavailable";
  }
  if (dependencies.isRunning()) {
    ctx.ui.notify("Agent settings cannot be changed while a workflow is running", "error");
    return "unavailable";
  }

  try {
    await ctx.modelRegistry.refresh();
  } catch (error) {
    ctx.ui.notify(`Could not refresh Pi models: ${messageOf(error)}`, "error");
    return "unavailable";
  }
  const registryError = ctx.modelRegistry.getError();
  if (registryError) {
    ctx.ui.notify(`Could not load Pi models: ${registryError}`, "error");
    return "unavailable";
  }
  const catalog = buildAvailableModelCatalog(ctx.modelRegistry.getAvailable());
  if (catalog.length === 0) {
    ctx.ui.notify("No authenticated Pi models are available. Configure a provider with /login or /model first.", "error");
    return "unavailable";
  }

  const config = await loadConfig(cwd);
  const initial = selectionsFrom(config);
  const staged = structuredClone(initial);
  const modelChoices = new Map(catalog.map(option => [option.label, option]));

  while (true) {
    const roleChoices = new Map<string, AgentName>();
    const choices = AGENT_NAMES.map(agent => {
      const selection = staged[agent];
      const changed = sameSelection(selection, initial[agent]) ? "" : " · changed";
      const label = `${agent} — ${selection.model} · ${selection.thinking ?? "default"}${changed}`;
      roleChoices.set(label, agent);
      return label;
    });
    choices.push(SAVE, CANCEL);

    const action = await ctx.ui.select("Orchestrator agent model settings", choices);
    if (!action || action === CANCEL) {
      ctx.ui.notify("Agent model settings were not changed", "info");
      return "cancelled";
    }
    if (action === SAVE) {
      const updates = changedSelections(initial, staged);
      if (Object.keys(updates).length === 0) {
        ctx.ui.notify("Agent model settings are already up to date", "info");
        return "unchanged";
      }
      const confirmed = await ctx.ui.confirm("Save agent model settings?", reviewSummary(initial, updates));
      if (!confirmed) continue;
      try {
        await dependencies.save(cwd, updates);
        ctx.ui.notify(`Saved model settings for ${Object.keys(updates).length} agent${Object.keys(updates).length === 1 ? "" : "s"}`, "info");
        return "saved";
      } catch (error) {
        ctx.ui.notify(`Agent settings were not saved: ${messageOf(error)}`, "error");
        continue;
      }
    }

    const agent = roleChoices.get(action);
    if (!agent) continue;
    const selectedLabel = await ctx.ui.select(`Choose a model for ${agent}`, catalog.map(option => option.label));
    if (!selectedLabel) continue;
    const selectedModel = modelChoices.get(selectedLabel);
    if (!selectedModel) continue;
    const supportedThinking = supportedThinkingLevels(selectedModel.model);
    const thinkingChoice = await ctx.ui.select(
      `Choose thinking for ${agent} (${selectedModel.reference})`,
      [MODEL_DEFAULT, ...supportedThinking]
    );
    if (!thinkingChoice) continue;
    staged[agent] = {
      model: selectedModel.reference,
      ...(thinkingChoice === MODEL_DEFAULT ? {} : { thinking: thinkingChoice as ThinkingLevel })
    };
  }
}

export function buildAvailableModelCatalog(models: readonly RegistryModel[]): AvailableModelOption[] {
  const unique = new Map<string, AvailableModelOption>();
  for (const model of models) {
    const reference = `${model.provider}/${model.id}`;
    if (!unique.has(reference)) {
      unique.set(reference, {
        reference,
        label: model.name && model.name !== model.id ? `${reference} — ${model.name}` : reference,
        model
      });
    }
  }
  return [...unique.values()].sort((left, right) => compare(left.reference, right.reference));
}

export function supportedThinkingLevels(model: RegistryModel): ThinkingLevel[] {
  if (!model.reasoning) return ["off"];
  const map = model.thinkingLevelMap as Partial<Record<ThinkingLevel, string | null>> | undefined;
  return THINKING_LEVELS.filter(level => {
    if (map?.[level] === null) return false;
    if (level === "xhigh" || level === "max") return typeof map?.[level] === "string";
    return true;
  });
}

function selectionsFrom(config: OrchestratorConfig): Record<AgentName, AgentModelSelection> {
  return Object.fromEntries(AGENT_NAMES.map(agent => [agent, {
    model: config.agents[agent].model,
    ...(config.agents[agent].thinking === undefined ? {} : { thinking: config.agents[agent].thinking })
  }])) as Record<AgentName, AgentModelSelection>;
}

function changedSelections(
  initial: Record<AgentName, AgentModelSelection>,
  staged: Record<AgentName, AgentModelSelection>
): AgentModelUpdates {
  const updates: AgentModelUpdates = {};
  for (const agent of AGENT_NAMES) {
    if (!sameSelection(initial[agent], staged[agent])) updates[agent] = staged[agent];
  }
  return updates;
}

function sameSelection(left: AgentModelSelection, right: AgentModelSelection): boolean {
  return left.model === right.model && left.thinking === right.thinking;
}

function reviewSummary(initial: Record<AgentName, AgentModelSelection>, updates: AgentModelUpdates): string {
  return AGENT_NAMES.flatMap(agent => {
    const next = updates[agent];
    if (!next) return [];
    const before = `${initial[agent].model} · ${initial[agent].thinking ?? "default"}`;
    const after = `${next.model} · ${next.thinking ?? "default"}`;
    return [`${agent}:\n  ${before}\n  → ${after}`];
  }).join("\n\n");
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
