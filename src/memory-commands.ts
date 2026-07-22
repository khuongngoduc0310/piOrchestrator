import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { approvePending, declinePending, showPending } from "./memory-command-candidates.js";
import { inspectMemory } from "./memory-command-inspect.js";
import { removeFromMemory } from "./memory-command-remove.js";
import type { MemoryCommandResult } from "./memory-command-utils.js";

export type { MemoryCommandResult } from "./memory-command-utils.js";

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
