// @vitest-environment jsdom

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview.js";

describe("MarkdownPreview", () => {
  afterEach(cleanup);

  it("allows web, mail, and relative links", () => {
    render(<MarkdownPreview markdown="[web](https://example.com) [mail](mailto:a@example.com) [local](./plan.md)" />);

    expect(screen.getByRole("link", { name: "web" }).getAttribute("href")).toBe("https://example.com");
    expect(screen.getByRole("link", { name: "mail" }).getAttribute("href")).toBe("mailto:a@example.com");
    expect(screen.getByRole("link", { name: "local" }).getAttribute("href")).toBe("./plan.md");
  });

  it("renders links with unsafe protocols as plain text", () => {
    render(<MarkdownPreview markdown="[bad](javascript:alert(1)) [data](data:text/html,test)" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/bad/)).not.toBeNull();
    expect(screen.getByText(/data/)).not.toBeNull();
  });
});
