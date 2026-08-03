import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { OrchestratorViewModel } from "../dashboard-types.js";
import { AGENT_NAMES } from "../agent-types.js";
import { elapsedText, phaseProgress } from "./ui-model.js";
import type { AgentSessionEvent, AgentSessionView } from "./agent-session.js";

export function clearTerminal(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): void {
  if (!ctx.hasUI) return;
  ctx.ui.setStatus("pi-orchestrator", undefined);
  ctx.ui.setWidget("pi-orchestrator", undefined);
}

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

const PINNER = 76;
const PINNER_INNER = PINNER - 2;

function pad(s: string, w: number): string {
  const pw = visibleWidth(s);
  return pw >= w ? s : s + "\u00a0".repeat(w - pw);
}

export function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[.*?\]/g, "").replace(/<\/?[^>]*>/g, "").length;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 1) + "\u2026";
}

function wordWrap(text: string, width: number): string[] {
  if (width <= 0) return [text];
  const result: string[] = [];
  for (const para of text.split("\n")) {
    if (para.length === 0) { result.push(""); continue; }
    let start = 0;
    while (start < para.length) {
      let end = Math.min(start + width, para.length);
      if (end < para.length && para[end] !== " " && para[end - 1] !== " ") {
        const space = para.lastIndexOf(" ", end);
        if (space > start) end = space;
      }
      result.push(para.slice(start, end));
      start = end + (para[end] === " " ? 1 : 0);
    }
  }
  return result;
}

function addWrapped(lines: string[], prefix: string, text: string, width: number): void {
  const pw = visibleWidth(prefix);
  const wrapWidth = Math.max(1, width - pw);
  const wrapped = wordWrap(text, wrapWidth);
  const cont = " ".repeat(pw);
  for (let i = 0; i < wrapped.length; i++) {
    lines.push(`${i === 0 ? prefix : cont}${wrapped[i]}`);
  }
}

function topBorder(theme: WidgetTheme, title: string): string {
  const tw = visibleWidth(title);
  const filler = Math.max(0, PINNER - tw - 4);
  return theme.fg("borderMuted", "\u250c ") + title + theme.fg("borderMuted", " " + "\u2500".repeat(filler) + "\u2510");
}

function row(theme: WidgetTheme, content: string): string {
  const cw = visibleWidth(content);
  if (cw > PINNER_INNER) {
    content = truncate(content, PINNER_INNER + content.length - cw);
  }
  return theme.fg("borderMuted", "\u2502") + pad(content, PINNER_INNER) + theme.fg("borderMuted", "\u2502");
}

function empty(theme: WidgetTheme): string {
  return theme.fg("borderMuted", "\u2502") + " ".repeat(PINNER_INNER) + theme.fg("borderMuted", "\u2502");
}

function bottomBorder(theme: WidgetTheme): string {
  return theme.fg("borderMuted", "\u2514" + "\u2500".repeat(PINNER_INNER) + "\u2518");
}

function A(theme: WidgetTheme) { return (s: string) => theme.fg("accent", s); }
function S(theme: WidgetTheme) { return (s: string) => theme.fg("success", s); }
function E(theme: WidgetTheme) { return (s: string) => theme.fg("error", s); }
function W(theme: WidgetTheme) { return (s: string) => theme.fg("warning", s); }
function M(theme: WidgetTheme) { return (s: string) => theme.fg("muted", s); }
function D(theme: WidgetTheme) { return (s: string) => theme.fg("dim", s); }
function L(theme: WidgetTheme) { return (s: string) => theme.fg("mdLink", s); }
function BLD(theme: WidgetTheme) { return (s: string) => theme.bold(s); }

function eventSymbol(event: AgentSessionEvent, theme: WidgetTheme): string {
  switch (event.type) {
    case "assistant":
    case "structured_response":
      return M(theme)("\u25d8");
    case "tool_call": {
      switch (event.status) {
        case "running": return A(theme)("\u2192");
        case "succeeded": return S(theme)("\u2713");
        case "failed": return E(theme)("\u2717");
        default: return M(theme)("\u25cb");
      }
    }
    case "system": {
      if (event.kind === "retry") return W(theme)("\u21bb");
      if (event.kind === "agent_start" || event.kind === "agent_end") return M(theme)("\u25cb");
      return M(theme)("\u25a1");
    }
  }
}

