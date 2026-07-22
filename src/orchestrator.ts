import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatPlanForReview } from "./plan-review.js";
import { openBrowser as defaultOpenBrowser } from "./open-browser.js";
import {
  formatApprovedPlan,
  formatApprovedReview,
  formatBaselineReport,
  formatCancelledRun,
  formatCompletedRun,
  formatDocumentationReport,
  formatFailedRun,
  formatStartedRun,
  formatVerifiedImplementation
} from "./session-messages.js";
import { PiSdkAgentExecutor, AgentCancelledError, type AgentExecutor, type AgentRunOptions } from "./agent-runner.js";
import { runChecks, type CheckRunOptions } from "./checks.js";
import { ensureChecksConfigured } from "./check-setup.js";
import { applyAgentModelUpdates, configPath, loadConfig, saveConfig } from "./config.js";
import { DashboardServer } from "./dashboard.js";
import { RunStore } from "./store.js";
import { clearTerminal } from "./terminal-ui.js";
import { collectWorktreeChanges, createWorktree, removeWorktree, syncWorktreeChanges, type WorktreeHandle } from "./worktree.js";
import { buildRunViewModel, buildIdleViewModel } from "./ui-model.js";
import { execSync } from "node:child_process";
import { loadMemory, promoteLessons, type MemoryStoreError } from "./memory-store.js";
import { selectMemoryLessons, type SelectionResult } from "./memory-selection.js";
import { candidateLessonId, permanentLessonId, validateCandidates, deduplicateAgainstMemory, validateNewLesson, computeFinalChecksDigest } from "./memory-validation.js";
import { createCandidateLedger, saveCandidateLedger, setCandidateState } from "./candidate-store.js";
import { ROLE_MUTATION_KINDS } from "./role-capabilities.js";
import {
  compareWorkspaceSnapshots,
  createWorkspaceSnapshot,
  deriveRoleMutationPaths,
  validateReportedFileSet,
  validateRoleDelta,
  type WorkspaceDelta
} from "./workspace-guard.js";
import {
  GateInteractionError,
  HumanGateUnavailableError,
  MutationBoundaryError,
  WorkflowCancelledError,
  WorkflowTerminationError
} from "./workflow-errors.js";
import type {
  CandidateLesson,
  CandidateLedger,
  CandidateScreening,
  MemoryDocument,
  MemoryLessonRef,
  PromotionResult,
} from "./memory-types.js";
import {
  AGENT_TASK_SCHEMA_VERSION,
  AGENT_NAMES,
  SCHEMA_VERSION,
  type AgentOutputMap,
  type AgentTaskEnvelope,
  type AgentTaskMap,
  type AgentInspection,
  type AgentModelUpdates,
  type AgentName,
  type AgentToolEvent,
  type ArtifactContent,
  type BaselineContext,
  type BaselineReviewContext,
  type BuilderOutput,
  type BuilderTask,
  type CheckResult,
  type CompletionSummary,
  type ConfigSummary,
  type HumanPlanReviewResult,
  type HumanGateState,
  type HumanReviewDecision,
  type DebuggerOutput,
  type OrchestratorConfig,
  type OrchestratorViewModel,
  type PlannerOutput,
  type ReviewOutput,
  type ReviewApprovalSource,
  type Stage,
  type StepRecord,
  type ThinkingLevel,
  type WorkflowState
} from "./types.js";
import {
  parseBuilderOutput,
  parseDebuggerOutput,
  parseDocumenterOutput,
  parseExplorerOutput,
  parsePlannerOutput,
  parseReviewOutput,
  parseTesterOutput,
  ValidationError
} from "./validation.js";

const OUTPUT_CORRECTABLE_AGENTS = new Set<AgentName>(["explorer", "planner", "reviewer", "debugger"]);
const CORRECTION_TOOLS = new Set(["read", "grep", "find", "ls"]);

