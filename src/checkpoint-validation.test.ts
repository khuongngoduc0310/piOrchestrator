import { describe, expect, it } from "vitest";
import { validateCheckpointPointer, validateCheckResults, validateWorkflowStateForResume } from "./checkpoint-validation.js";
import { CHECKPOINT_SCHEMA_VERSION } from "./checkpoint-types.js";

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
    expect(() => validateWorkflowStateForResume({ schemaVersion: 1 })).toThrow("extensionVersion");
    expect(() => validateCheckResults([{ command: "test", exitCode: -1 }])).toThrow("exitCode");
  });

  it("validates latestCheckpoint fields when present", () => {
    const validState = {
      schemaVersion: 1,
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
      schemaVersion: 1,
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
});
