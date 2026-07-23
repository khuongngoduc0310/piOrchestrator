import { describe, expect, it } from "vitest";
import {
  validateBuilderOutput,
  validateDebuggerOutput,
  validateDocumenterOutput,
  validateExplorerOutput,
  parsePlannerOutput,
  parseStructuredJson,
  validatePlannerOutput,
  validateTesterOutput,
  ValidationError
} from "./validation.js";
import { WORKFLOW_ROUTES } from "./types.js";

const validPlan = {
  route: "implementation",
  summary: "Do it safely",
  assumptions: [],
  acceptanceCriteria: ["Checks pass"],
  tasks: [
    { id: "a", description: "First", files: ["src/a.ts"], dependencies: [], verification: ["test"] },
    { id: "b", description: "Second", files: ["src/b.ts"], dependencies: ["a"], verification: ["test"] }
  ],
  risks: []
};

describe("structured output validation", () => {
  it("accepts raw JSON and exactly one fenced JSON block", () => {
    expect(parseStructuredJson(JSON.stringify({ ok: true }))).toEqual({ ok: true });
    expect(parseStructuredJson(`\`\`\`json\n{"ok":true}\n\`\`\``)).toEqual({ ok: true });
    expect(parseStructuredJson(`I inspected the repository.\n\n\`\`\`json\n{"ok":true}\n\`\`\`\n`)).toEqual({ ok: true });
  });

  it("rejects unfenced prose, multiple fences, and malformed output", () => {
    expect(() => parseStructuredJson(`Result: {"ok":true}`)).toThrow(ValidationError);
    expect(() => parseStructuredJson("```json\n{no}\n``` trailing")).toThrow("invalid JSON");
    expect(() => parseStructuredJson("```json\n{\"one\":true}\n```\n```json\n{\"two\":true}\n```")).toThrow("malformed JSON fence");
    expect(() => parseStructuredJson("```json\n{\"ok\":true}")).toThrow("malformed JSON fence");
    expect(() => parseStructuredJson(" ")).toThrow("empty output");
  });

  it("validates a dependency graph", () => {
    expect(parsePlannerOutput(JSON.stringify(validPlan))).toEqual(validPlan);
  });

  it("accepts supported workflow routes and rejects missing or unknown routes", () => {
    for (const route of WORKFLOW_ROUTES) expect(validatePlannerOutput({ ...validPlan, route }).route).toBe(route);
    const { route: _route, ...missingRoute } = validPlan;
    expect(() => validatePlannerOutput(missingRoute)).toThrow("plan.route");
    expect(() => validatePlannerOutput({ ...validPlan, route: "arbitrary_agents" })).toThrow("plan.route");
  });

  it("reports duplicate task IDs with an exact path", () => {
    const value = structuredClone(validPlan);
    value.tasks[1].id = "a";
    expect(() => validatePlannerOutput(value)).toThrow("plan.tasks[1].id: duplicate task id");
  });

  it("rejects dangling dependencies and cycles", () => {
    const dangling = structuredClone(validPlan);
    dangling.tasks[1].dependencies = ["missing"];
    expect(() => validatePlannerOutput(dangling)).toThrow("plan.tasks[1].dependencies[0]");

    const cyclic = structuredClone(validPlan);
    cyclic.tasks[0].dependencies = ["b"];
    expect(() => validatePlannerOutput(cyclic)).toThrow("dependency cycle");
  });

  it("requires planner task files and verification", () => {
    const noFiles = structuredClone(validPlan);
    noFiles.tasks[0].files = [];
    expect(() => validatePlannerOutput(noFiles)).toThrow("plan.tasks[0].files: must not be empty");

    const noVerification = structuredClone(validPlan);
    noVerification.tasks[0].verification = [];
    expect(() => validatePlannerOutput(noVerification)).toThrow("plan.tasks[0].verification: must not be empty");
  });

  it("normalizes Windows separators and accepts dot-prefixed repository paths", () => {
    const output = validateExplorerOutput({
      architecture: "extension",
      relevantFiles: ["src\\index.ts", ".pi\\config.json"],
      conventions: [],
      similarImplementations: [],
      commands: [],
      risks: [],
      knownLessons: [],
      evidence: [{ path: "src\\index.ts", detail: "entry point" }]
    });
    expect(output.relevantFiles).toEqual(["src/index.ts", ".pi/config.json"]);
    expect(output.evidence[0].path).toBe("src/index.ts");
  });

  it.each([
    "/etc/passwd",
    "C:\\secret.txt",
    "\\\\server\\share\\secret.txt",
    "src/../secret.txt",
    "src/./file.ts",
    "file://secret.txt"
  ])("rejects unsafe repository path %s", unsafePath => {
    expect(() => validateExplorerOutput({
      architecture: "extension",
      relevantFiles: [unsafePath],
      conventions: [],
      similarImplementations: [],
      commands: [],
      risks: [],
      knownLessons: [],
      evidence: [{ path: "src/index.ts", detail: "entry point" }]
    })).toThrow(ValidationError);
  });

  it("validates command status and evidence", () => {
    const valid = {
      summary: "built",
      changedFiles: ["src/index.ts"],
      commands: [{ command: "npm test", status: "passed", evidence: "10 tests passed" }],
      assumptions: [],
      unresolvedIssues: []
    };
    expect(validateBuilderOutput(valid).commands[0].status).toBe("passed");
    expect(() => validateBuilderOutput({ ...valid, commands: [{ command: "npm test", status: "green", evidence: "ok" }] }))
      .toThrow("builder.commands[0].status");
  });

  it("validates debugger categories", () => {
    const valid = {
      category: "implementation_defect",
      rootCause: "missing branch",
      evidence: [{ path: "src/index.ts", detail: "branch is absent" }],
      recommendedFix: "add branch",
      affectedFiles: ["src/index.ts"],
      confidence: "high"
    };
    expect(validateDebuggerOutput(valid).category).toBe("implementation_defect");
    expect(() => validateDebuggerOutput({ ...valid, category: "assertion" })).toThrow("debugger.category");
  });

  it("requires exhaustive tester acceptance coverage", () => {
    const criteria = ["First works", "Second works"];
    const base = {
      summary: "tests",
      changedFiles: ["src/index.test.ts"],
      testsAdded: ["covers behavior"],
      commands: [],
      assumptions: [],
      unresolvedIssues: []
    };
    const coverage = criteria.map((criterion, criterionIndex) => ({
      criterionIndex,
      criterion,
      status: "covered",
      tests: [`src/index.test.ts: criterion ${criterionIndex}`],
      preImplementationResult: "failed_as_expected",
      evidence: "failed before implementation"
    }));
    expect(validateTesterOutput({ ...base, acceptanceCoverage: coverage }, criteria).acceptanceCoverage).toHaveLength(2);
    expect(() => validateTesterOutput({ ...base, acceptanceCoverage: coverage.slice(0, 1) }, criteria))
      .toThrow("must contain exactly 2 items");
    expect(() => validateTesterOutput({ ...base, acceptanceCoverage: [coverage[0], coverage[0]] }, criteria))
      .toThrow("must be unique");
    expect(() => validateTesterOutput({ ...base, acceptanceCoverage: [{ ...coverage[0], criterion: "wrong" }, coverage[1]] }, criteria))
      .toThrow("must exactly match");
  });

  it("validates scoped documenter lessons before memory review", () => {
    const base = {
      summary: "docs",
      changedFiles: ["README.md"],
      documentationChanges: ["document behavior"],
      proposedLessons: [{
        title: "Validate boundaries",
        lesson: "Validate inputs at the boundary.",
        scope: { roles: ["builder"], paths: ["src/"], categories: ["correctness"], keywords: ["validation"] },
        evidence: [{ path: "src/index.ts", detail: "boundary validation is implemented" }]
      }],
      commands: [],
      unresolvedIssues: []
    };
    const output = validateDocumenterOutput(base);
    expect(output.proposedLessons[0].scope.paths).toEqual(["src"]);
    expect(() => validateDocumenterOutput({
      ...base,
      proposedLessons: [{ ...base.proposedLessons[0], scope: { roles: [], paths: [], categories: [], keywords: [] } }]
    })).toThrow("must have at least one non-empty scope dimension");
  });
});