function formatEventLine(event: AgentSessionEvent, width: number): string {
  const sym = eventSymbol(event, { fg: () => "", bold: () => "" } as WidgetTheme);
  switch (event.type) {
    case "assistant": {
      const text = event.text.replace(/\n/g, " ").trim();
      return `${sym} ${truncate(text, Math.max(1, width - 3))}`;
    }
    case "tool_call":
      return `${sym} ${event.tool}${event.args ? " " + truncate(event.args, Math.max(1, width - 4 - event.tool.length)) : ""}`;
    case "system":
      return `${sym} ${truncate(event.text, Math.max(1, width - 3))}`;
    case "structured_response":
      return `${sym} Response ready: ${event.response.agent}`;
  }
}

function renderLiveActivity(events: readonly AgentSessionEvent[], theme: WidgetTheme, maxEvents: number): string[] {
  const lines: string[] = [];
  const recent = events.slice(-maxEvents);
  if (recent.length === 0) return lines;
  lines.push(empty(theme));
  lines.push(row(theme, M(theme)("Live activity")));
  for (const ev of recent) {
    const prefix = eventSymbol(ev, theme) + " ";
    const raw = formatEventLine(ev, PINNER_INNER);
    addWrapped(lines, prefix, raw.slice(visibleWidth(prefix)), PINNER_INNER);
  }
  return lines;
}

