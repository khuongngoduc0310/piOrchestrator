import { describe, expect, it } from "vitest";
import type { BuilderOutput, CheckResult, CompletionSummary, DebuggerOutput, DocumenterOutput, PlannerOutput, ReviewOutput } from "../types.js";
import { AGENT_NAMES } from "../types.js";
import {
  CapabilityViolationError,
  GateInteractionError,
  HumanGateUnavailableError,
  MutationBoundaryError,
  WorkflowCancelledError,
  WorkflowTerminationError
} from "../orchestration/workflow-errors.js";
import {
  formatApprovedPlan,
  formatApprovedReview,
  formatBaselineReport,
  formatCancelledRun,
  formatCompletedRun,
  formatDocumentationReport,
  formatFailedRun,
  formatRepositoryReview,
  formatStartedRun,
  formatVerifiedImplementation
} from "./session-messages.js";

const samplePlan: PlannerOutput = {
  route: "implementation",
  summary: "Add pause/resume to the simulation",
  assumptions: ["UI element is the only change needed"],
  acceptanceCriteria: ["Pause preserves state"],
  tasks: [
    {
      id: "add-ui",
      description: "Add a Pause/Resume button next to the canvas",
      files: ["src/App.js"],
      dependencies: [],
      verification: ["Button text reflects current state"]
    }
  ],
  risks: []
};

const sampleCheck = (passed: boolean): CheckResult => ({
  command: "npm test",
  exitCode: passed ? 0 : 1,
  stdout: passed ? "PASS" : "FAIL",
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  passed,
  timedOut: false,
  cancelled: false,
  startedAt: "2024-01-01T00:00:00.000Z",
  completedAt: "2024-01-01T00:00:01.000Z",
  durationMs: 1000
});

const sampleCompletionSummary = (overrides: Partial<CompletionSummary> = {}): CompletionSummary => ({
  route: "implementation",
  request: "add feature",
  planSummary: "Implement the feature",
  changedFiles: ["src/index.ts"],
  testsAdded: ["test behavior"],
  checks: [sampleCheck(true)],
  attempts: 1,
  baselineRepaired: false,
  review: {
    outcome: "reviewer_approved",
    evidenceCount: 2,
    suggestions: [],
    blockingIssues: [],
    revisions: 0,
  },
  documentation: {
    changed: true,
    summary: "Updated docs",
  },
  lessons: {
    status: "skipped",
    count: 0,
  },
  memory: {
    mode: "disabled",
    loadedRevision: 0,
    selectedCount: 0,
    candidates: {
      proposed: 0,
      machineEligible: 0,
      machineRejected: 0,
      duplicates: 0,
      humanApproved: 0,
      humanDeclined: 0,
      pending: 0,
      promoted: 0,
      promotionFailed: 0,
    },
  },
  ...overrides,
});

