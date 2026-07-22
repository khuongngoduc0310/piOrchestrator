import { describe, expect, it, vi } from "vitest";
import { runCheck, runChecks, type ExecAdapter } from "./checks.js";

describe("checks", () => {
  it("runs commands sequentially and captures timestamps", async () => {
    const order: string[] = [];
    const exec: ExecAdapter = async (_shell, args) => {
      order.push(args.at(-1) ?? "");
      return { stdout: "ok", stderr: "", code: 0, killed: false };
    };
    const results = await runChecks(["one", "two"], ".", new AbortController().signal, {
      exec,
      timeoutMs: 100,
      maxOutputBytes: 100
    });
    expect(order).toEqual(["one", "two"]);
    expect(results.every(result => result.passed && result.startedAt && result.completedAt)).toBe(true);
  });

  it("marks timeout separately from cancellation", async () => {
    const killed: ExecAdapter = async () => ({ stdout: "", stderr: "", code: 1, killed: true });
    const result = await runCheck("slow", ".", new AbortController().signal, { exec: killed, timeoutMs: 1, maxOutputBytes: 100 });
    expect(result.timedOut).toBe(true);
    expect(result.cancelled).toBe(false);

    const controller = new AbortController();
    controller.abort();
    const cancelled = await runCheck("never", ".", controller.signal, { exec: vi.fn(), timeoutMs: 1, maxOutputBytes: 100 });
    expect(cancelled.cancelled).toBe(true);
  });

  it("bounds captured output and records execution errors", async () => {
    const exec: ExecAdapter = async () => ({ stdout: "x".repeat(500), stderr: "y".repeat(500), code: 2, killed: false });
    const result = await runCheck("large", ".", new AbortController().signal, { exec, timeoutMs: 100, maxOutputBytes: 80 });
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(80);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);

    const unicode = await runCheck("unicode", ".", new AbortController().signal, {
      exec: async () => ({ stdout: "🙂".repeat(20), stderr: "", code: 0, killed: false }),
      timeoutMs: 100,
      maxOutputBytes: 3
    });
    expect(Buffer.byteLength(unicode.stdout)).toBeLessThanOrEqual(3);
    expect(unicode.stdout).not.toContain("�");

    const failure = await runCheck("missing", ".", new AbortController().signal, {
      exec: async () => { throw new Error("spawn failed"); },
      timeoutMs: 100,
      maxOutputBytes: 80
    });
    expect(failure.executionError).toBe("spawn failed");
    expect(failure.exitCode).toBeNull();
  });

  it("rejects empty check lists", async () => {
    await expect(runChecks([], ".", new AbortController().signal, { exec: vi.fn(), timeoutMs: 1, maxOutputBytes: 1 }))
      .rejects.toThrow("No project checks");
  });
});
