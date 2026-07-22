import { readdir } from "node:fs/promises";
import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadCandidateLedger, saveCandidateLedger, setCandidateState } from "./candidate-store.js";
import { configPath } from "./config.js";
import { loadMemory, promoteLessons, removeLesson } from "./memory-store.js";
import { permanentLessonId, validateMemoryId, validateNewLesson } from "./memory-validation.js";
import type { CandidateLedger, CandidateLedgerEntry, MemoryDocument, MemoryLesson, PromotionResult } from "./memory-types.js";

const CANCEL = "Cancel";
const DEFER = "Defer";

export type MemoryCommandResult = "done" | "unavailable" | "error";

export async function handleMemoryCommand(
  args: string,
  cwd: string,
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  if (!ctx.isProjectTrusted()) {
    ctx.ui.notify("Project memory is disabled because this project is not trusted", "warning");
    return "unavailable";
  }

  const parts = args.trim().split(/\s+/).filter(Boolean);
  const subcommand = parts[0]?.toLowerCase();
  const rest = parts.slice(1);
  switch (subcommand) {
    case "inspect":
      return inspectMemory(cwd, rest[0], ctx);
    case "pending":
      return showPending(cwd, rest[0], ctx, isWorkflowActive);
    case "approve":
      return approvePending(cwd, rest, ctx, isWorkflowActive);
    case "decline":
      return declinePending(cwd, rest, ctx, isWorkflowActive);
    case "remove":
      return removeFromMemory(cwd, rest, ctx, isWorkflowActive);
    default:
      ctx.ui.notify(
        "Usage: /orchestrator-memory inspect [id] | pending [run-id] | approve <run-id> <candidate-id> | decline <run-id> <candidate-id> | remove <id>",
        "warning"
      );
      return "done";
  }
}

async function inspectMemory(cwd: string, lessonPrefix: string | undefined, ctx: ExtensionCommandContext): Promise<MemoryCommandResult> {
  const { document, error } = await loadMemory(cwd);
  if (error) {
    ctx.ui.notify(`Memory unavailable: ${error}`, "error");
    return "unavailable";
  }
  if (!document || document.lessons.length === 0) {
    ctx.ui.notify("No lessons in project memory", "info");
    return "done";
  }
  if (lessonPrefix) {
    const lesson = resolvePrefixed(document.lessons, lessonPrefix, item => item.id);
    if (lesson.error) {
      ctx.ui.notify(lesson.error, "warning");
      return "unavailable";
    }
    const content = formatLessonDetail(lesson.value!);
    if (ctx.hasUI) await ctx.ui.editor(`Memory lesson: ${lesson.value!.id}`, content);
    else ctx.ui.notify(content.slice(0, 5000), "info");
    return "done";
  }
  const summary = formatMemorySummary(document);
  if (!ctx.hasUI) {
    ctx.ui.notify(summary.slice(0, 5000), "info");
    return "done";
  }
  const choices = document.lessons.map(lesson => `${lesson.id} - ${lesson.title}`);
  const selection = await ctx.ui.select(`Project memory (${document.lessons.length} lessons)`, [...choices, CANCEL]);
  if (!selection || selection === CANCEL) return "done";
  const selected = document.lessons.find(lesson => `${lesson.id} - ${lesson.title}` === selection);
  if (selected) await ctx.ui.editor(`Memory lesson: ${selected.id}`, formatLessonDetail(selected));
  return "done";
}

