import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { PiSdkAgentExecutor, type AgentExecutor } from "../agents/agent-runner.js";
import { runChecks } from "../checks/checks.js";
import { applyAgentModelUpdates, loadConfig, saveConfig } from "../config/config.js";
import { DashboardServer } from "../ui/dashboard.js";
import { buildIdleViewModel, buildRunViewModel } from "../ui/ui-model.js";
import { openBrowser as defaultOpenBrowser } from "../commands/open-browser.js";
import { RunStore } from "../persistence/store.js";
import { clearTerminal } from "../ui/terminal-ui.js";
import { loadMemory } from "../memory/memory-store.js";
import { selectMemoryLessons } from "../memory/memory-selection.js";
import { AGENT_NAMES, type AgentModelUpdates, type AgentName, type AgentTranscript, type ArtifactContent, type BaselineContext, type BaselineReviewContext, type BuilderOutput, type ConfigSummary, type DashboardRunHistoryItem, type InvocationDiffView, type OrchestratorConfig, type OrchestratorViewModel, type ThinkingLevel, type WorkflowState } from "../types.js";
import type { CandidateLesson, CandidateLedger, MemoryDocument, MemoryLessonRef, PromotionResult } from "../memory/memory-types.js";
import type { CheckRunner, OrchestratorDependencies } from "./orchestrator-contracts.js";
import { messageOf, projectTrusted, transcriptKey } from "./orchestrator-helpers.js";
import { WorkflowCancelledError } from "./workflow-errors.js";
import { DashboardRunRepository } from "../ui/dashboard-run-repository.js";
import { validateInvocationFileDiff, type InvocationFileDiff } from "../workspace/git-tree-diff.js";
import { buildAgentHistory } from "../agents/agent-history.js";
import type { ValidatedFileAttestation } from "../workspace/workspace-attestation.js";

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
  validatedFileAttestations = new Map<string, ValidatedFileAttestation>();
  mutationCommitStarted = false;
  activeTranscripts = new Map<string, AgentTranscript>();
  transcriptRevision = 0;
  private dashboardCwd?: string;

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
      readArtifact: name => this.readArtifact(name),
      listRuns: () => this.listDashboardRuns(),
      getRunViewModel: runId => this.getRunViewModel(runId),
      getRunAgentInspection: (runId, name) => this.getRunAgentInspection(runId, name),
      getRunAgentHistory: runId => this.getRunAgentHistory(runId),
      getRunAgentTranscript: (runId, stepId, invocation) => this.getRunAgentTranscript(runId, stepId, invocation),
      getInvocationDiff: (runId, stepId, invocation) => this.getInvocationDiff(runId, stepId, invocation),
      readRunArtifact: (runId, name) => this.readRunArtifact(runId, name)
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
    return this.historyRepository()?.getInvocationTranscript(this.state.runId, stepId, invocationSequence);
  }

  async readArtifact(name: string): Promise<ArtifactContent | undefined> {
    if (!this.state) return undefined;
    return this.readRunArtifact(this.state.runId, path.basename(name));
  }

  async listDashboardRuns(): Promise<DashboardRunHistoryItem[]> {
    const repository = this.historyRepository();
    if (!repository) return [];
    const activeId = this.state?.runId;
    return (await repository.listRuns(100)).map(run => ({ ...run, active: run.id === activeId }));
  }

  async getRunViewModel(runId: string): Promise<OrchestratorViewModel | undefined> {
    if (this.state?.runId === runId) return this.getViewModel();
    const state = await this.historyRepository()?.loadRun(runId);
    if (!state) return undefined;
    const elapsedEnd = state.completedAt ?? state.updatedAt;
    const elapsedMs = Math.max(0, new Date(elapsedEnd).getTime() - new Date(state.startedAt).getTime());
    return buildRunViewModel(state, this.getConfigSummary(), state.cwd, elapsedMs, Math.max(1, state.attempt));
  }

  async getRunAgentInspection(runId: string, name: AgentName) {
    if (this.state?.runId === runId) return this.getAgentInspection(name);
    return this.historyRepository()?.getAgentInspection(runId, name);
  }

  async getRunAgentHistory(runId: string) {
    if (this.state?.runId === runId) return buildAgentHistory(this.state);
    return this.historyRepository()?.getAgentHistory(runId);
  }

  async getRunAgentTranscript(runId: string, stepId: string, invocation: number): Promise<AgentTranscript | undefined> {
    if (this.state?.runId === runId) {
      const active = this.activeTranscripts.get(transcriptKey(stepId, invocation));
      if (active) return active;
    }
    return this.historyRepository()?.getInvocationTranscript(runId, stepId, invocation);
  }

  async getInvocationDiff(runId: string, stepId: string, invocationSequence: number): Promise<InvocationDiffView | undefined> {
    const repository = this.historyRepository();
    const state = this.state?.runId === runId ? this.state : await repository?.loadRun(runId);
    const invocation = state?.steps.find(step => step.id === stepId)?.invocations?.find(item => item.sequence === invocationSequence);
    if (!repository || !invocation?.fileDiffArtifact) return undefined;
    const metadataArtifact = await repository.readArtifact(runId, invocation.fileDiffArtifact);
    if (!metadataArtifact || metadataArtifact.truncated) return undefined;
    const metadata = validateInvocationFileDiff(JSON.parse(metadataArtifact.text) as unknown);
    if (metadata.patchArtifact !== invocation.filePatchArtifact) throw new Error("Invocation diff patch reference does not match workflow state");
    const patchArtifact = invocation.filePatchArtifact ? await repository.readArtifact(runId, invocation.filePatchArtifact) : undefined;
    return { metadata, patch: patchArtifact?.text ?? "", patchTruncated: patchArtifact?.truncated ?? false };
  }

  async readRunArtifact(runId: string, name: string): Promise<ArtifactContent | undefined> {
    const artifact = await this.historyRepository()?.readArtifact(runId, name);
    return artifact ? { name: artifact.name, text: artifact.text, truncated: artifact.truncated, isJson: artifact.isJson, size: artifact.sizeBytes } : undefined;
  }

  private historyRepository(): DashboardRunRepository | undefined {
    const cwd = this.state?.cwd ?? this.dashboardCwd;
    return cwd ? new DashboardRunRepository(cwd) : undefined;
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
    this.dashboardCwd = this.state?.cwd ?? cwd ?? this.dashboardCwd;
    const url = await this.dashboard.start(this.config?.dashboard.port ?? 0);
    if (this.state) {
      this.state.dashboardUrl = url;
      const vm = this.getViewModel();
      if (vm) this.dashboard.publish(vm);
    } else if (cwd) {
      const { inspectConfig } = await import("../config/config.js");
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
