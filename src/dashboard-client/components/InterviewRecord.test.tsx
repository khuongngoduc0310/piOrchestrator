// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { InterviewRecord } from "./InterviewRecord.js";
import type { DashboardInterviewQAndA } from "../../dashboard-types.js";

const RECORD: DashboardInterviewQAndA[] = [
  {
    questionText: "Which platforms?",
    kind: "multiple",
    round: 1,
    options: [
      { id: "windows", text: "Windows", recommended: true, picked: true },
      { id: "macos", text: "macOS", recommended: false, picked: true },
      { id: "linux", text: "Linux", recommended: false, picked: false }
    ],
    answerText: "Windows, macOS"
  },
  {
    questionText: "Any constraints?",
    kind: "single",
    round: 1,
    options: [{ id: "yes", text: "Yes", recommended: true, picked: false }],
    answerText: "",
    customText: "Keep it small"
  },
  {
    questionText: "Where does it run?",
    kind: "single",
    round: 2,
    options: [
      { id: "server", text: "Server", recommended: true, picked: true },
      { id: "desktop", text: "Desktop", recommended: false, picked: false }
    ],
    answerText: "Server"
  }
];

describe("InterviewRecord", () => {
  afterEach(cleanup);

  it("renders the question with the picked option labels", () => {
    render(<InterviewRecord qa={RECORD} />);

    expect(screen.getByText("Which platforms?")).not.toBeNull();
    expect(screen.getByText("Windows")).not.toBeNull();
    expect(screen.getByText("macOS")).not.toBeNull();
    expect(screen.getByText("Where does it run?")).not.toBeNull();
    expect(screen.getByText("Server")).not.toBeNull();
  });

  it("marks multi-select questions and shows the custom answer", () => {
    render(<InterviewRecord qa={RECORD} />);

    expect(screen.getByText("multi-select")).not.toBeNull();
    expect(screen.getByText("Custom answer: Keep it small")).not.toBeNull();
  });

  it("flags the recommended option and highlights picked options", () => {
    render(<InterviewRecord qa={RECORD} />);

    expect(screen.getAllByText("recommended").length).toBe(3);
    const windows = screen.getByText("Windows").closest("li");
    const linux = screen.getByText("Linux").closest("li");
    expect(windows?.className).toContain("picked");
    expect(linux?.className).not.toContain("picked");
  });

  it("groups answered questions under round headings in order", () => {
    render(<InterviewRecord qa={RECORD} />);

    const headings = screen.getAllByText(/^Round \d+$/).map(node => node.textContent);
    expect(headings).toEqual(["Round 1", "Round 2"]);
    const firstRound = screen.getByText("Round 1").closest(".qa-round")!;
    expect(firstRound.textContent).toContain("Which platforms?");
    expect(firstRound.textContent).toContain("Any constraints?");
    expect(firstRound.textContent).not.toContain("Where does it run?");
  });

  it("falls back to the answer text when options are absent", () => {
    render(<InterviewRecord qa={[{ questionText: "Legacy?", kind: "single", round: 1, options: [], answerText: "Yes" }]} />);

    expect(screen.getByText("Yes")).not.toBeNull();
  });

  it("shows the empty state when nothing has been answered", () => {
    render(<InterviewRecord qa={[]} />);

    expect(screen.getByText(/No answers yet/)).not.toBeNull();
  });

  it("preserves answer order within a round", () => {
    render(<InterviewRecord qa={RECORD} />);

    const roundOne = screen.getByText("Round 1").closest(".qa-round")!;
    const texts = [...roundOne.querySelectorAll(".qa-question")].map(node => node.textContent);
    expect(texts).toEqual(["Which platforms?", "Any constraints?"]);
  });
});
