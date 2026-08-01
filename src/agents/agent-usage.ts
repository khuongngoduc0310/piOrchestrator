import type { AgentUsage } from "../types.js";

export function addUsage(total: AgentUsage, usage: AgentUsage): AgentUsage {
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

export function tokenTotal(usage: AgentUsage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

export function cloneUsage(usage: AgentUsage): AgentUsage {
  return {
    ...usage,
    costBreakdown: usage.costBreakdown ? { ...usage.costBreakdown } : undefined
  };
}

export function sdkUsageToAgentUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}): AgentUsage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: usage.totalTokens,
    ...(usage.reasoning !== undefined ? { reasoning: usage.reasoning } : {}),
    ...(usage.cacheWrite1h !== undefined ? { cacheWrite1h: usage.cacheWrite1h } : {}),
    cost: usage.cost.total,
    costBreakdown: {
      input: usage.cost.input,
      output: usage.cost.output,
      cacheRead: usage.cost.cacheRead,
      cacheWrite: usage.cost.cacheWrite
    }
  };
}
