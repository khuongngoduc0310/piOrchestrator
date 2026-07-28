import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DashboardDecisionAction, DashboardDecisionPresentation } from "../dashboard-types.js";
import { saveConfig } from "../config/config.js";
import type { CandidateLesson } from "../memory/memory-types.js";
import type { CheckpointBindings } from "../persistence/checkpoint-types.js";
import type { DebuggerOutput, HumanGateState, HumanPlanReviewResult, HumanReviewDecision, OrchestratorConfig, PlannerOutput, ReviewOutput } from "../types.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import type { ImplementationPlanningResult, WorkflowContext } from "./orchestrator-context.js";
import { formatCandidateForApproval } from "./orchestrator-helpers.js";
import { requestHumanDecision, type GateInteraction } from "./orchestrator-human-decisions.js";
import { HumanGateUnavailableError } from "./workflow-errors.js";
import { resolveParticipationPolicy, requiresHumanDecision } from "./participation-policy.js";
import { applyParticipationProfile } from "./participation-policy.js";
import { formatDiagnosisForApproval } from "../ui/session-messages.js";

export function shouldSuggestHumanTouchpoints(config: OrchestratorConfig, ctx: ExtensionCommandContext): boolean {
  const policy = resolveParticipationPolicy(config);
  return ctx.hasUI
    && !requiresHumanDecision(policy, "initial_plan")
    && !requiresHumanDecision(policy, "mutation_confirmation")
    && !requiresHumanDecision(policy, "final_delivery");
}

export async function suggestHumanTouchpoints(
  cwd: string,
  config: OrchestratorConfig,
  ctx: ExtensionCommandContext
): Promise<void> {
  try {
    const interested = await ctx.ui.confirm(
      "You can be involved in the workflow",
      "You can review plans, confirm mutations, and approve delivery. Would you like to choose a participation profile?"
    );
    if (!interested) return;
    const choice = await ctx.ui.select(
      "Choose a participation profile",
      [
        "Balanced  — approve plan and confirm mutation",
        "Controlled  — full human oversight",
        "Cancel  — keep autonomous"
      ]
    );
    if (!choice || choice.startsWith("Cancel")) return;
    const profile = choice.startsWith("Balanced") ? "balanced" : "controlled";
    const updated = applyParticipationProfile(config, profile);
    await saveConfig(cwd, updated);
    ctx.ui.notify(`Participation set to ${profile}. You can edit .pi/orchestrator/config.json to adjust.`, "info");
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
  parse: (result: Exclude<Awaited<ReturnType<typeof prompt>>, undefined | "defer">) => T,
  dashboard: DashboardDecisionPresentation,
): Promise<T> {
  const gi: GateInteraction<T> = { label, prompt, parse, dashboard };
  return requestHumanDecision(runtime, workflow, kind as import("./human-decision-types.js").HumanDecisionKind, "mandatory", resume, bindings, gi);
}

export async function requestBugDiagnosisApproval(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  planning: ImplementationPlanningResult,
  diagnosis: DebuggerOutput
): Promise<void> {
  await runDurableHumanGate(
    runtime,
    workflow,
    "bug_diagnosis_approval",
    "Bug diagnosis approval",
    { point: "bug_diagnosis_decision", scopeRevisionCount: planning.scopeRevisionCount },
    {
      exploration: planning.exploration,
      plan: planning.plan,
      baselineChecks: planning.baseline,
      diagnosis
    },
    async signal => {
      const answer = await workflow.ctx.ui.select(
        "Use the diagnosis shown in the session/dashboard for the bug fix?",
        ["Approve diagnosis", "Cancel workflow"],
        { signal }
      );
      if (!answer) return undefined;
      return { action: answer === "Approve diagnosis" ? "approve" as const : "cancel" as const };
    },
    () => undefined,
    {
      format: "markdown",
      content: formatDiagnosisForApproval(diagnosis),
      actions: [
        decisionAction("approve", "Approve diagnosis"),
        decisionAction("cancel", "Cancel workflow"),
      ],
    }
  );
}

export async function promptHumanPlanReview(
  runtime: OrchestratorRuntime,
  _plan: PlannerOutput,
  label: string,
  ctx: ExtensionCommandContext,
  signal = runtime.requireController().signal,
): Promise<HumanPlanReviewResult | undefined> {
  if (!ctx.hasUI) throw new HumanGateUnavailableError(`${label} requires TUI or RPC mode`);
  const decision = await ctx.ui.select(`${label} - review the plan in the session/dashboard`, [
    "Approve plan",
    "Request changes",
    "Cancel workflow"
  ], { signal });
  if (!decision) return undefined;
  if (decision === "Cancel workflow") return { approved: false, cancelled: true };
  if (decision === "Approve plan") return { approved: true };
  const feedback = await ctx.ui.input("Describe what changes you need:", "e.g. Add error handling to the login task", { signal });
  return feedback === undefined ? undefined : { approved: false, feedback };
}

export function decisionAction(
  value: DashboardDecisionAction["value"],
  label: string,
  requiresFeedback = false,
): DashboardDecisionAction {
  return { value, label, requiresFeedback };
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
