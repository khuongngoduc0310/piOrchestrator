import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { configPath } from "./config.js";
import type { CandidateLedger, CandidateLedgerEntry } from "./memory-types.js";
import { validateMemoryId } from "./memory-validation.js";

export const CANCEL = "Cancel";
export const DEFER = "Defer";

export type MemoryCommandResult = "done" | "unavailable" | "error";

export async function listRunIds(cwd: string, ctx: ExtensionCommandContext): Promise<string[] | null> {
  const runsDir = path.join(path.dirname(configPath(cwd)), "runs");
  try {
    const ids = (await readdir(runsDir, { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && isSafeId(entry.name))
      .map(entry => entry.name)
      .sort()
      .reverse();
    if (ids.length === 0) throw new Error("empty");
    return ids;
  } catch {
    ctx.ui.notify("No workflow runs found", "info");
    return null;
  }
}

export function actionableCandidates(ledger: CandidateLedger): CandidateLedgerEntry[] {
  return ledger.candidates.filter(candidate => candidate.state === "pending" || candidate.state === "promotion_pending" || candidate.state === "promotion_failed");
}

export function ensureTrusted(ctx: ExtensionCommandContext): boolean {
  if (ctx.isProjectTrusted()) return true;
  ctx.ui.notify("Project memory is disabled because this project is not trusted", "warning");
  return false;
}

export function formatCandidateApproval(candidate: CandidateLedgerEntry): string {
  return [
    `[${candidate.id}] ${candidate.title}`,
    candidate.guidance,
    `Roles: ${candidate.scope.roles.join(", ") || "any"}`,
    `Paths: ${candidate.scope.paths.join(", ") || "none"}`,
    `Categories: ${candidate.scope.categories.join(", ") || "none"}`,
    `Keywords: ${candidate.scope.keywords.join(", ") || "none"}`,
    "Evidence:",
    ...candidate.evidence.map(item => `- ${item.path}: ${item.detail}`)
  ].join("\n");
}

export function resolvePrefixed<T>(items: T[], prefix: string, idOf: (item: T) => string): { value?: T; error?: string } {
  if (!isSafeId(prefix)) return { error: `Invalid ID: ${prefix}` };
  const exact = items.find(item => idOf(item) === prefix);
  if (exact) return { value: exact };
  const matches = items.filter(item => idOf(item).startsWith(prefix));
  if (matches.length === 0) return { error: `ID not found: ${prefix}` };
  if (matches.length > 1) return { error: `ID prefix is ambiguous: ${prefix}` };
  return { value: matches[0] };
}

function isSafeId(value: string): boolean {
  try {
    validateMemoryId(value);
    return true;
  } catch {
    return false;
  }
}
