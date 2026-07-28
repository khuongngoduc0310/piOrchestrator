// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentHistory } from "./AgentHistory.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AgentHistory live transcripts", () => {
  it("opens a running invocation before a transcript artifact exists", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/agent-history")) {
        return new Response(JSON.stringify({
          runId: "run-1",
          total: { invocationCount: 1, measuredInvocationCount: 0 },
          agents: [{ name: "builder", invocationCount: 1, measuredInvocationCount: 0 }],
          invocations: [{
            key: "step-1:1",
            stepId: "step-1",
            stepLabel: "Build feature",
            sequence: 1,
            agent: "builder",
            mode: "execute",
            status: "running",
            startedAt: "2026-01-01T00:00:00.000Z",
            hasTranscript: false,
            hasDiff: false,
          }],
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Not found", { status: 404 });
    }));

    render(<AgentHistory runId="run-1" revision={1} />);
    fireEvent.click(await screen.findByRole("button", { name: /Build feature.*execute/i }));
    expect(await screen.findByText("Waiting for the first transcript event...")).not.toBeNull();
  });
});
