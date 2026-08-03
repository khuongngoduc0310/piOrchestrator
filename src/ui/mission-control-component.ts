import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentName } from "../agent-types.js";
import type { OrchestratorViewModel } from "../dashboard-types.js";
import { AGENT_NAMES } from "../agent-types.js";
import { elapsedText, phaseProgress } from "./ui-model.js";
import type { AgentSessionEvent, AgentSessionView } from "./agent-session.js";
import { renderInspectorScreen } from "./agent-session-inspector.js";
import type { InspectorOptions } from "./agent-session-inspector.js";

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface MissionControlDeps {
  getVM: () => OrchestratorViewModel | undefined;
  getAgentNames: () => string[];
  getAgentView: (agent: AgentName) => AgentSessionView | undefined;
}

type Screen = { mode: "dashboard" } | { mode: "inspector" };

interface State {
  screen: Screen;
  selectedAgent: AgentName | null;
  followFromBottom: number;
  expandedTools: boolean;
  manualSelection: boolean;
}

export function createMissionControlComponent(
  tui: { requestRender(): void },
  theme: WidgetTheme,
  done: (result: void) => void,
  deps: MissionControlDeps,
  initialAgent: AgentName | null,
  onAgentChange: (agent: AgentName | null) => void,
  initialScreen: Screen = { mode: "dashboard" },
): { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose(): void } {
  const st: State = {
    screen: initialScreen,
    selectedAgent: initialAgent,
    followFromBottom: 0,
    expandedTools: false,
    manualSelection: initialAgent !== null,
  };

  function invalidate(): void {
    tui.requestRender();
  }

  function ensureSelectedAgent(): void {
    if (!st.selectedAgent) {
      const vm = deps.getVM();
      if (vm) {
        const running = vm.agents.find(a => a.status === "running");
        st.selectedAgent = running?.name ?? vm.agents[0]?.name ?? null;
      }
    }
  }

  function followAgentChange(): void {
    if (st.manualSelection) return;
    const vm = deps.getVM();
    if (!vm) return;
    const running = vm.agents.find(a => a.status === "running");
    if (running && running.name !== st.selectedAgent) {
      st.selectedAgent = running.name;
    }
  }

  function cycleAgent(direction: 1 | -1): void {
    const names = getAgentNames();
    if (names.length === 0) return;
    const currentIdx = st.selectedAgent ? names.indexOf(st.selectedAgent) : -1;
    const nextIdx = ((currentIdx + direction) % names.length + names.length) % names.length;
    const next = names[nextIdx];
    st.selectedAgent = next;
    st.followFromBottom = 0;
    st.manualSelection = true;
    onAgentChange(next);
    invalidate();
  }

  function scrollUp(amount: number): void {
    st.followFromBottom += amount;
    invalidate();
  }

  function scrollDown(amount: number): void {
    st.followFromBottom = Math.max(0, st.followFromBottom - amount);
    invalidate();
  }

  function getAgentNames(): AgentName[] {
    const vm = deps.getVM();
    if (!vm) return deps.getAgentNames() as AgentName[];
    return AGENT_NAMES.filter(n => vm.agents.some(a => a.name === n) || deps.getAgentNames().includes(n));
  }

  function agentStatusChar(status: string): string {
    switch (status) {
      case "running": return "\u2192";
      case "succeeded": return "\u2713";
      case "failed": return "\u2717";
      case "cancelled": return "\u2298";
      default: return "\u25cb";
    }
  }

  function agentStatusColor(status: string, th: WidgetTheme): string {
    switch (status) {
      case "running": return th.fg("accent", "\u2192");
      case "succeeded": return th.fg("success", "\u2713");
      case "failed": return th.fg("error", "\u2717");
      case "cancelled": return th.fg("muted", "\u2298");
      default: return th.fg("dim", "\u25cb");
    }
  }

  // ── rendering ──

  function renderDashboard(width: number): string[] {
    const inner = Math.max(10, width - 2);

    function bn(s: string) { return theme.fg("borderMuted", s); }
    function aa(s: string) { return theme.fg("accent", s); }
    function ss(s: string) { return theme.fg("success", s); }
    function ee(s: string) { return theme.fg("error", s); }
    function ww(s: string) { return theme.fg("warning", s); }
    function mm(s: string) { return theme.fg("muted", s); }
    function dd(s: string) { return theme.fg("dim", s); }
    function ll(s: string) { return theme.fg("mdLink", s); }
    function bld(s: string) { return theme.bold(s); }

    function top(s: string): string {
      const tw = visibleWidth(s);
      return bn("\u250c ") + s + bn(" " + "\u2500".repeat(Math.max(0, width - tw - 4)) + "\u2510");
    }
    function row(s: string): string {
      const cw = visibleWidth(s);
      return bn("\u2502") + (cw > inner ? truncate(s, inner + s.length - cw) : s) + " ".repeat(Math.max(0, inner - cw)) + bn("\u2502");
    }
    function blank(): string { return bn("\u2502") + " ".repeat(inner) + bn("\u2502"); }
    function bot(): string { return bn("\u2514" + "\u2500".repeat(inner) + "\u2518"); }

    const lines: string[] = [];
    const vm = deps.getVM();
    const title = aa(`piOrchestrator \u00b7 ${vm?.run?.id?.slice(0, 8) ?? "\u2014"}`);
    lines.push(top(title));

    if (!vm || !vm.run) {
      lines.push(row(mm("No active workflow")));
      lines.push(bot());
      return lines;
    }

    const run = vm.run;
    const elapsed = elapsedText(run.elapsedMs);

    if (vm.mode === "waiting") {
      lines.push(row(`${ww("\u23f3")} ${bld("Waiting for you")} \u00b7 ${mm(run.waitingFor ?? "Your input")} \u00b7 ${dd(elapsed)}`));
      lines.push(blank());
      lines.push(row(` ${truncate(run.request, inner - 4)}`));
      lines.push(bot());
      return lines;
    }

    if (vm.mode === "running") {
      const phase = phaseProgress(run.phaseIndex);
      const attemptText = run.attempt > 0 && run.phaseIndex === 5 ? ` \u00b7 attempt ${run.attempt}/${run.maxAttempts}` : "";
      lines.push(row(`${aa("\u2192")} ${bld("Running")} \u00b7 ${aa(phase)}${attemptText} \u00b7 ${dd(elapsed)}`));

      // Agent phase line
      lines.push(row(phaseLine(vm.agents, theme)));

      // Active agent
      const activeAgent = vm.agents.find(a => a.status === "running");
      const agentModel = activeAgent?.model ?? vm.agents.find(a => a.name === run.activeAgent)?.model ?? "";
      let toolPart = "";
      if (run.currentTool) {
        const toolArgs = run.currentToolArgs ? ` ${truncate(run.currentToolArgs, inner - 60)}` : "";
        const toolStatus = run.toolStatus ? ` \u00b7 ${run.toolStatus === "ok" ? ss("ok") : run.toolStatus === "error" ? ee("error") : ww("retrying")}` : "";
        toolPart = ` \u00b7 ${mm("Tool")} ${ll(run.currentTool)}${dd(toolArgs)}${toolStatus}`;
      }
      lines.push(row(`${mm("Active")} ${aa(activeAgent?.name ?? run.activeAgent ?? "\u2014")} \u00b7 ${dd(agentModel)}${toolPart}`));

      // Selected agent (distinct from active)
      followAgentChange();
      ensureSelectedAgent();
      if (st.selectedAgent) {
        const selVM = vm.agents.find(a => a.name === st.selectedAgent);
        const selStatus = selVM?.status ?? "idle";
        const selModel = selVM?.model ? ` \u00b7 ${dd(selVM.model)}` : "";
        const selIsActive = st.selectedAgent === (activeAgent?.name ?? run.activeAgent);
        const statusStr = selIsActive ? `${aa("\u2192")} ${mm("active")}` : `${agentStatusColor(selStatus, theme)} ${mm(selStatus)}`;
        lines.push(row(`${mm("Selected")} ${aa(st.selectedAgent)} ${statusStr}${selModel}`));
      }

      // Compact agent selector bar
      const selBar = vm.agents.map(a => {
        const bracket = a.name === st.selectedAgent ? "[" : " ";
        const close = a.name === st.selectedAgent ? "]" : " ";
        const ch = agentStatusChar(a.status);
        const colored = aa(ch);
        return `${aa(bracket)}${a.name.slice(0, 4)}${colored}${aa(close)}`;
      }).join(" ");
      lines.push(row(mm(truncate(selBar, inner - 4))));

      // Request + route
      lines.push(row(`${mm("Request")} ${truncate(run.request, inner - 10)}`));
      if (run.route) lines.push(row(`${mm("Route")}   ${aa(run.route)}`));

      // Last agent output
      if (run.agentOutput && run.agentOutput.length > 0) {
        lines.push(row(dd(truncate(run.agentOutput[run.agentOutput.length - 1].replace(/\n/g, "\u21b5"), inner - 4))));
      }

      // Recent steps
      const recent = vm.recentSteps.slice(-4);
      if (recent.length > 0) {
        const recentLine = recent.map(s =>
          `${s.status === "succeeded" ? ss("\u2713") : s.status === "running" ? aa("\u2192") : ee("!")} ${truncate(s.label, 20)}`
        ).join(` ${dd("\u00b7")} `);
        lines.push(row(`${mm("Recent")}  ${truncate(recentLine, inner - 10)}`));
      }

      // Live activity section
      if (st.selectedAgent) {
        const view = deps.getAgentView(st.selectedAgent);
        if (view && view.events.length > 0) {
          lines.push(blank());
          lines.push(row(mm("Live activity")));
          for (const ev of view.events.slice(-3)) {
            const evLine = formatActivityEvent(ev, theme);
            lines.push(row(dd(truncate(evLine, inner - 4))));
          }
        }
      }

      // Controls
      const inspectName = st.selectedAgent ? ` ${aa(st.selectedAgent)}` : "";
      lines.push(blank());
      lines.push(row(mm(`\u23ce Inspect${inspectName}  Tab/Shift+Tab Select  Esc Close`)));
    } else {
      lines.push(row(modeLabel(vm.mode, theme, elapsed, vm)));
      if (run.message) lines.push(row(mm(truncate(run.message, inner - 4))));
      if (run.failedArtifact) lines.push(row(`${mm("Failed artifact")}  ${ll(pathBase(run.failedArtifact))}`));
      if (run.warning) lines.push(row(`${ww("\u26a0")} ${truncate(run.warning, inner - 5)}`));
      if (run.dashboardUrl) lines.push(row(`${mm("Dashboard")}  ${ll(truncate(run.dashboardUrl, inner - 14))}`));
      lines.push(blank());
      lines.push(row(mm("Esc Close")));
    }

    lines.push(bot());
    return lines;
  }

  // ── render entry ──

  function render(width: number): string[] {
    if (st.screen.mode === "dashboard") {
      return renderDashboard(width);
    }
    if (st.screen.mode === "inspector" && st.selectedAgent) {
      const view = deps.getAgentView(st.selectedAgent);
      const names = getAgentNames();
      const opts: InspectorOptions = {
        agent: st.selectedAgent,
        followFromBottom: st.followFromBottom,
        expandedTools: st.expandedTools,
      };
      const th = theme as { fg(color: string, text: string): string; bold(text: string): string };
      return renderInspectorScreen(width, view, opts, names as string[], th);
    }
    return renderDashboard(width);
  }

  // ── input ──

  function handleInput(data: string): void {
    if (st.screen.mode === "dashboard") {
      if (matchesKey(data, Key.escape)) {
        done(undefined);
        return;
      }
      if (matchesKey(data, Key.enter)) {
        ensureSelectedAgent();
        if (st.selectedAgent) {
          st.screen = { mode: "inspector" };
          invalidate();
        }
        return;
      }
      if (matchesKey(data, Key.tab)) {
        cycleAgent(1);
        return;
      }
      if (matchesKey(data, Key.shift("tab"))) {
        cycleAgent(-1);
        return;
      }
      return;
    }

    // inspector screen
    if (matchesKey(data, Key.escape)) {
      st.screen = { mode: "dashboard" };
      invalidate();
      return;
    }
    if (matchesKey(data, Key.tab)) {
      cycleAgent(1);
      return;
    }
    if (matchesKey(data, Key.shift("tab"))) {
      cycleAgent(-1);
      return;
    }
    if (matchesKey(data, Key.up)) {
      scrollUp(1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      scrollDown(1);
      return;
    }
    if (matchesKey(data, Key.pageUp)) {
      scrollUp(10);
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.enter)) {
      scrollDown(10);
      return;
    }
    if (data === "f" || data === "F") {
      st.followFromBottom = 0;
      invalidate();
      return;
    }
    if (data === "t" || data === "T") {
      st.expandedTools = !st.expandedTools;
      invalidate();
      return;
    }
  }

  function dispose(): void {
    // nothing to dispose
  }

  return { render, handleInput, invalidate, dispose };
}

