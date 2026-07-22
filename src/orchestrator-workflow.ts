import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ensureChecksConfigured } from "./check-setup.js";
import { loadConfig } from "./config.js";
import { AGENT_NAMES, SCHEMA_VERSION } from "./types.js";
import { removeWorktree } from "./worktree.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { EXTENSION_VERSION, messageOf } from "./orchestrator-helpers.js";
import { shouldSuggestHumanTouchpoints, suggestHumanTouchpoints } from "./orchestrator-human-gates.js";
import { runPlanningPhase } from "./orchestrator-planning.js";
import { runImplementationPhase } from "./orchestrator-implementation.js";
import { runReviewPhase } from "./orchestrator-review.js";
import { runFinalizationPhase } from "./orchestrator-finalization.js";
import { fail, publishSessionMessage } from "./orchestrator-state.js";
import { formatStartedRun } from "./session-messages.js";

export async function runWorkflow(
  runtime: OrchestratorRuntime,
  request: string,
  ctx: ExtensionCommandContext,
  controller: AbortController
): Promise<void> {
  const cwd = ctx.cwd ?? process.cwd();
  const loadedConfig = await loadConfig(cwd);
  const config = await ensureChecksConfigured(cwd, loadedConfig, ctx);
  if (!config) return;
  runtime.config = config;
  if (controller.signal.aborted) throw new Error("Workflow cancelled");
  await runtime.loadProjectMemory(cwd, ctx);
  const runId = runtime.id();
  const store = runtime.storeFactory(cwd, runId);
  runtime.store = store;
  await store.init();
  runtime.activeTranscripts.clear();
  runtime.transcriptRevision = 0;
  const agents = Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle", model: config.agents[name].model }])) as NonNullable<typeof runtime.state>["agents"];
  runtime.state = {
    schemaVersion: SCHEMA_VERSION,
    extensionVersion: EXTENSION_VERSION,
    runId,
    request,
    cwd,
    runDir: store.runDir,
    stage: "idle",
    status: "running",
    attempt: 0,
    startedAt: runtime.timestamp(),
    updatedAt: runtime.timestamp(),
    agents,
    steps: []
  };
  runtime.builderSessionOutputs = [];
  runtime.baselineRepaired = false;
  runtime.lessonStatus = "skipped";
  runtime.selectedMemoryIds.clear();
  runtime.candidateLessons = [];
  runtime.candidateLedger = undefined;
  runtime.promotionResult = undefined;
  runtime.validatedChangedFiles.clear();
  runtime.mutationCommitStarted = false;
  runtime.baselineContext = await runtime.captureBaseline(cwd, store);
  await store.saveJson("baseline.json", runtime.baselineContext);
  const artifactRoot = path.relative(cwd, store.runDir).split(path.sep).join("/");
  runtime.baselineReviewContext = {
    summary: runtime.baselineContext,
    artifacts: {
      baselineJson: `${artifactRoot}/baseline.json`,
      ...(runtime.baselineContext.diffArtifact ? { headDiffPatch: `${artifactRoot}/${runtime.baselineContext.diffArtifact}` } : {}),
      ...(runtime.baselineContext.stagedArtifact ? { stagedDiffPatch: `${artifactRoot}/${runtime.baselineContext.stagedArtifact}` } : {})
    }
  };
  const workflow: WorkflowContext = {
    request,
    ctx,
    cwd,
    mutationCwd: cwd,
    runId,
    store,
    config,
    controller,
    worktreeSynced: false,
    retainWorktree: false,
    mutationConfirmed: false
  };

  try {
    if (shouldSuggestHumanTouchpoints(config, ctx)) await suggestHumanTouchpoints(cwd, config, ctx);
    if (config.dashboard.enabled) {
      try {
        runtime.state.dashboardUrl = await runtime.dashboard.start(config.dashboard.port);
        runtime.openBrowser(runtime.state.dashboardUrl);
      } catch (error) {
        runtime.state.warning = `Dashboard unavailable: ${messageOf(error)}`;
      }
    }
    publishSessionMessage(runtime, formatStartedRun(request, runId, store.runDir), { kind: "started" });
    const planning = await runPlanningPhase(runtime, workflow);
    const implementation = await runImplementationPhase(runtime, workflow, planning);
    const review = await runReviewPhase(runtime, workflow, implementation);
    await runFinalizationPhase(runtime, workflow, review);
  } catch (error) {
    await fail(runtime, error, ctx);
  } finally {
    if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
    runtime.persistTimer = undefined;
    if (workflow.worktreeHandle && !workflow.worktreeSynced && !workflow.retainWorktree) {
      await removeWorktree(workflow.worktreeHandle).catch(error => {
        ctx.ui.notify(`Failed to remove mutation worktree: ${messageOf(error)}`, "warning");
      });
    }
    await store.flush().catch(error => {
      ctx.ui.notify(`Failed to flush run artifacts: ${messageOf(error)}`, "error");
    });
  }
}
