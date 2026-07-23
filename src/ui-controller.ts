import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { inspectConfig } from "./config.js";
import { buildIdleViewModel, buildRunViewModel, elapsedText, phaseProgress } from "./ui-model.js";
import type {
  OrchestratorConfig,
  OrchestratorViewModel,
  WorkflowState
} from "./types.js";
import { AGENT_NAMES } from "./types.js";

const BOX = 76;
const INNER = BOX - 2;

export interface WidgetTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

export interface UiControllerDependencies {
  isRunning: () => boolean;
  elapsedMs: () => number;
}

export class UiController {
  private viewModel?: OrchestratorViewModel;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly deps: UiControllerDependencies) {}

  async attach(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): Promise<void> {
    if (!ctx.hasUI) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (ctx as any).cwd ?? process.cwd();
    const config = await inspectConfig(cwd);
    this.viewModel = buildIdleViewModel(cwd, config);
    this.publish(ctx);
  }

  publish(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): void {
    if (!ctx.hasUI || !this.viewModel) return;
    const vm = this.viewModel;
    const theme = ctx.ui.theme as WidgetTheme;
    ctx.ui.setWidget("pi-orchestrator", renderViewModelLines(vm, theme));
    ctx.ui.setStatus("pi-orchestrator", statusText(vm, theme));
  }

  async refreshConfig(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): Promise<void> {
    if (!ctx.hasUI) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (ctx as any).cwd ?? process.cwd();
    const config = await inspectConfig(cwd);
    const old = this.viewModel;
    if (old && old.mode === "idle") {
      this.viewModel = buildIdleViewModel(cwd, config);
      this.publish(ctx);
    }
  }

  /** Single entry point for all run-state changes (running, completed, failed, cancelled). */
  updateRun(
    state: WorkflowState,
    config: OrchestratorConfig,
    ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">
  ): void {
    if (!ctx.hasUI) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (ctx as any).cwd ?? process.cwd();
    const configSummary = {
      status: "valid" as const,
      agentCount: AGENT_NAMES.length,
      checkCount: config.checks.length
    };
    const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
    const wasRunning = this.viewModel?.mode === "running" || this.viewModel?.mode === "waiting";
    this.viewModel = buildRunViewModel(state, configSummary, cwd, this.deps.elapsedMs(), maxAttempts);
    this.publish(ctx);
    if (state.status === "running") {
      if (!wasRunning) this.startTimer(ctx);
    } else {
      this.stopTimer();
    }
  }

  detach(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): void {
    this.stopTimer();
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("pi-orchestrator", undefined);
    ctx.ui.setWidget("pi-orchestrator", undefined);
    this.viewModel = undefined;
  }

  private startTimer(ctx: Pick<ExtensionCommandContext, "hasUI" | "ui">): void {
    if (this.timer) return;
    const theme = ctx.ui.theme as WidgetTheme;
    this.timer = setInterval(() => {
      if (this.viewModel?.run) {
        this.viewModel.run.elapsedMs = this.deps.elapsedMs();
        ctx.ui.setWidget("pi-orchestrator", renderViewModelLines(this.viewModel, theme));
      }
    }, 1_000);
    if (this.timer && typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as NodeJS.Timeout).unref();
    }
  }

  private stopTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
}

export function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").replace(/\[.*?\]/g, "").replace(/<\/?[^>]*>/g, "").length;
}

function pad(s: string, w: number): string {
  const padLen = w - visibleWidth(s);
  return s + " ".repeat(Math.max(0, padLen));
}

function topBorder(theme: WidgetTheme, title: string): string {
  const tw = visibleWidth(title);
  const filler = Math.max(0, BOX - tw - 4);
  return theme.fg("borderMuted", "┌ ") + title + theme.fg("borderMuted", " " + "─".repeat(filler) + "┐");
}

function row(theme: WidgetTheme, content: string): string {
  const cw = visibleWidth(content);
  if (cw > INNER) {
    content = truncate(content, INNER + content.length - cw);
  }
  return theme.fg("borderMuted", "│") + pad(content, INNER) + theme.fg("borderMuted", "│");
}

function empty(theme: WidgetTheme): string {
  return theme.fg("borderMuted", "│") + " ".repeat(INNER) + theme.fg("borderMuted", "│");
}

function bottomBorder(theme: WidgetTheme): string {
  return theme.fg("borderMuted", "└" + "─".repeat(INNER) + "┘");
}

