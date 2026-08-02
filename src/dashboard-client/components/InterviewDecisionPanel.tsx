import React, { useEffect, useRef, useState } from "react";
import { MarkdownPreview } from "./MarkdownPreview.js";
import type { DashboardDecisionAction, DashboardDecisionQuestion } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";
import type { PreviewStatus, SubmissionStatus } from "../state.js";

const CUSTOM_BYTE_CAP = 2000;
const ANSWERED_ELSEWHERE = /(no longer active|already resolved|HTTP 409)/i;

export interface InterviewDecisionNav {
  questionIndex: number;
  questionTotal: number;
  answeredCount: number;
  onPrev: () => void;
  onNext: () => void;
  onDismiss: () => void;
  nextDisabled: boolean;
}

export interface InterviewDecisionPanelProps {
  decisionId: string;
  label: string;
  content: string | null;
  question: DashboardDecisionQuestion | null;
  allowedActions: DashboardDecisionAction[];
  previewStatus: PreviewStatus;
  previewError: string | null;
  submissionStatus: SubmissionStatus;
  submissionError: string | null;
  currentDecisionId: string | null;
  onRetryPreview: () => void;
  onSubmitAction: (action: HumanDecisionAction, feedback?: string) => void;
  onDismissError: () => void;
  nav?: InterviewDecisionNav;
}

