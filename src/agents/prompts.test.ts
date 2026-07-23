import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENT_NAMES,
  DEBUGGER_CATEGORIES,
  LESSON_CATEGORIES
} from "../types.js";
import { MAX_EVIDENCE_DETAIL_BYTES } from "../memory/memory-types.js";

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
    expect(builder).toContain("structured `blocker`");
    expect(debuggerPrompt).toContain("every exact repository file required");
  });

  it("requires impacted-test discovery and constrained failure replanning", async () => {
    const explorer = await prompt("explorer");
    expect(explorer).toContain("Search all test, snapshot, and test-support files");
    expect(explorer).toContain("trace its usage into parent and integration tests");
    const planner = await prompt("planner");
    expect(planner).toContain("`revise_for_failure`");
    expect(planner).toContain("integration tests");
    expect(planner).toContain("cross-check every named source file");
    expect(await prompt("reviewer")).toContain("`scope_revision`");
    expect(await prompt("tester")).toContain("stale assertions");
  });

  it("keeps Tester, Reviewer, and Documenter contracts visible", async () => {
    expect(await prompt("tester")).toContain("acceptanceCoverage");
    const reviewer = await prompt("reviewer");
    for (const field of ["baselineJson", "headDiffPatch", "stagedDiffPatch"]) expect(reviewer).toContain(field);
    const documenter = await prompt("documenter");
    expect(documenter).toContain("approvalSource");
    for (const category of LESSON_CATEGORIES) expect(documenter).toContain(`\`${category}\``);
  });

  it("defines changedFiles as invocation-local for every mutation agent", async () => {
    for (const name of ["tester", "builder", "documenter"]) {
      const text = await prompt(name);
      expect(text).toContain("exact file delta produced by this");
      expect(text).toContain("not the cumulative workflow diff");
      expect(text.toLowerCase()).toContain("return `[]`");
      expect(text).toContain("correction.expectedChangedFiles");
    }
    const documenter = await prompt("documenter");
    expect(documenter).toContain("task.builderOutputs[].changedFiles");
    expect(documenter).toContain("task.tester.changedFiles");
  });

  it("documents repository evidence detail byte limits", async () => {
    const expectedLimits = [
      ["explorer", "`evidence[].detail`"],
      ["reviewer", "`evidence[].detail`"],
      ["debugger", "`evidence[].detail`"],
      ["documenter", "`proposedLessons[].evidence[].detail`"]
    ] as const;

    for (const [name, field] of expectedLimits) {
      const text = await prompt(name);
      expect(text).toContain(field);
      expect(text).toContain(`at most ${MAX_EVIDENCE_DETAIL_BYTES} UTF-8 bytes`);
    }
  });
});
