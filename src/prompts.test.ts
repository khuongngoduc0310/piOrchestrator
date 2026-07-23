import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_NAMES,
  DEBUGGER_CATEGORIES,
  LESSON_CATEGORIES
} from "./types.js";

const promptRoot = path.resolve("prompts");

async function prompt(name: string): Promise<string> {
  return readFile(path.join(promptRoot, `${name}.md`), "utf8");
}

describe("role prompt contracts", () => {
  it("documents the common version-3 envelope in every prompt", async () => {
    for (const name of AGENT_NAMES) {
      const text = await prompt(name);
      expect(text).toContain("taskSchemaVersion: 3");
      expect(text).toContain("memoryContext");
      expect(text).toContain("repository-relative");
      expect(text).toContain("raw JSON object");
    }
  });

  it("documents every Builder and Debugger action", async () => {
    const builder = await prompt("builder");
    for (const action of ["repair_baseline", "implement", "fix_failure", "address_review"]) {
      expect(builder).toContain(`\`${action}\``);
    }
    const debuggerPrompt = await prompt("debugger");
    for (const action of ["diagnose_baseline", "diagnose_implementation"]) {
      expect(debuggerPrompt).toContain(`\`${action}\``);
    }
    for (const category of DEBUGGER_CATEGORIES) expect(debuggerPrompt).toContain(`\`${category}\``);
  });

  it("keeps Tester, Reviewer, and Documenter contracts visible", async () => {
    expect(await prompt("tester")).toContain("acceptanceCoverage");
    const reviewer = await prompt("reviewer");
    for (const field of ["baselineJson", "headDiffPatch", "stagedDiffPatch"]) expect(reviewer).toContain(field);
    const documenter = await prompt("documenter");
    expect(documenter).toContain("approvalSource");
    for (const category of LESSON_CATEGORIES) expect(documenter).toContain(`\`${category}\``);
  });
});
