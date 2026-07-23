import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

export function clearTerminal(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("pi-orchestrator", undefined);
  ctx.ui.setWidget("pi-orchestrator", undefined);
}
