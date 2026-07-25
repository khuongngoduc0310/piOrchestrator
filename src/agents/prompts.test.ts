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
    for (const action of ["diagnose_baseline", "diagnose_investigation", "diagnose_implementation"]) {
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
    expect(planner).toContain("Copy `previousPlan.acceptanceCriteria` verbatim with identical text and ordering");
    expect(planner).toContain("integration tests");
    expect(planner).toContain("cross-check every named source file");
    expect(await prompt("reviewer")).toContain("`scope_revision`");
    expect(await prompt("tester")).toContain("stale assertions");
  });

  it("keeps Tester, Reviewer, and Documenter contracts visible", async () => {
    const tester = await prompt("tester");
    expect(tester).toContain("acceptanceCoverage");
    expect(tester).toContain("never authorizes production behavior files");
    expect(await prompt("planner")).toContain("cannot authorize arbitrary production files");
    const reviewer = await prompt("reviewer");
    for (const field of ["baselineJson", "headDiffPatch", "stagedDiffPatch"]) expect(reviewer).toContain(field);
    const documenter = await prompt("documenter");
    expect(documenter).toContain("approvalSource");
    for (const category of LESSON_CATEGORIES) expect(documenter).toContain(`\`${category}\``);
  });

  it("does not tell Builder or Tester to execute shell commands", async () => {
    for (const name of ["builder", "tester"]) {
      const text = await prompt(name);
      expect(text).toContain("Shell execution is unavailable");
      expect(text).toContain("return `commands: []`");
      expect(text).not.toMatch(/Run (?:only )?(?:the )?(?:narrowest|relevant).*(?:test command|verification)/i);
    }
  });

  it("keeps executable code-review verification with the orchestrator", async () => {
    const reviewer = await prompt("reviewer");
    expect(reviewer).toContain("`task.implementationChecks` as the authoritative executable verification");
    expect(reviewer).toContain("Never make running or rerunning a shell command a blocking issue");
    expect(reviewer).toContain("A blocking issue must identify a concrete repository defect");

    const builder = await prompt("builder");
    expect(builder).toContain("A request only to run or rerun validation requires no repository edit and is not a blocker");
    expect(builder).toContain("orchestrator runs authoritative configured checks after this step");
  });

  it("distinguishes Planner task files from narrow Tester support paths", async () => {
    const planner = await prompt("planner");
    expect(planner).toContain("Every primary mutation or inspection target");
    expect(planner).toContain("`files` plus the narrowly classified Tester support paths in `testSupportFiles`");
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

  it("documents every AgentResolutionRequest kind with its variant-specific fields", async () => {
    const builder = await prompt("builder");
    expect(builder).toContain("kind\": \"scope");
    expect(builder).toContain("kind\": \"baseline_repair");
    expect(builder).toContain("kind\": \"prerequisite_repair");
    expect(builder).toContain("kind\": \"role_handoff");
    expect(builder).toContain("kind\": \"insufficient_evidence");
    expect(builder).toContain("kind\": \"environment");
    expect(builder).toContain("kind\": \"tooling");
    const tester = await prompt("tester");
    expect(tester).toContain("scope` uses `{kind, reason, requiredFiles}");
    expect(tester).toContain("environment`/`tooling` use `{kind, reason, diagnostics, retryCondition, affectedCommands}");
    expect(tester).toContain("insufficient_evidence` uses `{kind, reason, questions, suggestedRoles, inspectedEvidence}");
    const documenter = await prompt("documenter");
    expect(documenter).toContain("only uses `scope` blockers");
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
