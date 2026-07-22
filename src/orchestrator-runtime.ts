import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PiSdkAgentExecutor, type AgentExecutor } from "./agent-runner.js";
import { runChecks } from "./checks.js";
import { applyAgentModelUpdates, loadConfig, saveConfig } from "./config.js";
import { DashboardServer } from "./dashboard.js";
import { buildIdleViewModel, buildRunViewModel } from "./ui-model.js";
import { openBrowser as defaultOpenBrowser } from "./open-browser.js";
import { RunStore } from "./store.js";
import { clearTerminal } from "./terminal-ui.js";
import { loadMemory } from "./memory-store.js";
import { selectMemoryLessons } from "./memory-selection.js";
import { AGENT_NAMES, type AgentModelUpdates, type AgentName, type AgentTranscript, type AgentTranscriptArtifact, type ArtifactContent, type BaselineContext, type BaselineReviewContext, type BuilderOutput, type ConfigSummary, type OrchestratorConfig, type OrchestratorViewModel, type ThinkingLevel, type WorkflowState } from "./types.js";
import type { CandidateLesson, CandidateLedger, MemoryDocument, MemoryLessonRef, PromotionResult } from "./memory-types.js";
import type { CheckRunner, OrchestratorDependencies } from "./orchestrator-contracts.js";
import { messageOf, projectTrusted, transcriptKey } from "./orchestrator-helpers.js";
import { WorkflowCancelledError } from "./workflow-errors.js";

export class OrchestratorRuntime {
  state?: WorkflowState;
  controller?: AbortController;
  config?: OrchestratorConfig;
  store?: RunStore;
  activeRun?: Promise<void>;
  settingsUpdateActive = false;
  persistTimer: ReturnType<typeof setTimeout> | undefined;
  onStateChange?: (state: WorkflowState, config: OrchestratorConfig, ctx: ExtensionCommandContext) => void;
  readonly agents: AgentExecutor;
  readonly checks: CheckRunner;
  readonly storeFactory: (cwd: string, runId: string) => RunStore;
  readonly now: () => Date;
  readonly id: () => string;
  readonly openBrowser: (url: string) => void;
  readonly enforceWorkspacePolicy: boolean;
  readonly dashboard: DashboardServer;
  builderSessionOutputs: BuilderOutput[] = [];
  baselineRepaired = false;
  lessonStatus: "approved" | "rejected" | "skipped" = "skipped";
  baselineContext?: BaselineContext;
  baselineReviewContext?: BaselineReviewContext;
  memoryMode: "untrusted" | "disabled" | "empty" | "valid" | "invalid" | "scope_mismatch" | "unsupported" = "disabled";
  memoryRevision = 0;
  loadedMemoryDoc: MemoryDocument | null = null;
  explorerRelevantFiles: string[] = [];
  candidateLessons: CandidateLesson[] = [];
  promotionResult: PromotionResult | undefined;
  selectedMemoryIds = new Set<string>();
  candidateLedger?: CandidateLedger;
  validatedChangedFiles = new Set<string>();
  mutationCommitStarted = false;
  activeTranscripts = new Map<string, AgentTranscript>();
  transcriptRevision = 0;

  constructor(
    readonly pi: ExtensionAPI,
    readonly extensionRoot: string,
    dependencies: OrchestratorDependencies = {}
  ) {
    this.agents = dependencies.agentExecutor ?? new PiSdkAgentExecutor();
    this.checks = dependencies.checkRunner ?? runChecks;
    this.storeFactory = dependencies.storeFactory ?? ((cwd, runId) => new RunStore(cwd, runId));
    this.now = dependencies.now ?? (() => new Date());
    this.id = dependencies.id ?? randomUUID;
    this.openBrowser = dependencies.openBrowser ?? defaultOpenBrowser;
    this.enforceWorkspacePolicy = dependencies.enforceWorkspacePolicy ?? true;
    this.dashboard = new DashboardServer({
      getViewModel: () => this.getViewModel(),
      getAgentInspection: name => this.getAgentInspection(name),
      getAgentTranscript: (stepId, invocation) => this.getAgentTranscript(stepId, invocation),
      readArtifact: name => this.readArtifact(name)
    });
  }

  getViewModel(): OrchestratorViewModel | undefined {
    if (!this.state) return undefined;
    const elapsedMs = Date.now() - new Date(this.state.startedAt).getTime();
    const maxAttempts = Math.max(1, (this.config?.limits.implementationRetries ?? 0) + 1);
    const model = buildRunViewModel(this.state, this.getConfigSummary(), this.state.cwd, elapsedMs, maxAttempts);
    if (model.run) model.run.transcriptRevision = this.transcriptRevision;
    return model;
  }