async function showPending(
  cwd: string,
  requestedRunId: string | undefined,
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  const runIds = await listRunIds(cwd, ctx);
  if (!runIds) return "unavailable";
  let runId = requestedRunId;
  if (!runId) {
    const choices = runIds.slice(0, 20);
    if (!ctx.hasUI) {
      ctx.ui.notify(`Runs:\n${choices.map((id, index) => `${index + 1}. ${id}`).join("\n")}`, "info");
      return "done";
    }
    const selection = await ctx.ui.select("Select a run to view pending candidates", [...choices, CANCEL]);
    if (!selection || selection === CANCEL) return "done";
    runId = selection;
  }
  const resolved = resolvePrefixed(runIds, runId, id => id);
  if (resolved.error) {
    ctx.ui.notify(resolved.error.replace("ID", "Run"), "warning");
    return "unavailable";
  }
  const loaded = await loadCandidateLedger(cwd, resolved.value!);
  if (loaded.error) {
    ctx.ui.notify(loaded.error, "error");
    return "unavailable";
  }
  if (!loaded.ledger) {
    ctx.ui.notify(`No candidate ledger in run ${resolved.value}`, "info");
    return "unavailable";
  }
  const candidates = actionableCandidates(loaded.ledger);
  if (candidates.length === 0) {
    ctx.ui.notify("No pending candidates", "info");
    return "done";
  }
  const summary = `Run ${resolved.value}\n${candidates.length} candidate(s) awaiting a decision\n\n${candidates
    .map((candidate, index) => `${index + 1}. [${candidate.id}] ${candidate.title} (${candidate.state})`)
    .join("\n")}`;
  if (!ctx.hasUI) {
    ctx.ui.notify(summary, "info");
    return "done";
  }
  const choice = await ctx.ui.select(summary, [
    "Approve all",
    ...candidates.map(candidate => `Approve: ${candidate.id} - ${candidate.title}`),
    ...candidates.map(candidate => `Decline: ${candidate.id} - ${candidate.title}`),
    DEFER,
  ]);
  if (!choice || choice === DEFER) return "done";
  if (choice === "Approve all") return promoteCandidates(cwd, loaded.ledger, candidates, ctx, isWorkflowActive);
  const approve = choice.startsWith("Approve: ");
  const decline = choice.startsWith("Decline: ");
  if (!approve && !decline) return "done";
  const id = choice.slice(choice.indexOf(":") + 1).split(" - ")[0].trim();
  const candidate = candidates.find(item => item.id === id);
  if (!candidate) return "unavailable";
  return approve
    ? promoteCandidates(cwd, loaded.ledger, [candidate], ctx, isWorkflowActive)
    : declineCandidates(cwd, loaded.ledger, [candidate], ctx, isWorkflowActive);
}

async function approvePending(
  cwd: string,
  args: string[],
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Approve requires TUI or RPC mode", "error");
    return "unavailable";
  }
  if (args.length !== 2) {
    ctx.ui.notify("Usage: /orchestrator-memory approve <run-id> <candidate-id>", "warning");
    return "unavailable";
  }
  const resolved = await resolveLedgerCandidate(cwd, args[0], args[1], ctx);
  if (!resolved) return "unavailable";
  return promoteCandidates(cwd, resolved.ledger, [resolved.candidate], ctx, isWorkflowActive);
}

async function declinePending(
  cwd: string,
  args: string[],
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Decline requires TUI or RPC mode", "error");
    return "unavailable";
  }
  if (args.length !== 2) {
    ctx.ui.notify("Usage: /orchestrator-memory decline <run-id> <candidate-id>", "warning");
    return "unavailable";
  }
  const resolved = await resolveLedgerCandidate(cwd, args[0], args[1], ctx);
  if (!resolved) return "unavailable";
  return declineCandidates(cwd, resolved.ledger, [resolved.candidate], ctx, isWorkflowActive);
}

async function resolveLedgerCandidate(
  cwd: string,
  runPrefix: string,
  candidatePrefix: string,
  ctx: ExtensionCommandContext
): Promise<{ ledger: CandidateLedger; candidate: CandidateLedgerEntry } | null> {
  const runIds = await listRunIds(cwd, ctx);
  if (!runIds) return null;
  const run = resolvePrefixed(runIds, runPrefix, id => id);
  if (run.error) {
    ctx.ui.notify(run.error.replace("ID", "Run"), "warning");
    return null;
  }
  const loaded = await loadCandidateLedger(cwd, run.value!);
  if (loaded.error || !loaded.ledger) {
    ctx.ui.notify(loaded.error ?? `No candidate ledger in run ${run.value}`, loaded.error ? "error" : "info");
    return null;
  }
  const candidate = resolvePrefixed(actionableCandidates(loaded.ledger), candidatePrefix, item => item.id);
  if (candidate.error) {
    ctx.ui.notify(candidate.error.replace("ID", "Candidate"), "warning");
    return null;
  }
  return { ledger: loaded.ledger, candidate: candidate.value! };
}

