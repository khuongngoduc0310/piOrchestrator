// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentTranscript } from "../../agent-types.js";
import { TranscriptViewer } from "./TranscriptViewer.js";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function response(transcript: AgentTranscript): Response {
  return new Response(JSON.stringify(transcript), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function transcript(text: string, thinking = false): AgentTranscript {
  return {
    schemaVersion: 1,
    truncated: false,
    messages: [{
      role: "assistant",
      content: thinking
        ? [{ type: "thinking", text: "inspect state" }, { type: "text", text }]
        : [{ type: "text", text }],
    }],
  };
}

describe("TranscriptViewer live updates", () => {
  it("recovers from an early 404 on the next transcript revision", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
      .mockResolvedValueOnce(response(transcript("partial response")));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<TranscriptViewer runId="run-1" stepId="step-1" sequence={1} query="" revision={0} status="running" />);
    expect(await screen.findByText("Waiting for the first transcript event...")).not.toBeNull();

    view.rerender(<TranscriptViewer runId="run-1" stepId="step-1" sequence={1} query="" revision={1} status="running" />);
    expect(await screen.findByText("partial response")).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes partial content while preserving scroll and expanded details", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response(transcript("first", true)))
      .mockResolvedValueOnce(response(transcript("second", true)));
    vi.stubGlobal("fetch", fetchMock);

    const view = render(<TranscriptViewer runId="run-1" stepId="step-1" sequence={1} query="" revision={1} status="running" />);
    expect(await screen.findByText("first")).not.toBeNull();
    const container = document.querySelector<HTMLElement>(".transcript")!;
    Object.defineProperties(container, {
      scrollHeight: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 100 },
    });
    container.scrollTop = 40;
    const details = document.querySelector<HTMLDetailsElement>("details.thinking")!;
    details.open = true;
    fireEvent.scroll(container);

    view.rerender(<TranscriptViewer runId="run-1" stepId="step-1" sequence={1} query="" revision={2} status="running" />);
    expect(await screen.findByText("second")).not.toBeNull();
    await waitFor(() => {
      expect(container.scrollTop).toBe(40);
      expect(document.querySelector<HTMLDetailsElement>("details.thinking")?.open).toBe(true);
    });
  });

  it("treats a completed invocation 404 as unavailable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Not found", { status: 404 })));
    render(<TranscriptViewer runId="run-1" stepId="step-1" sequence={1} query="" revision={3} status="succeeded" />);
    expect(await screen.findByText("Conversation is not available")).not.toBeNull();
  });
});
