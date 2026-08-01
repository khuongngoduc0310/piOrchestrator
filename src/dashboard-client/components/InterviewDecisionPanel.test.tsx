// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InterviewDecisionPanel, type InterviewDecisionPanelProps } from "./InterviewDecisionPanel.js";
import type { DashboardDecisionAction, DashboardDecisionQuestion } from "../../dashboard-types.js";
import type { HumanDecisionAction } from "../../orchestration/human-decision-types.js";

const SINGLE_QUESTION: DashboardDecisionQuestion = {
  id: "q1",
  kind: "single",
  options: [
    { id: "yes", text: "Yes", recommended: true, picked: false },
    { id: "no", text: "No", recommended: false, picked: false },
  ],
};

const MULTI_QUESTION: DashboardDecisionQuestion = {
  id: "q1",
  kind: "multiple",
  options: [
    { id: "windows", text: "Windows", recommended: true, picked: true },
    { id: "linux", text: "Linux", recommended: false, picked: false },
  ],
};

const SINGLE_ACTIONS: DashboardDecisionAction[] = [
  { value: "opt:q1:yes" as HumanDecisionAction, label: "Yes", requiresFeedback: false },
  { value: "opt:q1:no" as HumanDecisionAction, label: "No", requiresFeedback: false },
  { value: "custom:q1" as HumanDecisionAction, label: "✏️ Type my own answer", requiresFeedback: true },
  { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
];

function renderPanel(overrides: Partial<InterviewDecisionPanelProps> = {}, onSubmitAction = vi.fn()) {
  const props: InterviewDecisionPanelProps = {
    decisionId: "decision-1",
    label: "Which platforms?",
    content: "**Goal:** Build a CLI\n\n## Which platforms?",
    question: SINGLE_QUESTION,
    allowedActions: SINGLE_ACTIONS,
    previewStatus: "loaded",
    previewError: null,
    submissionStatus: "idle",
    submissionError: null,
    currentDecisionId: "decision-1",
    onRetryPreview: vi.fn(),
    onSubmitAction,
    onDismissError: vi.fn(),
    ...overrides,
  };
  render(<InterviewDecisionPanel {...props} />);
  return onSubmitAction;
}

describe("InterviewDecisionPanel", () => {
  afterEach(cleanup);

  it("renders the goal header, question, and structured options with a recommended badge", () => {
    renderPanel();

    expect(screen.getByText("Goal:")).not.toBeNull();
    expect(screen.getAllByText("Which platforms?").length).toBeGreaterThan(0);
    expect(screen.getByRole("option", { name: /Yes/ })).not.toBeNull();
    expect(screen.getByText("recommended")).not.toBeNull();
  });

  it("submits the matching option action on click", () => {
    const onSubmitAction = renderPanel();

    fireEvent.click(screen.getByRole("option", { name: /Yes/ }));
    expect(onSubmitAction).toHaveBeenCalledWith("opt:q1:yes", undefined);
  });

  it("marks picked options and shows the pick count on the Done action for multi-select", () => {
    renderPanel({
        question: MULTI_QUESTION,
        allowedActions: [
          { value: "opt:q1:windows" as HumanDecisionAction, label: "Windows", requiresFeedback: false },
          { value: "opt:q1:linux" as HumanDecisionAction, label: "Linux", requiresFeedback: false },
          { value: "done:q1" as HumanDecisionAction, label: "Done", requiresFeedback: false },
          { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
        ],
      },
    );

    expect(screen.getByRole("option", { name: /Windows/ }).className).toContain("picked");
    expect(screen.getByRole("button", { name: "Done (1 selected)" })).not.toBeNull();
  });

  it("submits the done action for multi-select", () => {
    const onSubmitAction = vi.fn();
    renderPanel(
      {
        question: MULTI_QUESTION,
        allowedActions: [
          { value: "opt:q1:windows" as HumanDecisionAction, label: "Windows", requiresFeedback: false },
          { value: "opt:q1:linux" as HumanDecisionAction, label: "Linux", requiresFeedback: false },
          { value: "done:q1" as HumanDecisionAction, label: "Done", requiresFeedback: false },
          { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
        ],
      },
      onSubmitAction,
    );

    fireEvent.click(screen.getByRole("button", { name: /Done/ }));
    expect(onSubmitAction).toHaveBeenCalledWith("done:q1", undefined);
  });

  it("collects a trimmed custom answer through the own-answer textarea", () => {
    const onSubmitAction = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Type my own answer/ }));
    const textbox = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(textbox, { target: { value: "  Cross-platform support  " } });
    fireEvent.click(screen.getByRole("button", { name: "Submit answer" }));
    expect(onSubmitAction).toHaveBeenCalledWith("custom:q1", "Cross-platform support");
  });

  it("disables the custom answer submit beyond the byte cap", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Type my own answer/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "x".repeat(2001) } });
    expect((screen.getByRole("button", { name: "Submit answer" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("navigates options with arrows and submits the active option with Enter", () => {
    const onSubmitAction = renderPanel();

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "ArrowDown" });
    fireEvent.keyDown(dialog, { key: "Enter" });
    expect(onSubmitAction).toHaveBeenCalledWith("opt:q1:no", undefined);
  });

  it("jumps to an option with its number key", () => {
    const onSubmitAction = renderPanel();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "1" });
    expect(onSubmitAction).toHaveBeenCalledWith("opt:q1:yes", undefined);
  });

  it("disables all controls when the decision is no longer current", () => {
    const onSubmitAction = renderPanel({ currentDecisionId: "decision-2" });

    expect((screen.getByRole("option", { name: /Yes/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("This question was already answered in the terminal.")).not.toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Yes/ }));
    expect(onSubmitAction).not.toHaveBeenCalled();
  });

  it("shows a muted note instead of an error banner when the decision was resolved elsewhere", () => {
    renderPanel({ submissionStatus: "error", submissionError: "Decision is no longer active" });

    expect(screen.getByText("This question was already answered in the terminal.")).not.toBeNull();
    expect(screen.queryByText(/Error:/)).toBeNull();
  });

  it("confirms cancellation before submitting", () => {
    const onSubmitAction = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Cancel interview" }));
    expect(onSubmitAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Go back" }));
    expect(onSubmitAction).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Cancel interview" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Cancel interview" })[1]);
    expect(onSubmitAction).toHaveBeenCalledWith("cancel", undefined);
  });

  it("keeps Escape from dismissing the interview", () => {
    renderPanel();

    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).not.toBeNull();
  });

  it("does not hijack Enter on the custom-answer submit button", () => {
    const onSubmitAction = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Type my own answer/ }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Cross-platform support" } });
    const submitButton = screen.getByRole("button", { name: "Submit answer" });
    fireEvent.keyDown(submitButton, { key: "Enter" });
    expect(onSubmitAction).not.toHaveBeenCalled();

    fireEvent.click(submitButton);
    expect(onSubmitAction).toHaveBeenCalledWith("custom:q1", "Cross-platform support");
  });

  it("does not hijack Enter on the cancel button", () => {
    const onSubmitAction = renderPanel();

    const cancelButton = screen.getByRole("button", { name: "Cancel interview" });
    fireEvent.keyDown(cancelButton, { key: "Enter" });
    expect(onSubmitAction).not.toHaveBeenCalled();
    expect(screen.queryByText("Cancel the interview?")).toBeNull();

    fireEvent.click(cancelButton);
    expect(screen.getByText("Cancel the interview?")).not.toBeNull();
    expect(onSubmitAction).not.toHaveBeenCalled();
  });

  it("does not submit cancel when Enter is pressed on Go back", () => {
    const onSubmitAction = renderPanel();

    fireEvent.click(screen.getByRole("button", { name: "Cancel interview" }));
    fireEvent.keyDown(screen.getByRole("button", { name: "Go back" }), { key: "Enter" });
    expect(onSubmitAction).not.toHaveBeenCalled();
    expect(screen.getByText("Cancel the interview?")).not.toBeNull();
  });

  it("disables Done for a multi-select question with no picks", () => {
    renderPanel({
      question: { ...MULTI_QUESTION, options: MULTI_QUESTION.options.map(option => ({ ...option, picked: false })) },
      allowedActions: [
        { value: "opt:q1:windows" as HumanDecisionAction, label: "Windows", requiresFeedback: false },
        { value: "opt:q1:linux" as HumanDecisionAction, label: "Linux", requiresFeedback: false },
        { value: "done:q1" as HumanDecisionAction, label: "Done", requiresFeedback: false },
        { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
      ],
    });

    expect((screen.getByRole("button", { name: /Done/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("enables Done for a multi-select question with picks", () => {
    renderPanel({
      question: MULTI_QUESTION,
      allowedActions: [
        { value: "opt:q1:windows" as HumanDecisionAction, label: "Windows", requiresFeedback: false },
        { value: "opt:q1:linux" as HumanDecisionAction, label: "Linux", requiresFeedback: false },
        { value: "done:q1" as HumanDecisionAction, label: "Done", requiresFeedback: false },
        { value: "cancel" as HumanDecisionAction, label: "Cancel interview", requiresFeedback: false },
      ],
    });

    expect((screen.getByRole("button", { name: /Done \(1 selected\)/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