async function promoteCandidates(
  cwd: string,
  ledger: CandidateLedger,
  candidates: CandidateLedgerEntry[],
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  if (isWorkflowActive()) {
    ctx.ui.notify("Cannot promote while a workflow is active", "warning");
    return "unavailable";
  }
  const confirmed = await ctx.ui.confirm(
    `Promote ${candidates.length} lesson(s) to project memory?`,
    `These will be available to future orchestrations.\n\n${candidates.map(formatCandidateApproval).join("\n\n")}`
  );
  if (!confirmed) return "done";
  if (!ensureTrusted(ctx)) return "unavailable";

  const latest = await loadCandidateLedger(cwd, ledger.runId);
  if (latest.error || !latest.ledger) {
    ctx.ui.notify(latest.error ?? "Candidate ledger disappeared", "error");
    return "unavailable";
  }

  const loadedMemory = await loadMemory(cwd);
  if (loadedMemory.error) {
    ctx.ui.notify(`Memory unavailable: ${loadedMemory.error}`, "error");
    return "unavailable";
  }
  let updated = latest.ledger;
  const requestedIds = new Set(candidates.map(candidate => candidate.id));
  const actionable: CandidateLedgerEntry[] = [];
  for (const id of requestedIds) {
    let candidate = updated.candidates.find(item => item.id === id);
    if (!candidate) continue;
    if (candidate.state === "promotion_pending") {
      const alreadyPromoted = loadedMemory.document?.lessons.some(lesson =>
        lesson.provenance.sourceRunId === updated.runId && lesson.provenance.candidateId === candidate!.id
      );
      updated = setCandidateState(updated, candidate.id, alreadyPromoted ? "promoted" : "pending", alreadyPromoted ? "reconciled completed promotion" : "retrying interrupted promotion");
      candidate = updated.candidates.find(item => item.id === id);
    }
    if (candidate && (candidate.state === "pending" || candidate.state === "promotion_failed")) actionable.push(candidate);
  }
  if (actionable.length === 0) {
    updated = await saveCandidateLedger(cwd, updated);
    ctx.ui.notify("Selected candidates were already resolved", "info");
    return "done";
  }
  const now = new Date().toISOString();
  for (const candidate of actionable) {
    updated = setCandidateState(updated, candidate.id, "promotion_pending", "human approved", now);
  }
  if (!ensureTrusted(ctx)) return "unavailable";
  updated = await saveCandidateLedger(cwd, updated);

  const lessons = actionable.map(candidate => validateNewLesson(
    permanentLessonId(updated.runId, candidate.id),
    candidate.title,
    candidate.guidance,
    candidate.scope,
    candidate.evidence,
    {
      sourceRunId: updated.runId,
      candidateId: candidate.id,
      finalChecksDigest: updated.finalChecksDigest,
      approvedAt: now,
      extensionVersion: updated.extensionVersion,
    }
  ));
  let result: PromotionResult;
  try {
    result = await promoteLessons(cwd, lessons, loadedMemory.document?.revision ?? 0);
  } catch (error) {
    for (const candidate of actionable) {
      updated = setCandidateState(updated, candidate.id, "promotion_failed", error instanceof Error ? error.message : String(error));
    }
    updated = await saveCandidateLedger(cwd, updated);
    ctx.ui.notify(`Promotion failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return "error";
  }
  const afterMemory = await loadMemory(cwd);
  for (const candidate of actionable) {
    const lessonId = permanentLessonId(updated.runId, candidate.id);
    const ownedLesson = afterMemory.document?.lessons.some(lesson =>
      lesson.provenance.sourceRunId === updated.runId && lesson.provenance.candidateId === candidate.id
    );
    let state: "pending" | "promotion_failed" | "duplicate" | "promoted";
    let reason: string;
    if (ownedLesson || result.promoted.includes(lessonId)) {
      state = "promoted";
      reason = "promotion completed";
    } else if (result.retryable) {
      state = "pending";
      reason = "promotion deferred by revision conflict";
    } else if (result.error || result.failed.some(item => item.candidateId === candidate.id)) {
      state = "promotion_failed";
      reason = result.error ?? "promotion failed validation";
    } else {
      state = "duplicate";
      reason = "content already exists in memory";
    }
    updated = setCandidateState(updated, candidate.id, state, reason);
  }
  updated = await saveCandidateLedger(cwd, updated);

  if (result.error && !result.retryable) {
    ctx.ui.notify(`Promotion failed: ${result.error}`, "error");
    return "error";
  }
  if (result.retryable) {
    ctx.ui.notify(`Promotion deferred: ${result.error ?? "stale revision"}. Reload and try again.`, "warning");
    return "unavailable";
  }
  const parts = [
    result.promoted.length ? `${result.promoted.length} promoted` : "",
    result.duplicates.length ? `${result.duplicates.length} duplicates skipped` : "",
    result.failed.length ? `${result.failed.length} failed` : "",
  ].filter(Boolean);
  ctx.ui.notify(`Memory: ${parts.join(", ") || "no changes"}`, result.promoted.length ? "info" : "warning");
  return "done";
}

async function declineCandidates(
  cwd: string,
  ledger: CandidateLedger,
  candidates: CandidateLedgerEntry[],
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  if (isWorkflowActive()) {
    ctx.ui.notify("Cannot decline lessons while a workflow is active", "warning");
    return "unavailable";
  }
  const confirmed = await ctx.ui.confirm(
    `Decline ${candidates.length} lesson candidate(s)?`,
    "Declined candidates remain recorded in the run ledger but cannot be promoted later."
  );
  if (!confirmed) return "done";
  if (!ensureTrusted(ctx)) return "unavailable";
  const latest = await loadCandidateLedger(cwd, ledger.runId);
  if (latest.error || !latest.ledger) {
    ctx.ui.notify(latest.error ?? "Candidate ledger disappeared", "error");
    return "unavailable";
  }
  let updated = latest.ledger;
  for (const requested of candidates) {
    const candidate = updated.candidates.find(item => item.id === requested.id);
    if (candidate && (candidate.state === "pending" || candidate.state === "promotion_failed")) {
      updated = setCandidateState(updated, candidate.id, "declined", "human declined");
    }
  }
  updated = await saveCandidateLedger(cwd, updated);
  ctx.ui.notify(`${candidates.length} candidate(s) declined`, "info");
  return "done";
}

async function removeFromMemory(
  cwd: string,
  args: string[],
  ctx: ExtensionCommandContext,
  isWorkflowActive: () => boolean
): Promise<MemoryCommandResult> {
  if (!ctx.hasUI) {
    ctx.ui.notify("Remove requires TUI or RPC mode", "error");
    return "unavailable";
  }
  if (isWorkflowActive()) {
    ctx.ui.notify("Cannot remove lessons while a workflow is active", "warning");
    return "unavailable";
  }
  if (args.length !== 1) {
    ctx.ui.notify("Usage: /orchestrator-memory remove <lesson-id>", "warning");
    return "unavailable";
  }
  const loaded = await loadMemory(cwd);
  if (loaded.error || !loaded.document) {
    ctx.ui.notify(loaded.error ? `Memory unavailable: ${loaded.error}` : "No memory document found", loaded.error ? "error" : "info");
    return "unavailable";
  }
  const lesson = resolvePrefixed(loaded.document.lessons, args[0], item => item.id);
  if (lesson.error) {
    ctx.ui.notify(lesson.error.replace("ID", "Lesson"), "warning");
    return "unavailable";
  }
  const confirmed = await ctx.ui.confirm(
    `Remove lesson "${lesson.value!.title}"?`,
    `Guidance: ${lesson.value!.guidance.slice(0, 200)}`
  );
  if (!confirmed) return "done";
  if (!ensureTrusted(ctx)) return "unavailable";
  const result = await removeLesson(cwd, lesson.value!.id, loaded.document.revision);
  ctx.ui.notify(result.removed ? `Lesson ${lesson.value!.id} removed` : `Remove failed: ${result.error ?? "unknown"}`, result.removed ? "info" : "error");
  return "done";
}

async function listRunIds(cwd: string, ctx: ExtensionCommandContext): Promise<string[] | null> {
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

function actionableCandidates(ledger: CandidateLedger): CandidateLedgerEntry[] {
  return ledger.candidates.filter(candidate => candidate.state === "pending" || candidate.state === "promotion_pending" || candidate.state === "promotion_failed");
}

function ensureTrusted(ctx: ExtensionCommandContext): boolean {
  if (ctx.isProjectTrusted()) return true;
  ctx.ui.notify("Project memory is disabled because this project is not trusted", "warning");
  return false;
}

function formatCandidateApproval(candidate: CandidateLedgerEntry): string {
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

function resolvePrefixed<T>(items: T[], prefix: string, idOf: (item: T) => string): { value?: T; error?: string } {
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

function formatLessonDetail(lesson: MemoryLesson): string {
  const lines = [
    `ID: ${lesson.id}`,
    `Content digest: ${lesson.contentDigest}`,
    `Title: ${lesson.title}`,
    `\nGuidance:\n${lesson.guidance}\n`,
    "Scope:",
    `  Roles: ${lesson.scope.roles.join(", ") || "(any)"}`,
    `  Paths: ${lesson.scope.paths.join(", ") || "(none)"}`,
    `  Categories: ${lesson.scope.categories.join(", ") || "(none)"}`,
    `  Keywords: ${lesson.scope.keywords.join(", ") || "(none)"}`,
  ];
  if (lesson.evidence.length) {
    lines.push(`\nEvidence (${lesson.evidence.length}):`);
    for (const evidence of lesson.evidence) lines.push(`  ${evidence.path}: ${evidence.detail}`);
  }
  lines.push("\nProvenance:", `  Source run: ${lesson.provenance.sourceRunId}`, `  Approved: ${lesson.provenance.approvedAt}`, `\nCreated: ${lesson.createdAt}`);
  return lines.join("\n");
}

function formatMemorySummary(document: MemoryDocument): string {
  return [
    `Project memory (${document.lessons.length} lessons, revision ${document.revision})`,
    "",
    ...document.lessons.map(lesson => `  ${lesson.id} - ${lesson.title} [${lesson.scope.roles.join(",") || "any"}]`),
  ].join("\n");
}
