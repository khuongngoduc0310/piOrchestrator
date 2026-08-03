import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";
import type { DashboardDecisionAction } from "../dashboard-types.js";
import type { InterviewerAssessment, InterviewQuestion } from "../agent-task-types.js";
import type { InterviewActionResult, InterviewPresentation } from "./requirements-channel-types.js";

export const CUSTOM_ACTION_LABEL = "✏️ Type my own answer";
export const BACK_ACTION_LABEL = "← Back to questions";
export const CANCEL_ACTION_LABEL = "Cancel interview";
export const REVIEW_QUESTION: InterviewQuestion = {
  id: "review",
  kind: "single",
  text: "Was the goal clear?",
  options: [
    { id: "yes", text: "Yes — the goal is clear, proceed", recommended: true },
    { id: "no", text: "No — I still have doubts" }
  ]
};
export const REVIEW_YES_OPTION_ID = "yes";

/**
 * The commit question appended to every set: answering Finish round ends the
 * set and lets the interviewer assess. It is not an interviewer question; it
 * never reaches the round history.
 */
export const COMMIT_QUESTION: InterviewQuestion = {
  id: "commit",
  kind: "single",
  text: "All questions are answered. Finish this round?",
  options: [
    { id: "finish-round", text: "Finish round", recommended: true },
    { id: "keep-working", text: "Keep working" }
  ]
};
export const COMMIT_FINISH_ACTION = `opt:${COMMIT_QUESTION.id}:finish-round`;
export const COMMIT_KEEP_ACTION = `opt:${COMMIT_QUESTION.id}:keep-working`;

export type InterviewPresent = (
  session: { goal: string },
  question: InterviewQuestion,
  picked: readonly string[]
) => InterviewPresentation;

function presentationBody(
  question: InterviewQuestion,
  picked: readonly string[],
  options: { allowCustom?: boolean } = {}
): Pick<InterviewPresentation, "actions" | "question"> {
  const actions: DashboardDecisionAction[] = question.options.map(option => ({
    value: `opt:${question.id}:${option.id}` as HumanDecisionAction,
    label: option.text,
    requiresFeedback: false
  }));
  if (options.allowCustom !== false) {
    actions.push({ value: `custom:${question.id}` as HumanDecisionAction, label: CUSTOM_ACTION_LABEL, requiresFeedback: true });
  }
  actions.push({ value: "cancel" as HumanDecisionAction, label: CANCEL_ACTION_LABEL, requiresFeedback: false });
  return {
    actions,
    question: {
      id: question.id,
      kind: question.kind,
      options: question.options.map(option => ({
        id: option.id,
        text: option.text,
        recommended: option.recommended === true,
        picked: picked.includes(option.id)
      }))
    }
  };
}

export function questionPresentation(
  session: { goal: string },
  question: InterviewQuestion,
  picked: readonly string[]
): InterviewPresentation {
  const lines: string[] = [`**Goal:** ${session.goal}`, "", `## ${question.text}`];
  return {
    content: lines.join("\n"),
    ...presentationBody(question, picked)
  };
}

export function reviewPresentation(
  assessment: InterviewerAssessment,
  session: { goal: string },
  question: InterviewQuestion,
  picked: readonly string[]
): InterviewPresentation {
  const lines: string[] = [
    `**Goal:** ${session.goal}`,
    "",
    "**What the interviewer understands so far:**",
    assessment.summary
  ];
  if (assessment.openQuestions !== undefined && assessment.openQuestions.length > 0) {
    lines.push("", "**Still open:**", ...assessment.openQuestions.map(item => `- ${item}`));
  }
  lines.push("", `## ${question.text}`);
  return {
    content: lines.join("\n"),
    ...presentationBody(question, picked)
  };
}

/** Presentation for the round's commit question: Finish round / Keep working, no custom answer. */
export function commitPresentation(session: { goal: string }): InterviewPresentation {
  const lines: string[] = [
    `**Goal:** ${session.goal}`,
    "",
    `## ${COMMIT_QUESTION.text}`
  ];
  return {
    content: lines.join("\n"),
    ...presentationBody(COMMIT_QUESTION, [], { allowCustom: false })
  };
}

export function tuiQuestionLabels(question: InterviewQuestion, picked: readonly string[], allowCustom = true): string[] {
  return [
    ...question.options.map(option => {
      const base = `${option.text}${option.recommended ? " (recommended)" : ""}`;
      return picked.includes(option.id) ? `✓ ${base}` : base;
    }),
    ...(allowCustom ? [CUSTOM_ACTION_LABEL] : []),
    CANCEL_ACTION_LABEL
  ];
}

/** Maps a TUI answer-dialog choice to a dashboard decision action. */
export function mapTuiChoice(question: InterviewQuestion, choice: string): InterviewActionResult | undefined {
  if (choice === CUSTOM_ACTION_LABEL) return { action: `custom:${question.id}` };
  if (choice === CANCEL_ACTION_LABEL) return { action: "cancel" };
  const option = question.options.find(candidate => candidate.text === choice.replace(/^✓ /, "").replace(/ \(recommended\)$/, ""));
  if (!option) return undefined;
  return { action: `opt:${question.id}:${option.id}` };
}
