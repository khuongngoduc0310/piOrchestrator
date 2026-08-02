import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AgentCancelledError, PiSdkAgentExecutor } from "../agents/agent-runner.js";
import { loadConfig as defaultLoadConfig } from "../config/config.js";
import { openBrowser as defaultOpenBrowser } from "./open-browser.js";
import { REQUIREMENTS_JSON, REQUIREMENTS_MARKDOWN, renderRequirementsMarkdown } from "../persistence/requirements-store.js";
import { selectWorkflowRoute } from "./route-selection.js";
import { MAX_INTERVIEW_ROUNDS, type InterviewerReport, type RequirementsDocument } from "../types.js";
import { askReview, askSet } from "./requirements-channels.js";
import { interviewerCall } from "./requirements-interviewer.js";
import {
  RequirementsCancelledError,
  RequirementsDeferredError,
  RequirementsSession,
  type RequirementsCommandDependencies
} from "./requirements-session.js";

export type { RequirementsCommandDependencies } from "./requirements-session.js";
export { RequirementsCancelledError, RequirementsSession } from "./requirements-session.js";
export { questionPresentation, reviewPresentation, commitPresentation, mapTuiChoice } from "./requirements-presentation.js";

export async function runRequirementsCommand(
  cwd: string,
  ctx: ExtensionCommandContext,
  deps: RequirementsCommandDependencies
): Promise<RequirementsSession | undefined> {
  if (!ctx.hasUI) {
    ctx.ui.notify("The requirements command requires an interactive UI.", "error");
    return undefined;
  }
  const goal = await ctx.ui.input("What goal should the requirements describe?");
  if (goal === undefined || !goal.trim()) {
    ctx.ui.notify("No goal entered; requirements session cancelled.", "warning");
    return undefined;
  }
  const session = new RequirementsSession(cwd, deps);
  session.goal = goal.trim();
  const executor = deps.executor ?? new PiSdkAgentExecutor();
  const startedAt = deps.now?.() ?? new Date();
  try {
    const config = await (deps.loadConfig ?? defaultLoadConfig)(cwd);
    session.interviewerModel = config.agents.interviewer?.model ?? "";
    await executor.preflight(config, cwd, deps.extensionRoot, session.controller.signal, config.limits.agentTimeoutMs, ["interviewer", "explorer"]);
    if (config.dashboard.enabled) {
      try {
        const url = await session.dashboard.start(0);
        session.dashboardUrl = url;
        (deps.openBrowser ?? defaultOpenBrowser)(url);
      } catch (error) {
        ctx.ui.notify(`Interview dashboard unavailable; answers are TUI-only: ${messageOf(error)}`, "warning");
      }
    }
    session.publish();

    const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
    if (!canPrompt && !session.dashboard.isListening) {
      throw new Error("The requirements interview requires a TUI dialog or the interview dashboard");
    }

    for (let round = 1; round <= MAX_INTERVIEW_ROUNDS; round++) {
      session.round = round;
      session.waitingFor = "Interviewer is preparing questions";
      session.interviewerStatus = "running";
      session.publish();
      const asked = await interviewerCall(session, executor, config, {
        action: "ask_questions",
        goal: session.goal,
        round,
        history: session.history,
        insights: session.insights
      });
      if (asked.action !== "ask_questions") throw new Error(`Interviewer returned ${asked.action} when asked for questions`);
      await askSet(session, ctx, asked.questions, round);

      session.waitingFor = "Interviewer is summarizing what it learned";
      session.interviewerStatus = "running";
      session.publish();
      const assessed = await interviewerCall(session, executor, config, {
        action: "assess",
        goal: session.goal,
        round,
        history: session.history,
        insights: session.insights
      });
      if (assessed.action !== "assess") throw new Error(`Interviewer returned ${assessed.action} when asked to assess`);
      session.waitingFor = "Reviewing the requirements with you";
      session.publish();
      let review: { clear: boolean; feedback?: string } | undefined;
      while (review === undefined) {
        review = await askReview(session, ctx, assessed.assessment, round);
      }
      if (review.clear) break;
      session.lastAssessmentNote = [
        assessed.assessment.summary,
        ...(assessed.assessment.openQuestions ?? []),
        ...(review.feedback ? [review.feedback] : [])
      ].join("; ");
      session.insights.push(
        assessed.assessment.summary,
        ...(assessed.assessment.openQuestions ?? []),
        ...(review.feedback ? [review.feedback] : [])
      );
      if (round === MAX_INTERVIEW_ROUNDS) {
        session.insights.push("Final round reached; finalize the report with the information gathered.");
      }
    }

    session.waitingFor = "Interviewer is finalizing the requirements report";
    session.interviewerStatus = "running";
    session.publish();
    const finalized = await interviewerCall(session, executor, config, {
      action: "finalize",
      goal: session.goal,
      history: session.history,
      insights: session.insights
    });
    if (finalized.action !== "finalize") throw new Error(`Interviewer returned ${finalized.action} when asked to finalize`);
    const document = buildRequirementsDocument(finalized.report, startedAt.toISOString());
    await session.store.saveDocument(document);
    await session.store.saveMarkdown(renderRequirementsMarkdown(document));
    session.requirement = {
      goal: finalized.report.goal,
      summary: finalized.report.summary,
      scope: finalized.report.scope,
      constraints: finalized.report.constraints,
      acceptanceCriteria: finalized.report.acceptanceCriteria,
      openQuestions: finalized.report.openQuestions
    };
    session.interviewerStatus = "succeeded";
    session.status = "completed";
    session.waitingFor = undefined;
    session.message = `Requirements saved to ${session.store.sessionDir}`;
    session.artifactPath = session.store.sessionDir;
    session.artifactNames = [REQUIREMENTS_MARKDOWN, REQUIREMENTS_JSON];
    session.publish();
    ctx.ui.notify(`Requirements saved to ${session.store.sessionDir}`, "info");
    await offerHandoff(ctx, deps, document);
  } catch (error) {
    const cancelled = error instanceof RequirementsCancelledError
      || error instanceof AgentCancelledError
      || session.controller.signal.aborted
      || (error instanceof Error && error.name === "AbortError");
    if (cancelled) {
      session.status = "cancelled";
      session.message = messageOf(error);
      session.interviewerStatus = "cancelled";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.pendingQuestions = [];
      session.publish();
      ctx.ui.notify(`Requirements interview cancelled: ${messageOf(error)}`, "warning");
    } else if (error instanceof RequirementsDeferredError) {
      session.status = "cancelled";
      session.message = error.message;
      session.interviewerStatus = "cancelled";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.pendingQuestions = [];
      session.publish();
      ctx.ui.notify(error.message, "warning");
    } else {
      session.status = "failed";
      session.message = messageOf(error);
      session.interviewerStatus = "failed";
      session.waitingFor = undefined;
      session.pendingDecision = undefined;
      session.pendingQuestions = [];
      session.publish();
      ctx.ui.notify(`Requirements interview failed: ${messageOf(error)}`, "error");
    }
  } finally {
    session.controller.abort(new Error("Requirements session ended"));
    await session.dashboard.stop().catch(() => undefined);
  }
  return session;
}

