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