// ── shared helpers ──

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 1) + "\u2026";
}

function pathBase(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

function formatActivityEvent(event: AgentSessionEvent, _theme: WidgetTheme): string {
  switch (event.type) {
    case "assistant": return `\u25d8 ${event.text.replace(/\n/g, " ").trim()}`;
    case "tool_call": return `\u2192 ${event.tool}${event.args ? " " + event.args : ""}`;
    case "system": return `\u25a1 ${event.text}`;
    case "structured_response": return `\u25d8 Response ready: ${event.response.agent}`;
    default: return "";
  }
}

function modeLabel(mode: string, theme: WidgetTheme, elapsed: string, vm: OrchestratorViewModel): string {
  const ss = (s: string) => theme.fg("success", s);
  const ee = (s: string) => theme.fg("error", s);
  const ww = (s: string) => theme.fg("warning", s);
  const mm = (s: string) => theme.fg("muted", s);
  const bld = (s: string) => theme.bold(s);
  const run = vm.run;
  if (!run) return `${mm(mode)}`;
  switch (mode) {
    case "completed": return `${ss("\u2713")} ${bld("Completed")} \u00b7 ${mm(elapsed)}`;
    case "failed": return `${ee("\u2717")} ${bld("Failed")} \u00b7 ${mm(run.stage)} \u00b7 ${mm(elapsed)}`;
    case "cancelled": return `${mm("\u2298")} ${bld("Cancelled")} \u00b7 ${mm(elapsed)}`;
    case "paused": return `${ww("\u2161")} ${bld("Paused")} \u00b7 ${mm(elapsed)}`;
    default: return `${mm(mode)}`;
  }
}

function phaseLine(agents: Array<{ name: string; status: string }>, theme: WidgetTheme): string {
  const ss = (s: string) => theme.fg("success", s);
  const aa = (s: string) => theme.fg("accent", s);
  const ee = (s: string) => theme.fg("error", s);
  const dd = (s: string) => theme.fg("dim", s);
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
    const colored = sym === "\u2713" ? ss(sym) : sym === "\u2192" ? aa(sym) : sym === "!" ? ee(sym) : dd(sym);
    return `${dd(name.slice(0, 4))}${colored}`;
  }).join(" ");
}
