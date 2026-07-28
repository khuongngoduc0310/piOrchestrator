import React, { useDeferredValue, useEffect, useState } from "react";
import type { AgentHistoryResponse } from "../../dashboard-types.js";
import type { AgentUsage } from "../../agent-types.js";
import { getAgentHistory } from "../api.js";
import { DiffViewer } from "./DiffViewer.js";
import { TranscriptViewer } from "./TranscriptViewer.js";

interface AgentHistoryProps {
  runId: string | null;
  revision?: number;
  structureRevision?: string;
}

type DetailTab = "transcript" | "files";

export function AgentHistory({ runId, revision, structureRevision }: AgentHistoryProps) {
  const [history, setHistory] = useState<AgentHistoryResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [agentFilter, setAgentFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("newest");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [comparisonKeys, setComparisonKeys] = useState<string[]>([]);
  const [detailTab, setDetailTab] = useState<DetailTab>("transcript");
  const [selectedDiffFile, setSelectedDiffFile] = useState(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());

  useEffect(() => {
    if (!runId) {
      setHistory(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(false);
    getAgentHistory(runId, controller.signal)
      .then(data => setHistory(data))
      .catch(error => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [runId, structureRevision]);

  useEffect(() => {
    setHistory(null);
    setSelectedKey(null);
    setAgentFilter("all");
    setStatusFilter("all");
    setQuery("");
    setSort("newest");
    setComparisonKeys([]);
  }, [runId]);

  if (!runId) return <div className="panel empty-state">Select a workflow run to inspect agent usage.</div>;
  if (loading && !history) return <div className="panel empty-state">Loading agent history...</div>;
  if (error && !history) return <div className="panel empty-state error-text">Agent history could not be loaded.</div>;
  if (!history) return null;

  const measured = history.total.measuredInvocationCount;
  const total = history.total.usage;
  const filtered = history.invocations.filter(item => {
    if (agentFilter !== "all" && item.agent !== agentFilter) return false;
    if (statusFilter !== "all" && item.status !== statusFilter) return false;
    if (!deferredQuery) return true;
    return `${item.agent} ${item.stepLabel} ${item.provider ?? ""} ${item.model ?? ""}`.toLowerCase().includes(deferredQuery);
  }).sort((left, right) => compareInvocations(left, right, sort));
  const selected = history.invocations.find(item => item.key === selectedKey) ?? null;
  const compared = comparisonKeys.map(key => history.invocations.find(item => item.key === key)).filter((item): item is AgentHistoryResponse["invocations"][number] => Boolean(item));
  const cacheDenominator = total ? total.input + total.cacheRead : 0;
  const cacheRate = total && cacheDenominator > 0 ? total.cacheRead / cacheDenominator : undefined;

  return (
    <section className="history-view" aria-labelledby="history-heading">
      <div className="history-title">
        <div>
          <h2 id="history-heading">Agent history</h2>
          <p className="muted">Invocation-level token usage and estimated model cost for this run.</p>
        </div>
        {measured < history.total.invocationCount && (
          <span className="usage-warning">Usage captured for {measured}/{history.total.invocationCount} invocations</span>
        )}
      </div>

      <div className="metric-grid">
        <Metric label="Estimated spend" value={total ? formatCost(total.cost) : "Unavailable"} accent />
        <Metric label="Total tokens" value={total ? formatTokens(tokenTotal(total)) : "Unavailable"} />
        <Metric label="Cache hit rate" value={cacheRate === undefined ? "Unavailable" : `${(cacheRate * 100).toFixed(1)}%`} />
        <Metric label="Invocations" value={String(history.total.invocationCount)} note={`${measured} measured`} />
      </div>

      {total && (
        <div className="panel usage-breakdown">
          <UsageStat label="Input" value={total.input} />
          <UsageStat label="Output" value={total.output} />
          <UsageStat label="Reasoning" value={total.reasoning} optional />
          <UsageStat label="Cache read" value={total.cacheRead} />
          <UsageStat label="Cache write" value={total.cacheWrite} />
        </div>
      )}

      <div className="agent-spend-grid">
        {history.agents.filter(agent => agent.invocationCount > 0).map(agent => (
          <button className={`spend-card${agentFilter === agent.name ? " selected" : ""}`} type="button" key={agent.name} onClick={() => setAgentFilter(agentFilter === agent.name ? "all" : agent.name)}>
            <span className="agent-name">{agent.name}</span>
            <strong>{agent.usage ? formatCost(agent.usage.cost) : "Unavailable"}</strong>
            <span className="muted">{agent.usage ? formatTokens(tokenTotal(agent.usage)) : "No usage"} / {agent.invocationCount} runs</span>
          </button>
        ))}
      </div>

      <div className="panel history-panel">
        <div className="history-filters">
          <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search agent, step, or model" aria-label="Search agent history" />
          <select value={agentFilter} onChange={event => setAgentFilter(event.target.value)} aria-label="Filter by agent">
            <option value="all">All agents</option>
            {history.agents.filter(agent => agent.invocationCount > 0).map(agent => <option key={agent.name} value={agent.name}>{agent.name}</option>)}
          </select>
          <select value={statusFilter} onChange={event => setStatusFilter(event.target.value)} aria-label="Filter by status">
            <option value="all">All statuses</option>
            <option value="succeeded">Succeeded</option>
            <option value="failed">Failed</option>
            <option value="cancelled">Cancelled</option>
            <option value="running">Running</option>
          </select>
          <select value={sort} onChange={event => setSort(event.target.value)} aria-label="Sort invocations">
            <option value="newest">Newest first</option>
            <option value="cost">Highest cost</option>
            <option value="tokens">Most tokens</option>
            <option value="duration">Longest duration</option>
          </select>
        </div>
        <div className="history-table-wrap">
          <table className="history-table">
            <thead><tr><th>Compare</th><th>Invocation</th><th>Model</th><th>Status</th><th>Tokens</th><th>Cache</th><th>Cost</th><th>Duration</th></tr></thead>
            <tbody>
              {filtered.map(item => (
                <tr key={item.key} className={selectedKey === item.key ? "selected" : ""} onClick={() => setSelectedKey(item.key)}>
                  <td><button type="button" className={`comparison-select${comparisonKeys.includes(item.key) ? " selected" : ""}`} aria-pressed={comparisonKeys.includes(item.key)} aria-label={`${comparisonKeys.includes(item.key) ? "Remove" : "Add"} ${item.agent} invocation ${item.sequence} ${comparisonKeys.includes(item.key) ? "from" : "to"} comparison`} onClick={event => { event.stopPropagation(); setComparisonKeys(keys => keys.includes(item.key) ? keys.filter(key => key !== item.key) : keys.length < 2 ? [...keys, item.key] : [keys[1], item.key]); }}>{comparisonKeys.includes(item.key) ? "Selected" : "Select"}</button></td>
                  <td>
                    <button
                      type="button"
                      className="history-invocation-button"
                      aria-pressed={selectedKey === item.key}
                      onClick={(event) => {
                        event.stopPropagation();
                        setSelectedKey(item.key);
                      }}
                    >
                      <strong>{item.agent}</strong>
                      <span>{item.stepLabel} / {item.mode.replace("_", " ")} #{item.sequence}</span>
                    </button>
                  </td>
                  <td>{item.model ?? "Unknown"}<span>{item.provider ?? ""}</span></td>
                  <td><span className={`status-text ${item.status}`}>{item.status}</span></td>
                  <td>{item.usage ? formatTokens(tokenTotal(item.usage)) : "Unavailable"}</td>
                  <td>{item.usage ? formatTokens(item.usage.cacheRead) : "-"}</td>
                  <td>{item.usage ? formatCost(item.usage.cost) : "Unavailable"}</td>
                  <td>{formatDuration(item.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div className="empty-state">No invocations match these filters.</div>}
        </div>
      </div>

      {compared.length > 0 && <section className="panel comparison-panel" aria-labelledby="comparison-heading"><div className="history-detail-title"><div><h3 id="comparison-heading">Invocation comparison</h3><span className="muted">Select any two invocations. A third selection replaces the oldest.</span></div><button type="button" className="close-btn" onClick={() => setComparisonKeys([])}>Clear</button></div><div className="comparison-grid">
        <div className="comparison-labels"><span>Invocation</span><span>Provider / model</span><span>Status</span><span>Duration</span><span>Tokens</span><span>Cost</span><span>Changes</span></div>
        {compared.map(item => <div className="comparison-column" key={item.key}><strong>{item.agent} #{item.sequence}</strong><span>{item.provider ?? "Unknown provider"} / {item.model ?? "Unknown model"}</span><span>{item.status}</span><span>{formatDuration(item.durationMs)}</span><span>{item.usage ? formatTokens(tokenTotal(item.usage)) : "Unavailable"}</span><span>{item.usage ? formatCost(item.usage.cost) : "Unavailable"}</span><span>{item.changedFileCount === undefined ? "Unavailable" : `${item.changedFileCount} files`}</span><button type="button" onClick={() => setSelectedKey(item.key)}>Open transcript / diff</button></div>)}
        {compared.length === 1 && <div className="comparison-placeholder">Select one more invocation</div>}
      </div></section>}

      {selected && (
        <div className="panel history-detail">
          <div className="history-detail-title"><div><h3>{selected.agent} / {selected.stepLabel}</h3><span className="muted">{selected.model ?? "Unknown model"} / {selected.startedAt.replace("T", " ").slice(0, 19)}</span></div><button className="close-btn" type="button" onClick={() => setSelectedKey(null)}>Close</button></div>
          <div className="inspector-tabs">
            <button className={`close-btn inspector-tab${detailTab === "transcript" ? " active" : ""}`} type="button" onClick={() => setDetailTab("transcript")}>Transcript</button>
            <button className={`close-btn inspector-tab${detailTab === "files" ? " active" : ""}`} type="button" onClick={() => setDetailTab("files")}>Files{selected.changedFileCount !== undefined ? ` (${selected.changedFileCount})` : ""}</button>
          </div>
          {detailTab === "transcript"
            ? selected.hasTranscript || selected.status === "running" ? <TranscriptViewer runId={runId} stepId={selected.stepId} sequence={selected.sequence} query="" revision={revision} status={selected.status} /> : <div className="empty-state">No transcript captured.</div>
            : selected.hasDiff ? <DiffViewer runId={runId} stepId={selected.stepId} sequence={selected.sequence} selectedDiffFile={selectedDiffFile} onSelectDiffFile={setSelectedDiffFile} /> : <div className="empty-state">No file diff captured.</div>}
        </div>
      )}
    </section>
  );
}

function Metric({ label, value, note, accent = false }: { label: string; value: string; note?: string; accent?: boolean }) {
  return <div className={`metric-card${accent ? " accent" : ""}`}><span>{label}</span><strong>{value}</strong>{note && <small>{note}</small>}</div>;
}

function UsageStat({ label, value, optional = false }: { label: string; value?: number; optional?: boolean }) {
  return <div><span className="muted">{label}</span><strong>{value === undefined && optional ? "Not reported" : formatTokens(value ?? 0)}</strong></div>;
}

function tokenTotal(usage: AgentUsage): number {
  return usage.totalTokens ?? usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatTokens(value: number): string {
  return new Intl.NumberFormat("en-US", { notation: value >= 100_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: value < 0.01 ? 4 : 2, maximumFractionDigits: value < 0.01 ? 4 : 2 }).format(value);
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "-";
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.floor(value / 60_000)}m ${Math.round((value % 60_000) / 1_000)}s`;
}

function compareInvocations(left: AgentHistoryResponse["invocations"][number], right: AgentHistoryResponse["invocations"][number], sort: string): number {
  if (sort === "cost") return (right.usage?.cost ?? -1) - (left.usage?.cost ?? -1);
  if (sort === "tokens") return (right.usage ? tokenTotal(right.usage) : -1) - (left.usage ? tokenTotal(left.usage) : -1);
  if (sort === "duration") return (right.durationMs ?? -1) - (left.durationMs ?? -1);
  return right.startedAt.localeCompare(left.startedAt);
}
