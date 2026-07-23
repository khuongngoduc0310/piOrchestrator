import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { DashboardRunRepository, type HistoricalRunSummary } from "./dashboard-run-repository.js";

const MAX_RESUME_CANDIDATES = 20;
const CANCEL = "Cancel";

export async function handleResumeCommand(
  cwd: string,
  args: string,
  ctx: ExtensionCommandContext,
  resume: (runId: string) => Promise<void>
): Promise<void> {
  const parts = args.trim().split(/\s+/).filter(Boolean);

  if (parts.length > 1) {
    ctx.ui.notify("Usage: /orchestrator-resume [exact-run-id]", "warning");
    return;
  }

  if (parts.length === 1) {
    try {
      await resume(parts[0]);
    } catch (error) {
      ctx.ui.notify(`Resume failed: ${messageOf(error)}`, "error");
    }
    return;
  }

  if (!ctx.hasUI) {
    ctx.ui.notify("The resume command requires an interactive UI to browse past runs.", "error");
    return;
  }

  const repository = new DashboardRunRepository(cwd);
  let summaries: HistoricalRunSummary[];
  try {
    summaries = await repository.listRuns(100);
  } catch (error) {
    ctx.ui.notify(`Could not read workflow runs: ${messageOf(error)}`, "error");
    return;
  }

  const eligible = summaries.filter(
    s => (s.status === "failed" || s.status === "cancelled") && s.latestCheckpoint && !s.resumeBlockedReason
  );

  if (eligible.length === 0) {
    ctx.ui.notify("No resumable workflow runs found", "info");
    return;
  }

  const labels = eligible.slice(0, MAX_RESUME_CANDIDATES).map(s => {
    const checkpoint = s.latestCheckpoint!.cursor;
    const request = truncate(s.request, 50);
    return `${s.id} | ${s.status} | ${checkpoint} | ${request}`;
  });

  const selection = await ctx.ui.select("Select a run to resume", [...labels, CANCEL]);
  if (!selection || selection === CANCEL) return;

  const index = labels.indexOf(selection);
  if (index < 0) {
    ctx.ui.notify("Unexpected selection value; run not resumed.", "warning");
    return;
  }

  const chosen = eligible[index];
  const confirmed = await ctx.ui.confirm(
    "Resume run?",
    `Resume workflow run ${chosen.id}?\n\nStatus: ${chosen.status}\nCheckpoint: ${chosen.latestCheckpoint!.cursor}\nRequest: ${chosen.request}`
  );
  if (!confirmed) return;

  try {
    await resume(chosen.id);
  } catch (error) {
    ctx.ui.notify(`Resume failed: ${messageOf(error)}`, "error");
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max - 1) + "\u2026";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