  getConfigSummary(): ConfigSummary {
    if (!this.config) return { status: "missing", agentCount: 0, checkCount: 0 };
    return { status: "valid", agentCount: AGENT_NAMES.length, checkCount: this.config.checks.length };
  }

  async getAgentInspection(name: AgentName) {
    if (!this.state) return undefined;
    const agentStatus = this.state.agents[name];
    if (!agentStatus) return undefined;
    const agentCfg = this.config?.agents?.[name];
    const steps = this.state.steps.filter(step => step.agent === name);
    return {
      name,
      status: agentStatus.status,
      model: agentStatus.model || agentCfg?.model || "",
      summary: agentStatus.summary,
      error: agentStatus.error,
      startedAt: agentStatus.startedAt,
      completedAt: agentStatus.completedAt,
      currentTool: name === this.state.activeAgent ? this.state.currentTool : undefined,
      currentToolArgs: name === this.state.activeAgent ? this.state.currentToolArgs : undefined,
      toolStatus: name === this.state.activeAgent ? this.state.toolStatus : undefined,
      agentOutput: name === this.state.activeAgent ? this.state.agentOutput : undefined,
      steps,
      toolEvents: [],
      hasArtifact: steps.some(step => step.artifact != null),
      hasRawArtifact: steps.some(step => step.rawArtifact != null),
      transcriptRevision: this.transcriptRevision
    };
  }

  async getAgentTranscript(stepId: string, invocationSequence: number): Promise<AgentTranscript | undefined> {
    if (!this.state) return undefined;
    const step = this.state.steps.find(candidate => candidate.id === stepId);
    const invocation = step?.invocations?.find(candidate => candidate.sequence === invocationSequence);
    if (!step || !invocation) return undefined;
    const active = this.activeTranscripts.get(transcriptKey(stepId, invocationSequence));
    if (active) return active;
    if (!invocation.transcriptArtifact) return undefined;
    try {
      const raw = await readFile(path.join(this.state.runDir, path.basename(invocation.transcriptArtifact)), "utf8");
      return JSON.parse(raw) as AgentTranscriptArtifact;
    } catch {
      return undefined;
    }
  }

  async readArtifact(name: string): Promise<ArtifactContent | undefined> {
    if (!this.state) return undefined;
    try {
      const text = await readFile(path.join(this.state.runDir, path.basename(name)), "utf8");
      const maxLen = 512 * 1024;
      return { name, text: text.length > maxLen ? text.slice(0, maxLen) : text, truncated: text.length > maxLen, isJson: name.endsWith(".json"), size: text.length };
    } catch {
      return undefined;
    }
  }

  async loadProjectMemory(cwd: string, ctx: ExtensionCommandContext): Promise<void> {
    this.memoryMode = "disabled";
    this.memoryRevision = 0;
    this.loadedMemoryDoc = null;
    if (!projectTrusted(ctx)) {
      this.memoryMode = "untrusted";
      ctx.ui.notify("Project memory is disabled because this project is not trusted", "warning");
      return;
    }
    try {
      const { document, error } = await loadMemory(cwd);
      if (error) {
        this.memoryMode = error.includes("projectPath mismatch") ? "scope_mismatch" : "invalid";
        ctx.ui.notify(`Project memory unavailable: ${error}`, "warning");
        return;
      }
      if (!document || document.lessons.length === 0) {
        this.memoryMode = "empty";
        return;
      }
      this.loadedMemoryDoc = document;
      this.memoryRevision = document.revision;
      this.memoryMode = "valid";
    } catch (error) {
      ctx.ui.notify(`Could not load project memory: ${messageOf(error)}`, "warning");
    }
  }

  getMemoryEnvelope(agent: AgentName): { advisoryOnly: true; selectedAtRevision: number; lessons: MemoryLessonRef[] } | undefined {
    if (this.memoryMode !== "valid" || !this.loadedMemoryDoc) return undefined;
    const selection = selectMemoryLessons(this.loadedMemoryDoc, agent, this.state?.request ?? "", this.explorerRelevantFiles);
    if (selection.lessons.length === 0) return undefined;
    for (const lesson of selection.lessons) this.selectedMemoryIds.add(lesson.id);
    return { advisoryOnly: true, selectedAtRevision: selection.revision, lessons: selection.lessons };
  }

