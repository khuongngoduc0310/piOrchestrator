import type { CheckResult } from "../types.js";

export interface ExecAdapterOptions {
  signal?: AbortSignal;
  timeout?: number;
  cwd?: string;
}

export interface ExecAdapterResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

export type ExecAdapter = (
  command: string,
  args: string[],
  options: ExecAdapterOptions
) => Promise<ExecAdapterResult>;

export interface CheckRunOptions {
  exec: ExecAdapter;
  timeoutMs: number;
  maxOutputBytes: number;
  now?: () => Date;
}

export async function runCheck(
  command: string,
  cwd: string,
  signal: AbortSignal,
  options: CheckRunOptions
): Promise<CheckResult> {
  const now = options.now ?? (() => new Date());
  const started = now();
  if (signal.aborted) return cancelledResult(command, started, now());
  const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-lc", command];
  try {
    const result = await options.exec(shell, args, { cwd, signal, timeout: options.timeoutMs });
    const completed = now();
    const stdout = truncateBytes(result.stdout, options.maxOutputBytes);
    const stderr = truncateBytes(result.stderr, options.maxOutputBytes);
    const cancelled = signal.aborted;
    const timedOut = result.killed && !cancelled;
    return {
      command,
      exitCode: result.code,
      stdout: stdout.text,
      stderr: stderr.text,
      stdoutTruncated: stdout.truncated,
      stderrTruncated: stderr.truncated,
      passed: result.code === 0 && !result.killed && !cancelled,
      timedOut,
      cancelled,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime())
    };
  } catch (error) {
    const completed = now();
    const cancelled = signal.aborted;
    return {
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      passed: false,
      timedOut: false,
      cancelled,
      executionError: error instanceof Error ? error.message : String(error),
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs: Math.max(0, completed.getTime() - started.getTime())
    };
  }
}

export async function runChecks(
  commands: string[],
  cwd: string,
  signal: AbortSignal,
  options: CheckRunOptions
): Promise<CheckResult[]> {
  if (commands.length === 0) throw new Error("No project checks are configured");
  const results: CheckResult[] = [];
  for (const command of commands) {
    if (signal.aborted) break;
    const result = await runCheck(command, cwd, signal, options);
    results.push(result);
    if (result.cancelled) break;
  }
  return results;
}

function cancelledResult(command: string, started: Date, completed: Date): CheckResult {
  return {
    command,
    exitCode: null,
    stdout: "",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    passed: false,
    timedOut: false,
    cancelled: true,
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
    durationMs: Math.max(0, completed.getTime() - started.getTime())
  };
}

function truncateBytes(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const buffer = Buffer.from(value);
  if (buffer.byteLength <= maxBytes) return { text: value, truncated: false };
  const fullMarker = Buffer.from("[truncated]\n");
  const marker = fullMarker.byteLength <= maxBytes ? fullMarker.toString("utf8") : "";
  const bodyBudget = Math.max(0, maxBytes - Buffer.byteLength(marker));
  let tail = buffer.subarray(buffer.byteLength - bodyBudget).toString("utf8").replace(/^\uFFFD+/, "");
  while (Buffer.byteLength(tail) > bodyBudget) tail = tail.slice(1);
  return { text: marker + tail, truncated: true };
}
