import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { UI_PHASE_LABELS } from "../../dashboard-types.js";

interface OverviewProps {
  snapshot: OrchestratorViewModel | null;
  onSelectAgent: (agent: string) => void;
}

export function Overview({ snapshot, onSelectAgent }: OverviewProps) {
  if (!snapshot) {
    return (
      <>
        <div id="activity" className="panel">
          <div className="empty-state">
            <p>Loading activity…</p>
          </div>
        </div>
        <div id="run-details" className="panel">
          <div className="empty-state">
            <p>Loading details…</p>
          </div>
        </div>
      </>
    );
  }

  const { run, mode, config, commands } = snapshot;

  if (!run) {
    return (
      <>
        <div id="activity" className="panel">
          <div className="empty-state">
            <p>Run <code>/orchestrate</code> to start a workflow</p>
            {commands && commands.length > 0 && (
              <p className="muted">
                {commands.map((c, i) => (
                  <span key={i}>
                    {i > 0 && " · "}
                    <code>{c}</code>
                  </span>
                ))}
              </p>
            )}
          </div>
        </div>
        <div id="run-details" className="panel">
          <div className="getting-started">
            <div className="getting-started-title">What appears here</div>
            <ol>
              <li>Exploration and an implementation plan</li>
              <li>Live agent activity, tools, and decisions</li>
              <li>Checks, file changes, and saved artifacts</li>
            </ol>
          </div>
        </div>
      </>
    );
  }

  const phaseLabel = UI_PHASE_LABELS[run.phaseIndex] ?? "Unknown";
  const attemptText = run.attempt > 0 ? ` attempt ${run.attempt}/${run.maxAttempts}` : "";

  return (
    <>
      <div id="activity" className="panel">
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: ".95em" }}>
          Current activity
        </div>

        <div className="value-row">
          <span className="value">
            {phaseLabel}
            {attemptText}
          </span>
          <span className="muted">{run.stage ?? ""}</span>
        </div>

        {run.activeAgent && (
          <div className="value-row">
            <span className="label">Agent:</span>
            <button
              type="button"
              className="close-btn"
              style={{ fontWeight: 600 }}
              onClick={() => onSelectAgent(run.activeAgent!)}
            >
              {run.activeAgent}
            </button>
          </div>
        )}

        {run.currentTool && (
          <div className="value-row">
            <span className="label">Tool:</span>
            <span
              className={`tool-status-dot ${run.toolStatus ?? "ok"}`}
              aria-label={run.toolStatus ?? "ok"}
            />
            <span className="value">{run.currentTool}</span>
            {run.currentToolArgs && (
              <span className="muted">{trunc(run.currentToolArgs, 80)}</span>
            )}
          </div>
        )}

        {run.agentOutput && run.agentOutput.length > 0 && (
          <div
            className="output-box"
            aria-label="Agent output"
            style={{ maxHeight: 120 }}
          >
            {run.agentOutput.map((line, i) => (
              <span key={i}>{line}</span>
            ))}
          </div>
        )}
      </div>

      <div id="run-details" className="panel">
        <div style={{ fontWeight: 600, marginBottom: 8, fontSize: ".95em" }}>
          Run details
        </div>
        {renderDetail("Status", run.runStatus)}
        {renderDetail("Stage", run.stage)}
        {renderDetail("Attempt", `${run.attempt}/${run.maxAttempts}`)}
        {renderDetail("Checks", String(config?.checkCount ?? "—"))}
        {renderDetail("Version", run.extensionVersion ?? "?")}
        {renderDetail("Artifacts", run.artifactPath)}
      </div>
    </>
  );
}

function renderDetail(label: string, value: string | undefined) {
  return (
    <div className="value-row">
      <span className="label">{label}:</span>
      <span className="value">{value ?? "—"}</span>
    </div>
  );
}

function trunc(v: string | null | undefined, m: number): string {
  if (!v) return "";
  return v.length <= m ? v : v.slice(0, m - 1) + "…";
}
