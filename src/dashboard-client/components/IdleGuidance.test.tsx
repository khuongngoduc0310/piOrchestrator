// @vitest-environment jsdom

import React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { Callout } from "./Callout.js";
import { Overview } from "./Overview.js";

const idleSnapshot: OrchestratorViewModel = {
  mode: "idle",
  cwd: "/project",
  config: { status: "missing", agentCount: 7, checkCount: 0 },
  agents: [],
  recentSteps: [],
  commands: ["/orchestrate"]
};

describe("idle dashboard guidance", () => {
  it("explains that read-only routes do not trigger check setup", () => {
    render(<Callout snapshot={idleSnapshot} onOpenArtifact={vi.fn()} />);

    expect(screen.getByText("Setup deferred")).toBeTruthy();
    expect(screen.getByText(/Read-only routes need no project checks/)).toBeTruthy();
    expect(screen.getByText(/only after a mutation route is approved/)).toBeTruthy();
  });

  it("describes route-dependent overview output", () => {
    render(<Overview snapshot={idleSnapshot} onSelectAgent={vi.fn()} />);

    expect(screen.getByText("Exploration and a plan for the selected route")).toBeTruthy();
    expect(screen.getByText(/checks and file changes when the route uses them/)).toBeTruthy();
  });
});