describe("session-messages", () => {
  it("formatStartedRun includes request and run ID", () => {
    const msg = formatStartedRun("add feature", "run-abc", "/project/.pi/orch/runs/run-abc");
    expect(msg).toContain("Workflow started");
    expect(msg).toContain("add feature");
    expect(msg).toContain("run-abc");
  });

  it("formatApprovedPlan includes plan summary and tasks", () => {
    const msg = formatApprovedPlan(samplePlan);
    expect(msg).toContain("Plan approved");
    expect(msg).toContain("Add pause/resume to the simulation");
    expect(msg).toContain("add-ui");
  });

  it("formatBaselineReport includes diagnosis and repair plan", () => {
    const checks = [sampleCheck(false)];
    const diagnosis: DebuggerOutput = {
      category: "implementation_defect",
      rootCause: "Missing implementation",
      evidence: [],
      recommendedFix: "Add the missing code",
      affectedFiles: ["src/index.ts"],
      confidence: "high"
    };
    const msg = formatBaselineReport(checks, diagnosis, samplePlan);
    expect(msg).toContain("Baseline repair");
    expect(msg).toContain("Missing implementation");
    expect(msg).toContain("Add the missing code");
  });

  it("formatVerifiedImplementation includes changed files and check summary", () => {
    const builderOutputs: BuilderOutput[] = [
      { summary: "built", changedFiles: ["src/App.js"], commands: [], assumptions: [], unresolvedIssues: [] }
    ];
    const checks = [sampleCheck(true)];
    const msg = formatVerifiedImplementation(samplePlan, builderOutputs, checks, false, "/artifacts");
    expect(msg).toContain("Implementation verified");
    expect(msg).toContain("src/App.js");
    expect(msg).toContain("1/1 checks passed");
  });

  it("formatApprovedReview includes evidence and check results", () => {
    const review: ReviewOutput = {
      decision: "approved",
      blockingIssues: [],
      suggestions: ["Consider adding error handling"],
      evidence: [{ path: "src/index.ts", detail: "implementation verified" }]
    };
    const checks = [sampleCheck(true)];
    const msg = formatApprovedReview(review, checks, 0, "reviewer");
    expect(msg).toContain("Code review complete");
    expect(msg).toContain("approved");
    expect(msg).toContain("1/1 passed");
    expect(msg).toContain("implementation verified");
    expect(msg).toContain("Consider adding error handling");
  });

  it("formatApprovedReview with user override includes blocking issues", () => {
    const review: ReviewOutput = {
      decision: "changes_requested",
      blockingIssues: ["Missing test coverage"],
      suggestions: [],
      evidence: []
    };
    const checks = [sampleCheck(true)];
    const msg = formatApprovedReview(review, checks, 2, "user_override");
    expect(msg).toContain("accepted by user");
    expect(msg).toContain("Missing test coverage");
    expect(msg).toContain("Review revisions:** 2");
  });

  it("formatRepositoryReview reports findings without approval semantics", () => {
    const msg = formatRepositoryReview({
      decision: "changes_requested",
      blockingIssues: ["src/index.ts: unsafe behavior"],
      suggestions: [],
      evidence: [{ path: "src/index.ts", detail: "unsafe behavior" }]
    });
    expect(msg).toContain("Repository review complete");
    expect(msg).toContain("1 blocking finding(s)");
    expect(msg).toContain("src/index.ts: unsafe behavior");
  });

  it("formatDocumentationReport includes summary and lesson status", () => {
    const output: DocumenterOutput = {
      summary: "Updated README",
      changedFiles: ["README.md"],
      documentationChanges: ["Add usage section"],
      proposedLessons: [{
        title: "Verify docs",
        lesson: "Always verify",
        scope: { roles: ["documenter"], paths: [], categories: ["documentation"], keywords: [] },
        evidence: []
      }],
      commands: [{ command: "npm test", status: "passed", evidence: "tests passed" }],
      unresolvedIssues: []
    };
    const msg = formatDocumentationReport(output, "approved");
    expect(msg).toContain("Documentation updated");
    expect(msg).toContain("Updated README");
    expect(msg).toContain("approved");
    expect(msg).toContain("Verify docs");
  });

  it("formatDocumentationReport uses 'reviewed' title when no files changed", () => {
    const output: DocumenterOutput = {
      summary: "No doc changes needed",
      changedFiles: [],
      documentationChanges: [],
      proposedLessons: [],
      commands: [],
      unresolvedIssues: []
    };
    const msg = formatDocumentationReport(output, "skipped");
    expect(msg).toContain("Documentation reviewed");
    expect(msg).not.toContain("Documentation updated");
    expect(msg).toContain("none proposed");
  });

  it("formatDocumentationReport includes lesson rejection reasons", () => {
    const output: DocumenterOutput = {
      summary: "Proposed lessons",
      changedFiles: [],
      documentationChanges: [],
      proposedLessons: [{
        title: "Test more",
        lesson: "Add tests",
        scope: { roles: ["tester"], paths: [], categories: ["testing"], keywords: [] },
        evidence: []
      }],
      commands: [],
      unresolvedIssues: []
    };
    const lessonReview: ReviewOutput = {
      decision: "changes_requested",
      blockingIssues: ["Lesson lacks evidence"],
      suggestions: [],
      evidence: []
    };
    const msg = formatDocumentationReport(output, "rejected", lessonReview);
    expect(msg).toContain("rejected");
    expect(msg).toContain("Lesson lacks evidence");
  });

  it("formatCompletedRun includes full summary", () => {
    const msg = formatCompletedRun(sampleCompletionSummary(), "http://dashboard", "/artifacts", undefined, "1.0.0");
    expect(msg).toContain("Workflow completed");
    expect(msg).toContain("add feature");
    expect(msg).toContain("src/index.ts");
    expect(msg).toContain("test behavior");
    expect(msg).toContain("1/1 checks passed");
    expect(msg).toContain("reviewer_approved");
    expect(msg).toContain("updated");
    expect(msg).toContain("http://dashboard");
    expect(msg).toContain("Extension version: 1.0.0");
  });

  it("formatCompletedRun handles empty files and skipped lessons", () => {
    const summary = sampleCompletionSummary({
      changedFiles: [],
      testsAdded: [],
      checks: [],
    });
    const msg = formatCompletedRun(summary);
    expect(msg).toContain("No file changes were reported");
    expect(msg).toContain("skipped");
  });

  it("formatCompletedRun describes review-only work without implementation claims", () => {
    const msg = formatCompletedRun(sampleCompletionSummary({
      route: "review_only",
      changedFiles: [],
      checks: [],
      attempts: 0,
      review: { outcome: "findings_reported", evidenceCount: 1, suggestions: [], blockingIssues: ["finding"], revisions: 0 }
    }));
    expect(msg).toContain("Documentation: skipped for review-only route");
    expect(msg).not.toContain("Implementation attempts");
    expect(msg).not.toContain("Baseline repaired");
  });

  it("formatCompletedRun includes warning", () => {
    const msg = formatCompletedRun(sampleCompletionSummary(), undefined, undefined, "Something went wrong");
    expect(msg).toContain("Something went wrong");
    expect(msg).toContain("Warning");
  });

  it("formatFailedRun includes stage and message", () => {
    const msg = formatFailedRun("planning", "Plan was rejected", "/project/.pi/runs/run-abc");
    expect(msg).toContain("Workflow failed");
    expect(msg).toContain("planning");
    expect(msg).toContain("Plan was rejected");
    expect(msg).toContain("/project/.pi/runs/run-abc");
  });

  it("formatCancelledRun includes cancellation details", () => {
    const msg = formatCancelledRun("exploring", "User cancelled", "/project/.pi/runs/run-abc");
    expect(msg).toContain("Workflow cancelled");
    expect(msg).toContain("exploring");
    expect(msg).toContain("User cancelled");
    expect(msg).toContain("/project/.pi/runs/run-abc");
  });

  it("formats structured termination details while preserving the old arguments", () => {
    const msg = formatFailedRun(
      "failed",
      "Legacy failure",
      "/project/.pi/runs/run-abc",
      {
        stoppedStage: "human_review_plan",
        termination: {
          kind: "human_gate_unavailable",
          message: "Plan approval requires an interactive UI"
        }
      }
    );
    expect(msg).toContain("human_review_plan");
    expect(msg).toContain("Plan approval requires an interactive UI");
    expect(msg).not.toContain("Legacy failure");
  });

  it("accepts a structured termination in the legacy message position", () => {
    const msg = formatCancelledRun(
      "cancelled",
      { kind: "cancelled", message: "Cancelled before mutation", stoppedStage: "creating_tests" },
      "/project/.pi/runs/run-abc"
    );
    expect(msg).toContain("creating_tests");
    expect(msg).toContain("Cancelled before mutation");
  });

  it("provides typed workflow termination errors", () => {
    const errors = [
      new WorkflowCancelledError("User cancelled"),
      new HumanGateUnavailableError(),
      new GateInteractionError(),
      new CapabilityViolationError(),
      new MutationBoundaryError()
    ];
    expect(errors.every(error => error instanceof WorkflowTerminationError)).toBe(true);
    expect(errors.map(error => error.kind)).toEqual([
      "cancelled",
      "human_gate_unavailable",
      "gate_interaction_failed",
      "capability_violation",
      "mutation_boundary_violation"
    ]);
    expect(errors.map(error => error.status)).toEqual(["cancelled", "failed", "failed", "failed", "failed"]);
    expect(errors[0].termination.message).toBe("User cancelled");
  });

  it("truncates content at 8KB boundary", () => {
    const longSummary = "x".repeat(20_000);
    const plan: PlannerOutput = { ...samplePlan, summary: longSummary };
    const msg = formatApprovedPlan(plan);
    expect(msg).toContain("(truncated");
    expect(new TextEncoder().encode(msg).length).toBeLessThanOrEqual(9000);
  });
});
