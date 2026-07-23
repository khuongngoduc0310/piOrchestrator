import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { CheckResult } from "../types.js";
import type { CandidateLesson, CandidateLedger, CandidateState } from "../memory/memory-types.js";
import { WorkflowCancelledError } from "./workflow-errors.js";

export const EXTENSION_VERSION: string = (() => {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export function allGreen(results: CheckResult[], expected: number): boolean {
  return results.length === expected && expected > 0 && results.every(result => result.passed);
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function transcriptKey(stepId: string, invocation: number): string {
  return `${stepId}:${invocation}`;
}

export function projectTrusted(ctx: ExtensionCommandContext): boolean {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

export function countCandidateStates(ledger: CandidateLedger): Record<CandidateState, number> {
  const counts: Record<CandidateState, number> = {
    proposed: 0,
    machine_approved: 0,
    machine_rejected: 0,
    duplicate: 0,
    pending: 0,
    declined: 0,
    promotion_pending: 0,
    promotion_failed: 0,
    promoted: 0
  };
  for (const candidate of ledger.candidates) counts[candidate.state]++;
  return counts;
}

export function formatCandidateForApproval(candidate: CandidateLesson): string {
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

export async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError("Workflow cancelled", "command");
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError("Workflow cancelled", "command"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
