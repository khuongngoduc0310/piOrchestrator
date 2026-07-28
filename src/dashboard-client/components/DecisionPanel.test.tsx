// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "./DecisionPanel.js";

describe("DecisionPanel", () => {
  afterEach(cleanup);
  it("requires nonblank feedback before submitting a revision", () => {
    const onSubmitAction = vi.fn();
    render(
      <DecisionPanel
        decisionId="decision-1"
        kind="plan_approval"
        label="Review plan"
        planMarkdown="# Plan"
        allowedActions={[{ value: "revise", label: "Request changes", requiresFeedback: true }]}
        previewStatus="loaded"
        previewError={null}
        submissionStatus="idle"
        submissionError={null}
        onRetryPreview={vi.fn()}
        onSubmitAction={onSubmitAction}
        onDismissError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Request changes" }));
    const submit = screen.getByRole("button", { name: "Submit: Request changes" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "   " } });
    expect(submit.disabled).toBe(true);
    expect(onSubmitAction).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "  Add a test  " } });
    fireEvent.click(submit);
    expect(onSubmitAction).toHaveBeenCalledWith("revise", "Add a test");
  });

  it("builds an evidence outline and confirms destructive cancellation", () => {
    const onSubmitAction = vi.fn();
    render(<DecisionPanel decisionId="decision-2" kind="plan_approval" label="Review plan" planMarkdown="# Plan\n\n## Checks\n\nRun tests." allowedActions={[{ value: "cancel", label: "Cancel workflow", requiresFeedback: false }]} previewStatus="loaded" previewError={null} submissionStatus="idle" submissionError={null} onRetryPreview={vi.fn()} onSubmitAction={onSubmitAction} onDismissError={vi.fn()} />);

    expect(screen.getByRole("navigation", { name: "Evidence outline" })).not.toBeNull();
    expect((screen.getByRole("button", { name: "Diff / unavailable" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel workflow" }));
    expect(onSubmitAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm Cancel workflow" }));
    expect(onSubmitAction).toHaveBeenCalledWith("cancel", undefined);
  });

  it("keeps Escape inside the approval workspace", () => {
    render(<DecisionPanel decisionId="decision-3" kind="mutation_confirmation" label="Confirm mutation" planMarkdown="# Scope" allowedActions={[{ value: "proceed", label: "Proceed", requiresFeedback: false }]} previewStatus="loaded" previewError={null} submissionStatus="idle" submissionError={null} onRetryPreview={vi.fn()} onSubmitAction={vi.fn()} onDismissError={vi.fn()} />);
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).not.toBeNull();
  });
});
