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

  return (
    <div id="phases">
      {UI_PHASE_LABELS.slice(0, phaseCount).map((label, i) => {
        const isSkipped = skipped.includes(i);
        const cls = isSkipped
          ? "phase skipped"
          : i < phaseIndex
            ? "phase done"
            : i === phaseIndex
              ? "phase active"
              : "phase pending";
        const icon = isSkipped ? "–" : i < phaseIndex ? "✓" : i === phaseIndex ? "→" : "•";
        const ariaLabel = isSkipped
          ? `Skipped: ${label}`
          : i < phaseIndex
            ? `Completed: ${label}`
            : i === phaseIndex
              ? `Current: ${label}`
              : `Pending: ${label}`;

        return (
          <div
            key={i}
            className={cls}
            aria-current={i === phaseIndex ? "step" : undefined}
            aria-label={ariaLabel}
          >
            <span className="phase-icon" aria-hidden="true">
              {icon}
            </span>{" "}
            {label}
          </div>
        );
      })}
    </div>
  );
}
