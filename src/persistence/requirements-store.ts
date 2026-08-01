import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { ArtifactContent, RequirementsDocument } from "../types.js";
import { atomicReplace } from "./atomic-write.js";
import { validateRequirementsDocument } from "../validation.js";

export const REQUIREMENTS_JSON = "requirements.json";
export const REQUIREMENTS_MARKDOWN = "requirements.md";

/**
 * Persistence for requirements-builder sessions. Lives under
 * `.pi/orchestrator/requirements/<sessionId>/`, deliberately outside the
 * workflow `runs/` directory, because the dashboard run history treats every
 * `runs/` entry as a workflow run with a valid `state.json`.
 */
export class RequirementsStore {
  readonly sessionDir: string;

  constructor(readonly cwd: string, readonly sessionId: string) {
    assertBasename(sessionId, "sessionId");
    this.sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", sessionId);
  }

  async init(): Promise<void> {
    await mkdir(this.sessionDir, { recursive: true });
  }

  async saveDocument(document: RequirementsDocument): Promise<string> {
    const validated = validateRequirementsDocument(document);
    await this.init();
    await atomicReplace(path.join(this.sessionDir, REQUIREMENTS_JSON), serializeJson(validated));
    return REQUIREMENTS_JSON;
  }

  async saveMarkdown(markdown: string): Promise<string> {
    await this.init();
    await atomicReplace(path.join(this.sessionDir, REQUIREMENTS_MARKDOWN), markdown.endsWith("\n") ? markdown : `${markdown}\n`);
    return REQUIREMENTS_MARKDOWN;
  }

  async saveRaw(name: string, content: string): Promise<string> {
    assertBasename(name, "artifact name");
    await this.init();
    await atomicReplace(path.join(this.sessionDir, name), content.endsWith("\n") ? content : `${content}\n`);
    return name;
  }

  async readArtifact(name: string): Promise<ArtifactContent | undefined> {
    assertBasename(name, "artifact name");
    const text = await readArtifactText(this.sessionDir, name);
    if (text === undefined) return undefined;
    const bytes = Buffer.byteLength(text, "utf8");
    const isJson = name.endsWith(".json");
    return {
      name,
      text: text.length > 200_000 ? text.slice(0, 200_000) : text,
      truncated: text.length > 200_000,
      isJson,
      size: bytes
    };
  }
}

export function renderRequirementsMarkdown(document: RequirementsDocument): string {
  const lines = [
    `# Requirements: ${document.goal}`,
    "",
    `- Goal: ${document.goal}`,
    `- Summary: ${document.summary}`,
    "",
    "## Scope",
    ...document.scope.map(item => `- ${item}`),
    "",
    "## Constraints",
    ...document.constraints.map(item => `- ${item}`),
    "",
    "## Acceptance criteria",
    ...document.acceptanceCriteria.map(item => `- ${item}`),
    ""
  ];
  if (document.openQuestions.length > 0) {
    lines.push("## Open questions", ...document.openQuestions.map(item => `- ${item}`), "");
  }
  lines.push("## Interview record", "");
  for (const entry of document.qa) {
    const picks = entry.answer.selectedOptionIds.length > 0
      ? entry.answer.selectedOptionIds.map(id => entry.question.options.find(option => option.id === id)?.text ?? id).join(", ")
      : "custom answer";
    lines.push(`### ${entry.question.text}`, `- Answer: ${picks}`);
    if (entry.answer.customText !== undefined) lines.push(`- Custom: ${entry.answer.customText}`);
    lines.push("");
  }
  return lines.join("\n");
}

async function readArtifactText(dir: string, name: string): Promise<string | undefined> {
  try {
    return await readFile(path.join(dir, name), "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function assertBasename(value: string, label: string): void {
  if (!value || path.basename(value) !== value || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

function serializeJson(value: unknown): string {
  return JSON.stringify(value, null, 2) + "\n";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