export function renderViewModelLines(vm: OrchestratorViewModel, theme: WidgetTheme): string[] {
  const aa = (s: string) => A(theme)(s);
  const ss = (s: string) => S(theme)(s);
  const ee = (s: string) => E(theme)(s);
  const ww = (s: string) => W(theme)(s);
  const mm = (s: string) => M(theme)(s);
  const dd = (s: string) => D(theme)(s);
  const ll = (s: string) => L(theme)(s);
  const bld = (s: string) => BLD(theme)(s);

  if (vm.mode === "config_error") {
    return [
      topBorder(theme, aa("piOrchestrator")),
      row(theme, `${ww("\u26a0")} ${bld("Config error")} \u00b7 ${bld("workflow unavailable")}`),
      row(theme, mm(truncate(vm.config.message ?? "Unknown error", PINNER_INNER - 4))),
      row(theme, `Fix the config, then run ${ll("/orchestrate")} again`),
      bottomBorder(theme),
    ];
  }

  if (vm.mode === "idle") {
    const lines = [
      topBorder(theme, aa("piOrchestrator")),
      row(theme, `${aa("\u25cf")} ${bld("Idle")} \u00b7 ${dd("ready")}`),
    ];
    if (vm.config.status === "missing") {
      lines.push(row(theme, "No project configuration yet"));
      lines.push(row(theme, "Check setup is deferred until a mutation route is approved"));
      lines.push(row(theme, `Run ${ll("/orchestrate")} and select a route`));
    } else {
      lines.push(row(theme, `Project: ${aa(String(vm.config.agentCount))} agents configured \u00b7 ${aa(String(vm.config.checkCount))} checks`));
      lines.push(row(theme, `${ll("/orchestrate")} \u00b7 ${ll("/orchestrator-settings")}`));
    }
    lines.push(bottomBorder(theme));
    return lines;
  }

  const run = vm.run;
  if (!run) return [];

  const elapsed = elapsedText(run.elapsedMs);
  const title = aa(`piOrchestrator \u00b7 ${run.id.slice(0, 8)}`);
  const lines = [topBorder(theme, title)];

  if (vm.mode === "waiting") {
    const waitReason = run.waitingFor ?? "Your input";
    lines.push(row(theme, `${ww("\u23f3")} ${bld("Waiting for you")} \u00b7 ${mm(waitReason)} \u00b7 ${dd(elapsed)}`));
    lines.push(empty(theme));
    lines.push(row(theme, " The workflow needs your input to continue."));
    lines.push(row(theme, " Check the dialog that opened above."));
    lines.push(empty(theme));
    lines.push(row(theme, ` ${truncate(run.request, PINNER_INNER - 4)}`));
    if (run.dashboardUrl) lines.push(row(theme, `${mm("Dashboard")}  ${ll(truncate(run.dashboardUrl, PINNER_INNER - 14))}`));
    lines.push(row(theme, `${ll("/orchestrator-status")}`));
  } else if (vm.mode === "running") {
    const phase = phaseProgress(run.phaseIndex);
    const attemptText = run.attempt > 0 && run.phaseIndex === 5 ? ` \u00b7 attempt ${run.attempt}/${run.maxAttempts}` : "";
    lines.push(row(theme, `${aa("\u2192")} ${bld("Running")} \u00b7 ${aa(phase)}${attemptText} \u00b7 ${dd(elapsed)}`));
    lines.push(row(theme, phaseLine(vm.agents, theme)));
    const activeAgent = vm.agents.find(a => a.status === "running");
    const agentModel = activeAgent?.model ?? vm.agents.find(a => a.name === run.activeAgent)?.model ?? "";
    let toolPart = "";
    if (run.currentTool) {
      const toolArgs = run.currentToolArgs ? ` ${truncate(run.currentToolArgs, PINNER_INNER - 60)}` : "";
      const toolStatus = run.toolStatus ? ` \u00b7 ${run.toolStatus === "ok" ? ss("ok") : run.toolStatus === "error" ? ee("error") : ww("retrying")}` : "";
      toolPart = ` \u00b7 ${mm("Tool")} ${ll(run.currentTool)}${dd(toolArgs)}${toolStatus}`;
    }
    lines.push(row(theme, `${mm("Active")} ${aa(activeAgent?.name ?? run.activeAgent ?? "\u2014")} \u00b7 ${dd(agentModel)}${toolPart}`));
    lines.push(row(theme, `${mm("Request")} ${truncate(run.request, PINNER_INNER - 10)}`));
    if (run.route) lines.push(row(theme, `${mm("Route")}   ${aa(run.route)}`));
    if (run.agentOutput && run.agentOutput.length > 0) {
      const lastLine = run.agentOutput[run.agentOutput.length - 1];
      lines.push(row(theme, dd(truncate(lastLine.replace(/\n/g, "\u21b5"), PINNER_INNER - 4))));
    }
    const recent = vm.recentSteps.slice(-4);
    if (recent.length > 0) {
      const recentLine = recent.map(s =>
        `${s.status === "succeeded" ? ss("\u2713") : s.status === "running" ? aa("\u2192") : ee("!")} ${truncate(s.label, 20)}`
      ).join(` ${dd("\u00b7")} `);
      lines.push(row(theme, `${mm("Recent")}  ${truncate(recentLine, PINNER_INNER - 10)}`));
    }
    const cmds = run.dashboardUrl
      ? `${mm("Dashboard")}  ${ll(truncate(run.dashboardUrl, PINNER_INNER - 45))}`
      : `${ll("/orchestrator-status")} \u00b7 ${ll("/orchestrator-cancel")}`;
    lines.push(row(theme, cmds));
  } else {
    if (vm.mode === "paused") {
      lines.push(row(theme, `${ww("\u2161")} ${bld("Paused")} \u00b7 ${dd(elapsed)}`));
    } else if (vm.mode === "completed") {
      lines.push(row(theme, `${ss("\u2713")} ${bld("Completed")} \u00b7 ${dd(elapsed)}`));
    } else if (vm.mode === "failed") {
      lines.push(row(theme, `${ee("\u2717")} ${bld("Failed")} \u00b7 ${dd(run.stage)} \u00b7 ${dd(elapsed)}`));
    } else {
      lines.push(row(theme, `${mm("\u2298")} ${bld("Cancelled")} \u00b7 ${dd(elapsed)}`));
    }
    if (run.message) lines.push(row(theme, mm(truncate(run.message, PINNER_INNER - 4))));
    if (run.failedArtifact) {
      lines.push(row(theme, `${mm("Failed artifact")}  ${ll(pathBase(run.failedArtifact))}`));
    }
    if (run.warning) lines.push(row(theme, `${ww("\u26a0")} ${truncate(run.warning, PINNER_INNER - 5)}`));
    if (run.checkpoint && run.resumeCommand && vm.mode !== "completed") {
      lines.push(row(theme, `${mm("Checkpoint")} ${ll(run.checkpoint.cursor)} \u00b7 ${ll(run.resumeCommand)}`));
    }
    if (run.resumeBlockedReason) lines.push(row(theme, `${ww("Resume unavailable")} ${truncate(run.resumeBlockedReason, PINNER_INNER - 21)}`));
    if (run.dashboardUrl) lines.push(row(theme, `${mm("Dashboard")}  ${ll(truncate(run.dashboardUrl, PINNER_INNER - 14))}`));
    lines.push(row(theme, `${mm("Inspect")}  ${ll(`/orchestrator-inspect ${run.id.slice(0, 8)}`)}`));
    lines.push(row(theme, `${mm("New run")}   ${ll("/orchestrate")}`));
  }

  lines.push(bottomBorder(theme));
  return lines;
}

