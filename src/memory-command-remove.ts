import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadMemory, removeLesson } from "./memory-store.js";
import { ensureTrusted, type MemoryCommandResult, resolvePrefixed } from "./memory-command-utils.js";

export async function removeFromMemory(
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
