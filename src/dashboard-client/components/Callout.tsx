import type { OrchestratorViewModel } from "../../dashboard-types.js";

interface CalloutProps {
  snapshot: OrchestratorViewModel | null;
  onOpenArtifact: (name: string) => void;
}

export function Callout({ snapshot, onOpenArtifact }: CalloutProps) {
  if (!snapshot) return null;

  const { mode, run, config } = snapshot;

  // Idle/config states (no run)
  if (!run) {
    if (config?.status === "invalid") {
      return (
        <div id="callout" className="failed" role="alert">
          <div className="callout-title">Configuration error</div>
          <div className="callout-body">
            {config.message ?? "The configuration file could not be validated"}
          </div>
        </div>
      );
    }
    if (config?.status === "missing") {
      return (
        <div id="callout" className="waiting" role="status" aria-live="polite">
          <div className="callout-title">Setup required</div>
          <div className="callout-body">
            Project checks are not configured. Run <code>/orchestrate</code> to begin setup.
          </div>
        </div>
      );
    }
    return (
      <div id="callout" className="completed" role="status" aria-live="polite">
        <div className="callout-title">Ready</div>
        <div className="callout-body">
          Agents: {config?.agentCount ?? 0} · Checks: {config?.checkCount ?? 0}
          {snapshot.cwd ? ` · ${snapshot.cwd}` : ""}
        </div>
      </div>
    );
  }

  // Run-associated states
  switch (mode) {
    case "waiting":
      return run.waitingFor ? (
        <div id="callout" className="waiting" role="status" aria-live="polite">
          <div className="callout-title">Waiting for input</div>
          <div className="callout-body">{run.waitingFor}</div>
        </div>
      ) : null;

    case "failed":
      return (
        <div id="callout" className="failed" role="alert">
          <div className="callout-title">Failed</div>
          {run.message && (
            <div className="callout-body">{run.message}</div>
          )}
          {run.failedArtifact && (
            <Button className="close-btn" style={{ marginTop: 6 }} onClick={() => onOpenArtifact(run.failedArtifact!)}>
              Open failed artifact
            </Button>
          )}
          {run.resumeCommand && (
            <div className="callout-body">
              Safe checkpoint: {run.checkpoint?.cursor ?? "available"} · {run.resumeCommand}
            </div>
          )}
          {run.resumeBlockedReason && (
            <div className="callout-body">
              Resume unavailable: {run.resumeBlockedReason}
            </div>
          )}
        </div>
      );

    case "cancelled":
      return (
        <div id="callout" className="failed" role="status" aria-live="polite">
          <div className="callout-title">Cancelled</div>
          {run.message && (
            <div className="callout-body">{run.message}</div>
          )}
          {run.resumeCommand && (
            <div className="callout-body">Resume: {run.resumeCommand}</div>
          )}
          {run.resumeBlockedReason && (
            <div className="callout-body">
              Resume unavailable: {run.resumeBlockedReason}
            </div>
          )}
        </div>
      );

    case "completed":
      return (
        <div id="callout" className="completed" role="status" aria-live="polite">
          <div className="callout-title">Completed</div>
          {run.message && (
            <div className="callout-body">{run.message}</div>
          )}
        </div>
      );

    case "config_error":
      return (
        <div id="callout" className="failed" role="alert">
          <div className="callout-title">Configuration error</div>
          <div className="callout-body">
            {config?.message ?? "The configuration file could not be validated"}
          </div>
        </div>
      );

    default:
      return null;
  }
}

function Button({
  className,
  style,
  onClick,
  children,
}: {
  className?: string;
  style?: React.CSSProperties;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className={className} style={style} onClick={onClick}>
      {children}
    </button>
  );
}
