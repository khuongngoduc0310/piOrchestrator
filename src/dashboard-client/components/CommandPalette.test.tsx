// @vitest-environment jsdom

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandPalette } from "./CommandPalette.js";

describe("CommandPalette", () => {
  afterEach(cleanup);
  it("filters and invokes keyboard-accessible commands", () => {
    const run = vi.fn();
    const close = vi.fn();
    render(<CommandPalette open commands={[{ id: "a", label: "Inspect builder", group: "Agent", run }, { id: "b", label: "Open report", group: "Panel", run: vi.fn() }]} onClose={close} />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "builder" } });
    expect(screen.queryByText("Open report")).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /Inspect builder/ }));
    expect(run).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it("runs the arrow-selected command with Enter", () => {
    const first = vi.fn();
    const second = vi.fn();
    render(<CommandPalette open commands={[{ id: "a", label: "First", group: "Panel", run: first }, { id: "b", label: "Second", group: "Panel", run: second }]} onClose={vi.fn()} />);
    const search = screen.getByRole("searchbox");
    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledOnce();
  });
});
