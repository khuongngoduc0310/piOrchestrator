import { describe, expect, it } from "vitest";
import type { IndexedAcceptanceCriterion } from "./types.js";
import {
  parseInterviewerOutput,
  parsePlannerOutput,
  parseStructuredJson,
  validateBuilderOutput,
  validateDebuggerOutput,
  validateDocumenterOutput,
  validateExplorerOutput,
  validateInterviewerOutput,
  validatePlannerOutput,
  validateRequirementsDocument,
  validateTesterOutput,
  ValidationError
} from "./validation.js";
import { MAX_EVIDENCE_DETAIL_BYTES } from "./memory/memory-types.js";
import {
  MAX_INTERVIEW_OPTIONS,
  MAX_INTERVIEW_OPTION_BYTES,
  MAX_INTERVIEW_QUESTIONS,
  MAX_INTERVIEW_QUESTION_BYTES,
  MIN_INTERVIEW_OPTIONS,
  MIN_INTERVIEW_QUESTIONS,
  WORKFLOW_ROUTES
} from "./types.js";

const validPlan = {
  route: "implementation",
  summary: "Do it safely",
  assumptions: [],
  acceptanceCriteria: ["Checks pass"],
  automatedAcceptanceCriteria: [0],
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
    for (const route of WORKFLOW_ROUTES) {
      const planWithRoute = {
        ...validPlan,
        route,
        automatedAcceptanceCriteria: route === "documentation_only" || route === "review_only" || route === "investigation_only" || route === "planning_only"
          ? []
          : route === "tests_only"
          ? [0]
          : [0]
      };
      expect(validatePlannerOutput(planWithRoute).route).toBe(route);
    }
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

  it("enforces repository evidence detail UTF-8 byte limits", () => {
    const output = {
      architecture: "extension",
      relevantFiles: ["src/index.ts"],
      conventions: [],
      similarImplementations: [],
      commands: [],
      risks: [],
      knownLessons: [],
      evidence: [{ path: "src/index.ts", detail: "x".repeat(MAX_EVIDENCE_DETAIL_BYTES) }]
    };

    expect(validateExplorerOutput(output).evidence[0].detail).toHaveLength(MAX_EVIDENCE_DETAIL_BYTES);
    output.evidence[0].detail = "\u00e9".repeat(MAX_EVIDENCE_DETAIL_BYTES / 2);
    expect(validateExplorerOutput(output).evidence[0].detail).toHaveLength(MAX_EVIDENCE_DETAIL_BYTES / 2);
    output.evidence[0].detail = "\u00e9".repeat(MAX_EVIDENCE_DETAIL_BYTES / 2 + 1);
    expect(() => validateExplorerOutput(output))
      .toThrow(`explorer.evidence[0].detail: must not exceed ${MAX_EVIDENCE_DETAIL_BYTES} bytes`);
    output.evidence[0].detail = "x".repeat(MAX_EVIDENCE_DETAIL_BYTES + 1);
    expect(() => validateExplorerOutput(output))
      .toThrow(`explorer.evidence[0].detail: must not exceed ${MAX_EVIDENCE_DETAIL_BYTES} bytes`);
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

  it("validates structured Builder blockers", () => {
    const base = {
      summary: "blocked",
      changedFiles: [],
      commands: [],
      assumptions: [],
      unresolvedIssues: ["integration test is outside scope"]
    };
    const scopeBlocker = validateBuilderOutput({
      ...base,
      blocker: { kind: "scope", reason: "test must change", requiredFiles: ["src/App.test.ts"] }
    }).blocker;
    expect(scopeBlocker && scopeBlocker.kind === "scope" ? scopeBlocker.requiredFiles : undefined).toEqual(["src/App.test.ts"]);
    expect(() => validateBuilderOutput({
      ...base,
      blocker: { kind: "scope", reason: "test must change", requiredFiles: [] }
    })).toThrow("builder.blocker.requiredFiles");
    expect(() => validateBuilderOutput({
      ...base,
      blocker: { kind: "tooling", reason: "tool unavailable", diagnostics: [], retryCondition: "", affectedCommands: [] }
    })).toThrow("builder.blocker.retryCondition");
  });

  it("accepts every AgentResolutionRequest variant on Builder output", () => {
    const base = { summary: "blocked", changedFiles: [], commands: [], assumptions: [], unresolvedIssues: [] };
    const scopeResult = validateBuilderOutput({ ...base, blocker: { kind: "scope", reason: "add tests", requiredFiles: ["src/test.ts"] } });
    expect(scopeResult.blocker?.kind).toBe("scope");
    const baselineResult = validateBuilderOutput({ ...base, blocker: { kind: "baseline_repair", reason: "lint fails", failedCheckCommands: ["npm run lint"], evidence: [{ path: "src/main.ts", detail: "lint error" }] } });
    expect(baselineResult.blocker?.kind).toBe("baseline_repair");
    const prereqResult = validateBuilderOutput({ ...base, blocker: { kind: "prerequisite_repair", reason: "dep missing", affectedFiles: ["src/dep.ts"], evidence: [{ path: "src/dep.ts", detail: "missing export" }], verification: ["verify import works"] } });
    expect(prereqResult.blocker?.kind).toBe("prerequisite_repair");
    const handoffResult = validateBuilderOutput({ ...base, blocker: { kind: "role_handoff", reason: "needs diagnosis", requestedRole: "debugger", requestedCapability: "find root cause", question: "why does this fail?", evidence: [{ path: "src/bug.ts", detail: "unexpected error" }] } });
    expect(handoffResult.blocker?.kind).toBe("role_handoff");
    const evidenceResult = validateBuilderOutput({ ...base, blocker: { kind: "insufficient_evidence", reason: "need more info", questions: ["what is the expected behavior?"], suggestedRoles: ["explorer"], inspectedEvidence: [{ path: "src/unknown.ts", detail: "no context" }] } });
    expect(evidenceResult.blocker?.kind).toBe("insufficient_evidence");
    const envResult = validateBuilderOutput({ ...base, blocker: { kind: "environment", reason: "no node", diagnostics: ["node not found"], retryCondition: "retry after install", affectedCommands: ["node --version"] } });
    expect(envResult.blocker?.kind).toBe("environment");
    const toolResult = validateBuilderOutput({ ...base, blocker: { kind: "tooling", reason: "tsc missing", diagnostics: ["tsc not found"], retryCondition: "retry after npm install", affectedCommands: ["npx tsc"] } });
    expect(toolResult.blocker?.kind).toBe("tooling");
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
    const criteria: IndexedAcceptanceCriterion[] = [{ index: 0, text: "First works" }, { index: 1, text: "Second works" }];
    const base = {
      summary: "tests",
      changedFiles: ["src/index.test.ts"],
      testsAdded: ["covers behavior"],
      commands: [],
      assumptions: [],
      unresolvedIssues: []
    };
    const coverage = criteria.map(c => ({
      criterionIndex: c.index,
      criterion: c.text,
      status: "covered",
      tests: [`src/index.test.ts: criterion ${c.index}`],
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

const sampleQuestion = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "q1",
  kind: "single",
  text: "Is the scope clear?",
  options: [
    { id: "yes", text: "Yes", recommended: true },
    { id: "no", text: "No" }
  ],
  ...overrides
});

const sampleQuestions = (count: number = MIN_INTERVIEW_QUESTIONS): Record<string, unknown>[] =>
  Array.from({ length: count }, (_, index) => sampleQuestion({ id: `q${index + 1}`, text: `Question ${index + 1}?` }));

function sampleReport(): Record<string, unknown> {
  return {
    goal: "Build a CLI",
    summary: "A small CLI",
    openQuestions: [],
    scope: ["src/"],
    constraints: ["No new dependencies"],
    acceptanceCriteria: ["CLI prints help"],
    qa: [{ question: sampleQuestion(), answer: { questionId: "q1", selectedOptionIds: ["yes"] } }]
  };
}

describe("interviewer output validation", () => {
  it("accepts a valid ask_questions payload", () => {
    const output = validateInterviewerOutput({ action: "ask_questions", questions: sampleQuestions() });
    expect(output.action).toBe("ask_questions");
    if (output.action !== "ask_questions") throw new Error("expected ask_questions");
    expect(output.questions).toHaveLength(MIN_INTERVIEW_QUESTIONS);
  });

  it("accepts a fenced parse of interviewer JSON", () => {
    const parsed = parseInterviewerOutput(`Here are my questions.\n\n\`\`\`json\n${JSON.stringify({ action: "ask_questions", questions: sampleQuestions() })}\n\`\`\``);
    expect(parsed.action).toBe("ask_questions");
  });

  it("bounds the question count", () => {
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: sampleQuestions(MIN_INTERVIEW_QUESTIONS - 1) }))
      .toThrow(`must contain at least ${MIN_INTERVIEW_QUESTIONS} questions`);
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: sampleQuestions(MAX_INTERVIEW_QUESTIONS + 1) }))
      .toThrow(`must not contain more than ${MAX_INTERVIEW_QUESTIONS} questions`);
  });

  it("rejects duplicate question ids", () => {
    const questions = sampleQuestions();
    questions[1] = { ...questions[1], id: "q1" };
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions })).toThrow("duplicate question id");
  });

  it("enforces option count and exactly one recommended option", () => {
    const under = sampleQuestion({ options: [{ id: "only", text: "Only" }] });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [under, ...sampleQuestions().slice(1)] }))
      .toThrow(`must contain at least ${MIN_INTERVIEW_OPTIONS} options`);
    const over = sampleQuestion({ options: Array.from({ length: MAX_INTERVIEW_OPTIONS + 1 }, (_, i) => ({ id: `o${i}`, text: `Option ${i}` })) });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [over, ...sampleQuestions().slice(1)] }))
      .toThrow(`must not contain more than ${MAX_INTERVIEW_OPTIONS} options`);
    const none = sampleQuestion({ options: [{ id: "a", text: "A" }, { id: "b", text: "B" }] });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [none, ...sampleQuestions().slice(1)] }))
      .toThrow("must mark exactly one option as recommended");
  });

  it("rejects duplicate option ids and labels", () => {
    const dupes = sampleQuestion({ options: [{ id: "a", text: "A", recommended: true }, { id: "a", text: "B" }] });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [dupes, ...sampleQuestions().slice(1)] }))
      .toThrow("duplicate option id");
    const labels = sampleQuestion({ options: [{ id: "a", text: "Same", recommended: true }, { id: "b", text: "Same" }] });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [labels, ...sampleQuestions().slice(1)] }))
      .toThrow("must not contain duplicate option labels");
  });

  it("bounds question and option byte sizes", () => {
    const longText = sampleQuestion({ text: "x".repeat(MAX_INTERVIEW_QUESTION_BYTES + 1) });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [longText, ...sampleQuestions().slice(1)] }))
      .toThrow("exceed");
    const longOption = sampleQuestion({ options: [{ id: "a", text: "x".repeat(MAX_INTERVIEW_OPTION_BYTES + 1), recommended: true }, { id: "b", text: "B" }] });
    expect(() => validateInterviewerOutput({ action: "ask_questions", questions: [longOption, ...sampleQuestions().slice(1)] }))
      .toThrow("exceed");
  });

  it("validates an assess payload", () => {
    const output = validateInterviewerOutput({
      action: "assess",
      assessment: { goal: "Build a CLI", summary: "Scope is vague", openQuestions: ["Where does it run?"] }
    });
    expect(output.action).toBe("assess");
    if (output.action !== "assess") throw new Error("expected assess");
    expect(output.assessment.summary).toBe("Scope is vague");
    expect(output.assessment.openQuestions).toEqual(["Where does it run?"]);
    expect(() => validateInterviewerOutput({ action: "assess", assessment: { goal: "Build a CLI", summary: "?" } })).not.toThrow();
  });

  it("validates a finalize report and its recorded Q&A", () => {
    const output = validateInterviewerOutput({ action: "finalize", report: sampleReport() });
    expect(output.action).toBe("finalize");
    if (output.action !== "finalize") throw new Error("expected finalize");
    expect(output.report.scope).toEqual(["src/"]);
    expect(output.report.qa[0].answer.selectedOptionIds).toEqual(["yes"]);
  });

  it("rejects finalize reports with empty scope, constraints, or acceptance criteria", () => {
    for (const field of ["scope", "constraints", "acceptanceCriteria"]) {
      const report = sampleReport();
      report[field] = [];
      expect(() => validateInterviewerOutput({ action: "finalize", report })).toThrow("must not be empty");
    }
  });

  it("rejects answers referencing unknown options or the wrong question", () => {
    const report = sampleReport();
    report.qa = [{ question: sampleQuestion(), answer: { questionId: "q1", selectedOptionIds: ["missing"] } }];
    expect(() => validateInterviewerOutput({ action: "finalize", report })).toThrow("unknown option id");
    report.qa = [{ question: sampleQuestion(), answer: { questionId: "other", selectedOptionIds: ["yes"] } }];
    expect(() => validateInterviewerOutput({ action: "finalize", report })).toThrow("must match question id");
  });

  it("rejects empty answers without a custom text and multi-picks on single questions", () => {
    const empty = sampleReport();
    empty.qa = [{ question: sampleQuestion(), answer: { questionId: "q1", selectedOptionIds: [] } }];
    expect(() => validateInterviewerOutput({ action: "finalize", report: empty })).toThrow("must select an option or provide a custom answer");
    const multi = sampleReport();
    multi.qa = [{ question: sampleQuestion(), answer: { questionId: "q1", selectedOptionIds: ["yes", "no"] } }];
    expect(() => validateInterviewerOutput({ action: "finalize", report: multi })).toThrow("must not contain more than one option");
  });

  it("rejects an unexpected action", () => {
    expect(() => validateInterviewerOutput({ action: "nope" })).toThrow("interviewer.action");
  });
});

describe("requirements document validation", () => {
  const validDocument = {
    schemaVersion: 1,
    goal: "Build a CLI",
    summary: "A small CLI",
    scope: ["src/"],
    constraints: ["No new dependencies"],
    acceptanceCriteria: ["CLI prints help"],
    openQuestions: [],
    qa: [{ question: sampleQuestion(), answer: { questionId: "q1", selectedOptionIds: ["yes"] } }],
    handoffRequest: "Goal: Build a CLI",
    createdAt: "2026-08-01T00:00:00.000Z"
  };

  it("accepts a valid document", () => {
    expect(validateRequirementsDocument(validDocument)).toEqual(validDocument);
  });

  it("rejects unknown schema versions and missing handoff", () => {
    expect(() => validateRequirementsDocument({ ...validDocument, schemaVersion: 2 })).toThrow("must be 1");
    expect(() => validateRequirementsDocument({ ...validDocument, handoffRequest: "" })).toThrow("handoffRequest");
  });
});
