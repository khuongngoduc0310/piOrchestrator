import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentModelUpdates, AgentName, OrchestratorConfig, ThinkingLevel, WorkflowState } from "./types.js";
import { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { runWorkflow } from "./orchestrator-workflow.js";
import type { OrchestratorDependencies } from "./orchestrator-contracts.js";

export type { CheckRunner, OrchestratorDependencies } from "./orchestrator-contracts.js";

export class Orchestrator {
  private readonly runtime: OrchestratorRuntime;

  constructor(pi: ExtensionAPI, extensionRoot: string, dependencies: OrchestratorDependencies = {}) {
    this.runtime = new OrchestratorRuntime(pi, extensionRoot, dependencies);
  }

  getState(): WorkflowState | undefined { return this.runtime.state; }
  isRunning(): boolean { return this.runtime.activeRun !== undefined; }

  start(request: string, ctx: ExtensionCommandContext): Promise<void> {
    if (this.runtime.activeRun) return Promise.reject(new Error("A workflow is already running"));
    if (this.runtime.settingsUpdateActive) return Promise.reject(new Error("Agent model settings are being validated and saved"));
    const controller = new AbortController();
    this.runtime.controller = controller;
    const running = runWorkflow(this.runtime, request, ctx, controller);
    const tracked = running.finally(() => {
      if (this.runtime.activeRun === tracked) this.runtime.activeRun = undefined;
    });
    this.runtime.activeRun = tracked;
    return tracked;
  }

  cancel(source: "command" | "shutdown" = "command"): boolean {
    return this.runtime.cancel(source);
  }

  startDashboard(cwd?: string): Promise<string> {
    return this.runtime.startDashboard(cwd);
  }

  saveAgentSettings(cwd: string, updates: AgentModelUpdates): Promise<OrchestratorConfig> {
    return this.runtime.saveAgentSettings(cwd, updates);
  }

  saveAgentModel(
    cwd: string,
    agent: AgentName,
    model: string,
    thinking: ThinkingLevel | null | undefined
  ): Promise<OrchestratorConfig> {
    return this.runtime.saveAgentModel(cwd, agent, model, thinking);
  }

  setOnStateChange(
    handler: ((state: WorkflowState, config: OrchestratorConfig, ctx: ExtensionCommandContext) => void) | undefined
  ): void {
    this.runtime.onStateChange = handler;
  }

  getConfigForPublish(): OrchestratorConfig | undefined {
    return this.runtime.config;
  }

  shutdown(ctx?: Pick<ExtensionCommandContext, "hasUI" | "ui">): Promise<void> {
    return this.runtime.shutdown(ctx);
  }
}
