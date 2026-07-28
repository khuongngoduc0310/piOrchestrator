// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DecisionPanel } from "./DecisionPanel.js";

describe("DecisionPanel", () => {
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
});
