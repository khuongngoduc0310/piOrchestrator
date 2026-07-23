import type { StepRecord } from "../../workflow-types.js";

interface TimelineProps {
  steps: StepRecord[];
  onOpenArtifact: (name: string) => void;
}

export function Timeline({ steps, onOpenArtifact }: TimelineProps) {
  if (steps.length === 0) return null;

  const reversed = [...steps].reverse();

  return (
    <div id="timeline-entries" role="list">
      {reversed.map((step) => {
        const statusClass =
          step.status === "succeeded"
            ? "succeeded"
            : step.status === "running"
              ? "running"
              : step.status === "failed"
                ? "failed"
                : "cancelled";
        const icon =
          step.status === "succeeded"
            ? "✓"
            : step.status === "running"
              ? "→"
              : step.status === "failed"
                ? "!"
                : "—";

        return (
          <div
            key={step.id}
            className="timeline-step"
            role="listitem"
            data-step-id={step.id}
          >
            <span className="ts">
              {step.startedAt ? step.startedAt.slice(11, 19) : ""}
            </span>
            <span className={`status-text ${statusClass}`}>{icon}</span>
            <div className="step-main">
              <div className="step-label">{step.label}</div>
              <div className="step-meta">
                {step.agent && <>{step.agent} </>}
                {step.attempt != null && <>attempt {step.attempt} </>}
                {step.revision != null && <>rev {step.revision} </>}
                {step.message && <>{step.message}</>}
              </div>
              {(step.artifact || step.rawArtifact || step.mutationArtifact) && (
                <div className="step-actions">
                  {step.artifact && (
                    <StepArtifactButton
                      name={step.artifact}
                      onClick={onOpenArtifact}
                    />
                  )}
                  {step.rawArtifact && (
                    <StepArtifactButton
                      name={step.rawArtifact}
                      onClick={onOpenArtifact}
                    />
                  )}
                  {step.mutationArtifact && (
                    <StepArtifactButton
                      name={step.mutationArtifact}
                      onClick={onOpenArtifact}
                    />
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StepArtifactButton({
  name,
  onClick,
}: {
  name: string;
  onClick: (name: string) => void;
}) {
  return (
    <button
      type="button"
      className="artifact-btn"
      data-artifact={name}
      onClick={() => onClick(name)}
    >
      {name}
    </button>
  );
}
