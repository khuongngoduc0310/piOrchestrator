// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewSetPanel, type InterviewSetPanelProps } from "./InterviewSetPanel.js";
import type { PendingQuestionInfo } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";

function question(questionId: string, options: Array<{ id: string; text: string; recommended?: boolean; picked?: boolean }>, kind: "single" | "multiple" = "single"): PendingQuestionInfo {
  return {
    decisionId: `decision-${questionId}`,
    questionId,
    kind,
    label: `Which ${questionId}?`,
    content: "**Goal:** Build a CLI",
    actions: [
      ...options.map(option => ({ value: `opt:${questionId}:${option.id}` as HumanDecisionAction, label: option.text, requiresFeedback: false })),
      ...(kind === "multiple" ? [{ value: `done:${questionId}` as HumanDecisionAction, label: "Done", requiresFeedback: false }] : []),
      { value: `custom:${questionId}` as HumanDecisionAction, label: "✏️ Type my own answer", requiresFeedback: true },
      { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
    ],
    question: {
      id: questionId,
      kind,
      options: options.map(option => ({ id: option.id, text: option.text, recommended: option.recommended ?? false, picked: option.picked ?? false })),
    },
    answered: false,
  };
}

function baseProps(overrides: Partial<InterviewSetPanelProps> = {}, onSubmitAction = vi.fn(), onFocus = vi.fn()): InterviewSetPanelProps {
  return {
    runId: "run-1",
    questions: [question("q1", [{ id: "yes", text: "Yes", recommended: true }, { id: "no", text: "No" }])],
    focusIndex: 0,
    onFocus,
    submissions: {},
    errors: {},
    onSubmitAction,
    onDismissError: vi.fn(),
    ...overrides,
  };
}

function panel(): HTMLDivElement {
  const node = document.getElementById("interview-set-panel") as HTMLDivElement;
  expect(node).not.toBeNull();
  return node;
}

describe("InterviewSetPanel", () => {
  afterEach(cleanup);

  it("renders each open question with its options", () => {
    render(<InterviewSetPanel {...baseProps({
      questions: [question("q1", [{ id: "yes", text: "Yes", recommended: true }]), question("q2", [{ id: "yes", text: "Yes" }])],
    })} />);

    expect(screen.getByText("1. Which q1?")).not.toBeNull();
    expect(screen.getByText("2. Which q2?")).not.toBeNull();
    expect(screen.getAllByRole("option", { name: /Yes/ })).toHaveLength(2);
    expect(screen.getByText("recommended")).not.toBeNull();
  });

  it("renders nothing when there are no open questions", () => {
    const { container } = render(<InterviewSetPanel {...baseProps({ questions: [], focusIndex: null })} />);
    expect(container.innerHTML).toBe("");
  });

  it("submits the matching option action on click", () => {
    const onSubmitAction = vi.fn();
    render(<InterviewSetPanel {...baseProps({}, onSubmitAction)} />);

    fireEvent.click(screen.getByRole("option", { name: /Yes/ }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "opt:q1:yes", undefined);
  });

  it("switches the focused question with the arrow keys, wrapping around", () => {
    const onFocus = vi.fn();
    const questions = [question("q1", [{ id: "yes", text: "Yes" }]), question("q2", [{ id: "yes", text: "Yes" }])];
    const { rerender } = render(<InterviewSetPanel {...baseProps({ questions, focusIndex: 0 }, vi.fn(), onFocus)} />);

    fireEvent.keyDown(panel(), { key: "ArrowLeft" });
    expect(onFocus).toHaveBeenLastCalledWith(1);

    rerender(<InterviewSetPanel {...baseProps({ questions, focusIndex: 1 }, vi.fn(), onFocus)} />);
    fireEvent.keyDown(panel(), { key: "ArrowRight" });
    expect(onFocus).toHaveBeenLastCalledWith(0);
  });

  it("moves the active option within the focused question and submits it with Enter", () => {
    const onSubmitAction = vi.fn();
    render(<InterviewSetPanel {...baseProps({}, onSubmitAction)} />);

    fireEvent.keyDown(panel(), { key: "ArrowDown" });
    fireEvent.keyDown(panel(), { key: "Enter" });
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "opt:q1:no", undefined);
  });

  it("advances the active option to the first unpicked option after a pick arrives", () => {
    const onSubmitAction = vi.fn();
    const { rerender } = render(<InterviewSetPanel {...baseProps({}, onSubmitAction)} />);
    const node = panel();

    fireEvent.click(screen.getByRole("option", { name: /Yes/ }));
    rerender(<InterviewSetPanel {...baseProps({
      questions: [question("q1", [{ id: "yes", text: "Yes", recommended: true, picked: true }, { id: "no", text: "No" }])],
      submissions: { "decision-q1": "idle" },
    }, onSubmitAction)} />);

    fireEvent.keyDown(node, { key: "Enter" });
    expect(onSubmitAction).toHaveBeenLastCalledWith("decision-q1", "opt:q1:no", undefined);
  });

  it("submits the done action for multi-select questions with the pick count", () => {
    const onSubmitAction = vi.fn();
    render(<InterviewSetPanel {...baseProps({
      questions: [question("q1", [{ id: "windows", text: "Windows", picked: true }, { id: "linux", text: "Linux" }], "multiple")],
    }, onSubmitAction)} />);

    fireEvent.click(screen.getByRole("button", { name: "Done (1 selected)" }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "done:q1", undefined);
  });

  it("collects a trimmed custom answer through the own-answer textarea", () => {
    const onSubmitAction = vi.fn();
    render(<InterviewSetPanel {...baseProps({}, onSubmitAction)} />);

    fireEvent.click(screen.getByRole("button", { name: /Type my own answer/ }));
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "  Cross-platform support  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "custom:q1", "Cross-platform support");
  });

  it("requires a second click before cancelling the interview", () => {
    const onSubmitAction = vi.fn();
    render(<InterviewSetPanel {...baseProps({}, onSubmitAction)} />);

    fireEvent.click(screen.getByRole("button", { name: "Cancel interview" }));
    expect(onSubmitAction).not.toHaveBeenCalled();
    const confirm = screen.getByRole("alertdialog");
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel interview" }));
    expect(onSubmitAction).toHaveBeenCalledWith("decision-q1", "cancel", undefined);
  });

  it("notes when the question was already answered in the terminal", () => {
    render(<InterviewSetPanel {...baseProps({
      submissions: { "decision-q1": "error" },
      errors: { "decision-q1": "HTTP 409: Decision is no longer active" },
    })} />);

    expect(screen.getByText("This question was already answered in the terminal.")).not.toBeNull();
  });

  it("shows an error banner with a dismiss button for other failures", () => {
    const onDismissError = vi.fn();
    const { container } = render(<InterviewSetPanel {...baseProps({
      submissions: { "decision-q1": "error" },
      errors: { "decision-q1": "HTTP 500" },
      onDismissError,
    })} />);

    expect(container.querySelector(".decision-error-banner")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(onDismissError).toHaveBeenCalledWith("decision-q1");
  });

  it("disables interactions while a submission is in flight", () => {
    render(<InterviewSetPanel {...baseProps({ submissions: { "decision-q1": "submitting" } })} />);

    const option = screen.getByRole("option", { name: /Yes/ }) as HTMLButtonElement;
    expect(option.disabled).toBe(true);
  });
});
