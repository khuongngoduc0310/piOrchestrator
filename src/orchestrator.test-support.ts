import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  AgentCancelledError,
  AgentIncompleteResponseError,
  type AgentExecutor,
  type AgentRunOptions
} from "./agents/agent-runner.js";
import type { CheckRunner, OrchestratorDependencies } from "./orchestrator.js";
import { Orchestrator } from "./orchestrator.js";
import { DEFAULT_CONFIG, loadConfig, saveConfig } from "./config/config.js";
import { MAX_EVIDENCE_DETAIL_BYTES } from "./memory/memory-types.js";
import { RunStore } from "./persistence/store.js";
import { CheckpointStore } from "./persistence/checkpoint-store.js";
import { canonicalSha256 } from "./workspace/workspace-guard.js";
import type { CheckpointWrite } from "./persistence/checkpoint-types.js";
import type { AgentResult } from "./agent-types.js";
import type { CheckResult, WorkflowState } from "./workflow-types.js";
import type { OrchestratorConfig } from "./config-types.js";
import type { WorkflowRoute } from "./workflow-shared.js";

export { mkdir, mkdtemp, readFile, readdir, rm, writeFile, execFileSync, os, path, createServer, describe, expect, it, vi, AgentCancelledError, AgentIncompleteResponseError, Orchestrator, DEFAULT_CONFIG, loadConfig, saveConfig, MAX_EVIDENCE_DETAIL_BYTES, RunStore, CheckpointStore, canonicalSha256 };
export type { ExtensionAPI, ExtensionCommandContext, AgentExecutor, AgentRunOptions, CheckRunner, OrchestratorDependencies, CheckpointWrite, AgentResult, CheckResult, WorkflowState, OrchestratorConfig, WorkflowRoute };

export const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

export function defaultTestConfig(): OrchestratorConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  config.humanInTheLoop.planApproval = false;
  config.humanInTheLoop.planRevisionApproval = false;
  config.humanInTheLoop.confirmBeforeMutation = false;
  config.humanInTheLoop.importantDecisions = false;
  config.humanInTheLoop.finalDeliveryApproval = false;
  config.humanInTheLoop.diagnosisApproval = "never";
  config.limits.worktreeIsolation = false;
  return config;
}

export const explorer = json({
  architecture: "small extension",
  relevantFiles: ["src/index.ts"],
  conventions: [],
  similarImplementations: [],
  commands: ["check"],
  risks: [],
  knownLessons: [],
  evidence: [{ path: "src/index.ts", detail: "entry point" }]
});
export const checkDiscovery = json({
  packageManager: "npm",
  commands: ["npm test"],
  scripts: ["test"],
  diagnostics: ["root package.json test script"]
});
export const plan = json({
  route: "implementation",
  summary: "implement",
  assumptions: [],
  acceptanceCriteria: ["check passes"],
  automatedAcceptanceCriteria: [0],
  tasks: [{ id: "one", description: "change", files: ["src/index.ts"], dependencies: [], verification: ["check"] }],
  risks: []
});
export const reviewOnlyPlan = json({
  route: "review_only",
  summary: "review existing changes",
  assumptions: [],
  acceptanceCriteria: ["findings cite repository evidence"],
  automatedAcceptanceCriteria: [],
  tasks: [{ id: "review", description: "review changes", files: ["src/index.ts"], dependencies: [], verification: ["report findings"] }],
  risks: []
});
export function routePlan(route: WorkflowRoute, files = ["src/index.ts"]): string {
  const automatedIndices = route === "documentation_only" || route === "review_only" || route === "investigation_only" || route === "planning_only" ? [] : [0];
  return json({
    route,
    summary: `${route} plan`,
    assumptions: [],
    acceptanceCriteria: ["check passes"],
    automatedAcceptanceCriteria: automatedIndices,
    tasks: [{ id: "one", description: "bounded work", files, dependencies: [], verification: ["check"] }],
    risks: []
  });
}
export const approved = json({
  decision: "approved",
  blockingIssues: [],
  suggestions: [],
  evidence: [{ path: "src/index.ts", detail: "verified" }]
});
export const changes = json({
  decision: "changes_requested",
  blockingIssues: ["fix required"],
  suggestions: [],
  evidence: [{ path: "src/index.ts", detail: "problem" }]
});
export const tester = json({
  summary: "tests",
  changedFiles: ["test.ts"],
  testsAdded: ["behavior"],
  acceptanceCoverage: [{
    criterionIndex: 0,
    criterion: "check passes",
    status: "covered",
    tests: ["test.ts: behavior"],
    preImplementationResult: "failed_as_expected",
    evidence: "targeted test failed before implementation"
  }],
  commands: [],
  assumptions: [],
  unresolvedIssues: []
});
export const builder = json({ summary: "built", changedFiles: ["src/index.ts"], commands: [], assumptions: [], unresolvedIssues: [] });
export const baselineRepairBlocker = json({
  summary: "baseline repair needed",
  changedFiles: [],
  commands: [],
  assumptions: [],
  unresolvedIssues: [],
  blocker: {
    kind: "baseline_repair",
    reason: "repair the baseline",
    failedCheckCommands: ["check"],
    evidence: [{ path: "src/index.ts", detail: "baseline failure" }]
  }
});
export const debuggerOutput = json({
  category: "implementation_defect",
  rootCause: "missing implementation",
  evidence: [{ path: "src/index.ts", detail: "missing" }],
  recommendedFix: "implement",
  affectedFiles: ["src/index.ts"],
  confidence: "high"
});
export const documenter = json({
  summary: "docs",
  changedFiles: ["README.md"],
  documentationChanges: ["documented"],
  proposedLessons: [{
    title: "lesson",
    lesson: "verify",
    scope: { roles: ["builder"], paths: ["src"], categories: ["correctness"], keywords: ["verify"] },
    evidence: [{ path: "README.md", detail: "documented" }]
  }],
  commands: [],
  unresolvedIssues: []
});
export const documentationOnlyOutput = json({
  summary: "documentation updated",
  changedFiles: ["README.md"],
  documentationChanges: ["documented"],
  proposedLessons: [],
  commands: [],
  unresolvedIssues: []
});

