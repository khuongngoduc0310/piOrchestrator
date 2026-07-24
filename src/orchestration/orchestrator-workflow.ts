import path from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "../config/config.js";
import { AGENT_NAMES, SCHEMA_VERSION, type WorkflowRequest } from "../types.js";
import { removeWorktree } from "../workspace/worktree.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { EXTENSION_VERSION, messageOf } from "./orchestrator-helpers.js";
import { shouldSuggestHumanTouchpoints, suggestHumanTouchpoints } from "./orchestrator-human-gates.js";
import { runPlanningPhase } from "./orchestrator-planning.js";
import { runSelectedRoute } from "./orchestrator-routes.js";
import { fail, persist, publishSessionMessage } from "./orchestrator-state.js";
import { formatStartedRun } from "../ui/session-messages.js";
import { CheckpointStore } from "../persistence/checkpoint-store.js";
import { currentWorkspaceDigest } from "./orchestrator-checkpoints.js";
import { WorkflowPausedError } from "./workflow-errors.js";

export async function runWorkflow(
  runtime: OrchestratorRuntime,
  input: WorkflowRequest,
  ctx: ExtensionCommandContext,
  controller: AbortController
): Promise<void> {
  const { request, route } = input;
  const cwd = ctx.cwd ?? process.cwd();
  const config = await loadConfig(cwd);
  runtime.config = config;
  if (controller.signal.aborted) throw new Error("Workflow cancelled");
  await runtime.loadProjectMemory(cwd, ctx);
  const runId = runtime.id();
  const store = runtime.storeFactory(cwd, runId);
  runtime.store = store;
  await store.init();
  const lease = await store.acquireLease();
  let workflow: WorkflowContext | undefined;
  try {
    runtime.activeTranscripts.clear();
    runtime.transcriptRevision = 0;
    const agents = Object.fromEntries(AGENT_NAMES.map(name => [name, { status: "idle", model: config.agents[name].model }])) as NonNullable<typeof runtime.state>["agents"];
    runtime.state = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: EXTENSION_VERSION,
      runId,
      request,
      route,
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
    runtime.validatedFileAttestations.clear();
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
    workflow = {
      route,
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
    if (shouldSuggestHumanTouchpoints(config, ctx)) await suggestHumanTouchpoints(cwd, config, ctx);
    if (config.dashboard.enabled) {
      try {
        runtime.state.dashboardUrl = await runtime.dashboard.start(config.dashboard.port);
        runtime.openBrowser(runtime.state.dashboardUrl);
      } catch (error) {
        runtime.state.warning = `Dashboard unavailable: ${messageOf(error)}`;
      }
    }
    publishSessionMessage(runtime, formatStartedRun(request, runId, store.runDir, route), { kind: "started" });
    const planning = await runPlanningPhase(runtime, workflow);
    await runSelectedRoute(runtime, workflow, planning);
  } catch (error) {
    if (error instanceof WorkflowPausedError) {
      const state = runtime.state;
      if (state) {
        state.status = "paused";
        await persist(runtime, ctx).catch(() => undefined);
      }
    } else {
      await fail(runtime, error, ctx);
    }
  } finally {
    if (runtime.persistTimer) clearTimeout(runtime.persistTimer);
    runtime.persistTimer = undefined;
    const finalState = runtime.state;
    const isPaused = finalState?.status === "paused";
    if (workflow?.worktreeHandle && !workflow.worktreeSynced && !workflow.retainWorktree && !isPaused) {
      try {
        const checkpoint = await new CheckpointStore(store.runDir, runId).loadLatest();
        if (checkpoint && checkpoint.worktreeHandle && checkpoint.workspaceDigest === await currentWorkspaceDigest(runtime, workflow.worktreeHandle.effectiveCwd)) {
          workflow.retainWorktree = true;
          runtime.requireState().warning = `Resumable mutation worktree retained at ${workflow.worktreeHandle.worktreeRoot}`;
        }
      } catch {
        // An unverifiable worktree is removed below.
      }
    } else if (isPaused && workflow?.worktreeHandle && !workflow.worktreeSynced) {
      workflow.retainWorktree = true;
    }
    if (workflow?.worktreeHandle && !workflow.worktreeSynced && !workflow.retainWorktree) {
      await removeWorktree(workflow.worktreeHandle).catch(error => {
        ctx.ui.notify(`Failed to remove mutation worktree: ${messageOf(error)}`, "warning");
      });
    }
    await store.flush().catch(error => {
      ctx.ui.notify(`Failed to flush run artifacts: ${messageOf(error)}`, "error");
    });
    await lease.release().catch(() => false);
  }
}