const EXTENSION_VERSION: string = (() => {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = path.resolve(dir, "..", "package.json");
    return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

export type CheckRunner = typeof runChecks;

export interface OrchestratorDependencies {
  agentExecutor?: AgentExecutor;
  checkRunner?: CheckRunner;
  storeFactory?: (cwd: string, runId: string) => RunStore;
  now?: () => Date;
  id?: () => string;
  openBrowser?: (url: string) => void;
  enforceWorkspacePolicy?: boolean;
}

export class Orchestrator {
  private state?: WorkflowState;
  private controller?: AbortController;
  private dashboard: DashboardServer;
  private config?: OrchestratorConfig;
  private store?: RunStore;
  private activeRun?: Promise<void>;
  private settingsUpdateActive = false;
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private onStateChange?: (state: WorkflowState, config: OrchestratorConfig, ctx: ExtensionCommandContext) => void;
  private readonly agents: AgentExecutor;
  private readonly checks: CheckRunner;
  private readonly storeFactory: (cwd: string, runId: string) => RunStore;
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly openBrowser: (url: string) => void;
  private readonly enforceWorkspacePolicy: boolean;
  private builderSessionOutputs: BuilderOutput[] = [];
  private baselineRepaired = false;
  private lessonStatus: "approved" | "rejected" | "skipped" = "skipped";
  private baselineContext?: BaselineContext;
  private baselineReviewContext?: BaselineReviewContext;
  private memoryMode: "untrusted" | "disabled" | "empty" | "valid" | "invalid" | "scope_mismatch" | "unsupported" = "disabled";
  private memoryRevision = 0;
  private loadedMemoryDoc: MemoryDocument | null = null;
  private explorerRelevantFiles: string[] = [];
  private candidateLessons: CandidateLesson[] = [];
  private screeningResults: CandidateScreening[] = [];
  private humanApprovedCandidateIds: string[] = [];
  private promotionResult: PromotionResult | undefined;
  private selectedMemoryIds = new Set<string>();
  private candidateLedger?: CandidateLedger;
  private validatedChangedFiles = new Set<string>();
  private mutationCommitStarted = false;

  constructor(
    private readonly pi: ExtensionAPI,
    private readonly extensionRoot: string,
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
      getAgentInspection: (name) => this.getAgentInspection(name),
      readArtifact: (name) => this.readArtifact(name),
    });
  }

  getState(): WorkflowState | undefined { return this.state; }

  private getViewModel(): OrchestratorViewModel | undefined {
    if (!this.state) return undefined;
    const configSummary = this.getConfigSummary();
    const elapsedMs = Date.now() - new Date(this.state.startedAt).getTime();
    const maxAttempts = Math.max(1, (this.config?.limits.implementationRetries ?? 0) + 1);
    return buildRunViewModel(this.state, configSummary, this.state.cwd, elapsedMs, maxAttempts);
  }

  private getConfigSummary(): ConfigSummary {
    const cfg = this.config;
    if (!cfg) return { status: "missing", agentCount: 0, checkCount: 0 };
    return {
      status: "valid",
      agentCount: AGENT_NAMES.length,
      checkCount: cfg.checks.length
    };
  }

  private async loadProjectMemory(cwd: string, ctx: ExtensionCommandContext): Promise<void> {
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

  private getMemoryEnvelope(agent: AgentName): { advisoryOnly: true; selectedAtRevision: number; lessons: MemoryLessonRef[] } | undefined {
    if (this.memoryMode !== "valid" || !this.loadedMemoryDoc) return undefined;
    const request = this.state?.request ?? "";
    const selection = selectMemoryLessons(this.loadedMemoryDoc, agent, request, this.explorerRelevantFiles);
    if (selection.lessons.length === 0) return undefined;
    for (const lesson of selection.lessons) this.selectedMemoryIds.add(lesson.id);
    return {
      advisoryOnly: true,
      selectedAtRevision: selection.revision,
      lessons: selection.lessons,
    };
  }

  async getAgentInspection(name: AgentName): Promise<AgentInspection | undefined> {
    if (!this.state) return undefined;
    const agentStatus = this.state.agents[name];
    if (!agentStatus) return undefined;
    const agentCfg = this.config?.agents?.[name];
    const steps = this.state.steps.filter((s) => s.agent === name);
    const toolEvents: AgentToolEvent[] = [];
    for (const step of steps) {
      if (step.artifact || step.rawArtifact) {
        toolEvents.push({
          toolName: step.label,
          startedAt: step.startedAt,
        });
      }
    }
    const hasArtifact = steps.some((s) => s.artifact != null);
    const hasRawArtifact = steps.some((s) => s.rawArtifact != null);
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
      toolEvents,
      hasArtifact,
      hasRawArtifact,
    };
  }

  async readArtifact(name: string): Promise<ArtifactContent | undefined> {
    if (!this.state) return undefined;
    const runDir = this.state.runDir;
    const filePath = path.join(runDir, path.basename(name));
    try {
      const text = await readFile(filePath, "utf8");
      const isJson = name.endsWith(".json");
      const maxLen = 512 * 1024;
      const truncated = text.length > maxLen;
      return {
        name,
        text: truncated ? text.slice(0, maxLen) : text,
        truncated,
        isJson,
        size: text.length,
      };
    } catch {
      return undefined;
    }
  }

  private async captureBaseline(cwd: string, store: RunStore): Promise<BaselineContext> {
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
      untrackedFiles = untracked.split("\n").map(s => s.trim()).filter(Boolean);
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

  isRunning(): boolean { return this.activeRun !== undefined; }

  start(request: string, ctx: ExtensionCommandContext): Promise<void> {
    if (this.activeRun) return Promise.reject(new Error("A workflow is already running"));
    if (this.settingsUpdateActive) return Promise.reject(new Error("Agent model settings are being validated and saved"));
    const controller = new AbortController();
    this.controller = controller;
    const running = this.runWorkflow(request, ctx, controller);
    const tracked = running.finally(() => {
      if (this.activeRun === tracked) this.activeRun = undefined;
    });
    this.activeRun = tracked;
    return tracked;
  }

  private async runWorkflow(request: string, ctx: ExtensionCommandContext, controller: AbortController): Promise<void> {
    const cwd = ctx.cwd ?? process.cwd();
    const loadedConfig = await loadConfig(cwd);
    const config = await ensureChecksConfigured(cwd, loadedConfig, ctx);
    if (!config) return;
    this.config = config;
    if (controller.signal.aborted) throw new Error("Workflow cancelled");
    await this.loadProjectMemory(cwd, ctx);
    const runId = this.id();
    const store = this.storeFactory(cwd, runId);
    this.store = store;
    await store.init();
    const agents = Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle", model: config.agents[name].model }])) as WorkflowState["agents"];
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      runId,
      request,
      cwd,
      runDir: store.runDir,
      stage: "idle",
      status: "running",
      attempt: 0,
      startedAt: this.timestamp(),
      updatedAt: this.timestamp(),
      agents,
      steps: []
    };

    this.builderSessionOutputs = [];
    this.baselineRepaired = false;
    this.lessonStatus = "skipped";
    this.selectedMemoryIds.clear();
    this.candidateLessons = [];
    this.candidateLedger = undefined;
    this.promotionResult = undefined;
    this.validatedChangedFiles.clear();
    this.mutationCommitStarted = false;
    this.baselineContext = await this.captureBaseline(cwd, store);
    await store.saveJson("baseline.json", this.baselineContext);
    const artifactRoot = path.relative(cwd, store.runDir).split(path.sep).join("/");
    this.baselineReviewContext = {
      summary: this.baselineContext,
      artifacts: {
        baselineJson: `${artifactRoot}/baseline.json`,
        ...(this.baselineContext.diffArtifact ? { headDiffPatch: `${artifactRoot}/${this.baselineContext.diffArtifact}` } : {}),
        ...(this.baselineContext.stagedArtifact ? { stagedDiffPatch: `${artifactRoot}/${this.baselineContext.stagedArtifact}` } : {})
      }
    };

    let mutationCwd = cwd;
    let worktreeHandle: WorktreeHandle | undefined;
    let worktreeSynced = false;
    let retainWorktree = false;
    let mutationConfirmed = false;
    const enterMutationPhase = async (): Promise<void> => {
      if (!mutationConfirmed && config.humanInTheLoop.confirmBeforeMutation) {
        await this.runRequiredHumanGate("mutation_confirmation", "Mutation phase confirmation", ctx, async signal => {
          const proceed = await ctx.ui.confirm(
            "Enter the mutation phase?",
            "Tester, Builder, Documenter, and project checks may modify files. Continue?",
            { signal }
          );
          if (!proceed) throw new WorkflowCancelledError("Workflow cancelled before mutation", "human_gate");
        });
      }
      mutationConfirmed = true;
      if (config.limits.worktreeIsolation && !worktreeHandle) {
        worktreeHandle = await createWorktree(cwd, runId);
        mutationCwd = worktreeHandle.effectiveCwd;
        await store.saveJson("worktree.json", {
          repositoryRoot: worktreeHandle.repositoryRoot,
          effectiveCwd: worktreeHandle.effectiveCwd,
          baselineCommit: worktreeHandle.baselineCommit
        });
        ctx.ui.notify(`Mutation phase isolated in ${mutationCwd}`, "info");
      }
    };

    try {
      if (this.shouldSuggestHumanTouchpoints(config, ctx)) {
        await this.suggestHumanTouchpoints(cwd, config, ctx);
      }

      if (config.dashboard.enabled) {
        try {
          this.state.dashboardUrl = await this.dashboard.start(config.dashboard.port);
          this.openBrowser(this.state.dashboardUrl);
        } catch (error) {
          this.state.warning = `Dashboard unavailable: ${messageOf(error)}`;
        }
      }
      this.publishSessionMessage(formatStartedRun(request, runId, store.runDir), { kind: "started" });
      await this.transition("preflight", undefined, "Validating configuration and models", ctx);
      if (config.checks.length === 0) {
        throw new Error(`No project checks are configured. Edit ${configPath(cwd)} before running the workflow.`);
      }
      await this.agents.preflight(config, cwd, this.extensionRoot, controller.signal, config.limits.agentTimeoutMs);

      const exploration = await this.runAgentStep("explorer", "exploring", "Explore repository", { request }, cwd, ctx, parseExplorerOutput);
      this.explorerRelevantFiles = exploration.relevantFiles;
      let plan = await this.runAgentStep("planner", "planning", "Create implementation plan", { action: "create_plan", request, exploration }, cwd, ctx, parsePlannerOutput, { revision: 0 });

      let planApproved = false;
      for (let reviewIndex = 0; reviewIndex <= config.limits.planRevisions; reviewIndex++) {
        const useHuman = reviewIndex === 0
          ? config.humanInTheLoop.planApproval
          : config.humanInTheLoop.planRevisionApproval;
        if (useHuman) {
          const label = reviewIndex === 0 ? "Review implementation plan" : "Review revised plan";
          const humanDecision = await this.runRequiredHumanGate(
            reviewIndex === 0 ? "plan_approval" : "plan_revision_approval",
            reviewIndex === 0 ? "Plan approval" : "Plan revision approval",
            ctx,
            async () => {
              const decision = await this.promptHumanPlanReview(plan, label, ctx);
              if (!decision) throw new WorkflowCancelledError("Workflow cancelled during plan review", "human_gate");
              return decision;
            }
          );
          if (humanDecision.approved) {
            planApproved = true;
            break;
          }
          if (reviewIndex === config.limits.planRevisions) break;
          plan = await this.runAgentStep(
            "planner",
            "planning",
            "Revise implementation plan",
            { action: "revise_plan", request, exploration, previousPlan: plan, feedback: { source: "human", text: humanDecision.feedback ?? "" } },
            cwd,
            ctx,
            parsePlannerOutput,
            { revision: reviewIndex + 1 }
          );
        } else {
          const review = await this.runAgentStep(
            "reviewer",
            "reviewing_plan",
            "Review implementation plan",
            { reviewType: "plan", request, exploration, plan },
            cwd,
            ctx,
            parseReviewOutput,
            { revision: reviewIndex }
          );
          if (review.decision === "approved") {
            planApproved = true;
            break;
          }
          if (reviewIndex === config.limits.planRevisions) break;
          plan = await this.runAgentStep(
            "planner",
            "planning",
            "Revise implementation plan",
            { action: "revise_plan", request, exploration, previousPlan: plan, feedback: { source: "reviewer", review } },
            cwd,
            ctx,
            parsePlannerOutput,
            { revision: reviewIndex + 1 }
          );
        }
      }
      if (!planApproved) throw new Error("Plan was not approved within the revision limit");
      await store.saveJson("plan.json", plan);
      this.publishSessionMessage(formatApprovedPlan(plan), { kind: "plan_approved" });

      let baseline = await this.runCheckStep("baseline", "Run green baseline", cwd, ctx, { requireGreen: false });

      if (!allGreen(baseline, config.checks.length)) {
        ctx.ui.notify("Baseline checks are not all green. Diagnosing failures...", "warning");

        const baselineDiagnosis = await this.runAgentStep(
          "debugger",
          "baseline",
          "Diagnose baseline failures",
          { action: "diagnose_baseline", request, checks: baseline },
          cwd, ctx, parseDebuggerOutput
        );

        const baselineFixPlan = await this.runAgentStep(
          "planner",
          "baseline",
          "Create baseline repair plan",
          { action: "repair_baseline", request, diagnosis: baselineDiagnosis, checkFailures: baseline },
          cwd, ctx, parsePlannerOutput
        );
        await store.saveJson("baseline-fix-plan.json", baselineFixPlan);

        if (!ctx.hasUI) {
          const dir = path.relative(cwd, store.runDir);
          throw new Error(
            `Baseline checks failed and need repair. ` +
            `A repair plan has been saved to ${dir}/baseline-fix-plan.json. ` +
            `Apply the fixes manually or re-run with an interactive UI to approve the repair plan.`
          );
        }

        const fixDecision = await this.runRequiredHumanGate(
          "baseline_repair_approval",
          "Baseline repair approval",
          ctx,
          async () => {
            const decision = await this.promptHumanPlanReview(baselineFixPlan, "Review baseline repair plan", ctx);
            if (!decision) throw new WorkflowCancelledError("Workflow cancelled during baseline repair review", "human_gate");
            return decision;
          }
        );
        if (!fixDecision.approved) throw new WorkflowCancelledError("Baseline repair was not approved", "human_gate");

        await enterMutationPhase();

        await this.runAgentStep(
          "builder",
          "baseline",
          "Repair baseline failures",
          { action: "repair_baseline", request, fixPlan: baselineFixPlan, attempt: 1 },
          mutationCwd, ctx, parseBuilderOutput, { mutationPlan: baselineFixPlan }
        );

        baseline = await this.runCheckStep("baseline", "Verify baseline after repair", mutationCwd, ctx, { requireGreen: true, kind: "baseline-verify" });
        this.baselineRepaired = true;
        this.publishSessionMessage(formatBaselineReport(baseline, baselineDiagnosis, baselineFixPlan), { kind: "baseline_repaired" });
      }

      await enterMutationPhase();

      const tester = await this.runAgentStep(
        "tester",
        "creating_tests",
        "Create acceptance tests",
        {
          action: "create_tests",
          request,
          plan,
          acceptanceCriteria: plan.acceptanceCriteria.map((text, index) => ({ index, text })),
          baselineChecks: baseline
        },
        mutationCwd,
        ctx,
        text => parseTesterOutput(text, plan.acceptanceCriteria),
        { mutationPlan: plan }
      );
      const checksAfterTests = await this.runCheckStep("testing", "Run checks after test creation", mutationCwd, ctx, { requireGreen: false, kind: "after-tests" });

      let diagnosis: DebuggerOutput | undefined;
      const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
      let implAttemptChecks: CheckResult[] | undefined;
      let finalImplChecks: CheckResult[] | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        this.state.attempt = attempt;
        const builderTask: BuilderTask = attempt === 1
          ? { action: "implement", request, plan, tester, checks: implAttemptChecks ?? checksAfterTests, attempt }
          : { action: "fix_failure", request, plan, tester, checks: implAttemptChecks ?? checksAfterTests, diagnosis: diagnosis!, attempt };
        const builderOut = await this.runAgentStep(
          "builder",
          "implementing",
          attempt === 1 ? "Implement approved plan" : "Fix diagnosed check failures",
          builderTask,
          mutationCwd,
          ctx,
          parseBuilderOutput,
          { attempt, mutationPlan: plan }
        );
        this.builderSessionOutputs.push(builderOut);
        implAttemptChecks = await this.runCheckStep("testing", `Run implementation checks (attempt ${attempt})`, mutationCwd, ctx, {
          requireGreen: false,
          attempt,
          kind: "implementation"
        });
        if (allGreen(implAttemptChecks, config.checks.length)) break;
        if (attempt === maxAttempts) throw new Error("Implementation retry limit reached with failing checks");
        diagnosis = await this.runAgentStep(
          "debugger",
          "debugging",
          "Diagnose check failures",
          { action: "diagnose_implementation", request, plan, checks: implAttemptChecks, attempt },
          mutationCwd,
          ctx,
          parseDebuggerOutput,
          { attempt }
        );
      }
      if (!implAttemptChecks || !allGreen(implAttemptChecks, config.checks.length)) {
        throw new Error("Implementation did not reach a verified state");
      }
      finalImplChecks = implAttemptChecks;

      this.publishSessionMessage(
        formatVerifiedImplementation(plan, this.builderSessionOutputs, finalImplChecks, !!config.limits.worktreeIsolation, store.runDir),
        { kind: "implementation_verified" }
      );

      let codeReview: ReviewOutput | undefined;
      let reviewApproved = false;
      let reviewApprovalSource: ReviewApprovalSource = "reviewer";
      const priorCodeReviews: ReviewOutput[] = [];
      let allowedReviewFixes = config.limits.reviewRevisions;
      for (let fixes = 0; fixes <= allowedReviewFixes; fixes++) {
        codeReview = await this.runAgentStep(
          "reviewer",
          "reviewing_code",
          "Review implementation",
          {
            reviewType: "code",
            request,
            plan,
            baseline: this.requireBaselineReviewContext(),
            exploration,
            implementationChecks: finalImplChecks,
            tester,
            builderOutputs: this.builderSessionOutputs,
            priorReviews: priorCodeReviews
          },
          mutationCwd,
          ctx,
          parseReviewOutput,
          { revision: fixes }
        );
        if (codeReview.decision === "approved") {
          reviewApproved = true;
          this.publishSessionMessage(formatApprovedReview(codeReview, finalImplChecks ?? [], fixes, "reviewer"), { kind: "review_approved" });
          break;
        }
        priorCodeReviews.push(codeReview);
        if (fixes === allowedReviewFixes) {
          const decision = await this.runRequiredHumanGate(
            "code_review_decision",
            "Code review decision",
            ctx,
            () => this.promptHumanReviewDecision(codeReview!, fixes, ctx)
          );
          if (decision.action === "accept") {
            reviewApproved = true;
            reviewApprovalSource = "user_override";
            this.publishSessionMessage(formatApprovedReview(codeReview, finalImplChecks ?? [], fixes, "user_override"), { kind: "review_approved" });
            break;
          }
          if (decision.action === "fix_again") {
            allowedReviewFixes++;
          } else {
            throw new WorkflowCancelledError("Workflow cancelled after code review", "human_gate");
          }
        }
        const reviewOut = await this.runAgentStep(
          "builder",
          "implementing",
          "Address code review",
          { action: "address_review", request, plan, baseline: this.requireBaselineReviewContext(), review: codeReview, priorReviews: priorCodeReviews.slice(0, -1), revision: fixes + 1 },
          mutationCwd,
          ctx,
          parseBuilderOutput,
          { revision: fixes + 1, mutationPlan: plan }
        );
        this.builderSessionOutputs.push(reviewOut);
        const reviewFixChecks = await this.runCheckStep("testing", `Run checks after review fix ${fixes + 1}`, mutationCwd, ctx, {
          requireGreen: true,
          revision: fixes + 1,
          kind: "review-fix"
        });
        if (!allGreen(reviewFixChecks, config.checks.length)) {
          throw new Error(`Checks failed after review fix ${fixes + 1}`);
        }
        finalImplChecks = reviewFixChecks;
      }
      if (!reviewApproved || !codeReview) throw new Error("Code review was not approved within the revision limit");

      const documentation = await this.runAgentStep(
        "documenter",
        "documenting",
        "Update documentation and propose lessons",
        {
          action: "document",
          request,
          plan,
          baselineChecks: baseline,
          codeReview,
          approvalSource: reviewApprovalSource,
          implementationChecks: finalImplChecks,
          builderOutputs: this.builderSessionOutputs,
          tester
        },
        mutationCwd,
        ctx,
        parseDocumenterOutput,
        { mutationPlan: plan }
      );
      // --- Lesson candidates, machine screening, human approval, and promotion ---

      this.candidateLessons = validateCandidates(documentation.proposedLessons.map((lesson, index) => ({
        id: candidateLessonId(runId, index + 1),
        title: lesson.title,
        guidance: lesson.lesson,
        scope: lesson.scope,
        evidence: lesson.evidence
      })));
      const proposedCandidates = this.candidateLessons.slice();
      let machineEligibleCount = 0;
      let machineRejectedCount = 0;
      let duplicateCount = 0;
      const duplicateCandidateIds = new Set<string>();

      await store.saveJson("proposed-lessons.json", documentation.proposedLessons);

      if (this.candidateLessons.length === 0) {
        this.lessonStatus = "skipped";
        await store.saveJson("proposed-lessons-status.json", { status: "skipped", reason: "none_proposed" });
      } else {
        this.state.stage = "screening_lessons";
        const lessonReview = await this.runAgentStep(
          "reviewer",
          "screening_lessons",
          "Screen proposed lessons",
          { reviewType: "lessons", request, lessons: documentation.proposedLessons },
          mutationCwd,
          ctx,
          parseReviewOutput
        );
        if (lessonReview.decision === "changes_requested") {
          this.state.warning = "Proposed lessons were rejected by review; verified code remains complete";
          this.lessonStatus = "rejected";
          machineRejectedCount = this.candidateLessons.length;
          await store.saveJson("proposed-lessons-status.json", { status: "rejected", review: lessonReview });
        } else {
          const { eligible, duplicates } = this.memoryMode === "valid"
            ? deduplicateAgainstMemory(this.candidateLessons, this.loadedMemoryDoc!.lessons)
            : { eligible: this.candidateLessons.slice(), duplicates: [] };
          machineEligibleCount = eligible.length;
          duplicateCount = duplicates.length;
          for (const duplicate of duplicates) duplicateCandidateIds.add(duplicate.id);
          this.candidateLessons = eligible;
          this.lessonStatus = "approved";
          await store.saveJson("proposed-lessons-status.json", { status: "machine_approved", review: lessonReview });
          if (duplicates.length > 0) {
            await store.saveJson("candidate-duplicates.json", duplicates.map(d => ({ id: d.id, title: d.title })));
          }
        }
      }

      this.publishSessionMessage(
        formatDocumentationReport(documentation, this.lessonStatus),
        { kind: "documentation_updated" }
      );

      const finalChecks = await this.runCheckStep("testing", "Run final checks after all agent sessions", mutationCwd, ctx, { requireGreen: true, kind: "final" });
      this.throwIfAborted();

      let synchronizedFiles: string[] | undefined;
      if (worktreeHandle) {
        const activeWorktree = worktreeHandle;
        const pendingChanges = await collectWorktreeChanges(activeWorktree);
        await store.saveRaw("worktree-final.patch", pendingChanges.patch.toString("utf8"));
        this.throwIfAborted();
        if (this.enforceWorkspacePolicy) this.validateFinalWorktreeChanges(activeWorktree, pendingChanges.changedFiles);
        this.mutationCommitStarted = true;
        try {
          const synchronized = await syncWorktreeChanges(activeWorktree);
          synchronizedFiles = synchronized.changedFiles;
          for (const file of synchronized.changedFiles) this.validatedChangedFiles.add(file);
          worktreeSynced = true;
          this.state.message = `Synchronized ${synchronized.changedFiles.length} validated file(s) from the mutation worktree`;
        } catch (error) {
          retainWorktree = true;
          this.state.warning = `Worktree synchronization failed; recovery worktree retained at ${activeWorktree.worktreeRoot}`;
          throw error;
        }
        try {
          await removeWorktree(activeWorktree);
          worktreeHandle = undefined;
        } catch (error) {
          this.state.warning = `Validated changes were synchronized, but worktree cleanup failed: ${messageOf(error)}`;
          ctx.ui.notify(this.state.warning, "warning");
        }
      }

      const finalChecksDigest = computeFinalChecksDigest(finalChecks);
      await store.saveJson("final-checks-digest.json", { digest: finalChecksDigest });
      this.candidateLedger = createCandidateLedger(cwd, runId, proposedCandidates, finalChecksDigest, EXTENSION_VERSION, this.timestamp());
      for (const candidate of proposedCandidates) {
        if (this.lessonStatus === "rejected") {
          this.candidateLedger = setCandidateState(this.candidateLedger, candidate.id, "machine_rejected", "lesson review rejected the candidate", this.timestamp());
          continue;
        }
        this.candidateLedger = setCandidateState(this.candidateLedger, candidate.id, "machine_approved", "lesson review approved the candidate", this.timestamp());
        this.candidateLedger = setCandidateState(
          this.candidateLedger,
          candidate.id,
          duplicateCandidateIds.has(candidate.id) ? "duplicate" : "pending",
          duplicateCandidateIds.has(candidate.id) ? "content already exists in memory" : "awaiting human decision",
          this.timestamp()
        );
      }
      this.candidateLedger = await saveCandidateLedger(cwd, this.candidateLedger);
      await store.saveJson("pending-candidates.json", this.candidateLedger.candidates.filter(candidate => candidate.state === "pending"));
      await store.flush();

      const eligibleCandidates = this.candidateLedger.candidates.filter(candidate => candidate.state === "pending");
      if (eligibleCandidates.length > 0 && ctx.hasUI && this.memoryMode !== "untrusted") {
        this.state.waitingFor = `Memory approval: ${eligibleCandidates.length} candidate(s)`;
        this.state.stage = "human_review_lessons";
        await this.persist(ctx);
        const decision = await this.promptHumanMemoryApproval(eligibleCandidates, ctx);
        this.state.waitingFor = undefined;
        for (const id of decision.declinedIds) {
          this.candidateLedger = setCandidateState(this.candidateLedger, id, "declined", "human declined", this.timestamp());
        }
        for (const id of decision.approvedIds) {
          this.candidateLedger = setCandidateState(this.candidateLedger, id, "promotion_pending", "human approved", this.timestamp());
        }
        this.candidateLedger = await saveCandidateLedger(cwd, this.candidateLedger);
        await store.saveJson("human-approvals.json", decision);

        if (decision.approvedIds.length > 0) {
          if (!projectTrusted(ctx)) {
            ctx.ui.notify("Project trust changed; approved lessons remain pending", "warning");
            for (const id of decision.approvedIds) {
              this.candidateLedger = setCandidateState(this.candidateLedger, id, "pending", "project is not trusted", this.timestamp());
            }
          } else if (this.memoryMode !== "invalid" && this.memoryMode !== "scope_mismatch" && this.memoryMode !== "unsupported") {
            this.state.stage = "promoting_memory";
            await this.persist(ctx);
            const toPromote = eligibleCandidates.filter(candidate => decision.approvedIds.includes(candidate.id));
            const now = this.timestamp();
            const lessons = toPromote.map(candidate => validateNewLesson(
              permanentLessonId(runId, candidate.id),
              candidate.title,
              candidate.guidance,
              candidate.scope,
              candidate.evidence,
              {
                sourceRunId: runId,
                candidateId: candidate.id,
                finalChecksDigest,
                approvedAt: now,
                extensionVersion: EXTENSION_VERSION,
              }
            ));
            this.promotionResult = await promoteLessons(cwd, lessons, this.memoryRevision);
            const promotedIds = new Set(this.promotionResult.promoted);
            const failedIds = new Set(this.promotionResult.failed.map(item => item.candidateId));
            for (const candidate of toPromote) {
              const lessonId = permanentLessonId(runId, candidate.id);
              const next = promotedIds.has(lessonId)
                ? "promoted"
                : this.promotionResult.retryable
                  ? "pending"
                  : failedIds.has(candidate.id) || this.promotionResult.error
                    ? "promotion_failed"
                    : "duplicate";
              this.candidateLedger = setCandidateState(this.candidateLedger, candidate.id, next, this.promotionResult.error, this.timestamp());
            }
            await store.saveJson("promotion-result.json", this.promotionResult);
          } else {
            for (const id of decision.approvedIds) {
              this.candidateLedger = setCandidateState(this.candidateLedger, id, "promotion_failed", `memory is ${this.memoryMode}`, this.timestamp());
            }
          }
        }
        this.candidateLedger = await saveCandidateLedger(cwd, this.candidateLedger);
      }

      const candidateCounts = countCandidateStates(this.candidateLedger);
      const humanApprovedCount = candidateCounts.promoted + candidateCounts.promotion_failed + candidateCounts.promotion_pending;
      const humanDeclinedCount = candidateCounts.declined;
      const promotedCount = candidateCounts.promoted;
      const promotionFailedCount = candidateCounts.promotion_failed;
      const pendingCount = candidateCounts.pending + candidateCounts.promotion_pending;

      const reportedChanged = [...new Set([
        ...(tester.changedFiles ?? []),
        ...this.builderSessionOutputs.flatMap(b => b.changedFiles),
        ...documentation.changedFiles,
      ])];
      const allChanged = synchronizedFiles ?? (this.enforceWorkspacePolicy ? [...this.validatedChangedFiles].sort() : reportedChanged);

      const completionSummary: CompletionSummary = {
        request,
        planSummary: plan.summary,
        changedFiles: allChanged,
        testsAdded: tester.testsAdded ?? [],
        checks: finalChecks,
        attempts: this.state.attempt,
        baselineRepaired: this.baselineRepaired,
        review: {
          outcome: reviewApprovalSource === "user_override" ? "accepted_by_user" : "reviewer_approved",
          evidenceCount: codeReview?.evidence.length ?? 0,
          suggestions: codeReview?.suggestions ?? [],
          blockingIssues: codeReview?.blockingIssues ?? [],
          revisions: priorCodeReviews.length,
        },
        documentation: {
          changed: documentation.changedFiles.length > 0,
          summary: documentation.summary,
        },
        lessons: {
          status: this.lessonStatus,
          count: documentation.proposedLessons.length,
        },
        memory: {
          mode: this.memoryMode,
          loadedRevision: this.memoryRevision,
          selectedCount: this.selectedMemoryIds.size,
          candidates: {
            proposed: documentation.proposedLessons.length,
            machineEligible: machineEligibleCount,
            machineRejected: machineRejectedCount,
            duplicates: duplicateCount,
            humanApproved: humanApprovedCount,
            humanDeclined: humanDeclinedCount,
            pending: pendingCount,
            promoted: promotedCount,
            promotionFailed: promotionFailedCount,
          },
        },
      };
      await store.saveJson("completion-summary.json", completionSummary);

      this.state.status = "completed";
      this.state.completedAt = this.timestamp();
      await this.transition("completed", undefined, "Workflow completed", ctx);
      this.publishSessionMessage(
        formatCompletedRun(completionSummary, this.state.dashboardUrl, this.state.runDir, this.state.warning, EXTENSION_VERSION),
        { kind: "completed" }
      );
      await store.flush();
      ctx.ui.notify("piOrchestrator workflow completed", "info");
    } catch (error) {
      await this.fail(error, ctx);
    } finally {
      if (this.persistTimer) {
        clearTimeout(this.persistTimer);
        this.persistTimer = undefined;
      }
      if (worktreeHandle && !worktreeSynced && !retainWorktree) {
        await removeWorktree(worktreeHandle).catch(error => {
          ctx.ui.notify(`Failed to remove mutation worktree: ${messageOf(error)}`, "warning");
        });
      }
      await store.flush().catch(error => {
        ctx.ui.notify(`Failed to flush run artifacts: ${messageOf(error)}`, "error");
      });
    }
  }

  cancel(source: "command" | "shutdown" = "command"): boolean {
    if (!this.activeRun || !this.controller || this.controller.signal.aborted || this.mutationCommitStarted) return false;
    this.controller.abort(new WorkflowCancelledError(`Workflow cancelled by ${source}`, source));
    return true;
  }

  async startDashboard(cwd?: string): Promise<string> {
    const url = await this.dashboard.start(this.config?.dashboard.port ?? 0);
    if (this.state) {
      this.state.dashboardUrl = url;
      const vm = this.getViewModel();
      if (vm) this.dashboard.publish(vm);
    } else if (cwd) {
      const { inspectConfig } = await import("./config.js");
      const configSummary = await inspectConfig(cwd);
      const vm = buildIdleViewModel(cwd, configSummary);
      this.dashboard.publish(vm);
    }
    return url;
  }

  async saveAgentSettings(cwd: string, updates: AgentModelUpdates): Promise<OrchestratorConfig> {
    return this.saveAgentConfig(cwd, config => applyAgentModelUpdates(config, updates));
  }

  async saveAgentModel(
    cwd: string,
    agent: AgentName,
    model: string,
    thinking: ThinkingLevel | null | undefined
  ): Promise<OrchestratorConfig> {
    return this.saveAgentConfig(cwd, config => {
      const updated = structuredClone(config);
      updated.agents[agent].model = model.trim();
      if (thinking === null) delete updated.agents[agent].thinking;
      else if (thinking !== undefined) updated.agents[agent].thinking = thinking;
      return updated;
    });
  }

  private async saveAgentConfig(
    cwd: string,
    update: (config: OrchestratorConfig) => OrchestratorConfig
  ): Promise<OrchestratorConfig> {
    if (this.isRunning()) throw new Error("Agent models cannot be changed while a workflow is running");
    if (this.settingsUpdateActive) throw new Error("Another agent settings update is already active");
    this.settingsUpdateActive = true;
    try {
      const current = await loadConfig(cwd);
      const candidate = update(current);
      const controller = new AbortController();
      await this.agents.preflight(candidate, cwd, this.extensionRoot, controller.signal, candidate.limits.agentTimeoutMs);
      await saveConfig(cwd, candidate);
      this.config = candidate;
      return candidate;
    } finally {
      this.settingsUpdateActive = false;
    }
  }

  setOnStateChange(
    handler: ((state: WorkflowState, config: OrchestratorConfig, ctx: ExtensionCommandContext) => void) | undefined
  ): void {
    this.onStateChange = handler;
  }

  getConfigForPublish(): OrchestratorConfig | undefined {
    return this.config;
  }

  async shutdown(ctx?: Pick<ExtensionCommandContext, "hasUI" | "ui">): Promise<void> {
    this.cancel("shutdown");
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
    }
    await this.activeRun?.catch(() => undefined);
    await this.store?.flush().catch(() => undefined);
    await this.dashboard.stop();
    if (ctx) clearTerminal(ctx);
  }

  private async runAgentStep<A extends AgentName>(
    agent: A,
    stage: Stage,
    label: string,
    payload: AgentTaskMap[A],
    cwd: string,
    ctx: ExtensionCommandContext,
    validate: (text: string) => AgentOutputMap[A],
    qualifier: { attempt?: number; revision?: number; mutationPlan?: PlannerOutput } = {}
  ): Promise<AgentOutputMap[A]> {
    const config = this.requireConfig();
    const controller = this.requireController();
    const state = this.requireState();
    const store = this.requireStore();
    // Clear previous agent activity
    state.currentTool = undefined;
    state.currentToolArgs = undefined;
    state.agentOutput = undefined;
    state.toolStatus = undefined;
    const step = this.beginStep(stage, label, agent, qualifier);
    const status = state.agents[agent];
    status.status = "running";
    status.startedAt = step.startedAt;
    delete status.error;
    await this.transition(stage, agent, `${agent} is running`, ctx);
    const beforeWorkspace = this.enforceWorkspacePolicy
      ? await createWorkspaceSnapshot(cwd, { excludedRoots: this.workspaceExclusions(cwd) })
      : undefined;
    let rawText: string | undefined;
    try {
      const onEvent = (event: Parameters<NonNullable<AgentRunOptions["onEvent"]>>[0]): void => {
        void store.event("agent_event", { stepId: step.id, agent, event }).catch(() => undefined);
        this.updateAgentActivity(event);
        this.throttledPersist(ctx);
      };
      const runBase = {
        name: agent,
        cwd,
        extensionRoot: this.extensionRoot,
        config: config.agents[agent],
        timeoutMs: config.limits.agentTimeoutMs,
        signal: controller.signal,
        onEvent,
        allowedWritePaths: qualifier.mutationPlan ? deriveRoleMutationPaths(agent, qualifier.mutationPlan) : [],
        readRoots: [store.runDir]
      } satisfies Omit<AgentRunOptions, "task">;

      if (!projectTrusted(ctx)) {
        this.memoryMode = "untrusted";
        this.loadedMemoryDoc = null;
      }
      const memoryEnvelope = this.getMemoryEnvelope(agent) ?? null;
      const executeEnvelope: AgentTaskEnvelope<AgentTaskMap[A]> = {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode: "execute",
        task: payload,
        memoryContext: memoryEnvelope
      };

      let result = await this.agents.run({ ...runBase, task: JSON.stringify(executeEnvelope, null, 2) });
      rawText = result.text;
      let output: AgentOutputMap[A];
      try {
        output = validate(result.text);
      } catch (validationError) {
        const rawArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "invalid-output-attempt-1", extension: "txt" });
        step.rawArtifact = await store.saveRaw(rawArtifact, result.text);

        if (!OUTPUT_CORRECTABLE_AGENTS.has(agent)) {
          throw new Error(`${agent} returned invalid structured output after a potentially mutating session: ${messageOf(validationError)}`);
        }

        const rawPath = validationError instanceof ValidationError ? validationError.path : undefined;
        const fieldPath = rawPath && /^[a-zA-Z0-9_.\[\]-]+$/.test(rawPath) ? rawPath : undefined;
        const correctionEnvelope: AgentTaskEnvelope<AgentTaskMap[A]> = {
          taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
          mode: "correct_output",
          task: payload,
          memoryContext: memoryEnvelope,
          correction: {
            attempt: 1,
            reason: "schema_validation_failed",
            ...(fieldPath ? { fieldPath } : {})
          }
        };
        const correctionConfig = {
          ...runBase.config,
          tools: runBase.config.tools.filter(tool => CORRECTION_TOOLS.has(tool))
        };
        result = await this.agents.run({ ...runBase, config: correctionConfig, task: JSON.stringify(correctionEnvelope, null, 2) });
        rawText = result.text;
        try {
          output = validate(result.text);
        } catch (correctionError) {
          const secondRawArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "invalid-output-attempt-2", extension: "txt" });
          step.rawArtifact = await store.saveRaw(secondRawArtifact, result.text);
          throw correctionError;
        }
      }
      if (beforeWorkspace) {
        const afterWorkspace = await createWorkspaceSnapshot(cwd, { excludedRoots: this.workspaceExclusions(cwd) });
        const delta = compareWorkspaceSnapshots(beforeWorkspace, afterWorkspace);
        await this.validateAgentMutation(agent, qualifier.mutationPlan, output, delta, step, store);
      }
      const artifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "output" });
      step.artifact = await store.saveJson(artifact, { output, usage: result.usage });
      this.throwIfAborted();
      step.status = "succeeded";
      step.message = `${agent} completed`;
      status.status = "succeeded";
      status.summary = result.text.slice(0, 500);
      status.completedAt = this.timestamp();
      return output;
    } catch (error) {
      const cancelled = controller.signal.aborted || error instanceof AgentCancelledError;
      step.status = cancelled ? "cancelled" : "failed";
      step.message = messageOf(error);
      status.status = cancelled ? "cancelled" : "failed";
      status.error = messageOf(error);
      status.completedAt = this.timestamp();
      if (rawText === undefined) {
        const errorArtifact = store.artifactName({ ...qualifier, sequence: step.sequence, stage, agent, kind: "execution-error" });
        step.artifact = await store.saveJson(errorArtifact, { error: messageOf(error) });
      }
      throw error;
    } finally {
      step.completedAt = this.timestamp();
      state.activeAgent = undefined;
      await this.persist(ctx);
    }
  }

  private async runCheckStep(
    stage: Stage,
    label: string,
    cwd: string,
    ctx: ExtensionCommandContext,
    options: { requireGreen: boolean; attempt?: number; revision?: number; kind?: string }
  ): Promise<CheckResult[]> {
    const config = this.requireConfig();
    const controller = this.requireController();
    const step = this.beginStep(stage, label, undefined, options);
    await this.transition(stage, undefined, label, ctx);
    const beforeWorkspace = this.enforceWorkspacePolicy
      ? await createWorkspaceSnapshot(cwd, { excludedRoots: this.workspaceExclusions(cwd) })
      : undefined;
    try {
      const checkOptions: CheckRunOptions = {
        exec: (command, args, execOptions) => this.pi.exec(command, args, execOptions),
        timeoutMs: config.limits.checkTimeoutMs,
        maxOutputBytes: config.limits.maxOutputBytes,
        now: this.now
      };
      const results = await this.checks(config.checks, cwd, controller.signal, checkOptions);
      if (beforeWorkspace) {
        const afterWorkspace = await createWorkspaceSnapshot(cwd, { excludedRoots: this.workspaceExclusions(cwd) });
        const delta = compareWorkspaceSnapshots(beforeWorkspace, afterWorkspace);
        if (delta.changedFiles.length > 0) {
          const mutationArtifact = this.requireStore().artifactName({
            sequence: step.sequence,
            stage,
            attempt: options.attempt,
            revision: options.revision,
            kind: "check-mutation"
          });
          step.artifact = await this.requireStore().saveJson(mutationArtifact, { actual: delta, violations: delta.changedFiles });
          throw new MutationBoundaryError(`Configured checks changed project files: ${delta.changedFiles.join(", ")}`);
        }
      }
      const artifact = this.requireStore().artifactName({
        sequence: step.sequence,
        stage,
        attempt: options.attempt,
        revision: options.revision,
        kind: options.kind ?? "checks"
      });
      step.artifact = await this.requireStore().saveJson(artifact, results);
      if (controller.signal.aborted || results.some(result => result.cancelled)) throw new Error("Checks cancelled");
      const infrastructureFailure = results.find(result => result.timedOut || result.executionError);
      if (infrastructureFailure) {
        throw new Error(`Check could not complete: ${infrastructureFailure.command} (${infrastructureFailure.executionError ?? "timeout"})`);
      }
      if (options.requireGreen && !allGreen(results, config.checks.length)) {
        throw new Error(`${label} failed`);
      }
      this.throwIfAborted();
      step.status = "succeeded";
      step.message = allGreen(results, config.checks.length) ? "All checks passed" : "Checks completed with failures";
      return results;
    } catch (error) {
      step.status = controller.signal.aborted ? "cancelled" : "failed";
      step.message = messageOf(error);
      throw error;
    } finally {
      step.completedAt = this.timestamp();
      await this.persist(ctx);
    }
  }

  private workspaceExclusions(cwd: string): string[] {
    const runDir = this.requireStore().runDir;
    const relative = path.relative(cwd, runDir).split(path.sep).join("/");
    return relative && relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative) ? [relative] : [];
  }

  private validateFinalWorktreeChanges(handle: WorktreeHandle, repositoryPaths: readonly string[]): void {
    const projectPrefix = handle.projectRelativePath.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
    const projectFiles: string[] = [];
    const outsideProject: string[] = [];
    for (const repositoryPath of repositoryPaths) {
      const normalized = repositoryPath.replace(/\\/g, "/");
      if (!projectPrefix) projectFiles.push(normalized);
      else if (normalized === projectPrefix || normalized.startsWith(`${projectPrefix}/`)) {
        projectFiles.push(normalized.slice(projectPrefix.length).replace(/^\//, ""));
      } else outsideProject.push(normalized);
    }
    const unvalidated = projectFiles.filter(file => file && !this.validatedChangedFiles.has(file));
    if (outsideProject.length > 0 || unvalidated.length > 0) {
      const detail = [
        outsideProject.length ? `outside project: ${outsideProject.join(", ")}` : "",
        unvalidated.length ? `not validated: ${unvalidated.join(", ")}` : ""
      ].filter(Boolean).join("; ");
      throw new MutationBoundaryError(`Worktree contains changes that cannot be synchronized (${detail})`);
    }
  }

  private async validateAgentMutation<A extends AgentName>(
    agent: A,
    plan: PlannerOutput | undefined,
    output: AgentOutputMap[A],
    delta: WorkspaceDelta,
    step: StepRecord,
    store: RunStore
  ): Promise<void> {
    const mutation = ROLE_MUTATION_KINDS[agent];
    const reported = "changedFiles" in (output as object)
      ? ((output as unknown as { changedFiles: string[] }).changedFiles ?? [])
      : [];
    const violations: string[] = [];
    try {
      if (mutation === "none") {
        if (delta.changedFiles.length > 0) throw new Error(`${agent} is read-only but changed ${delta.changedFiles.join(", ")}`);
      } else {
        if (!plan) throw new Error(`${agent} has no approved mutation plan`);
        validateRoleDelta(agent, plan, delta);
        validateReportedFileSet(reported, delta);
      }
    } catch (error) {
      violations.push(messageOf(error));
    }
    const artifact = store.artifactName({ sequence: step.sequence, stage: step.stage, agent, attempt: step.attempt, revision: step.revision, kind: "mutation" });
    await store.saveJson(artifact, {
      role: agent,
      policy: mutation,
      allowed: plan ? deriveRoleMutationPaths(agent, plan) : [],
      reported,
      actual: delta,
      violations
    });
    if (violations.length > 0) throw new MutationBoundaryError(violations.join("; "));
    for (const file of delta.changedFiles) this.validatedChangedFiles.add(file);
  }

  private shouldSuggestHumanTouchpoints(config: OrchestratorConfig, ctx: ExtensionCommandContext): boolean {
    if (!ctx.hasUI) return false;
    return !config.humanInTheLoop.planApproval
      && !config.humanInTheLoop.planRevisionApproval
      && !config.humanInTheLoop.confirmBeforeMutation;
  }

  private async suggestHumanTouchpoints(cwd: string, config: OrchestratorConfig, ctx: ExtensionCommandContext): Promise<void> {
    try {
      const enableAll = await ctx.ui.confirm(
        "You can be involved in the workflow",
        "You can review and approve plans before they are executed. " +
        "Would you like to enable human review of the implementation plan? " +
        "You can always change this later in the config."
      );
      if (!enableAll) return;
      const choices = await ctx.ui.select(
        "Which stages would you like to review?",
        [
          "Plan approval (Recommended — review plan before implementation)",
          "Plan + revisions (Recommended — review plan and any revisions)",
          "All touchpoints (Plan, revisions, and confirmation before code changes)"
        ]
      );
      if (!choices) return;
      config.humanInTheLoop.planApproval = true;
      if (choices.startsWith("Plan + revisions") || choices.startsWith("All touchpoints")) {
        config.humanInTheLoop.planRevisionApproval = true;
      }
      if (choices.startsWith("All touchpoints")) {
        config.humanInTheLoop.confirmBeforeMutation = true;
      }
      await saveConfig(cwd, config);
      ctx.ui.notify("Human touchpoints enabled and saved to config. You can edit .pi/orchestrator/config.json to adjust.", "info");
    } catch {
      // Suggestion is best-effort; the workflow continues with defaults.
    }
  }

  private async runRequiredHumanGate<T>(
    kind: HumanGateState["kind"],
    label: string,
    ctx: ExtensionCommandContext,
    interaction: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    if (!ctx.hasUI || ctx.mode === "json" || ctx.mode === "print") {
      throw new HumanGateUnavailableError(`${label} requires TUI or RPC mode`);
    }
    const state = this.requireState();
    const signal = this.requireController().signal;
    state.humanGate = { kind, label, startedAt: this.timestamp() };
    state.waitingFor = label;
    await this.persist(ctx);
    try {
      return await interaction(signal);
    } catch (error) {
      if (error instanceof WorkflowTerminationError) throw error;
      if (signal.aborted) {
        const reason = signal.reason;
        throw reason instanceof WorkflowCancelledError ? reason : new WorkflowCancelledError("Workflow cancelled", "command", { cause: error });
      }
      throw new GateInteractionError(`${label} interaction failed: ${messageOf(error)}`, { cause: error });
    } finally {
      state.humanGate = undefined;
      state.waitingFor = undefined;
      await this.persist(ctx).catch(() => undefined);
    }
  }

  private async promptHumanPlanReview(
    plan: PlannerOutput,
    label: string,
    ctx: ExtensionCommandContext
  ): Promise<HumanPlanReviewResult | undefined> {
    if (!ctx.hasUI) {
      throw new HumanGateUnavailableError(`${label} requires TUI or RPC mode`);
    }
    const signal = this.requireController().signal;
    const planText = formatPlanForReview(plan);
    const title = `${label}

Review the plan below. You can approve, request changes, or cancel.`;
    const _viewed = await raceWithAbort(ctx.ui.editor(title, planText), signal);
    if (_viewed === undefined) return undefined;
    const decision = await ctx.ui.select(`${label} — What would you like to do?`, [
      "Approve plan",
      "Request changes",
      "Cancel workflow"
    ], { signal });
    if (!decision || decision === "Cancel workflow") return undefined;
    if (decision === "Approve plan") return { approved: true };
    const feedback = await ctx.ui.input("Describe what changes you need:", "e.g. Add error handling to the login task", { signal });
    if (feedback === undefined) return undefined;
    return { approved: false, feedback };
  }

  private async promptHumanReviewDecision(
    review: ReviewOutput,
    completedFixes: number,
    ctx: ExtensionCommandContext
  ): Promise<HumanReviewDecision> {
    if (!ctx.hasUI) {
      throw new Error(
        `Code review was not approved within the revision limit.\n\n` +
        `Final review blocking issues:\n${review.blockingIssues.map((i, idx) => `  ${idx + 1}. ${i}`).join("\n")}`
      );
    }
    const issues = review.blockingIssues.map((i, idx) => `${idx + 1}. ${i}`).join("\n");
    const title = `Code review not approved after ${completedFixes} fix round(s).

Blocking issues:
${issues}

What would you like to do?`;
    const decision = await ctx.ui.select(title, [
      "Accept current implementation",
      "Allow one more targeted fix",
      "Abort workflow"
    ], { signal: this.requireController().signal });
    if (!decision || decision === "Abort workflow") return { action: "abort" };
    if (decision === "Accept current implementation") return { action: "accept" };
    return { action: "fix_again" };
  }

  private async promptHumanMemoryApproval(
    candidates: CandidateLesson[],
    ctx: ExtensionCommandContext
  ): Promise<{ approvedIds: string[]; declinedIds: string[] }> {
    const signal = this.requireController().signal;
    const summary = candidates.map((candidate, index) => `${index + 1}. ${formatCandidateForApproval(candidate)}`).join("\n\n");
    const action = await ctx.ui.select(
      `Lessons learned (${candidates.length} eligible for memory)\n\n${summary}\n\nPromote lessons to project memory for future workflows?`,
      [
        "Promote all",
        candidates.length > 1 ? "Review individually" : null,
        "Decline all",
        "Defer all"
      ].filter((s): s is string => s !== null)
    , { signal });
    if (!action || action === "Defer all") return { approvedIds: [], declinedIds: [] };
    if (action === "Promote all") return { approvedIds: candidates.map(candidate => candidate.id), declinedIds: [] };
    if (action === "Decline all") return { approvedIds: [], declinedIds: candidates.map(candidate => candidate.id) };
    const approvedIds: string[] = [];
    const declinedIds: string[] = [];
    for (const candidate of candidates) {
      const decision = await ctx.ui.select(
        formatCandidateForApproval(candidate),
        ["Approve", "Decline", "Defer", "Stop reviewing"],
        { signal }
      );
      if (!decision || decision === "Stop reviewing") break;
      if (decision === "Approve") approvedIds.push(candidate.id);
      if (decision === "Decline") declinedIds.push(candidate.id);
    }
    return { approvedIds, declinedIds };
  }

  private beginStep(
    stage: Stage,
    label: string,
    agent?: AgentName,
    qualifier: { attempt?: number; revision?: number } = {}
  ): StepRecord {
    const state = this.requireState();
    const sequence = state.steps.length + 1;
    const step: StepRecord = {
      id: `step-${String(sequence).padStart(3, "0")}`,
      sequence,
      stage,
      label,
      status: "running",
      agent,
      attempt: qualifier.attempt,
      revision: qualifier.revision,
      startedAt: this.timestamp()
    };
    state.steps.push(step);
    return step;
  }

  private async fail(error: unknown, ctx: ExtensionCommandContext): Promise<void> {
    const state = this.state;
    const controller = this.controller;
    if (!state || !controller) throw error;
    const abortReason = controller.signal.reason;
    const effectiveError = controller.signal.aborted && abortReason instanceof Error ? abortReason : error;
    const cancelled = effectiveError instanceof WorkflowCancelledError || controller.signal.aborted || error instanceof AgentCancelledError;
    state.stoppedStage = state.stage;
    state.failedStage = cancelled ? undefined : state.stage;
    state.status = cancelled ? "cancelled" : "failed";
    state.completedAt = this.timestamp();
    state.waitingFor = undefined;
    state.humanGate = undefined;
    const msg = messageOf(effectiveError);
    const termination = effectiveError instanceof WorkflowTerminationError
      ? { ...effectiveError.termination, stoppedStage: state.stoppedStage }
      : {
          kind: cancelled ? "cancelled" as const : "workflow_failed" as const,
          code: cancelled ? "cancelled" as const : "workflow_failed" as const,
          status: cancelled ? "cancelled" as const : "failed" as const,
          message: msg,
          stoppedStage: state.stoppedStage
        };
    state.termination = termination;
    try {
      await this.transition(cancelled ? "cancelled" : "failed", undefined, msg, ctx);
    } catch {
      state.stage = cancelled ? "cancelled" : "failed";
      state.message = msg;
    }
    try {
      const formatted = cancelled
        ? formatCancelledRun(state.stoppedStage ?? state.stage, msg, state.runDir)
        : formatFailedRun(state.stoppedStage ?? state.stage, msg, state.runDir);
      this.publishSessionMessage(formatted, { kind: cancelled ? "cancelled" : "failed" });
    } catch {
      // Session messaging is supplementary.
    }
    ctx.ui.notify(state.message ?? msg, cancelled ? "warning" : "error");
  }

  private publishSessionMessage(content: string, details?: Record<string, unknown>): void {
    try {
      this.pi.sendMessage({
        customType: "pi-orchestrator",
        content,
        display: true,
        details: { runId: this.state?.runId, ...details }
      });
    } catch {
      // Session messaging is supplementary; never fail the workflow.
    }
  }

  private async transition(stage: Stage, activeAgent: AgentName | undefined, message: string, ctx: ExtensionCommandContext): Promise<void> {
    const state = this.requireState();
    state.stage = stage;
    state.activeAgent = activeAgent;
    state.message = message;
    state.updatedAt = this.timestamp();
    await this.store?.event("transition", { stage, activeAgent, message });
    await this.persist(ctx);
  }

  private async persist(ctx: ExtensionCommandContext): Promise<void> {
    const state = this.requireState();
    await this.store?.saveState(state);
    const vm = this.getViewModel();
    if (vm) this.dashboard.publish(vm);
    if (this.config && this.onStateChange) {
      this.onStateChange(state, this.config, ctx);
    }
    try {
      this.pi.appendEntry("pi-orchestrator-run", {
        runId: state.runId,
        stage: state.stage,
        failedStage: state.failedStage,
        stoppedStage: state.stoppedStage,
        termination: state.termination,
        status: state.status,
        runDir: state.runDir
      });
    } catch {
      // Session persistence is supplementary; run artifacts remain authoritative.
    }
  }

  private throwIfAborted(): void {
    const signal = this.requireController().signal;
    if (signal.aborted) {
      throw signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError("Workflow cancelled", "command");
    }
  }

  private updateAgentActivity(event: { type: string; toolName?: string; args?: string; isError?: boolean; text?: string }): void {
    const state = this.state;
    if (!state) return;
    switch (event.type) {
      case "tool_execution_start":
        state.currentTool = event.toolName;
        state.currentToolArgs = event.args;
        state.toolStatus = undefined;
        break;
      case "tool_execution_end":
        state.toolStatus = event.isError ? "error" : "ok";
        break;
      case "auto_retry_start":
        state.toolStatus = "retrying";
        break;
      case "message_update":
        if (event.text) {
          const lines = (state.agentOutput ?? []).concat(event.text);
          state.agentOutput = lines.slice(-5);
        }
        break;
    }
  }

  private throttledPersist(ctx: ExtensionCommandContext): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      const state = this.state;
      if (state) {
        state.updatedAt = this.timestamp();
        const vm = this.getViewModel();
        if (vm) this.dashboard.publish(vm);
        if (this.config && this.onStateChange) {
          this.onStateChange(state, this.config, ctx);
        }
      }
    }, 500);
  }

  private timestamp(): string { return this.now().toISOString(); }
  private requireState(): WorkflowState { if (!this.state) throw new Error("Orchestrator state is not initialized"); return this.state; }
  private requireStore(): RunStore { if (!this.store) throw new Error("Run store is not initialized"); return this.store; }
  private requireConfig(): OrchestratorConfig { if (!this.config) throw new Error("Orchestrator config is not initialized"); return this.config; }
  private requireController(): AbortController { if (!this.controller) throw new Error("Orchestrator controller is not initialized"); return this.controller; }
  private requireBaselineReviewContext(): BaselineReviewContext {
    if (!this.baselineReviewContext) throw new Error("Baseline review context is not initialized");
    return this.baselineReviewContext;
  }
}

