import { AGENT_NAMES, type AgentUsage } from "../agent-types.js";
import type { AgentHistoryInvocation, AgentHistoryResponse, AgentUsageSummary } from "../dashboard-types.js";
import type { WorkflowState } from "../workflow-types.js";
import { addUsage } from "./agent-usage.js";

export function buildAgentHistory(
  state: WorkflowState,
  activeTranscriptKeys: ReadonlySet<string> = new Set(),
): AgentHistoryResponse {
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
        hasTranscript: invocation.transcriptArtifact !== undefined || activeTranscriptKeys.has(`${step.id}:${invocation.sequence}`),
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

function durationMs(startedAt: string, completedAt: string | undefined): number | undefined {
  if (!completedAt) return undefined;
  const duration = Date.parse(completedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) && duration >= 0 ? duration : undefined;
}
