import React, { useDeferredValue, useRef, useState } from "react";
import type { DashboardRunHistoryItem } from "../../dashboard-types.js";
import { getRunState, listRuns } from "../api.js";
import type { DashboardAction } from "../state.js";

interface RunSidebarProps {
  runs: DashboardRunHistoryItem[];
  selectedRunId: string | null;
  open: boolean;
  dispatch: React.Dispatch<DashboardAction>;
  onClose: () => void;
}

export function RunSidebar({ runs, selectedRunId, open, dispatch, onClose }: RunSidebarProps) {
  const [query, setQuery] = useState("");
  const requestRef = useRef(0);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const visible = runs.filter(run => `${run.request} ${run.route ?? ""} ${run.status} ${run.id}`.toLowerCase().includes(deferredQuery));
  const groups = [
    { label: "Active", runs: visible.filter(run => run.active) },
    { label: "Recent", runs: visible.filter(run => !run.active) },
  ];

  function selectRun(runId: string) {
    const selectedRun = runs.find(run => run.id === runId);
    if (selectedRun?.active) {
      dispatch({ type: "displayLiveRun" });
      onClose();
      return;
    }
    const request = ++requestRef.current;
    dispatch({ type: "runSelected", runId });
    getRunState(runId).then(snapshot => {
      if (request === requestRef.current) dispatch({ type: "historicalSnapshotLoaded", runId, snapshot });
    }).catch(() => {});
    onClose();
  }

  function refresh() {
    listRuns().then(next => dispatch({ type: "runsLoaded", runs: next })).catch(() => {});
  }

  return (
    <aside className={`run-sidebar${open ? " open" : ""}`} aria-label="Workflow runs">
      <div className="sidebar-heading"><strong>RUN INDEX</strong><button type="button" className="icon-btn sidebar-close" onClick={onClose} aria-label="Close run drawer">x</button></div>
      <label className="sidebar-search"><span className="visually-hidden">Search runs</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter runs..." autoFocus={open} /></label>
      <div className="run-groups">
        {groups.map(group => group.runs.length > 0 && <section key={group.label} aria-labelledby={`run-group-${group.label}`}>
          <h2 id={`run-group-${group.label}`}>{group.label} <span>{group.runs.length}</span></h2>
          {group.runs.map(run => <button key={run.id} type="button" className={`run-row${selectedRunId === run.id ? " selected" : ""}`} aria-current={selectedRunId === run.id ? "true" : undefined} onClick={() => selectRun(run.id)}>
            <span className="run-row-head"><span className={`status-pip ${run.status}`} aria-hidden="true" /><strong>{run.route ?? "workflow"}</strong><time>{formatDate(run.updatedAt)}</time></span>
            <span className="run-row-request">{run.request}</span>
            <span className="run-row-status">{run.status} / {run.stage}</span>
          </button>)}
        </section>)}
        {visible.length === 0 && <p className="empty-state">No matching runs.</p>}
      </div>
      <button type="button" className="sidebar-refresh" onClick={refresh}>Refresh index</button>
    </aside>
  );
}

function formatDate(value: string) {
  return value ? value.slice(5, 16).replace("T", " ") : "";
}
