import React from "react";
import type { PendingQuestionInfo } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";
import type { SubmissionStatus } from "../state.js";
import { InterviewDecisionPanel } from "./InterviewDecisionPanel.js";

export interface InterviewWizardProps {
  runId: string | null;
  questions: PendingQuestionInfo[];
  focusIndex: number | null;
  submissions: Record<string, SubmissionStatus>;
  errors: Record<string, string>;
  onSubmitAction: (decisionId: string, action: HumanDecisionAction, feedback?: string) => void;
  onDismissError: (decisionId: string) => void;
  onFocus: (index: number) => void;
  onDismiss: () => void;
}

export function InterviewWizard({
  runId,
  questions,
  focusIndex,
  submissions,
  errors,
  onSubmitAction,
  onDismissError,
  onFocus,
  onDismiss,
}: InterviewWizardProps) {
  if (questions.length === 0) return null;
  const focusedIndex = focusIndex ?? 0;
  const focused = questions[focusedIndex] ?? null;
  if (!focused) return null;

  const realQuestions = questions.filter(question => question.questionId !== "commit");
  const answeredCount = realQuestions.filter(question => question.answered).length;
  const lastIndex = questions.length - 1;

  const submitFocused = (action: HumanDecisionAction, feedback?: string) => {
    onSubmitAction(focused.decisionId, action, feedback);
    if (focused.questionId === "commit") return;
    const optimisticPick = action.startsWith("opt:") || action.startsWith("custom:");
    if (!optimisticPick || focused.question.kind === "multiple") return;
    onFocus(Math.min(focusedIndex + 1, lastIndex));
  };

  return (
    <div className="interview-wizard" data-run-id={runId ?? ""}>
      <InterviewDecisionPanel
        key={focused.decisionId}
        decisionId={focused.decisionId}
        label={focused.label}
        content={focused.content}
        question={focused.question}
        allowedActions={focused.actions}
        previewStatus="loaded"
        previewError={null}
        submissionStatus={submissions[focused.decisionId] ?? "idle"}
        submissionError={errors[focused.decisionId] ?? null}
        currentDecisionId={null}
        onRetryPreview={() => {}}
        onSubmitAction={submitFocused}
        onDismissError={() => onDismissError(focused.decisionId)}
        nav={{
          questionIndex: focusedIndex + 1,
          questionTotal: questions.length,
          answeredCount,
          onPrev: () => { if (focusedIndex > 0) onFocus(focusedIndex - 1); },
          onNext: () => { if (focusedIndex < lastIndex) onFocus(focusedIndex + 1); },
          onDismiss,
          nextDisabled: focusedIndex >= lastIndex,
        }}
      />
    </div>
  );
}