export function statusText(vm: OrchestratorViewModel, theme: WidgetTheme): string {
  const dot = (c: string, ch: string) => theme.fg(c, ch);
  if (vm.mode === "idle") return `${dot("accent", "●")} orchestrator: idle · ready`;
  if (vm.mode === "config_error") return `${dot("warning", "⚠")} orchestrator: config error`;
  if (vm.mode === "waiting") return `${dot("warning", "⏳")} orchestrator: waiting for you · ${vm.run?.waitingFor ?? "human input"}`;
  if (vm.run) {
    const phase = UI_PHASE_LABELS[vm.run.phaseIndex] ?? vm.run.stage;
    const statusMap: Record<string, { ch: string; color: string }> = {
      running: { ch: "→", color: "accent" },
      failed: { ch: "✗", color: "error" },
      cancelled: { ch: "⊘", color: "muted" },
      completed: { ch: "✓", color: "success" },
    };
    const s = statusMap[vm.run.runStatus] ?? { ch: "?", color: "text" };
    return `${dot(s.color, s.ch)} orchestrator: ${vm.run.runStatus} · ${phase}${vm.run.activeAgent ? ` · ${vm.run.activeAgent}` : ""}`;
  }
  return `orchestrator: ${vm.mode}`;
}

const C = {
  border: (t: WidgetTheme) => (s: string) => t.fg("borderMuted", s),
  accent: (t: WidgetTheme) => (s: string) => t.fg("accent", s),
  success: (t: WidgetTheme) => (s: string) => t.fg("success", s),
  error: (t: WidgetTheme) => (s: string) => t.fg("error", s),
  warning: (t: WidgetTheme) => (s: string) => t.fg("warning", s),
  muted: (t: WidgetTheme) => (s: string) => t.fg("muted", s),
  dim: (t: WidgetTheme) => (s: string) => t.fg("dim", s),
  link: (t: WidgetTheme) => (s: string) => t.fg("mdLink", s),
  b: (t: WidgetTheme) => (s: string) => t.bold(s),
};

