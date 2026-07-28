import type { AgentSummary, TimelineStepSummary } from "../dashboard-types.js";

export function derivePreviousAgent(
  steps: TimelineStepSummary[],
  activeAgent: string | null | undefined,
): string | null {
  const ordered = [...steps].sort((left, right) => {
    const sequence = right.sequence - left.sequence;
    return sequence || right.startedAt.localeCompare(left.startedAt);
  });
  const activeIndex = activeAgent
    ? ordered.findIndex(step => step.agent === activeAgent && step.status === "running")
    : -1;
  const candidates = activeIndex >= 0 ? ordered.slice(activeIndex + 1) : ordered;
  return candidates.find(step => step.agent && step.agent !== activeAgent)?.agent ?? null;
}

export function findAgent(agents: AgentSummary[], name: string | null | undefined) {
  return agents.find(agent => agent.name === name) ?? null;
}

export function isNarrowWorkspace(width: number): boolean {
  return width < 1280;
}

export function preferredInvocationKey(
  invocations: Array<{ key: string; status: string }>,
  selectedKey: string | null,
  preserveSelection = true,
): string | null {
  if (preserveSelection && invocations.some(item => item.key === selectedKey)) return selectedKey;
  return [...invocations].reverse().find(item => item.status === "running")?.key
    ?? invocations[invocations.length - 1]?.key
    ?? null;
}