  async captureBaseline(cwd: string, store: RunStore): Promise<BaselineContext> {
    let gitHead: string | undefined;
    let diffVsHead: string | undefined;
    let stagedDiff: string | undefined;
    let statusPorcelain: string | undefined;
    let untrackedFiles: string[] = [];
    let hasUncommittedChanges = false;
    let hasStagedChanges = false;
    let diffArtifact: string | undefined;
    let stagedArtifact: string | undefined;
    try {
      gitHead = execSync("git rev-parse HEAD", { cwd, stdio: "pipe", timeout: 10_000, encoding: "utf8" }).trim();
      statusPorcelain = execSync("git status --porcelain", { cwd, stdio: "pipe", timeout: 10_000, encoding: "utf8" });
      hasUncommittedChanges = statusPorcelain.trim().length > 0;
      const untracked = execSync("git ls-files --others --exclude-standard", { cwd, stdio: "pipe", timeout: 10_000, encoding: "utf8" });
      untrackedFiles = untracked.split("\n").map(value => value.trim()).filter(Boolean);
      const diff = execSync("git diff HEAD", { cwd, stdio: "pipe", timeout: 10_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" }).trim();
      if (diff) {
        diffArtifact = "baseline-diff.patch";
        await store.saveRaw(diffArtifact, diff);
        diffVsHead = diff.slice(0, 2000);
      }
      const staged = execSync("git diff --cached", { cwd, stdio: "pipe", timeout: 10_000, maxBuffer: 10 * 1024 * 1024, encoding: "utf8" }).trim();
      if (staged) {
        hasStagedChanges = true;
        stagedArtifact = "baseline-staged.patch";
        await store.saveRaw(stagedArtifact, staged);
        stagedDiff = staged.slice(0, 2000);
      }
    } catch {
    }
    return { gitHead, hasUncommittedChanges, hasStagedChanges, diffVsHead, stagedDiff, untrackedFiles, statusPorcelain, diffArtifact, stagedArtifact };
  }

  async startDashboard(cwd?: string): Promise<string> {
    const url = await this.dashboard.start(this.config?.dashboard.port ?? 0);
    if (this.state) {
      this.state.dashboardUrl = url;
      const vm = this.getViewModel();
      if (vm) this.dashboard.publish(vm);
    } else if (cwd) {
      const { inspectConfig } = await import("./config.js");
      this.dashboard.publish(buildIdleViewModel(cwd, await inspectConfig(cwd)));
    }
    return url;
  }

  async saveAgentSettings(cwd: string, updates: AgentModelUpdates): Promise<OrchestratorConfig> {
    return this.saveAgentConfig(cwd, config => applyAgentModelUpdates(config, updates));
  }

  async saveAgentModel(cwd: string, agent: AgentName, model: string, thinking: ThinkingLevel | null | undefined): Promise<OrchestratorConfig> {
    return this.saveAgentConfig(cwd, config => {
      const updated = structuredClone(config);
      updated.agents[agent].model = model.trim();
      if (thinking === null) delete updated.agents[agent].thinking;
      else if (thinking !== undefined) updated.agents[agent].thinking = thinking;
      return updated;
    });
  }

  private async saveAgentConfig(cwd: string, update: (config: OrchestratorConfig) => OrchestratorConfig): Promise<OrchestratorConfig> {
    if (this.activeRun) throw new Error("Agent models cannot be changed while a workflow is running");
    if (this.settingsUpdateActive) throw new Error("Another agent settings update is already active");
    this.settingsUpdateActive = true;
    try {
      const candidate = update(await loadConfig(cwd));
      await this.agents.preflight(candidate, cwd, this.extensionRoot, new AbortController().signal, candidate.limits.agentTimeoutMs);
      await saveConfig(cwd, candidate);
      this.config = candidate;
      return candidate;
    } finally {
      this.settingsUpdateActive = false;
    }
  }

  cancel(source: "command" | "shutdown" = "command"): boolean {
    if (!this.activeRun || !this.controller || this.controller.signal.aborted || this.mutationCommitStarted) return false;
    this.controller.abort(new WorkflowCancelledError(`Workflow cancelled by ${source}`, source));
    return true;
  }

  async shutdown(ctx?: Pick<ExtensionCommandContext, "hasUI" | "ui">): Promise<void> {
    this.cancel("shutdown");
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.activeRun?.catch(() => undefined);
    await this.store?.flush().catch(() => undefined);
    await this.dashboard.stop();
    if (ctx) clearTerminal(ctx);
  }

  timestamp(): string { return this.now().toISOString(); }
  requireState(): WorkflowState { if (!this.state) throw new Error("Orchestrator state is not initialized"); return this.state; }
  requireStore(): RunStore { if (!this.store) throw new Error("Run store is not initialized"); return this.store; }
  requireConfig(): OrchestratorConfig { if (!this.config) throw new Error("Orchestrator config is not initialized"); return this.config; }
  requireController(): AbortController { if (!this.controller) throw new Error("Orchestrator controller is not initialized"); return this.controller; }
  requireBaselineReviewContext(): BaselineReviewContext { if (!this.baselineReviewContext) throw new Error("Baseline review context is not initialized"); return this.baselineReviewContext; }
}
