import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export interface GitResult {
  stdout: Buffer;
  stderr: Buffer;
}

export class GitError extends Error {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly stderr: Buffer;
  readonly stdout: Buffer;

  constructor(message: string, cwd: string, args: readonly string[], exitCode: number | null, stdout: Buffer, stderr: Buffer) {
    super(message);
    this.name = "GitError";
    this.args = args;
    this.cwd = cwd;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

/** Execute Git directly, never through a command shell. */
export function runGit(cwd: string, args: readonly string[], options: GitOptions = {}): Promise<GitResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;

  return new Promise((resolve, reject) => {
    const child = spawn("git", [...args], {
      cwd,
      env: { ...process.env, ...options.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let failure: Error | undefined;
    let settled = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const finish = (error?: Error, result?: GitResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
      if (error) reject(error);
      else resolve(result!);
    };

    const exceedBuffer = (): void => {
      if (failure) return;
      failure = new Error(`git output exceeded ${maxBuffer} bytes`);
      child.kill();
      forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* process already exited */ } }, 1_000);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (stdoutLength + stderrLength + chunk.length > maxBuffer) return exceedBuffer();
      stdout.push(chunk);
      stdoutLength += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (failure) return;
      if (stdoutLength + stderrLength + chunk.length > maxBuffer) return exceedBuffer();
      stderr.push(chunk);
      stderrLength += chunk.length;
    });
    child.on("error", error => finish(error));
    child.on("close", code => {
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      if (failure) {
        finish(failure);
        return;
      }
      if (code !== 0) {
        const detail = stderrBuffer.toString("utf8").trim() || stdoutBuffer.toString("utf8").trim();
        finish(new GitError(`git ${args[0] ?? ""} failed${detail ? `: ${detail}` : ""}`, cwd, args, code, stdoutBuffer, stderrBuffer));
        return;
      }
      finish(undefined, { stdout: stdoutBuffer, stderr: stderrBuffer });
    });
    child.stdin.on("error", () => {
      // A command that exits early can close stdin before all input is written.
    });

    const timer = setTimeout(() => {
      failure = new Error(`git ${args[0] ?? ""} timed out after ${timeoutMs}ms`);
      child.kill();
      forceKillTimer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* process already exited */ } }, 1_000);
    }, timeoutMs);
    child.stdin.end(options.input);
  });
}

export async function gitText(cwd: string, args: readonly string[], options?: GitOptions): Promise<string> {
  return (await runGit(cwd, args, options)).stdout.toString("utf8");
}
