// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewWizard, type InterviewWizardProps } from "./InterviewWizard.js";
import type { PendingQuestionInfo } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";

function question(questionId: string, options: Array<{ id: string; text: string; recommended?: boolean; picked?: boolean }>, kind: "single" | "multiple" = "single", answered = false): PendingQuestionInfo {
  return {
    decisionId: `decision-${questionId}`,
    questionId,
    kind,
    label: `Which ${questionId}?`,
    content: "**Goal:** Build a CLI",
    actions: [
      ...options.map(option => ({ value: `opt:${questionId}:${option.id}` as HumanDecisionAction, label: option.text, requiresFeedback: false })),
      { value: `custom:${questionId}` as HumanDecisionAction, label: "✏️ Type my own answer", requiresFeedback: true },
      { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
    ],
    question: {
      id: questionId,
      kind,
      options: options.map(option => ({ id: option.id, text: option.text, recommended: option.recommended ?? false, picked: option.picked ?? false })),
    },
    answered,
  };
}

function commitQuestion(): PendingQuestionInfo {
  return {
    decisionId: "decision-commit",
    questionId: "commit",
    kind: "single",
    label: "All questions are answered. Finish this round?",
    content: "**Goal:** Build a CLI",
    actions: [
      { value: "opt:commit:finish-round" as HumanDecisionAction, label: "Finish round", requiresFeedback: false },
      { value: "opt:commit:keep-working" as HumanDecisionAction, label: "Keep working", requiresFeedback: false },
      { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
    ],
    question: {
      id: "commit",
      kind: "single",
      options: [
        { id: "finish-round", text: "Finish round", recommended: true, picked: false },
        { id: "keep-working", text: "Keep working", recommended: false, picked: false },
      ],
    },
    answered: false,
  };
}

function baseProps(overrides: Partial<InterviewWizardProps> = {}, onSubmitAction = vi.fn(), onFocus = vi.fn()): InterviewWizardProps {
  return {
    runId: "run-1",
    questions: [
      question("q1", [{ id: "yes", text: "Yes", recommended: true }, { id: "no", text: "No" }]),
      question("q2", [{ id: "yes", text: "Yes" }]),
      question("q3", [{ id: "yes", text: "Yes" }]),
    ],
    focusIndex: 0,
    submissions: {},
    errors: {},
    onSubmitAction,
    onDismissError: vi.fn(),
    onFocus,
    onDismiss: vi.fn(),
    ...overrides,
  };
}

function dialog(): HTMLDivElement {
  const node = screen.getByRole("dialog") as HTMLDivElement;
  expect(node).not.toBeNull();
  return node;
}

describe("InterviewWizard", () => {
  afterEach(cleanup);

  it("renders nothing when there are no open questions", () => {
    const { container } = render(<InterviewWizard {...baseProps({ questions: [], focusIndex: null })} />);
    expect(container.innerHTML).toBe("");
  });

  it("renders only the focused question with its options", () => {
    render(<InterviewWizard {...baseProps()} />);

    expect(screen.getByText("Which q1?")).not.toBeNull();
    expect(screen.queryByText("Which q2?")).toBeNull();
    expect(screen.queryByText("Which q3?")).toBeNull();
    expect(screen.getByRole("option", { name: /Yes/ })).not.toBeNull();
    expect(screen.getByRole("option", { name: /No/ })).not.toBeNull();
    expect(screen.getByText("recommended")).not.toBeNull();
  });

  it("shows the position and answered count in the progress header", () => {
    render(<InterviewWizard {...baseProps({
      questions: [
        question("q1", [{ id: "yes", text: "Yes" }], "single", true),
        question("q2", [{ id: "yes", text: "Yes" }], "single", false),
        commitQuestion(),
      ],
      focusIndex: 2,
    })} />);

    expect(screen.getByText(/Question 3 of 3/)).not.toBeNull();
    expect(screen.getByText(/1 answered/)).not.toBeNull();
  });

  it("auto-advances to the next question after a single-choice pick", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({}, onSubmitAction, onFocus)} />);

    fireEvent.click(screen.getByRole("option", { name: /Yes/ }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "opt:q1:yes", undefined);
    expect(onFocus).toHaveBeenCalledWith(1);
  });

  it("does not auto-advance after a multi-select toggle", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({
      questions: [question("q1", [{ id: "windows", text: "Windows", picked: true }, { id: "linux", text: "Linux" }], "multiple")],
    }, onSubmitAction, onFocus)} />);

    fireEvent.click(screen.getByRole("option", { name: /Linux/ }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "opt:q1:linux", undefined);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("auto-advances after a custom answer is submitted", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({}, onSubmitAction, onFocus)} />);

    fireEvent.click(screen.getByRole("button", { name: /Type my own answer/ }));
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "  Cross-platform support  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "custom:q1", "Cross-platform support");
    expect(onFocus).toHaveBeenCalledWith(1);
  });

  it("does not auto-advance after cancelling the interview", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({}, onSubmitAction, onFocus)} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel interview" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel interview" })[1]);
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "cancel", undefined);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("moves focus with the Back and Next buttons and clamps at the ends", () => {
    const onFocus = vi.fn();
    const { rerender } = render(<InterviewWizard {...baseProps({ focusIndex: 1 }, vi.fn(), onFocus)} />);

    fireEvent.click(screen.getByRole("button", { name: "Next →" }));
    expect(onFocus).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByRole("button", { name: "← Back" }));
    expect(onFocus).toHaveBeenLastCalledWith(0);

    rerender(<InterviewWizard {...baseProps({ focusIndex: 0 }, vi.fn(), onFocus)} />);
    expect((screen.getByRole("button", { name: "← Back" }) as HTMLButtonElement).disabled).toBe(true);

    rerender(<InterviewWizard {...baseProps({ focusIndex: 2 }, vi.fn(), onFocus)} />);
    expect((screen.getByRole("button", { name: "Next →" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders the commit question with Finish round and Keep working and no custom answer", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({
      questions: [question("q1", [{ id: "yes", text: "Yes" }]), commitQuestion()],
      focusIndex: 1,
    }, onSubmitAction, onFocus)} />);

    expect(screen.getByText("All questions are answered. Finish this round?")).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Type my own answer/ })).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /Finish round/ }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-commit", "opt:commit:finish-round", undefined);
    expect(onFocus).not.toHaveBeenCalled();
  });

  it("keeps the next question enabled after answering the focused one", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({
      questions: [question("q1", [{ id: "yes", text: "Yes", picked: true }, { id: "no", text: "No" }]), question("q2", [{ id: "yes", text: "Yes" }])],
    }, onSubmitAction, onFocus)} />);

    const option = screen.getByRole("option", { name: /No/ }) as HTMLButtonElement;
    expect(option.disabled).toBe(false);
    fireEvent.click(option);
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "opt:q1:no", undefined);
    expect(onFocus).toHaveBeenCalledWith(1);
  });

  it("notes when the focused question was already answered in the terminal", () => {
    render(<InterviewWizard {...baseProps({
      submissions: { "decision-q1": "error" },
      errors: { "decision-q1": "HTTP 409: Decision is no longer active" },
    })} />);

    expect(screen.getByText("This question was already answered in the terminal.")).not.toBeNull();
    expect(screen.queryByText(/Error:/)).toBeNull();
  });

  it("shows an error banner with a dismiss button for other failures", () => {
    const onDismissError = vi.fn();
    render(<InterviewWizard {...baseProps({
      submissions: { "decision-q1": "error" },
      errors: { "decision-q1": "HTTP 500" },
      onDismissError,
    })} />);

    expect(screen.getByText(/Error: HTTP 500/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissError).toHaveBeenCalledWith("decision-q1");
  });

  it("lets the custom-answer textarea use arrow, number, and Enter keys natively", () => {
    const onSubmitAction = vi.fn();
    const onFocus = vi.fn();
    render(<InterviewWizard {...baseProps({}, onSubmitAction, onFocus)} />);

    fireEvent.click(screen.getByRole("button", { name: /Type my own answer/ }));
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.keyDown(textbox, { key: "ArrowLeft" });
    fireEvent.keyDown(textbox, { key: "ArrowRight" });
    fireEvent.keyDown(textbox, { key: "1" });
    fireEvent.keyDown(textbox, { key: "Enter" });
    expect(onFocus).not.toHaveBeenCalled();
    expect(onSubmitAction).not.toHaveBeenCalled();
  });

  it("dismisses the wizard through the close button", () => {
    const onDismiss = vi.fn();
    render(<InterviewWizard {...baseProps({ onDismiss })} />);

    fireEvent.keyDown(dialog(), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Close questions panel" }));
    expect(onDismiss).toHaveBeenCalledTimes(2);
  });
});
