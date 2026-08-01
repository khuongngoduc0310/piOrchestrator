// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { RequirementReport } from "./RequirementReport.js";
import type { RequirementsSummary } from "../../dashboard-types.js";

const REQUIREMENT: RequirementsSummary = {
  goal: "Make the ledger better",
  summary: "A category breakdown of spending",
  scope: ["src/ledger.js", "test/ledger.js", "README.md"],
  constraints: ["No new dependencies"],
  acceptanceCriteria: ["npm test passes", "Balance is always correct"],
  openQuestions: ["Should categories be user-defined?"]
};

describe("RequirementReport", () => {
  afterEach(cleanup);

  it("renders the goal, summary, and structured sections", () => {
    render(<RequirementReport requirement={REQUIREMENT} />);

    expect(screen.getByText("Make the ledger better")).not.toBeNull();
    expect(screen.getByText("A category breakdown of spending")).not.toBeNull();
    expect(screen.getByText("Scope")).not.toBeNull();
    expect(screen.getByText("Constraints")).not.toBeNull();
    expect(screen.getByText("Acceptance criteria")).not.toBeNull();
    expect(screen.getByText("Open questions")).not.toBeNull();
    expect(screen.getByText("src/ledger.js")).not.toBeNull();
    expect(screen.getByText("No new dependencies")).not.toBeNull();
    expect(screen.getByText("npm test passes")).not.toBeNull();
    expect(screen.getByText("Should categories be user-defined?")).not.toBeNull();
  });

  it("shows None for empty open questions", () => {
    render(<RequirementReport requirement={{ ...REQUIREMENT, openQuestions: [] }} />);

    expect(screen.getByText("None")).not.toBeNull();
  });
});