function allGreen(results: CheckResult[], expected: number): boolean {
  return results.length === expected && expected > 0 && results.every(result => result.passed);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function projectTrusted(ctx: ExtensionCommandContext): boolean {
  return typeof ctx.isProjectTrusted === "function" && ctx.isProjectTrusted();
}

function countCandidateStates(ledger: CandidateLedger): Record<import("./memory-types.js").CandidateState, number> {
  const counts = {
    proposed: 0,
    machine_approved: 0,
    machine_rejected: 0,
    duplicate: 0,
    pending: 0,
    declined: 0,
    promotion_pending: 0,
    promotion_failed: 0,
    promoted: 0
  };
  for (const candidate of ledger.candidates) counts[candidate.state]++;
  return counts;
}

function formatCandidateForApproval(candidate: CandidateLesson): string {
  return [
    `[${candidate.id}] ${candidate.title}`,
    candidate.guidance,
    `Roles: ${candidate.scope.roles.join(", ") || "any"}`,
    `Paths: ${candidate.scope.paths.join(", ") || "none"}`,
    `Categories: ${candidate.scope.categories.join(", ") || "none"}`,
    `Keywords: ${candidate.scope.keywords.join(", ") || "none"}`,
    "Evidence:",
    ...candidate.evidence.map(item => `- ${item.path}: ${item.detail}`)
  ].join("\n");
}

async function raceWithAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError("Workflow cancelled", "command");
  let rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = (): void => rejectAbort(signal.reason instanceof Error ? signal.reason : new WorkflowCancelledError("Workflow cancelled", "command"));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
