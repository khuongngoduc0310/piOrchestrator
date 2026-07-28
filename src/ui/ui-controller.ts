import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentName, OrchestratorConfig, OrchestratorViewModel, WorkflowState } from "../types.js";
import { AGENT_NAMES } from "../types.js";
import { inspectConfig } from "../config/config.js";
import { buildIdleViewModel, buildRunViewModel } from "./ui-model.js";
import { statusText } from "./terminal-ui.js";
import type { WidgetTheme } from "./terminal-ui.js";
import { createMissionControlComponent } from "./mission-control-component.js";
import type { MapSessionBuffer } from "./agent-session.js";

type Ctx = Pick<ExtensionCommandContext, "hasUI" | "ui">;
type TuiAwareCtx = Pick<ExtensionCommandContext, "hasUI" | "ui" | "mode">;

export interface UiControllerDependencies {
  isRunning: () => boolean;
  elapsedMs: () => number;
  sessionBuffers: () => MapSessionBuffer;
}

type McCloseReason = "user" | "waiting" | "shutdown" | "run_changed";

export class UiController {
  private viewModel?: OrchestratorViewModel;
  private mcDone: ((result: void) => void) | undefined;
  private mcOpen = false;
  private mcTimer: ReturnType<typeof setInterval> | undefined;
  private reopenAfterWaiting = false;
  private reopenRunId?: string;
  selectedAgent: AgentName | null = null;

  constructor(private readonly deps: UiControllerDependencies) {}

  async attach(ctx: Ctx | TuiAwareCtx): Promise<void> {
    if (!ctx.hasUI) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (ctx as any).cwd ?? process.cwd();
    const config = await inspectConfig(cwd);
    this.viewModel = buildIdleViewModel(cwd, config);
    this.reopenAfterWaiting = false;
    this.reopenRunId = undefined;
    ctx.ui.setWidget("pi-orchestrator", undefined);
    this.publish(ctx);
  }

  publish(ctx: Ctx): void {
    if (!ctx.hasUI || !this.viewModel) return;
    const vm = this.viewModel;
    const theme = ctx.ui.theme as WidgetTheme;
    ctx.ui.setStatus("pi-orchestrator", statusText(vm, theme));
  }

  async refreshConfig(ctx: TuiAwareCtx): Promise<void> {
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

  updateRun(
    state: WorkflowState,
    config: OrchestratorConfig,
    ctx: TuiAwareCtx,
  ): void {
    if (!ctx.hasUI) return;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cwd = (ctx as any).cwd ?? process.cwd();
    const configSummary = {
      status: "valid" as const,
      agentCount: AGENT_NAMES.length,
      checkCount: config.checks.length,
    };
    const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
    this.viewModel = buildRunViewModel(state, configSummary, cwd, this.deps.elapsedMs(), maxAttempts);

    // If MC was closed for a waiting dialog and workflow is now running, reopen.
    if (this.reopenAfterWaiting && this.viewModel.mode === "running" && this.reopenRunId === this.viewModel.run?.id && ctx.mode === "tui") {
      this.reopenAfterWaiting = false;
      this.reopenRunId = undefined;
      void this.openMissionControl(ctx as unknown as ExtensionCommandContext);
      this.publish(ctx);
      return;
    }

    this.publish(ctx);

    // Close MC before workflow enters human dialog.  Preserve reopen intent.
    if (this.viewModel.mode === "waiting") {
      if (this.mcOpen) {
        this.reopenAfterWaiting = true;
        this.reopenRunId = this.viewModel.run?.id;
      }
      this.closeMissionControl();
      return;
    }

    // Terminal states clear reopen intent.
    if (this.viewModel.mode !== "running") {
      this.reopenAfterWaiting = false;
      this.reopenRunId = undefined;
    }
  }

  detach(ctx: TuiAwareCtx): void {
    this.reopenAfterWaiting = false;
    this.reopenRunId = undefined;
    this.closeMissionControl();
    if (!ctx.hasUI) return;
    ctx.ui.setStatus("pi-orchestrator", undefined);
    ctx.ui.setWidget("pi-orchestrator", undefined);
    this.viewModel = undefined;
  }

  async openMissionControl(ctx: ExtensionCommandContext, screen: "dashboard" | "inspector" = "dashboard"): Promise<void> {
    if (this.mcOpen) return;
    if (!this.viewModel?.run) return;
    if (this.viewModel.mode === "waiting") {
      ctx.ui.notify("Mission Control is unavailable while another orchestrator dialog is open", "warning");
      return;
    }
    if (ctx.mode !== "tui") {
      ctx.ui.notify("Mission Control requires Pi's terminal UI", "warning");
      return;
    }
    this.mcOpen = true;
    try {
      await ctx.ui.custom<void>(
        (tui, theme, _keybindings, done) => {
          this.mcDone = done;
          this.startMCTimer(tui);
          return createMissionControlComponent(
            tui,
            theme as WidgetTheme,
            (result: void) => {
              this.stopMCTimer();
              this.mcDone = undefined;
              this.mcOpen = false;
              done(result);
            },
            {
              getVM: () => this.viewModel,
              getAgentNames: () => {
                const sb = this.deps.sessionBuffers();
                return sb.getAgentNames();
              },
              getAgentView: agent => {
                const sb = this.deps.sessionBuffers();
                return sb.getView(agent);
              },
            },
            this.selectedAgent,
            (agent: AgentName | null) => { this.selectedAgent = agent; },
            screen === "inspector" ? { mode: "inspector" } : { mode: "dashboard" },
          );
        },
        { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center" } },
      );
    } catch {
      // overlay rejected or cancelled
    } finally {
      this.stopMCTimer();
      this.mcOpen = false;
      this.mcDone = undefined;
    }
  }

  private closeMissionControl(): void {
    if (!this.mcDone) return;
    this.mcDone(undefined);
    this.mcDone = undefined;
    this.mcOpen = false;
    this.stopMCTimer();
  }

  private startMCTimer(tui: { requestRender(): void }): void {
    this.stopMCTimer();
    this.mcTimer = setInterval(() => {
      tui.requestRender();
    }, 2_000);
    if (this.mcTimer && typeof this.mcTimer === "object" && "unref" in this.mcTimer) {
      (this.mcTimer as NodeJS.Timeout).unref();
    }
  }

  private stopMCTimer(): void {
    if (this.mcTimer !== undefined) {
      clearInterval(this.mcTimer);
      this.mcTimer = undefined;
    }
  }
}
