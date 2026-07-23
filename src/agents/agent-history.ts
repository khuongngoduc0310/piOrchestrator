import { AGENT_NAMES, type AgentUsage } from "../agent-types.js";
import type { AgentHistoryInvocation, AgentHistoryResponse, AgentUsageSummary } from "../dashboard-types.js";
import type { WorkflowState } from "../workflow-types.js";

export function buildAgentHistory(state: WorkflowState): AgentHistoryResponse {
  const invocations: AgentHistoryInvocation[] = [];
  for (const step of state.steps) {
    if (!step.agent) continue;
    for (const invocation of step.invocations ?? []) {
      invocations.push({
        key: `${step.id}:${invocation.sequence}`,
        stepId: step.id,
        stepLabel: step.label,
        sequence: invocation.sequence,
        agent: step.agent,
        mode: invocation.mode,
        status: invocation.status,
        startedAt: invocation.startedAt,
        completedAt: invocation.completedAt,
        durationMs: durationMs(invocation.startedAt, invocation.completedAt),
        usage: invocation.usage,
        provider: invocation.provider,
        model: invocation.model,
        api: invocation.api,
        stopReason: invocation.stopReason,
        changedFileCount: invocation.changedFileCount,
        hasTranscript: invocation.transcriptArtifact !== undefined,
        hasDiff: invocation.fileDiffArtifact !== undefined
      });
    }
  }
  return {
    runId: state.runId,
    total: summarize(invocations),
    agents: AGENT_NAMES.map(name => ({ name, ...summarize(invocations.filter(item => item.agent === name)) })),
    invocations: invocations.sort((left, right) => right.startedAt.localeCompare(left.startedAt))
  };
}

function summarize(invocations: AgentHistoryInvocation[]): AgentUsageSummary {
  const measured = invocations.filter(item => item.usage !== undefined);
  return {
    invocationCount: invocations.length,
    measuredInvocationCount: measured.length,
    usage: measured.length > 0 ? measured.reduce((total, item) => addUsage(total, item.usage!), emptyUsage()) : undefined
  };
}

function emptyUsage(): AgentUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    totalTokens: 0,
    costBreakdown: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
  };
}

function addUsage(total: AgentUsage, usage: AgentUsage): AgentUsage {
  total.input += usage.input;
  total.output += usage.output;
  total.cacheRead += usage.cacheRead;
  total.cacheWrite += usage.cacheWrite;
  total.cost += usage.cost;
  total.totalTokens = (total.totalTokens ?? 0) + (usage.totalTokens ?? tokenTotal(usage));
  if (usage.reasoning !== undefined) total.reasoning = (total.reasoning ?? 0) + usage.reasoning;
  if (usage.cacheWrite1h !== undefined) total.cacheWrite1h = (total.cacheWrite1h ?? 0) + usage.cacheWrite1h;
  if (usage.costBreakdown) {
    total.costBreakdown ??= { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    total.costBreakdown.input += usage.costBreakdown.input;
    total.costBreakdown.output += usage.costBreakdown.output;
    total.costBreakdown.cacheRead += usage.costBreakdown.cacheRead;
    total.costBreakdown.cacheWrite += usage.costBreakdown.cacheWrite;
  }
  return total;
}

function tokenTotal(usage: AgentUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function durationMs(startedAt: string, completedAt: string | undefined): number | undefined {
  if (!completedAt) return undefined;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
