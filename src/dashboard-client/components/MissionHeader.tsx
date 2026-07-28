import React from "react";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import type { ConnectionState, DashboardView } from "../state.js";

interface MissionHeaderProps {
  snapshot: OrchestratorViewModel | null;
  connection: ConnectionState;
  elapsedText: string;
  view: DashboardView;
  onView: (view: DashboardView) => void;
  onOpenRuns: () => void;
  onOpenPalette: () => void;
}

export function MissionHeader({ snapshot, connection, elapsedText, view, onView, onOpenRuns, onOpenPalette }: MissionHeaderProps) {
  const run = snapshot?.run;
  const mode = snapshot?.mode ?? "idle";
  return <header className="command-bar" aria-label="Mission status">
    <button className="icon-btn run-drawer-trigger" type="button" onClick={onOpenRuns} aria-label="Open run drawer">RUNS</button>
    <div className="brand"><span className="brand-mark">PI</span><strong>MISSION CONTROL</strong></div>
    <div className="command-run" role="status"><span className={`status-pip ${mode}`} aria-hidden="true" /><span>{mode}</span>{run && <><code>{run.id.slice(0, 8)}</code><span className="command-request">{run.request}</span></>}</div>
    <nav className="command-tabs" aria-label="Main panels">
      <button type="button" aria-current={view === "run" ? "page" : undefined} onClick={() => onView("run")}>Workspace</button>
      <button type="button" aria-current={view === "agent-history" ? "page" : undefined} onClick={() => onView("agent-history")}>History</button>
      {run?.runStatus === "completed" && <button type="button" aria-current={view === "report" ? "page" : undefined} onClick={() => onView("report")}>Report</button>}
    </nav>
    <span className="elapsed">{elapsedText}</span>
    <span className={`connection-badge ${connection}`}>{connection}</span>
    <button type="button" className="palette-trigger" onClick={onOpenPalette} aria-label="Open command palette">Command <kbd>Ctrl K</kbd></button>
  </header>;
}
