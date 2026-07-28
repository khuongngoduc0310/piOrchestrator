import React, { useEffect, useState } from "react";
import type { AgentHistoryResponse, AgentSummary, OrchestratorViewModel } from "../../dashboard-types.js";
import { getAgentHistory } from "../api.js";
import { derivePreviousAgent, findAgent } from "../workspace.js";

interface CurrentAgentsProps {
  snapshot: OrchestratorViewModel | null;
  runId: string | null;
  onSelectAgent: (agent: string) => void;
}

export function CurrentAgents({ snapshot, runId, onSelectAgent }: CurrentAgentsProps) {
  const [history, setHistory] = useState<AgentHistoryResponse | null>(null);
  const steps = snapshot?.timelineSteps ?? snapshot?.recentSteps ?? [];
  const activeName = snapshot?.run?.activeAgent ?? null;
  const previousName = derivePreviousAgent(steps, activeName);

  useEffect(() => {
    if (!runId || (!activeName && !previousName)) return setHistory(null);
    const controller = new AbortController();
    setHistory(null);
    getAgentHistory(runId, controller.signal).then(setHistory).catch(() => {});
    return () => controller.abort();
  }, [runId, activeName, previousName]);

  return <section className="current-agents" aria-labelledby="current-agents-heading">
    <div className="section-kicker">ACTIVE HANDOFF</div>
    <h2 id="current-agents-heading">Current activity</h2>
    <div className="handoff-grid">
      <FocusAgent label="Current agent" agent={findAgent(snapshot?.agents ?? [], activeName)} name={activeName} history={history} onSelect={onSelectAgent} active />
      <FocusAgent label="Previous agent (derived)" agent={findAgent(snapshot?.agents ?? [], previousName)} name={previousName} history={history} onSelect={onSelectAgent} />
    </div>
  </section>;
}

function FocusAgent({ label, agent, name, history, onSelect, active = false }: { label: string; agent: AgentSummary | null; name: string | null; history: AgentHistoryResponse | null; onSelect: (name: string) => void; active?: boolean }) {
  const invocations = history?.invocations.filter(item => item.agent === name) ?? [];
  const latest = invocations[0];
  const usage = latest?.usage;
  return <button type="button" className={`focus-agent${active ? " active" : ""}`} disabled={!name} onClick={() => name && onSelect(name)}>
    <span className="focus-agent-label">{label}</span>
    <span className="focus-agent-name">{name ?? "No agent recorded"}</span>
    <span className="focus-agent-meta"><span>Status: {agent?.status ?? "unavailable"}</span><span>Model: {agent?.model || latest?.model || "unavailable"}</span><span>Invocations: {agent?.invocationCount ?? invocations.length}</span>{latest?.durationMs !== undefined && <span>Latest: {formatDuration(latest.durationMs)}</span>}{usage && <><span>Tokens: {usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite}</span><span>Cost: ${usage.cost.toFixed(4)}</span></>}</span>
    {agent?.summary && <span className="focus-agent-summary">{agent.summary}</span>}
  </button>;
}

function formatDuration(value: number) {
  return value < 1000 ? `${value}ms` : `${(value / 1000).toFixed(1)}s`;
}
