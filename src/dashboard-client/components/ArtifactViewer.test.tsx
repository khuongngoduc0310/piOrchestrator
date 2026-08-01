// @vitest-environment jsdom

import React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { ArtifactViewer } from "./ArtifactViewer.js";

describe("ArtifactViewer", () => {
  it("opens the selected artifact from the recent artifact list", () => {
    const onOpenArtifact = vi.fn();
    const snapshot = {
      run: null,
      recentSteps: [{ id: "step-1", artifact: "plan.md" }],
    } as unknown as OrchestratorViewModel;

    render(
      <ArtifactViewer
        snapshot={snapshot}
        selectedArtifact={null}
        runId="run-1"
        onCloseArtifact={vi.fn()}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "plan.md" }));

    expect(onOpenArtifact).toHaveBeenCalledOnce();
    expect(onOpenArtifact).toHaveBeenCalledWith("plan.md");
  });

  it("lists run-level artifact names and de-duplicates step artifacts", () => {
    const onOpenArtifact = vi.fn();
    const snapshot = {
      run: { artifactNames: ["requirements.md", "requirements.json"] },
      recentSteps: [{ id: "step-1", artifact: "requirements.md" }],
    } as unknown as OrchestratorViewModel;

    render(
      <ArtifactViewer
        snapshot={snapshot}
        selectedArtifact={null}
        runId="run-1"
        onCloseArtifact={vi.fn()}
        onOpenArtifact={onOpenArtifact}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "requirements.md" }));
    fireEvent.click(screen.getByRole("button", { name: "requirements.json" }));

    expect(onOpenArtifact).toHaveBeenNthCalledWith(1, "requirements.md");
    expect(onOpenArtifact).toHaveBeenNthCalledWith(2, "requirements.json");
    expect(screen.getAllByRole("button", { name: "requirements.md" })).toHaveLength(1);
  });
});
