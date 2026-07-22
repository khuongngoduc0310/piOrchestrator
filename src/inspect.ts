import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configPath } from "./config.js";

export type InspectResult = "done" | "unavailable";

const BACK = "Back";
const CANCEL = "Cancel";

/**
 * Inspect previous runs and agent outputs.
 *
 * /orchestrator-inspect            → list runs
 * /orchestrator-inspect <run-id>   → show run steps
 * /orchestrator-inspect <run-id> <step> → show agent output
 */
export async function inspectRun(
  cwd: string,
  args: string,
  ctx: ExtensionCommandContext
): Promise<InspectResult> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Inspect command requires a UI", "error");
    return "unavailable";
  }

  const runsDir = path.join(path.dirname(configPath(cwd)), "runs");
  let runDirs: string[];
  try {
    runDirs = (await readdir(runsDir, { withFileTypes: true }))
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name)
      .sort()
      .reverse();
  } catch {
    ctx.ui.notify("No workflow runs found", "info");
    return "unavailable";
  }

  if (runDirs.length === 0) {
    ctx.ui.notify("No workflow runs found", "info");
    return "unavailable";
  }

  const parts = args.split(/\s+/).filter(Boolean);
  const runArg = parts[0];
  const stepArg = parts.slice(1).join(" ");

  // If a run ID is provided, show that run directly
  if (runArg) {
    const match = runDirs.find(dir => dir.startsWith(runArg));
    if (!match) {
      ctx.ui.notify(`No run found matching "${runArg}"`, "warning");
      return "unavailable";
    }
    return inspectRunSteps(cwd, match, stepArg, ctx);
  }

  // Otherwise, list runs interactively
  return listRuns(cwd, runDirs, ctx);
}

async function listRuns(cwd: string, runDirs: string[], ctx: ExtensionCommandContext): Promise<InspectResult> {
  const choices = runDirs.slice(0, 20).map(dir => {
    const runDir = path.join(path.dirname(configPath(cwd)), "runs", dir);
    // Try to read state.json for the request text
    return { dir, label: dir, runDir };
  });

  // Build labels with request text
  const labels = await Promise.all(choices.map(async ({ dir, runDir }) => {
    try {
      const stateText = await readFile(path.join(runDir, "state.json"), "utf8");
      const state = JSON.parse(stateText);
      const request = state.request ? ` — ${truncate(String(state.request), 50)}` : "";
      return `${dir}${request}`;
    } catch {
      return dir;
    }
  }));

  const selection = await ctx.ui.select("Select a run to inspect", [...labels, CANCEL]);
  if (!selection || selection === CANCEL) return "unavailable";

  const index = labels.indexOf(selection);
  if (index < 0) return "unavailable";
  return inspectRunSteps(cwd, choices[index].dir, "", ctx);
}

async function inspectRunSteps(cwd: string, runId: string, stepFilter: string, ctx: ExtensionCommandContext): Promise<InspectResult> {
  const runDir = path.join(path.dirname(configPath(cwd)), "runs", runId);

  let stateText: string;
  try {
    stateText = await readFile(path.join(runDir, "state.json"), "utf8");
  } catch {
    ctx.ui.notify(`Could not read state for run ${runId}`, "error");
    return "unavailable";
  }

  const state = JSON.parse(stateText);
  const steps = state.steps ?? [];

  if (stepFilter) {
    // Show a specific step
    return showStepOutput(runDir, steps, stepFilter, ctx);
  }

  // List steps
  const stepLabels = steps.map((step: any, index: number) => {
    const status = step.status === "succeeded" ? "✓" : step.status === "failed" ? "!" : step.status === "cancelled" ? "⊘" : step.status === "running" ? "→" : "·";
    const cancellation = step.status === "cancelled" && step.message ? ` — ${truncate(String(step.message), 60)}` : "";
    return `${status} ${step.label}${step.agent ? ` (${step.agent})` : ""}${cancellation}${step.artifact ? ` [output]` : ""}${step.rawArtifact ? ` [raw]` : ""}`;
  });

  if (stepLabels.length === 0) {
    ctx.ui.notify("No steps in this run", "info");
    return "unavailable";
  }

  const selection = await ctx.ui.select(`Run ${runId} — select a step to inspect`, [...stepLabels, BACK, CANCEL]);
  if (!selection || selection === CANCEL || selection === BACK) return "unavailable";

  const stepIndex = stepLabels.indexOf(selection);
  if (stepIndex < 0) return "unavailable";

  return showStepOutput(runDir, steps, steps[stepIndex].id ?? String(stepIndex), ctx);
}

async function showStepOutput(
  runDir: string,
  steps: any[],
  stepIdOrLabel: string,
  ctx: ExtensionCommandContext
): Promise<InspectResult> {
  const step = steps.find((s: any) => s.id === stepIdOrLabel || s.label === stepIdOrLabel);
  if (!step) {
    ctx.ui.notify(`Step not found: ${stepIdOrLabel}`, "warning");
    return "unavailable";
  }

  const artifactFile = step.artifact ?? step.rawArtifact;
  if (!artifactFile) {
    if (step.status === "cancelled") {
      const reason = step.message ? `: ${step.message}` : "";
      ctx.ui.notify(`Step cancelled: ${step.label}${reason}`, "info");
      return "done";
    }
    ctx.ui.notify(`No output artifact for step: ${step.label}`, "info");
    return "unavailable";
  }

  try {
    const content = await readFile(path.join(runDir, artifactFile), "utf8");
    const title = `${step.label} (${step.status}) — ${artifactFile}`;
    await ctx.ui.editor(title, content);
    return "done";
  } catch (error) {
    ctx.ui.notify(`Could not read artifact: ${messageOf(error)}`, "error");
    return "unavailable";
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "…";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
