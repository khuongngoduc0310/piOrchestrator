import React, { useEffect, useRef, useState } from "react";
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
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const [confirmation, setConfirmation] = useState<DashboardDecisionAction | null>(null);

  const isSubmitting = submissionStatus === "submitting";
  const hasFeedback = feedback.trim().length > 0;

  function submitAction(action: DashboardDecisionAction) {
    if (isSubmitting) return;
    if (action.requiresFeedback && !showFeedback) {
      setShowFeedback(true);
      setTimeout(() => feedbackRef.current?.focus(), 0);
      return;
    }
    if (action.requiresFeedback && !hasFeedback) return;
    if (["cancel", "proceed", "accept_current", "finish"].includes(action.value) && confirmation?.value !== action.value) {
      setConfirmation(action);
      return;
    }
    onSubmitAction(action.value, action.requiresFeedback ? feedback.trim() : undefined);
  }

  const isPlanApproval = kind === "plan_approval" || kind === "plan_revision_approval";
  const isBaselineRepair = kind === "baseline_repair_approval";
  const headings = extractHeadings(planMarkdown ?? "");
  const evidence = evidenceStatus(planMarkdown ?? "", headings);

  useEffect(() => {
    if (confirmation) confirmationRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [confirmation]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first = panel.querySelector<HTMLElement>("button, [href], input, textarea, [tabindex]:not([tabindex='-1'])");
    (first ?? panel).focus();
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmation(null);
        return;
      }
      if (event.key !== "Tab") return;
      const focusScope = confirmationRef.current ?? panelRef.current;
      if (!focusScope) return;
      const focusable = [...focusScope.querySelectorAll<HTMLElement>("button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const firstItem = focusable[0];
      const lastItem = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === firstItem) { event.preventDefault(); lastItem.focus(); }
      else if (!event.shiftKey && document.activeElement === lastItem) { event.preventDefault(); firstItem.focus(); }
    }
    panel.addEventListener("keydown", handleKey);
    return () => {
      panel.removeEventListener("keydown", handleKey);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div ref={panelRef} id="decision-panel" role="dialog" aria-modal="true" aria-labelledby="decision-heading" tabIndex={-1}>
      <div className="decision-header">
        <div><div className="decision-badge">Decision required</div>
        <h2 id="decision-heading">{label}</h2>
        {isPlanApproval && <p className="muted">Review the plan below and approve, request changes, or cancel.</p>}
        {isBaselineRepair && <p className="muted">Review the baseline repair plan below and approve, request changes, or cancel.</p>}</div>
        <div className="decision-evidence-status">{evidence.map(item => <span key={item.label}>{item.label}: {item.available ? "available" : "unavailable"}</span>)}</div>
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
        <div className="decision-workspace">
          <nav className="decision-outline" aria-label="Evidence outline"><strong>AVAILABLE EVIDENCE</strong>{headings.length ? headings.map((heading, index) => <button type="button" key={`${heading}-${index}`} onClick={() => panelRef.current?.querySelectorAll(".decision-plan h1, .decision-plan h2, .decision-plan h3")[index]?.scrollIntoView({ block: "start" })}>{heading}</button>) : <span className="muted">Plan has no headings</span>}<button type="button" disabled>Diff / unavailable</button></nav>
          <article className="decision-plan" aria-label="Approval document"><MarkdownPreview markdown={planMarkdown} /></article>
        </div>
      )}

      {previewStatus === "loaded" && (
        <div className="decision-actions">
          {showFeedback && allowedActions.some(action => action.requiresFeedback) && (
            <div className="decision-feedback">
              <label htmlFor="decision-feedback-input">
                Markdown feedback describing the requested changes:
              </label>
              <textarea
                id="decision-feedback-input"
                ref={feedbackRef}
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Use Markdown to describe required changes and evidence."
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
                onClick={() => submitAction(action)}
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
          {confirmation && <div ref={confirmationRef} className="decision-confirm" role="alertdialog" aria-modal="true" aria-labelledby="decision-confirm-heading"><h3 id="decision-confirm-heading">Confirm {confirmation.label.toLowerCase()}</h3><p>This action can stop the workflow or accept evidence with unresolved risk. It cannot be dismissed by clicking outside.</p><div><button type="button" className="decision-btn changes" onClick={() => setConfirmation(null)}>Go back</button><button type="button" className="decision-btn cancel" onClick={() => submitAction(confirmation)}>Confirm {confirmation.label}</button></div></div>}
        </div>
      )}
    </div>
  );
}

export function extractHeadings(markdown: string): string[] {
  return markdown.split("\n").map(line => line.match(/^#{1,3}\s+(.+)$/)?.[1]?.trim()).filter((value): value is string => Boolean(value));
}

function evidenceStatus(markdown: string, headings: string[]) {
  const evidenceText = headings.join(" ").toLowerCase();
  return [
    { label: "Review document", available: markdown.trim().length > 0 },
    { label: "Files", available: /\bfiles?\b|changed paths?|authorized paths?/.test(evidenceText) },
    { label: "Checks", available: /\bchecks?\b|verification|test results?/.test(evidenceText) },
    { label: "Risks", available: /\brisks?\b|assumptions?|blocking issues?/.test(evidenceText) },
    { label: "Diff", available: false },
  ];
}