export class QueueAgent implements AgentExecutor {
  readonly calls: AgentRunOptions[] = [];
  readonly preflight = vi.fn(async (_config: OrchestratorConfig): Promise<void> => undefined);
  constructor(private readonly outputs: Array<string | Error>) {}
  async run(options: AgentRunOptions): Promise<AgentResult> {
    this.calls.push(options);
    const output = this.outputs.shift();
    if (!output) throw new Error(`Missing fake output for ${options.name}`);
    if (output instanceof Error) throw output;
    const transcript = {
      schemaVersion: 1 as const,
      messages: [
        { role: "user" as const, content: [{ type: "text" as const, text: options.task }] },
        { role: "assistant" as const, content: [{ type: "text" as const, text: output }], stopReason: "stop" }
      ],
      truncated: false
    };
    options.onTranscript?.(transcript);
    return { text: output, transcript };
  }
}

export function check(passed: boolean): CheckResult {
  return {
    command: "check",
    exitCode: passed ? 0 : 1,
    stdout: "",
    stderr: passed ? "" : "failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    passed,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1
  };
}

export function checkCommand(command: string, passed: boolean): CheckResult {
  return { ...check(passed), command, stderr: passed ? "" : `npm error Missing script: "${command}"` };
}

export async function scenario(
  outputs: Array<string | Error>,
  checkPasses: boolean[],
  configure?: (config: OrchestratorConfig) => void,
  dependencies: Partial<OrchestratorDependencies> = {},
  route: WorkflowRoute = "implementation"
): Promise<{ engine: Orchestrator; agent: QueueAgent; cwd: string; notifications: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> }> {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "pi-orchestrator-flow-"));
  directories.push(cwd);
  const config = defaultTestConfig();
  config.checks = ["check"];
  config.dashboard.enabled = false;
  configure?.(config);
  await saveConfig(cwd, config);
  const agent = new QueueAgent(outputs);
  const queues = checkPasses.map(value => [check(value)]);
  const checkRunner = vi.fn(async () => {
    const next = queues.shift();
    if (!next) throw new Error("Missing fake checks");
    return next;
  }) as unknown as CheckRunner;
  const notifications = vi.fn();
  const openBrowser = vi.fn();
  const sendMessage = vi.fn();
  const pi = {
    appendEntry: vi.fn(),
    exec: vi.fn(),
    sendMessage
  } as unknown as ExtensionAPI;
  const ctx = {
    cwd,
    hasUI: false,
    ui: { notify: notifications, setStatus: vi.fn(), setWidget: vi.fn() }
  } as unknown as ExtensionCommandContext;
  const engine = new Orchestrator(pi, path.resolve("."), { agentExecutor: agent, checkRunner, openBrowser, enforceWorkspacePolicy: false, ...dependencies });
  await engine.start({ route, request: "request" }, ctx);
  return { engine, agent, cwd, notifications, sendMessage };
}

export function checkWithCommand(passed: boolean, command: string): CheckResult {
  return {
    command,
    exitCode: passed ? 0 : 1,
    stdout: "",
    stderr: passed ? "" : "failed",
    stdoutTruncated: false,
    stderrTruncated: false,
    passed,
    timedOut: false,
    cancelled: false,
    startedAt: new Date(0).toISOString(),
    completedAt: new Date(1).toISOString(),
    durationMs: 1
  };
}

export function json(value: unknown): string { return JSON.stringify(value); }
