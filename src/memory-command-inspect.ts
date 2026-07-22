import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadMemory } from "./memory-store.js";
import type { MemoryDocument, MemoryLesson } from "./memory-types.js";
import { CANCEL, type MemoryCommandResult, resolvePrefixed } from "./memory-command-utils.js";

export async function inspectMemory(cwd: string, lessonPrefix: string | undefined, ctx: ExtensionCommandContext): Promise<MemoryCommandResult> {
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