export function renderViewModelWithActivity(
  vm: OrchestratorViewModel,
  theme: WidgetTheme,
  sessionViews: Map<string, AgentSessionView>,
): string[] {
  const lines = renderViewModelLines(vm, theme);
  if (vm.mode !== "running") return lines;
  const activeAgent = vm.run?.activeAgent;
  if (!activeAgent) return lines;
  const view = sessionViews.get(activeAgent);
  if (!view || view.events.length === 0) return lines;
  const activityLines = renderLiveActivity(view.events, theme, 3);
  lines.splice(lines.length - 1, 0, ...activityLines);
  return lines;
}

export function createMissionControlWidget(
  getVM: () => OrchestratorViewModel | undefined,
  getSessionViews: () => Map<string, AgentSessionView>,
  theme: WidgetTheme,
): { render(width: number): string[]; invalidate(): void } {
  let cachedKey = "";
  let cachedLines: string[] = [];
  let cachedWidth = 0;
  return {
    render(width: number): string[] {
      const vm = getVM();
      if (!vm) return [];
      const key = `${vm.mode}-${vm.run?.id ?? ""}-${vm.run?.elapsedMs ?? 0}-${vm.run?.currentTool ?? ""}`;
      if (cachedLines.length > 0 && cachedKey === key && cachedWidth === width) return cachedLines;
      cachedKey = key;
      cachedWidth = width;
      const views = getSessionViews();
      cachedLines = renderViewModelWithActivity(vm, theme, views);
      return cachedLines;
    },
    invalidate(): void {
      cachedKey = "";
    },
  };
}

export function statusText(vm: OrchestratorViewModel, theme: WidgetTheme): string {
  const dot = (c: string, ch: string) => theme.fg(c, ch);
  if (vm.mode === "idle") return `${dot("accent", "\u25cf")} orchestrator: idle \u00b7 ready`;
  if (vm.mode === "config_error") return `${dot("warning", "\u26a0")} orchestrator: config error`;
  if (vm.mode === "waiting") return `${dot("warning", "\u23f3")} orchestrator: waiting for you \u00b7 ${vm.run?.waitingFor ?? "human input"}`;
  if (vm.mode === "paused") return `${dot("warning", "\u2161")} orchestrator: paused \u00b7 ${vm.run?.waitingFor ?? "resume available"}`;
  if (vm.run) {
    const phaseLabel = (["Setup / preflight", "Explore", "Plan", "Baseline", "Tests", "Implementation", "Review", "Finalize"] as const)[vm.run.phaseIndex] ?? vm.run.stage;
    const statusMap: Record<string, { ch: string; color: string }> = {
      running: { ch: "\u2192", color: "accent" },
      failed: { ch: "\u2717", color: "error" },
      cancelled: { ch: "\u2298", color: "muted" },
      completed: { ch: "\u2713", color: "success" },
    };
    const s = statusMap[vm.run.runStatus] ?? { ch: "?", color: "text" };
    const cmdHint = vm.run.runStatus === "running" ? ` \u00b7 /orchestrator-control` : "";
    return `${dot(s.color, s.ch)} orchestrator: ${vm.run.runStatus} \u00b7 ${phaseLabel}${vm.run.activeAgent ? ` \u00b7 ${vm.run.activeAgent}` : ""}${cmdHint}`;
  }
  return `orchestrator: ${vm.mode}`;
}

function phaseLine(agents: Array<{ name: string; status: string }>, theme: WidgetTheme): string {
  const parts = AGENT_NAMES.map(name => {
    const agent = agents.find(a => a.name === name);
    if (!agent) return "\u00b7";
    const p = agent.status;
    if (p === "succeeded") return "\u2713";
    if (p === "running") return "\u2192";
    if (p === "failed" || p === "cancelled") return "!";
    return "\u00b7";
  });
  return AGENT_NAMES.map((name, i) => {
    const sym = parts[i];
    const colored = sym === "\u2713" ? S(theme)(sym) : sym === "\u2192" ? A(theme)(sym) : sym === "!" ? E(theme)(sym) : D(theme)(sym);
    return `${D(theme)(name.slice(0, 4))}${colored}`;
  }).join(" ");
}

function pathBase(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx >= 0 ? value.slice(idx + 1) : value;
}