export function InterviewDecisionPanel({
  decisionId,
  label,
  content,
  question,
  allowedActions,
  previewStatus,
  previewError,
  submissionStatus,
  submissionError,
  currentDecisionId,
  onRetryPreview,
  onSubmitAction,
  onDismissError,
  nav,
}: InterviewDecisionPanelProps) {
  const [feedback, setFeedback] = useState("");
  const [showCustom, setShowCustom] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const customRef = useRef<HTMLTextAreaElement>(null);

  const isSubmitting = submissionStatus === "submitting";
  const stale = currentDecisionId !== null && decisionId !== currentDecisionId;
  const inert = isSubmitting || stale;
  const answeredElsewhere = stale || Boolean(submissionError && ANSWERED_ELSEWHERE.test(submissionError));
  const options = question?.options ?? [];
  const questionId = question?.id ?? null;
  const isMultiple = question?.kind === "multiple";
  const pickCount = options.filter(option => option.picked).length;
  const feedbackBytes = new TextEncoder().encode(feedback).length;
  const feedbackOverLimit = feedbackBytes > CUSTOM_BYTE_CAP;

  function actionFor(value: string | null | undefined): DashboardDecisionAction | undefined {
    if (!value) return undefined;
    return allowedActions.find(candidate => candidate.value === value);
  }

  const optionActions = options.map(option => ({
    option,
    action: actionFor(questionId ? `opt:${questionId}:${option.id}` : null),
  }));
  const doneAction = actionFor(questionId ? `done:${questionId}` : null);
  const customAction = actionFor(questionId ? `custom:${questionId}` : null);
  const cancelAction = actionFor("cancel");

  function submit(action: DashboardDecisionAction | undefined, feedbackText?: string) {
    if (!action || inert) return;
    onSubmitAction(action.value, action.requiresFeedback ? feedbackText : undefined);
  }

  function chooseCustom() {
    if (!customAction || inert) return;
    if (!showCustom) {
      setConfirming(false);
      setShowCustom(true);
      setTimeout(() => customRef.current?.focus(), 0);
      return;
    }
    const text = feedback.trim();
    if (!text) return;
    submit(customAction, text);
  }

  function chooseCancel() {
    if (!cancelAction || inert) return;
    if (!confirming) {
      setShowCustom(false);
      setConfirming(true);
      return;
    }
    submit(cancelAction);
  }

  useEffect(() => {
    if (confirming) {
      const confirmNode = panelRef.current?.querySelector<HTMLElement>(".interview-confirm button");
      confirmNode?.focus();
    } else {
      const firstOption = panelRef.current?.querySelector<HTMLElement>(".interview-option");
      (firstOption ?? panelRef.current)?.focus();
    }
  }, [confirming, showCustom]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && target !== panel && !(target instanceof HTMLElement && target.closest(".interview-option, .interview-wizard-nav, .interview-wizard-close"))) return;
      if (event.key === "ArrowLeft" && nav) {
        event.preventDefault();
        nav.onPrev();
        return;
      }
      if (event.key === "ArrowRight" && nav) {
        event.preventDefault();
        nav.onNext();
        return;
      }
      if (event.key === "Escape" && nav?.onDismiss) {
        event.preventDefault();
        nav.onDismiss();
        return;
      }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const count = optionActions.length;
        if (count === 0) return;
        setActiveIndex(index => {
          const delta = event.key === "ArrowDown" ? 1 : -1;
          return (index + delta + count) % count;
        });
        return;
      }
      if (event.key === "Enter") {
        if (confirming) {
          event.preventDefault();
          submit(cancelAction);
          return;
        }
        event.preventDefault();
        submit(optionActions[activeIndex]?.action);
        return;
      }
      if (/^[1-9]$/.test(event.key)) {
        const index = Number(event.key) - 1;
        const entry = optionActions[index];
        if (entry) {
          event.preventDefault();
          submit(entry.action);
        }
      }
    }
    panel.addEventListener("keydown", handleKey);
    return () => panel.removeEventListener("keydown", handleKey);
  });

  const activeOptionId = optionActions[activeIndex] ? `interview-option-${optionActions[activeIndex].option.id}` : undefined;

  return (
    <div ref={panelRef} id="interview-decision-panel" role="dialog" aria-modal="true" aria-labelledby="interview-decision-heading" tabIndex={-1}>
      <div className="decision-header">
        <div>
          <div className="decision-badge">Interview question</div>
          <h2 id="interview-decision-heading">{label}</h2>
        </div>
        {nav && (
          <button type="button" className="icon-btn interview-wizard-close" onClick={nav.onDismiss} aria-label="Close questions panel">
            x
          </button>
        )}
      </div>

      {nav && (
        <div className="interview-wizard-nav">
          <button type="button" className="decision-btn" onClick={nav.onPrev} disabled={nav.questionIndex <= 1}>
            ← Back
          </button>
          <span className="muted">
            Question {nav.questionIndex} of {nav.questionTotal} · {nav.answeredCount} answered
          </span>
          <button type="button" className="decision-btn" onClick={nav.onNext} disabled={nav.nextDisabled}>
            Next →
          </button>
        </div>
      )}

      {previewStatus === "loading" && (
        <div className="decision-loading">
          <div className="spinner" />
          <span className="muted">Loading question...</span>
        </div>
      )}

      {previewStatus === "error" && (
        <div className="decision-loading">
          <span className="error-text">Failed to load question</span>
          {previewError && <span className="muted">({previewError})</span>}
          <button type="button" className="decision-btn changes" onClick={onRetryPreview}>
            Retry
          </button>
        </div>
      )}

      {previewStatus === "loaded" && (
        <div className="interview-card">
          <div className="interview-body">
            {content && (
              <div className="interview-question">
                <MarkdownPreview markdown={content} />
              </div>
            )}
            {question && (
              <div className="interview-options" role="listbox" aria-label="Answer options" aria-activedescendant={activeOptionId}>
                {optionActions.map((entry, index) => (
                  <button
                    key={entry.option.id}
                    type="button"
                    id={`interview-option-${entry.option.id}`}
                    role="option"
                    aria-selected={entry.option.picked || index === activeIndex}
                    className={`interview-option${entry.option.picked ? " picked" : ""}${index === activeIndex ? " active" : ""}`}
                    disabled={inert || !entry.action}
                    onClick={() => {
                      setActiveIndex(index);
                      submit(entry.action);
                    }}
                  >
                    <span className="interview-option-key">{index < 9 ? String(index + 1) : ""}</span>
                    <span className="interview-option-text">{entry.option.text}</span>
                    {entry.option.recommended && <span className="interview-option-badge">recommended</span>}
                    {entry.option.picked && <span className="interview-option-check" aria-label="Selected">✓</span>}
                  </button>
                ))}
              </div>
            )}
            {!question && content && (
              <div className="interview-fallback">
                <MarkdownPreview markdown={content} />
              </div>
            )}
          </div>

          <div className="interview-actions">
            {isMultiple && doneAction && (
              <button type="button" className="decision-btn approve" disabled={inert || pickCount === 0} onClick={() => submit(doneAction)}>
                Done{pickCount > 0 ? ` (${pickCount} selected)` : ""}
              </button>
            )}
            {customAction && showCustom ? (
              <div className="interview-custom">
                <label htmlFor="interview-custom-input">Your own answer:</label>
                <textarea
                  id="interview-custom-input"
                  ref={customRef}
                  value={feedback}
                  onChange={event => setFeedback(event.target.value)}
                  placeholder="Type your answer. It must not exceed 2000 bytes."
                  rows={3}
                  disabled={inert}
                />
                <div className="interview-custom-row">
                  <span className={`muted${feedbackOverLimit ? " error-text" : ""}`}>
                    {feedbackBytes} / {CUSTOM_BYTE_CAP} bytes
                  </span>
                  <button
                    type="button"
                    className="decision-btn changes"
                    disabled={inert || !feedback.trim() || feedbackOverLimit}
                    onClick={chooseCustom}
                  >
                    Submit answer
                  </button>
                </div>
              </div>
            ) : (
              customAction && (
                <button type="button" className="decision-btn changes" disabled={inert} onClick={chooseCustom}>
                  ✏️ Type my own answer
                </button>
              )
            )}
            {cancelAction && (
              <button type="button" className="decision-btn cancel" disabled={inert} onClick={chooseCancel}>
                Cancel interview
              </button>
            )}
          </div>

          {answeredElsewhere && (
            <div className="interview-muted-note" role="status">
              This question was already answered in the terminal.
            </div>
          )}

          {submissionStatus === "error" && submissionError && !answeredElsewhere && (
            <div className="decision-error-banner">
              <span>Error: {submissionError}</span>
              <button type="button" onClick={onDismissError}>Dismiss</button>
            </div>
          )}

          {confirming && (
            <div className="interview-confirm" role="alertdialog" aria-modal="true" aria-labelledby="interview-confirm-heading">
              <h3 id="interview-confirm-heading">Cancel the interview?</h3>
              <p>The interview and all answers so far will be discarded.</p>
              <div>
                <button type="button" className="decision-btn changes" onClick={() => setConfirming(false)}>
                  Go back
                </button>
                <button type="button" className="decision-btn cancel" onClick={() => submit(cancelAction)}>
                  Cancel interview
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