async function offerHandoff(
  ctx: ExtensionCommandContext,
  deps: RequirementsCommandDependencies,
  document: RequirementsDocument
): Promise<void> {
  if (!deps.startWorkflow || !ctx.hasUI) return;
  const choice = await ctx.ui.select("Requirements are ready. What next?", [
    "Start a workflow with these requirements",
    "Done"
  ]);
  if (choice !== "Start a workflow with these requirements") return;
  const route = await selectWorkflowRoute(ctx);
  if (!route) return;
  await deps.startWorkflow({ route, request: document.handoffRequest });
}

function buildRequirementsDocument(report: InterviewerReport, createdAt: string): RequirementsDocument {
  const handoffRequest = [
    `Goal: ${report.goal}`,
    report.summary,
    `Scope: ${report.scope.join("; ")}`,
    `Constraints: ${report.constraints.join("; ")}`,
    `Acceptance criteria: ${report.acceptanceCriteria.join("; ")}`
  ].join("\n");
  return {
    schemaVersion: 1,
    goal: report.goal,
    summary: report.summary,
    scope: report.scope,
    constraints: report.constraints,
    acceptanceCriteria: report.acceptanceCriteria,
    openQuestions: report.openQuestions,
    qa: report.qa,
    handoffRequest,
    createdAt
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
