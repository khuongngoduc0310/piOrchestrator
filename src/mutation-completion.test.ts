import { describe, expect, it } from "vitest";
import { assertBuilderComplete, assertDocumenterComplete, assertTesterComplete } from "./mutation-completion.js";
import type { BuilderOutput, DocumenterOutput, TesterOutput } from "./types.js";

const builder: BuilderOutput = { summary: "done", changedFiles: [], commands: [], assumptions: [], unresolvedIssues: [] };
const tester: TesterOutput = {
  summary: "done",
  changedFiles: [],
  testsAdded: [],
  commands: [],
  assumptions: [],
  unresolvedIssues: [],
  acceptanceCoverage: [{
    criterionIndex: 0,
    criterion: "works",
    status: "covered",
    tests: ["test/example.test.ts: works"],
    preImplementationResult: "already_passed",
    evidence: "passed"
  }]
};
const documenter: DocumenterOutput = {
  summary: "done",
  changedFiles: [],
  documentationChanges: [],
  proposedLessons: [],
  commands: [],
  unresolvedIssues: []
};

describe("mutation completion gates", () => {
  it("accepts complete role outputs", () => {
    expect(() => assertBuilderComplete(builder)).not.toThrow();
    expect(() => assertTesterComplete(tester, "tests_only")).not.toThrow();
    expect(() => assertDocumenterComplete(documenter)).not.toThrow();
  });

  it("rejects unresolved and partially covered work", () => {
    expect(() => assertBuilderComplete({ ...builder, unresolvedIssues: ["remaining work"] })).toThrow("remaining work");
    expect(() => assertTesterComplete({
      ...tester,
      acceptanceCoverage: [{ ...tester.acceptanceCoverage[0], status: "partially_covered" }]
    }, "tests_only")).toThrow("did not fully cover");
    expect(() => assertDocumenterComplete({ ...documenter, unresolvedIssues: ["stale guide"] })).toThrow("stale guide");
  });

  it("rejects structured blockers for every mutation role", () => {
    const blocker = { kind: "tooling" as const, reason: "tool missing", requiredFiles: [] };
    expect(() => assertBuilderComplete({ ...builder, blocker })).toThrow("tool missing");
    expect(() => assertTesterComplete({ ...tester, blocker }, "tests_only")).toThrow("tool missing");
    expect(() => assertDocumenterComplete({ ...documenter, blocker })).toThrow("tool missing");
  });
});
