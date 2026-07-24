import { useCallback } from "react";
import type {
  DashboardRunHistoryItem,
  OrchestratorViewModel,
} from "../../dashboard-types.js";
import { listRuns, getRunState } from "../api.js";
import type {
  ConnectionState,
  DashboardAction,
} from "../state.js";

const CONNECTION_LABELS: Record<ConnectionState, string> = {
  connecting: "Connecting",
  live: "Live",
  reconnecting: "Reconnecting",
  disconnected: "Disconnected",
};

interface HeaderProps {
  snapshot: OrchestratorViewModel | null;
  connection: ConnectionState;
  runs: DashboardRunHistoryItem[];
  selectedRunId: string | null;
  elapsedText: string;
  dispatch: React.Dispatch<DashboardAction>;
}

export function Header({
  snapshot,
  connection,
  runs,
  selectedRunId,
  elapsedText,
  dispatch,
}: HeaderProps) {
  const mode = snapshot?.mode ?? "idle";
  const run = snapshot?.run ?? null;
  const config = snapshot?.config ?? null;

  const handleRunChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>) => {
      const runId = e.target.value;
      if (!runId) return;
      dispatch({ type: "runSelected", runId });
      getRunState(runId)
        .then((data) => {
          dispatch({ type: "historicalSnapshotLoaded", snapshot: data });
        })
        .catch(() => {});
    },
    [dispatch],
  );

  const handleRefreshRuns = useCallback(() => {
    listRuns()
      .then((runs) => {
        dispatch({ type: "runsLoaded", runs });
        if (!selectedRunId && runs.length > 0) {
          const target = runs.find((r) => r.active) ?? runs[0];
          dispatch({ type: "runSelected", runId: target.id });
          return getRunState(target.id);
        }
        return null;
      })
      .then((data) => {
        if (data) {
          dispatch({ type: "historicalSnapshotLoaded", snapshot: data });
        }
      })
      .catch(() => {});
  }, [dispatch, selectedRunId]);

  return (
    <header>
      <div className="header-main">
        <span className="product-name">piOrchestrator</span>
        <span className={`status-badge ${mode}`}>
          {mode === "idle" && config?.status === "invalid"
            ? "CONFIG ERROR"
            : mode === "idle"
              ? "IDLE"
              : mode}
        </span>
        <span className={`connection-badge ${connection}`}>
          {CONNECTION_LABELS[connection] ?? connection}
        </span>
        {elapsedText && (
          <span className="elapsed">{elapsedText}</span>
        )}
        {run && (
          <span className="run-id muted">{run.id.slice(0, 8)}</span>
        )}
      </div>
      {connection !== "live" && (
        <div className={`connection-note ${connection}`} role="status" aria-live="polite">
          {connection === "connecting"
            ? "Connecting to live workflow updates…"
            : connection === "reconnecting"
              ? "Live updates were interrupted. Reconnecting automatically…"
              : "Live updates are unavailable. The dashboard will keep retrying automatically."}
        </div>
      )}
      {run && (
        <div className="request" role="status">
          {run.route ? `[${run.route}] ` : ""}
          {run.request ?? ""}
        </div>
      )}
      <div className="run-controls">
        <label htmlFor="run-picker">Run history</label>
        <select
          id="run-picker"
          aria-label="Select workflow run"
          value={selectedRunId ?? ""}
          onChange={handleRunChange}
        >
          {runs.length === 0 && (
            <option value="">No runs</option>
          )}
          {runs.map((run) => (
            <option key={run.id} value={run.id}>
              {run.active ? "● " : ""}
              {run.status} · {trunc(run.request, 58)}
            </option>
          ))}
        </select>
        <button
          id="refresh-runs"
          className="close-btn"
          type="button"
          onClick={handleRefreshRuns}
        >
          Refresh
        </button>
      </div>
    </header>
  );
}

function trunc(v: string | null | undefined, m: number): string {
  if (!v) return "";
  return v.length <= m ? v : v.slice(0, m - 1) + "…";
}
