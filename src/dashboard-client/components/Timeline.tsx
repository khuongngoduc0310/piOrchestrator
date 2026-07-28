import React from "react";
import type { TimelineStepSummary } from "../../dashboard-types.js";
import type { WorkflowMilestone } from "../../workflow-types.js";
import { MarkdownPreview } from "./MarkdownPreview.js";

interface TimelineProps {
  steps: TimelineStepSummary[];
  milestones?: WorkflowMilestone[];
  onOpenArtifact: (name: string) => void;
}

export function Timeline({ steps, milestones = [], onOpenArtifact }: TimelineProps) {
  if (steps.length === 0 && milestones.length === 0) return null;

  const entries = [
    ...steps.map(step => ({ type: "step" as const, at: step.startedAt, step })),
    ...milestones.map(milestone => ({ type: "milestone" as const, at: milestone.occurredAt, milestone }))
  ].sort((left, right) => right.at.localeCompare(left.at));

  return (
    <div id="timeline-entries" role="list">
      {entries.map((entry) => {
        if (entry.type === "milestone") {
          const milestone = entry.milestone;
          return (
            <div key={`milestone:${milestone.id}`} className="timeline-step milestone" role="listitem" data-milestone-id={milestone.id}>
              <span className="ts">{milestone.occurredAt.slice(11, 19)}</span>
              <span className="status-text succeeded">
                <span aria-hidden="true">✓</span>
                <span className="visually-hidden">Milestone completed</span>
              </span>
              <div className="step-main">
                <div className="step-label">{milestone.title}</div>
                {milestone.details && <div className="milestone-details"><MarkdownPreview markdown={milestone.details} /></div>}
              </div>
            </div>
          );
        }
        const step = entry.step;
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
        const statusLabel = step.status.charAt(0).toUpperCase() + step.status.slice(1);

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
            <span className={`status-text ${statusClass}`}>
              <span aria-hidden="true">{icon}</span>
              <span className="visually-hidden">{statusLabel}</span>
            </span>
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