export function renderViewModelLines(vm: OrchestratorViewModel, theme: WidgetTheme): string[] {
  const B = (s: string) => C.border(theme)(s);
  const A = (s: string) => C.accent(theme)(s);
  const S = (s: string) => C.success(theme)(s);
  const E = (s: string) => C.error(theme)(s);
  const W = (s: string) => C.warning(theme)(s);
  const M = (s: string) => C.muted(theme)(s);
  const D = (s: string) => C.dim(theme)(s);
  const L = (s: string) => C.link(theme)(s);
  const BLD = (s: string) => C.b(theme)(s);

  if (vm.mode === "config_error") {
    return [
      topBorder(theme, A("piOrchestrator")),
      row(theme, `${W("⚠")} ${BLD("Config error")} · ${BLD("workflow unavailable")}`),
      row(theme, M(truncate(vm.config.message ?? "Unknown error", INNER - 4))),
      row(theme, `Fix the config, then run ${L("/orchestrate")} again`),
      bottomBorder(theme),
    ];
  }

  if (vm.mode === "idle") {
    const lines = [
      topBorder(theme, A("piOrchestrator")),
      row(theme, `${A("●")} ${BLD("Idle")} · ${D("ready")}`),
    ];
    if (vm.config.status === "missing") {
      lines.push(row(theme, "Project checks are not configured"));
      lines.push(row(theme, `Run ${L("/orchestrate")} <request> to begin setup`));
    } else {
      lines.push(row(theme, `Project: ${A(String(vm.config.agentCount))} agents configured · ${A(String(vm.config.checkCount))} checks`));
      lines.push(row(theme, `${L("/orchestrate")} <request> · ${L("/orchestrator-settings")}`));
    }
    lines.push(bottomBorder(theme));
    return lines;
  }

  const run = vm.run;
  if (!run) return [];

  const elapsed = elapsedText(run.elapsedMs);
  const title = A(`piOrchestrator · ${run.id.slice(0, 8)}`);
  const lines = [topBorder(theme, title)];

  if (vm.mode === "waiting") {
    const waitReason = run.waitingFor ?? "Your input";
    lines.push(row(theme, `${W("⏳")} ${BLD("Waiting for you")} · ${M(waitReason)} · ${D(elapsed)}`));
    lines.push(empty(theme));
    lines.push(row(theme, " The workflow needs your input to continue."));
    lines.push(row(theme, " Check the dialog that opened above."));
    lines.push(empty(theme));
    lines.push(row(theme, ` ${truncate(run.request, INNER - 4)}`));
    if (run.dashboardUrl) lines.push(row(theme, `${M("Dashboard")}  ${L(truncate(run.dashboardUrl, INNER - 14))}`));
    lines.push(row(theme, `${L("/orchestrator-status")}`));
  } else if (vm.mode === "running") {
    const phase = phaseProgress(run.phaseIndex);
    const attemptText = run.attempt > 0 ? ` · attempt ${run.attempt}/${run.maxAttempts}` : "";
    lines.push(row(theme, `${A("→")} ${BLD("Running")} · ${A(phase)}${attemptText} · ${D(elapsed)}`));
    lines.push(row(theme, phaseLine(vm.agents, theme)));
    const activeAgent = vm.agents.find(a => a.status === "running");
    const agentModel = activeAgent?.model ?? vm.agents.find(a => a.name === run.activeAgent)?.model ?? "";
    let toolPart = "";
    if (run.currentTool) {
      const toolArgs = run.currentToolArgs ? ` ${truncate(run.currentToolArgs, INNER - 60)}` : "";
      const toolStatus = run.toolStatus ? ` · ${run.toolStatus === "ok" ? S("ok") : run.toolStatus === "error" ? E("error") : W("retrying")}` : "";
      toolPart = ` · ${M("Tool")} ${L(run.currentTool)}${D(toolArgs)}${toolStatus}`;
    }
    lines.push(row(theme, `${M("Active")} ${A(activeAgent?.name ?? run.activeAgent ?? "—")} · ${D(agentModel)}${toolPart}`));
    if (run.agentOutput && run.agentOutput.length > 0) {
      const lastLine = run.agentOutput[run.agentOutput.length - 1];
      lines.push(row(theme, D(truncate(lastLine.replace(/\n/g, "↵"), INNER - 4))));
    }
    lines.push(row(theme, `${M("Request")} ${truncate(run.request, INNER - 10)}`));
    if (run.route) lines.push(row(theme, `${M("Route")}   ${A(run.route)}`));
    const recent = vm.recentSteps.slice(-4);
    if (recent.length > 0) {
      const recentLine = recent.map(s =>
        `${s.status === "succeeded" ? S("✓") : s.status === "running" ? A("→") : E("!")} ${truncate(s.label, 20)}`
      ).join(` ${D("·")} `);
      lines.push(row(theme, `${M("Recent")}  ${truncate(recentLine, INNER - 10)}`));
    }
    const cmds = run.dashboardUrl
      ? `${M("Dashboard")}  ${L(truncate(run.dashboardUrl, INNER - 45))}`
      : `${L("/orchestrator-status")} · ${L("/orchestrator-cancel")}`;
    lines.push(row(theme, cmds));
  } else {
    if (vm.mode === "completed") {
      lines.push(row(theme, `${S("✓")} ${BLD("Completed")} · ${D(elapsed)}`));
    } else if (vm.mode === "failed") {
      const stageSuffix = run.stage !== "completed" ? ` · ${run.stage}` : "";
      lines.push(row(theme, `${E("✗")} ${BLD("Failed")}${D(stageSuffix)} · ${D(elapsed)}`));
    } else {
      lines.push(row(theme, `${M("⊘")} ${BLD("Cancelled")} · ${D(elapsed)}`));
    }
    if (run.message) lines.push(row(theme, M(truncate(run.message, INNER - 4))));
    if (run.failedArtifact) {
      lines.push(row(theme, `${M("Failed artifact")}  ${L(pathBase(run.failedArtifact))}`));
    }
    if (vm.mode === "completed" && vm.config.checkCount > 0) {
      lines.push(row(theme, `${A(String(vm.config.checkCount))}/${A(String(vm.config.checkCount))} ${S("checks passed")} · ${S("workflow completed")}`));
    }
    if (run.warning) lines.push(row(theme, `${W("⚠")} ${truncate(run.warning, INNER - 5)}`));
    if (run.checkpoint && run.resumeCommand && vm.mode !== "completed") {
      lines.push(row(theme, `${M("Checkpoint")} ${L(run.checkpoint.cursor)} · ${L(run.resumeCommand)}`));
    }
    if (run.resumeBlockedReason) lines.push(row(theme, `${W("Resume unavailable")} ${truncate(run.resumeBlockedReason, INNER - 21)}`));
    if (run.dashboardUrl) lines.push(row(theme, `${M("Dashboard")}  ${L(truncate(run.dashboardUrl, INNER - 14))}`));
    lines.push(row(theme, `${M("Inspect")}  ${L(`/orchestrator-inspect ${run.id.slice(0, 8)}`)}`));
    lines.push(row(theme, `${M("New run")}   ${L("/orchestrate")} <request>`));
  }

  lines.push(bottomBorder(theme));
  return lines;
}

function phaseLine(agents: Array<{ name: string; status: string }>, theme: WidgetTheme): string {
  const parts = AGENT_NAMES.map(name => {
    const agent = agents.find(a => a.name === name);
    if (!agent) return "·";
    const p = agent.status;
    if (p === "succeeded") return C.success(theme)("✓");
    if (p === "running") return C.accent(theme)("→");
    if (p === "failed" || p === "cancelled") return C.error(theme)("!");
    return C.dim(theme)("·");
  });
  return AGENT_NAMES.map((name, i) => `${C.dim(theme)(name.slice(0, 4))}${parts[i]}`).join(" ");
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  if (max <= 3) return value.slice(0, max);
  return value.slice(0, max - 1) + "…";
}

function pathBase(value: string): string {
  const idx = value.lastIndexOf("/");
  return idx >= 0 ? value.slice(idx + 1) : value;
}

const UI_PHASE_LABELS = [
  "Setup / preflight",
  "Explore",
  "Plan",
  "Baseline",
  "Tests",
  "Implementation",
  "Review",
  "Finalize"
];
