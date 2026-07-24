import { describe, expect, it } from "vitest";
import { validateCheckpointPointer, validateCheckResults, validateWorkflowCheckpoint, validateWorkflowStateForResume } from "./checkpoint-validation.js";
import { CHECKPOINT_SCHEMA_VERSION } from "./checkpoint-types.js";
import { SCHEMA_VERSION } from "../types.js";
import { DEFAULT_CONFIG } from "../config/config.js";

describe("checkpoint validation", () => {
  it("validates strict checkpoint pointers", () => {
    const pointer = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      runId: "run-1",
      checkpointNumber: 2,
      fileName: "checkpoint-000002.json",
      digest: "a".repeat(64)
    };
    expect(validateCheckpointPointer(pointer)).toEqual(pointer);
    expect(() => validateCheckpointPointer({ ...pointer, fileName: "checkpoint-000003.json" })).toThrow("numbered checkpoint basename");
    expect(() => validateCheckpointPointer({ ...pointer, digest: "ABC" })).toThrow("lowercase SHA-256");
  });

  it("rejects incomplete resume state and malformed checks", () => {
    expect(() => validateWorkflowStateForResume({ schemaVersion: SCHEMA_VERSION })).toThrow("extensionVersion");
    expect(() => validateCheckResults([{ command: "test", exitCode: -1 }])).toThrow("exitCode");
  });

  it("validates latestCheckpoint fields when present", () => {
    const validState = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: "test",
      runId: "run-1",
      request: "fix bug",
      route: "implementation",
      cwd: "/tmp",
      runDir: "/tmp/runs/run-1",
      stage: "failed",
      status: "failed",
      attempt: 1,
      startedAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:01:00.000Z",
      agents: { builder: { status: "idle", model: "test" }, explorer: { status: "idle", model: "test" }, planner: { status: "idle", model: "test" }, reviewer: { status: "idle", model: "test" }, documenter: { status: "idle", model: "test" }, tester: { status: "idle", model: "test" }, debugger: { status: "idle", model: "test" } },
      steps: [],
      latestCheckpoint: { number: 1, cursor: "plan_approved", createdAt: "2026-07-22T10:30:00.000Z" }
    };
    expect(() => validateWorkflowStateForResume(validState)).not.toThrow();
    expect(() => validateWorkflowStateForResume({ ...validState, latestCheckpoint: "not-an-object" })).toThrow("expected an object");
    expect(() => validateWorkflowStateForResume({ ...validState, latestCheckpoint: { number: 0, cursor: "plan_approved", createdAt: "2026-07-22T10:30:00.000Z" } })).toThrow(">= 1");
    expect(() => validateWorkflowStateForResume({ ...validState, latestCheckpoint: { number: 1, cursor: "unknown_cursor", createdAt: "2026-07-22T10:30:00.000Z" } })).toThrow("expected one of");
    expect(() => validateWorkflowStateForResume({ ...validState, latestCheckpoint: { number: 1, cursor: "plan_approved", createdAt: "invalid-date" } })).toThrow("ISO date");
  });

  it("rejects non-empty resumeBlockedReason when present", () => {
    const validState = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: "test",
      runId: "run-1",
      request: "fix bug",
      route: "implementation",
      cwd: "/tmp",
      runDir: "/tmp/runs/run-1",
      stage: "failed",
      status: "failed",
      attempt: 1,
      startedAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:01:00.000Z",
      agents: { builder: { status: "idle", model: "test" }, explorer: { status: "idle", model: "test" }, planner: { status: "idle", model: "test" }, reviewer: { status: "idle", model: "test" }, documenter: { status: "idle", model: "test" }, tester: { status: "idle", model: "test" }, debugger: { status: "idle", model: "test" } },
      steps: []
    };
    expect(() => validateWorkflowStateForResume({ ...validState, resumeBlockedReason: "finalization started" })).not.toThrow();
    expect(() => validateWorkflowStateForResume({ ...validState, resumeBlockedReason: "" })).toThrow("must not be empty");
    expect(() => validateWorkflowStateForResume({ ...validState, resumeBlockedReason: 123 })).toThrow("expected a string");
  });

  it("rejects semantically contradictory successful checks", () => {
    expect(() => validateCheckResults([{
      command: "test",
      exitCode: 1,
      stdout: "",
      stderr: "failed",
      stdoutTruncated: false,
      stderrTruncated: false,
      passed: true,
      timedOut: false,
      cancelled: false,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000
    }])).toThrow("inconsistent");
  });

  it("rejects malformed nested checkpoint state and mismatched attestations", () => {
    const state = {
      schemaVersion: SCHEMA_VERSION,
      extensionVersion: "test",
      runId: "run-1",
      request: "fix bug",
      route: "implementation",
      cwd: "C:/repo",
      runDir: "C:/repo/.pi/orchestrator/runs/run-1",
      stage: "planning",
      status: "running",
      attempt: 0,
      startedAt: "2026-07-22T10:00:00.000Z",
      updatedAt: "2026-07-22T10:00:00.000Z",
      agents: Object.fromEntries(["explorer", "planner", "reviewer", "tester", "builder", "debugger", "documenter"]
        .map(name => [name, { status: "idle", model: "test" }])),
      steps: []
    };
    const checkpoint = {
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      checkpointNumber: 1,
      runId: "run-1",
      createdAt: "2026-07-22T10:00:00.000Z",
      workspaceDigest: "a".repeat(64),
      workspaceRoot: "C:/repo",
      config: DEFAULT_CONFIG,
      configDigest: "b".repeat(64),
      memoryMode: "disabled",
      memoryRevision: 0,
      memoryDigest: "c".repeat(64),
      selectedMemoryIds: [],
      validatedChangedFiles: ["src/index.ts"],
      validatedFileAttestations: [{
        path: "src/index.ts",
        state: "present",
        hash: "d".repeat(64),
        mode: 0o100644,
        agent: "builder",
        stepId: "step-1",
        invocation: 1
      }],
      baselineRepaired: false,
      baselineContext: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] },
      baselineReviewContext: {
        summary: { hasUncommittedChanges: false, hasStagedChanges: false, untrackedFiles: [] },
        artifacts: { baselineJson: ".pi/orchestrator/runs/run-1/baseline.json" }
      },
      lessonStatus: "skipped",
      mutationConfirmed: false,
      state,
      cursor: { kind: "plan_approved", continuation: null },
      bindings: {}
    };
    expect(() => validateWorkflowCheckpoint(checkpoint)).not.toThrow();
    expect(() => validateWorkflowCheckpoint({
      ...checkpoint,
      baselineContext: { ...checkpoint.baselineContext, hasStagedChanges: "yes" }
    })).toThrow("hasStagedChanges");
    expect(() => validateWorkflowCheckpoint({
      ...checkpoint,
      validatedChangedFiles: []
    })).toThrow("must exactly match");
    expect(() => validateWorkflowCheckpoint({
      ...checkpoint,
      validatedFileAttestations: [{ ...checkpoint.validatedFileAttestations[0], path: "../outside.ts" }]
    })).toThrow("must not contain empty, . or ..");
  });
});
