import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { RequirementsDocument } from "../types.js";
import { RequirementsStore, renderRequirementsMarkdown } from "./requirements-store.js";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-requirements-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

const document: RequirementsDocument = {
  schemaVersion: 1,
  goal: "Build a CLI",
  summary: "A small CLI that prints help",
  scope: ["src"],
  constraints: ["No new dependencies"],
  acceptanceCriteria: ["CLI prints help"],
  openQuestions: ["Windows support?"],
  qa: [
    {
      question: {
        id: "q1",
        kind: "single",
        text: "Is the scope clear?",
        options: [
          { id: "yes", text: "Yes", recommended: true },
          { id: "no", text: "No" }
        ]
      },
      answer: { questionId: "q1", selectedOptionIds: ["yes"] }
    }
  ],
  handoffRequest: "Goal: Build a CLI",
  createdAt: "2026-08-01T00:00:00.000Z"
};

describe("RequirementsStore", () => {
  it("writes validated artifacts under the requirements directory", async () => {
    const cwd = await temporaryDirectory();
    const store = new RequirementsStore(cwd, "session-1");
    expect(store.sessionDir).toBe(path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "session-1"));

    await store.saveDocument(document);
    await store.saveMarkdown(renderRequirementsMarkdown(document));

    const saved = JSON.parse(await readFile(path.join(store.sessionDir, "requirements.json"), "utf8"));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.handoffRequest).toBe("Goal: Build a CLI");
    expect(await readFile(path.join(store.sessionDir, "requirements.md"), "utf8")).toContain("# Requirements: Build a CLI");
  });

  it("round-trips artifacts through readArtifact with JSON detection", async () => {
    const cwd = await temporaryDirectory();
    const store = new RequirementsStore(cwd, "session-2");
    await store.saveDocument(document);
    const artifact = await store.readArtifact("requirements.json");
    expect(artifact?.isJson).toBe(true);
    expect(JSON.parse(artifact?.text ?? "{}").goal).toBe("Build a CLI");
    expect(await store.readArtifact("missing.json")).toBeUndefined();
  });

  it("rejects unsafe session ids and artifact names", async () => {
    expect(() => new RequirementsStore("/tmp", "a/b")).toThrow("Invalid sessionId");
    expect(() => new RequirementsStore("/tmp", "..")).toThrow("Invalid sessionId");
    const store = new RequirementsStore("/tmp", "ok");
    await expect(store.saveRaw("../escape.md", "x")).rejects.toThrow("Invalid artifact name");
    await expect(store.readArtifact("a/b.md")).rejects.toThrow("Invalid artifact name");
  });

  it("rejects malformed documents without writing anything", async () => {
    const cwd = await temporaryDirectory();
    const store = new RequirementsStore(cwd, "session-3");
    await expect(store.saveDocument({ ...document, schemaVersion: 2 as never })).rejects.toThrow("schemaVersion");
    expect(await store.readArtifact("requirements.json")).toBeUndefined();
  });
});

describe("renderRequirementsMarkdown", () => {
  it("renders every section including open questions and the interview record", () => {
    const markdown = renderRequirementsMarkdown(document);
    expect(markdown).toContain("## Scope\n- src");
    expect(markdown).toContain("## Constraints\n- No new dependencies");
    expect(markdown).toContain("## Acceptance criteria\n- CLI prints help");
    expect(markdown).toContain("## Open questions\n- Windows support?");
    expect(markdown).toContain("### Is the scope clear?\n- Answer: Yes");
  });

  it("renders custom answers without a custom text section", () => {
    const custom: RequirementsDocument = {
      ...document,
      qa: [
        {
          question: document.qa[0].question,
          answer: { questionId: "q1", selectedOptionIds: [], customText: "A custom answer" }
        }
      ],
      openQuestions: []
    };
    const markdown = renderRequirementsMarkdown(custom);
    expect(markdown).toContain("- Answer: custom answer");
    expect(markdown).toContain("- Custom: A custom answer");
    expect(markdown).not.toContain("## Open questions");
  });
});
