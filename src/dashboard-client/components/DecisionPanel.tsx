import React, { useCallback, useRef, useState } from "react";
import { MarkdownPreview } from "./MarkdownPreview.js";
import type { DashboardDecisionAction } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";

interface DecisionPanelProps {
  decisionId: string;
  kind: string;
  label: string;
  planMarkdown: string | null;
  allowedActions: DashboardDecisionAction[];
  previewStatus: "idle" | "loading" | "loaded" | "error";
  previewError: string | null;
  submissionStatus: "idle" | "submitting" | "submitted" | "error";
  submissionError: string | null;
  onRetryPreview: () => void;
  onSubmitAction: (action: HumanDecisionAction, feedback?: string) => void;
  onDismissError: () => void;
}

export function DecisionPanel({
  kind,
  label,
  planMarkdown,
  allowedActions,
  previewStatus,
  previewError,
  submissionStatus,
  submissionError,
  onRetryPreview,
  onSubmitAction,
  onDismissError,
}: DecisionPanelProps) {
  const [feedback, setFeedback] = useState("");
  const [showFeedback, setShowFeedback] = useState(false);
  const feedbackRef = useRef<HTMLTextAreaElement>(null);

  const isSubmitting = submissionStatus === "submitting";
  const hasFeedback = feedback.trim().length > 0;

  const handleAction = useCallback((action: DashboardDecisionAction) => {
    if (isSubmitting) return;
    if (action.requiresFeedback && !showFeedback) {
      setShowFeedback(true);
      setTimeout(() => feedbackRef.current?.focus(), 0);
      return;
    }
    if (action.requiresFeedback && !hasFeedback) return;
    onSubmitAction(action.value, action.requiresFeedback ? feedback.trim() : undefined);
  }, [isSubmitting, showFeedback, hasFeedback, feedback, onSubmitAction]);

  const isPlanApproval = kind === "plan_approval" || kind === "plan_revision_approval";
  const isBaselineRepair = kind === "baseline_repair_approval";

  return (
    <div id="decision-panel" className="panel" role="dialog" aria-modal="true" aria-labelledby="decision-heading">
      <div className="decision-header">
        <div className="decision-badge">Decision required</div>
        <h2 id="decision-heading">{label}</h2>
        {isPlanApproval && <p className="muted">Review the plan below and approve, request changes, or cancel.</p>}
        {isBaselineRepair && <p className="muted">Review the baseline repair plan below and approve, request changes, or cancel.</p>}
      </div>

      {previewStatus === "loading" && (
        <div className="decision-loading">
          <div className="spinner" />
          <span className="muted">Loading plan...</span>
        </div>
      )}

      {previewStatus === "error" && (
        <div className="decision-loading">
          <span className="error-text">Failed to load plan preview</span>
          {previewError && <span className="muted">({previewError})</span>}
          <button type="button" className="decision-btn changes" onClick={onRetryPreview}>
            Retry
          </button>
        </div>
      )}

      {previewStatus === "loaded" && planMarkdown && (
        <div className="decision-plan">
          <MarkdownPreview markdown={planMarkdown} />
        </div>
      )}

      {previewStatus === "loaded" && (
        <div className="decision-actions">
          {showFeedback && allowedActions.some(action => action.requiresFeedback) && (
            <div className="decision-feedback">
              <label htmlFor="decision-feedback-input">
                Describe what changes you need:
              </label>
              <textarea
                id="decision-feedback-input"
                ref={feedbackRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="e.g. Add error handling to the login task"
                rows={3}
                required
                disabled={isSubmitting}
              />
            </div>
          )}
          <div className="decision-buttons">
            {allowedActions.map(action => (
              <button
                key={action.value}
                type="button"
                className={`decision-btn ${action.value === "cancel" ? "cancel" : action.requiresFeedback ? "changes" : "approve"}`}
                onClick={() => handleAction(action)}
                disabled={isSubmitting || (action.requiresFeedback && showFeedback && !hasFeedback)}
              >
                {action.requiresFeedback && showFeedback ? `Submit: ${action.label}` : action.label}
              </button>
            ))}
          </div>
          {submissionStatus === "error" && submissionError && (
            <div className="decision-error-banner">
              <span>Error: {submissionError}</span>
              <button type="button" onClick={onDismissError}>Dismiss</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
