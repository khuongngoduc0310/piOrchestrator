import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { formatPlanForReview } from "./plan-review.js";
import { saveConfig } from "../config/config.js";
import type { CandidateLesson } from "../memory/memory-types.js";
import type { CheckpointBindings } from "../persistence/checkpoint-types.js";
import type { HumanGateState, HumanPlanReviewResult, HumanReviewDecision, OrchestratorConfig, PlannerOutput, ReviewOutput } from "../types.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import type { WorkflowContext } from "./orchestrator-context.js";
import { formatCandidateForApproval, raceWithAbort } from "./orchestrator-helpers.js";
import { requestHumanDecision, type GateInteraction } from "./orchestrator-human-decisions.js";
import { HumanGateUnavailableError, WorkflowCancelledError } from "./workflow-errors.js";

export function shouldSuggestHumanTouchpoints(config: OrchestratorConfig, ctx: ExtensionCommandContext): boolean {
  return ctx.hasUI
    && !config.humanInTheLoop.planApproval
    && !config.humanInTheLoop.planRevisionApproval
    && !config.humanInTheLoop.confirmBeforeMutation;
}

export async function suggestHumanTouchpoints(
  cwd: string,
  config: OrchestratorConfig,
  ctx: ExtensionCommandContext
): Promise<void> {
  try {
    const enableAll = await ctx.ui.confirm(
      "You can be involved in the workflow",
      "You can review and approve plans before they are executed. " +
      "Would you like to enable human review of the implementation plan? " +
      "You can always change this later in the config."
    );
    if (!enableAll) return;
    const choices = await ctx.ui.select("Which stages would you like to review?", [
      "Plan approval (Recommended — review plan before implementation)",
      "Plan + revisions (Recommended — review plan and any revisions)",
      "All touchpoints (Plan, revisions, and confirmation before code changes)"
    ]);
    if (!choices) return;
    config.humanInTheLoop.planApproval = true;
    if (choices.startsWith("Plan + revisions") || choices.startsWith("All touchpoints")) config.humanInTheLoop.planRevisionApproval = true;
    if (choices.startsWith("All touchpoints")) config.humanInTheLoop.confirmBeforeMutation = true;
    await saveConfig(cwd, config);
    ctx.ui.notify("Human touchpoints enabled and saved to config. You can edit .pi/orchestrator/config.json to adjust.", "info");
  } catch {
    // Suggestion is best-effort; the workflow continues with defaults.
  }
}

/** Durable gate that persists across process interruptions. */
export async function runDurableHumanGate<T>(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  kind: HumanGateState["kind"],
  label: string,
  resume: import("./human-decision-types.js").HumanDecisionResumePoint,
  bindings: CheckpointBindings,
  prompt: (signal: AbortSignal) => Promise<{ action: import("./human-decision-types.js").HumanDecisionAction; feedback?: string } | undefined | "defer">,
  parse: (result: Exclude<Awaited<ReturnType<typeof prompt>>, undefined | "defer">) => T
): Promise<T> {
  const gi: GateInteraction<T> = { label, prompt, parse };
  return requestHumanDecision(runtime, workflow, kind as import("./human-decision-types.js").HumanDecisionKind, "mandatory", resume, bindings, gi);
}

export async function promptHumanPlanReview(
  runtime: OrchestratorRuntime,
  plan: PlannerOutput,
  label: string,
  ctx: ExtensionCommandContext
): Promise<HumanPlanReviewResult | undefined> {
  if (!ctx.hasUI) throw new HumanGateUnavailableError(`${label} requires TUI or RPC mode`);
  const signal = runtime.requireController().signal;
  const title = `${label}\n\nReview the plan below. You can approve, request changes, or cancel.`;
  const viewed = await raceWithAbort(ctx.ui.editor(title, formatPlanForReview(plan)), signal);
  if (viewed === undefined) return undefined;
  const decision = await ctx.ui.select(`${label} — What would you like to do?`, [
    "Approve plan",
    "Request changes",
    "Cancel workflow"
  ], { signal });
  if (!decision) return undefined;
  if (decision === "Cancel workflow") throw new WorkflowCancelledError("Workflow cancelled during plan review", "human_gate");
  if (decision === "Approve plan") return { approved: true };
  const feedback = await ctx.ui.input("Describe what changes you need:", "e.g. Add error handling to the login task", { signal });
  return feedback === undefined ? undefined : { approved: false, feedback };
}

export async function promptHumanReviewDecision(
  runtime: OrchestratorRuntime,
  review: ReviewOutput,
  completedFixes: number,
  ctx: ExtensionCommandContext
): Promise<HumanReviewDecision> {
  if (!ctx.hasUI) {
    throw new Error(
      `Code review was not approved within the revision limit.\n\n` +
      `Final review blocking issues:\n${review.blockingIssues.map((issue, index) => `  ${index + 1}. ${issue}`).join("\n")}`
    );
  }
  const issues = review.blockingIssues.map((issue, index) => `${index + 1}. ${issue}`).join("\n");
  const decision = await ctx.ui.select(
    `Code review not approved after ${completedFixes} fix round(s).\n\nBlocking issues:\n${issues}\n\nWhat would you like to do?`,
    ["Accept current implementation", "Allow one more targeted fix", "Abort workflow"],
    { signal: runtime.requireController().signal }
  );
  if (!decision || decision === "Abort workflow") return { action: "abort" };
  return decision === "Accept current implementation" ? { action: "accept" } : { action: "fix_again" };
}

export async function promptHumanMemoryApproval(
  runtime: OrchestratorRuntime,
  candidates: CandidateLesson[],
  ctx: ExtensionCommandContext
): Promise<{ approvedIds: string[]; declinedIds: string[] }> {
  const signal = runtime.requireController().signal;
  const summary = candidates.map((candidate, index) => `${index + 1}. ${formatCandidateForApproval(candidate)}`).join("\n\n");
  const action = await ctx.ui.select(
    `Lessons learned (${candidates.length} eligible for memory)\n\n${summary}\n\nPromote lessons to project memory for future workflows?`,
    ["Promote all", candidates.length > 1 ? "Review individually" : null, "Decline all", "Defer all"].filter((value): value is string => value !== null),
    { signal }
  );
  if (!action || action === "Defer all") return { approvedIds: [], declinedIds: [] };
  if (action === "Promote all") return { approvedIds: candidates.map(candidate => candidate.id), declinedIds: [] };
  if (action === "Decline all") return { approvedIds: [], declinedIds: candidates.map(candidate => candidate.id) };
  const approvedIds: string[] = [];
  const declinedIds: string[] = [];
  for (const candidate of candidates) {
    const decision = await ctx.ui.select(formatCandidateForApproval(candidate), ["Approve", "Decline", "Defer", "Stop reviewing"], { signal });
    if (!decision || decision === "Stop reviewing") break;
    if (decision === "Approve") approvedIds.push(candidate.id);
    if (decision === "Decline") declinedIds.push(candidate.id);
  }
  return { approvedIds, declinedIds };
}
