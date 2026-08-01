import React, { useEffect, useRef, useState } from "react";
import type { PendingQuestionInfo } from "../../dashboard-types.js";
import type { DashboardDecisionAction } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";
import type { SubmissionStatus } from "../state.js";

const CUSTOM_BYTE_CAP = 2000;
const ANSWERED_ELSEWHERE = /(no longer active|already resolved|HTTP 409)/i;

export interface InterviewSetPanelProps {
  runId: string | null;
  questions: PendingQuestionInfo[];
  focusIndex: number | null;
  onFocus: (index: number) => void;
  submissions: Record<string, SubmissionStatus>;
  errors: Record<string, string>;
  onSubmitAction: (decisionId: string, action: HumanDecisionAction, feedback?: string) => void;
  onDismissError: (decisionId: string) => void;
}

export function InterviewSetPanel({
  runId,
  questions,
  focusIndex,
  onFocus,
  submissions,
  errors,
  onSubmitAction,
  onDismissError,
}: InterviewSetPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const customRef = useRef<Record<string, HTMLTextAreaElement | null>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState<Record<string, boolean>>({});
  const [activeOptions, setActiveOptions] = useState<Record<string, number>>({});

  const focused = focusIndex === null ? null : questions[focusIndex] ?? null;

  function firstUnpicked(question: PendingQuestionInfo): number {
    const index = question.question.options.findIndex(option => !option.picked);
    return index >= 0 ? index : 0;
  }

  useEffect(() => {
    setActiveOptions(previous => {
      const next: Record<string, number> = {};
      const live = new Set(questions.map(question => question.questionId));
      for (const [questionId, index] of Object.entries(previous)) {
        if (live.has(questionId)) next[questionId] = index;
      }
      for (const question of questions) {
        const current = next[question.questionId];
        const option = current === undefined ? undefined : question.question.options[current];
        if (current === undefined || (option !== undefined && option.picked)) {
          next[question.questionId] = firstUnpicked(question);
        }
      }
      return next;
    });
  }, [questions]);

  function actionFor(question: PendingQuestionInfo, value: string): DashboardDecisionAction | undefined {
    return question.actions.find(candidate => candidate.value === value);
  }

  function submit(question: PendingQuestionInfo, action: DashboardDecisionAction | undefined, feedbackText?: string) {
    if (!action) return;
    onSubmitAction(question.decisionId, action.value, action.requiresFeedback ? feedbackText : undefined);
  }

  function chooseCustom(question: PendingQuestionInfo) {
    if (!actionFor(question, `custom:${question.questionId}`)) return;
    if (!customOpen[question.questionId]) {
      setConfirming(current => ({ ...current, [question.questionId]: false }));
      setCustomOpen(current => ({ ...current, [question.questionId]: true }));
      setTimeout(() => customRef.current[question.questionId]?.focus(), 0);
      return;
    }
    const text = (feedback[question.questionId] ?? "").trim();
    if (!text) return;
    submit(question, actionFor(question, `custom:${question.questionId}`), text);
  }

  function chooseCancel(question: PendingQuestionInfo) {
    if (!actionFor(question, "cancel")) return;
    if (!confirming[question.questionId]) {
      setCustomOpen(current => ({ ...current, [question.questionId]: false }));
      setConfirming(current => ({ ...current, [question.questionId]: true }));
      return;
    }
    submit(question, actionFor(question, "cancel"));
  }

  function switchQuestion(delta: number) {
    if (questions.length === 0) return;
    const base = focusIndex ?? 0;
    onFocus((base + delta + questions.length) % questions.length);
  }

  function stepActiveOption(delta: number) {
    if (!focused) return;
    const count = focused.question.options.length;
    if (count === 0) return;
    setActiveOptions(previous => {
      const current = previous[focused.questionId] ?? firstUnpicked(focused);
      return { ...previous, [focused.questionId]: (current + delta + count) % count };
    });
  }

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        switchQuestion(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        switchQuestion(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        stepActiveOption(-1);
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        stepActiveOption(1);
        return;
      }
      if (event.key === "Enter" && focused) {
        event.preventDefault();
        const index = activeOptions[focused.questionId] ?? firstUnpicked(focused);
        const option = focused.question.options[index];
        if (option) {
          const action = actionFor(focused, `opt:${focused.questionId}:${option.id}`);
          if (action) submit(focused, action);
        }
        return;
      }
      if (/^[1-9]$/.test(event.key) && focused) {
        const option = focused.question.options[Number(event.key) - 1];
        if (option) {
          const action = actionFor(focused, `opt:${focused.questionId}:${option.id}`);
          if (action) {
            event.preventDefault();
            submit(focused, action);
          }
        }
      }
    }
    panel.addEventListener("keydown", handleKey);
    return () => panel.removeEventListener("keydown", handleKey);
  });

  if (questions.length === 0) return null;

  return (
    <div ref={panelRef} id="interview-set-panel" className="interview-set" data-run-id={runId ?? ""} tabIndex={-1}>
      <div className="interview-set-header">
        <div>
          <div className="decision-badge">Interview questions</div>
          <h2 id="interview-set-heading">Answering questions</h2>
        </div>
        <span className="muted">← / → switch questions · ↑ / ↓ pick an option · Enter submits</span>
      </div>
      <div className="interview-set-list" role="list" aria-label="Open questions">
        {questions.map((question, index) => {
          const questionId = question.questionId;
          const submissionStatus = submissions[question.decisionId] ?? "idle";
          const inert = submissionStatus === "submitting" || submissionStatus === "submitted";
          const answeredElsewhere = Boolean(errors[question.decisionId] && ANSWERED_ELSEWHERE.test(errors[question.decisionId]));
          const optionActions = question.question.options.map(option => ({
            option,
            action: actionFor(question, `opt:${questionId}:${option.id}`),
          }));
          const doneAction = actionFor(question, `done:${questionId}`);
          const pickCount = question.question.options.filter(option => option.picked).length;
          const activeOptionId = `interview-set-option-${questionId}-${optionActions[activeOptions[questionId] ?? firstUnpicked(question)]?.option.id}`;
          const focusedQuestion = focused?.questionId === questionId;
          return (
            <div
              key={questionId}
              id={`interview-set-question-${questionId}`}
              className={`interview-set-question${focusedQuestion ? " active" : ""}`}
              role="group"
              aria-labelledby={`interview-set-question-heading-${questionId}`}
            >
              <div className="interview-set-question-heading">
                <h3 id={`interview-set-question-heading-${questionId}`}>{index + 1}. {question.label}</h3>
                {submissionStatus === "submitting" && <span className="muted">Submitting...</span>}
                {submissionStatus === "submitted" && <span className="muted">Submitted</span>}
              </div>
              <div className="interview-set-options" role="listbox" aria-label={`Options for ${question.label}`} aria-activedescendant={focusedQuestion ? activeOptionId : undefined}>
                {optionActions.map((entry, optionIndex) => {
                  const activeIndex = activeOptions[questionId] ?? firstUnpicked(question);
                  return (
                    <button
                      key={entry.option.id}
                      type="button"
                      id={`interview-set-option-${questionId}-${entry.option.id}`}
                      role="option"
                      aria-selected={entry.option.picked || (focusedQuestion && optionIndex === activeIndex)}
                      className={`interview-option${entry.option.picked ? " picked" : ""}${focusedQuestion && optionIndex === activeIndex ? " active" : ""}`}
                      disabled={inert || !entry.action}
                      onClick={() => submit(question, entry.action)}
                    >
                      <span className="interview-option-key">{optionIndex < 9 ? String(optionIndex + 1) : ""}</span>
                      <span className="interview-option-text">{entry.option.text}</span>
                      {entry.option.recommended && <span className="interview-option-badge">recommended</span>}
                      {entry.option.picked && <span className="interview-option-check" aria-label="Selected">✓</span>}
                    </button>
                  );
                })}
              </div>
              <div className="interview-set-actions">
                {question.question.kind === "multiple" && doneAction && (
                  <button type="button" className="decision-btn approve" disabled={inert || pickCount === 0} onClick={() => submit(question, doneAction)}>
                    Done{pickCount > 0 ? ` (${pickCount} selected)` : ""}
                  </button>
                )}
                {actionFor(question, `custom:${questionId}`) && customOpen[questionId] ? (
                  <div className="interview-custom">
                    <label htmlFor={`interview-set-custom-${questionId}`}>Your own answer:</label>
                    <textarea
                      id={`interview-set-custom-${questionId}`}
                      ref={node => { customRef.current[questionId] = node; }}
                      value={feedback[questionId] ?? ""}
                      onChange={event => setFeedback(current => ({ ...current, [questionId]: event.target.value }))}
                      placeholder="Type your answer. It must not exceed 2000 bytes."
                      rows={2}
                      disabled={inert}
                    />
                    <div className="interview-custom-row">
                      <span className="muted">
                        {new TextEncoder().encode(feedback[questionId] ?? "").length} / {CUSTOM_BYTE_CAP} bytes
                      </span>
                      <button
                        type="button"
                        className="decision-btn changes"
                        disabled={inert || !(feedback[questionId] ?? "").trim() || new TextEncoder().encode(feedback[questionId] ?? "").length > CUSTOM_BYTE_CAP}
                        onClick={() => chooseCustom(question)}
                      >
                        Submit answer
                      </button>
                    </div>
                  </div>
                ) : (
                  actionFor(question, `custom:${questionId}`) && (
                    <button type="button" className="decision-btn changes" disabled={inert} onClick={() => chooseCustom(question)}>
                      ✏️ Type my own answer
                    </button>
                  )
                )}
                {actionFor(question, "cancel") && (
                  <button type="button" className="decision-btn cancel" disabled={inert} onClick={() => chooseCancel(question)}>
                    Cancel interview
                  </button>
                )}
              </div>
              {answeredElsewhere && (
                <div className="interview-muted-note" role="status">
                  This question was already answered in the terminal.
                </div>
              )}
              {submissionStatus === "error" && errors[question.decisionId] && !answeredElsewhere && (
                <div className="decision-error-banner">
                  <span>Error: {errors[question.decisionId]}</span>
                  <button type="button" onClick={() => onDismissError(question.decisionId)}>Dismiss</button>
                </div>
              )}
              {confirming[questionId] && (
                <div className="interview-confirm" role="alertdialog" aria-modal="true" aria-labelledby={`interview-set-confirm-heading-${questionId}`}>
                  <h3 id={`interview-set-confirm-heading-${questionId}`}>Cancel the interview?</h3>
                  <p>The interview and all answers so far will be discarded.</p>
                  <div>
                    <button type="button" className="decision-btn changes" onClick={() => setConfirming(current => ({ ...current, [questionId]: false }))}>
                      Go back
                    </button>
                    <button type="button" className="decision-btn cancel" onClick={() => submit(question, actionFor(question, "cancel"))}>
                      Cancel interview
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
