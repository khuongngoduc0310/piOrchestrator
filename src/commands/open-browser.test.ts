import { describe, expect, it, vi } from "vitest";
import { openBrowser } from "./open-browser.js";

describe("openBrowser", () => {
  it("spawns a platform launcher without throwing", () => {
    expect(() => openBrowser("http://127.0.0.1:1234")).not.toThrow();
  });

  it("does not crash on invalid URLs", () => {
    expect(() => openBrowser("")).not.toThrow();
    expect(() => openBrowser("file:///null")).not.toThrow();
  });
});
