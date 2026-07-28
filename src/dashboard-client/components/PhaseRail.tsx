import React from "react";
import { UI_PHASE_LABELS } from "../../dashboard-types.js";
import type { RunSummary } from "../../dashboard-types.js";

interface PhaseRailProps {
  run: RunSummary | null;
}

export function PhaseRail({ run }: PhaseRailProps) {
  if (!run) return null;

  const phaseIndex = run.phaseIndex;
  const phaseCount = run.phaseCount ?? UI_PHASE_LABELS.length;
  const skipped = run.skippedPhaseIndexes ?? [];
  const completed = run.runStatus === "completed";
  const terminalStatus = run.runStatus === "failed" || run.runStatus === "cancelled"
    ? run.runStatus
    : null;

  return (
    <section className="phase-graph" aria-labelledby="phase-graph-heading">
      <div className="section-kicker">AUTHORITATIVE ROUTE</div>
      <h2 id="phase-graph-heading">Workflow progress</h2>
      <div id="phases" role="list" aria-label="Route phases">
      {UI_PHASE_LABELS.slice(0, phaseCount).map((label, i) => {
        const isSkipped = skipped.includes(i);
        const isTerminalPhase = terminalStatus !== null && i === phaseIndex;
        const cls = isSkipped
          ? "phase skipped"
          : isTerminalPhase
            ? `phase ${terminalStatus}`
          : i < phaseIndex || (completed && i === phaseIndex)
            ? "phase done"
            : i === phaseIndex
              ? "phase active"
              : "phase pending";
        const icon = isSkipped ? "-" : isTerminalPhase ? terminalStatus === "failed" ? "!" : "x" : i < phaseIndex || (completed && i === phaseIndex) ? "OK" : i === phaseIndex ? ">" : ".";
        const ariaLabel = isSkipped
          ? `Skipped: ${label}`
          : isTerminalPhase
            ? `${terminalStatus === "failed" ? "Failed" : "Cancelled"}: ${label}`
          : i < phaseIndex || (completed && i === phaseIndex)
            ? `Completed: ${label}`
            : i === phaseIndex
              ? `Current: ${label}`
              : `Pending: ${label}`;

        return (
          <div
            key={i}
            className={cls}
            aria-current={!completed && !terminalStatus && i === phaseIndex ? "step" : undefined}
            aria-label={ariaLabel}
            role="listitem"
          >
            <span className="phase-icon" aria-hidden="true">
              {icon}
            </span>{" "}
            {label}
          </div>
        );
      })}
      </div>
    </section>
  );
}
