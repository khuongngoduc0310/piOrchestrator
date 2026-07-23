import { describe, expect, it } from "vitest";
import { renderViewModelLines, statusText, visibleWidth, type WidgetTheme } from "./ui-controller.js";
import type { AgentSummary, ConfigSummary, OrchestratorViewModel, RunSummary, StepRecord } from "../types.js";
import { AGENT_NAMES } from "../types.js";

function ansiTheme(): WidgetTheme {
  return {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  };
}

function markerTheme(): WidgetTheme {
  return {
    fg: (color: string, text: string) => `[${color}]${text}[/]`,
    bold: (text: string) => `<b>${text}</>`,
  };
}

function allIdleAgents(): AgentSummary[] {
  return AGENT_NAMES.map(name => ({ name, model: `p/${name}`, status: "idle" as const }));
}

function makeSteps(count: number): StepRecord[] {
  const stages = ["preflight", "exploring", "planning", "baseline", "creating_tests", "implementing", "reviewing_code", "documenting"] as const;
  return stages.slice(0, count).map((stage, i) => ({
    id: `step-${String(i + 1).padStart(3, "0")}`,
    sequence: i + 1,
    stage,
    label: stage[0].toUpperCase() + stage.slice(1),
    status: (i < count - 1 ? "succeeded" : "running") as "succeeded" | "running",
    startedAt: new Date().toISOString(),
  }));
}

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    id: "test-abc-123",
    request: "add a simple feature",
    runStatus: "running",
    stage: "exploring",
    phaseIndex: 1,
    phaseCount: 8,
    attempt: 1,
    maxAttempts: 3,
    elapsedMs: 5000,
    artifactPath: "/project/.pi/runs/test-abc-123",
    ...overrides,
  };
}

const validConfig: ConfigSummary = { status: "valid", agentCount: AGENT_NAMES.length, checkCount: 2 };
const missingConfig: ConfigSummary = { status: "missing", agentCount: AGENT_NAMES.length, checkCount: 0 };
const errorConfig: ConfigSummary = { status: "invalid", agentCount: AGENT_NAMES.length, checkCount: 0, message: "parse error" };

function makeVM(overrides: Partial<OrchestratorViewModel>): OrchestratorViewModel {
  return {
    mode: "idle",
    cwd: "/project",
    config: validConfig,
    agents: allIdleAgents(),
    recentSteps: [],
    commands: [],
    ...overrides,
  } as OrchestratorViewModel;
}

describe("visibleWidth", () => {
  it("measures plain text length", () => {
    expect(visibleWidth("hello")).toBe(5);
  });

  it("ignores ANSI escape codes", () => {
    expect(visibleWidth("\x1b[32mhello\x1b[0m")).toBe(5);
  });

  it("ignores marker-style tags", () => {
    expect(visibleWidth("[accent]hello[/]")).toBe(5);
  });

  it("ignores bold tags", () => {
    expect(visibleWidth("<b>hello</>")).toBe(5);
  });

  it("handles empty string", () => {
    expect(visibleWidth("")).toBe(0);
  });
});

describe("renderViewModelLines", () => {
  const m = markerTheme();
  const a = ansiTheme();

  it("produces a bordered box for idle mode with missing config", () => {
    const vm = makeVM({ mode: "idle", config: missingConfig });
    const lines = renderViewModelLines(vm, m);
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines[0]).toContain("piOrchestrator");
    expect(lines[0]).toMatch(/┌/);
    expect(lines[0]).toMatch(/┐/);
    expect(lines[lines.length - 1]).toMatch(/└/);
    expect(lines[lines.length - 1]).toMatch(/┘/);
    const joined = lines.join(" ");
    expect(joined).toContain("[accent]●[/]");
    expect(joined).toContain("Project checks are not configured");
    expect(joined).toContain("/orchestrate");
    expect(joined).not.toContain("<request>");
  });

  it("produces a bordered box for idle mode with valid config", () => {
    const vm = makeVM({ mode: "idle", config: validConfig });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("agents configured");
    expect(joined).toContain("checks");
    expect(joined).toContain("/orchestrator-settings");
    expect(joined).not.toContain("<request>");
  });

  it("produces a bordered box for config_error mode", () => {
    const vm = makeVM({ mode: "config_error", config: errorConfig });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[warning]⚠[/]");
    expect(joined).toContain("parse error");
  });

  it("renders completed mode with success color", () => {
    const run = makeRun({ runStatus: "completed", stage: "completed", elapsedMs: 30000 });
    const vm = makeVM({ mode: "completed", run, agents: allIdleAgents(), recentSteps: makeSteps(8) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[success]✓[/]");
    expect(joined).toContain("<b>Completed</>");
    expect(joined).toContain("0:30");
  });

  it("renders completed mode with check count", () => {
    const run = makeRun({ runStatus: "completed", stage: "completed", elapsedMs: 30000 });
    const vm = makeVM({ mode: "completed", run, agents: allIdleAgents(), recentSteps: makeSteps(8) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[success]checks passed[/]");
  });

  it("renders failed mode with error color", () => {
    const run = makeRun({ runStatus: "failed", stage: "exploring", elapsedMs: 15000, failedArtifact: "output.txt", message: "invalid output" });
    const vm = makeVM({ mode: "failed", run, agents: allIdleAgents(), recentSteps: makeSteps(2) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[error]✗[/]");
    expect(joined).toContain("<b>Failed</>");
    expect(joined).toContain("output.txt");
    expect(joined).toContain("invalid output");
  });

  it("renders cancelled mode with muted color", () => {
    const run = makeRun({ runStatus: "cancelled", stage: "cancelled", elapsedMs: 8000 });
    const vm = makeVM({ mode: "cancelled", run, agents: allIdleAgents(), recentSteps: makeSteps(1) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[muted]⊘[/]");
    expect(joined).toContain("<b>Cancelled</>");
  });

  it("renders waiting mode with warning color", () => {
    const run = makeRun({ runStatus: "running", stage: "reviewing_code", phaseIndex: 6, waitingFor: "Code review decision" });
    const vm = makeVM({ mode: "waiting", run, agents: allIdleAgents(), recentSteps: makeSteps(6) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[warning]⏳[/]");
    expect(joined).toContain("<b>Waiting for you</>");
    expect(joined).toContain("Code review decision");
  });

  it("renders running mode with accent color and agent phase line", () => {
    const run = makeRun({ runStatus: "running", stage: "exploring", phaseIndex: 1, currentTool: "read", currentToolArgs: "src/file.ts", toolStatus: "ok" });
    const agents = allIdleAgents();
    agents[0] = { ...agents[0], status: "running" };
    const vm = makeVM({ mode: "running", run, agents, recentSteps: makeSteps(2) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[accent]→[/]");
    expect(joined).toContain("<b>Running</>");
    expect(joined).toContain("[dim]expl[/][accent]→[/]");
    expect(joined).toContain("[accent]explorer[/]");
    expect(joined).toContain("[mdLink]read[/]");
  });

  it("renders running mode with last agent output line", () => {
    const run = makeRun({ runStatus: "running", stage: "exploring", agentOutput: ["Processing files...", "Done"] });
    const vm = makeVM({ mode: "running", run, agents: allIdleAgents(), recentSteps: makeSteps(2) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("Done");
    expect(joined).not.toContain("Processing files...");
  });

  it("hides attempt text when attempt is zero", () => {
    const run = makeRun({ runStatus: "running", stage: "exploring", attempt: 0, maxAttempts: 4 });
    const vm = makeVM({ mode: "running", run, agents: allIdleAgents(), recentSteps: makeSteps(2) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).not.toContain("attempt");
    expect(joined).toContain("Explore");
  });

  it("running widget fits within 10 lines", () => {
    const run = makeRun({
      runStatus: "running",
      stage: "exploring",
      attempt: 2,
      maxAttempts: 4,
      currentTool: "read",
      currentToolArgs: "src/file.ts",
      toolStatus: "ok",
      agentOutput: ["Processing..."],
      dashboardUrl: "http://127.0.0.1:61290"
    });
    const agents = allIdleAgents();
    agents[0] = { ...agents[0], status: "running" };
    const vm = makeVM({ mode: "running", run, agents, recentSteps: makeSteps(8) });
    const lines = renderViewModelLines(vm, m);
    expect(lines.length).toBeLessThanOrEqual(10);
  });

  it("renders running mode with dashboard url", () => {
    const run = makeRun({ runStatus: "running", dashboardUrl: "http://127.0.0.1:61290" });
    const vm = makeVM({ mode: "running", run, agents: allIdleAgents(), recentSteps: makeSteps(2) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("http://127.0.0.1:61290");
  });

  it("renders completed mode with dashboard url", () => {
    const run = makeRun({ runStatus: "completed", stage: "completed", dashboardUrl: "http://127.0.0.1:61290" });
    const vm = makeVM({ mode: "completed", run, agents: allIdleAgents(), recentSteps: makeSteps(8) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("http://127.0.0.1:61290");
    expect(joined).toContain("[muted]Inspect[/]");
    expect(joined).toContain("orchestrator-inspect test-abc");
    expect(joined).toContain("[mdLink]/orchestrate[/]");
    expect(joined).not.toContain("<request>");
  });

  it("renders waiting mode with dashboard url", () => {
    const run = makeRun({ runStatus: "running", stage: "reviewing_code", waitingFor: "Decision", dashboardUrl: "http://127.0.0.1:61290" });
    const vm = makeVM({ mode: "waiting", run, agents: allIdleAgents(), recentSteps: makeSteps(6) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("http://127.0.0.1:61290");
  });

  it("renders failed mode with dashboard url", () => {
    const run = makeRun({ runStatus: "failed", stage: "implementing", failedArtifact: "err.txt", dashboardUrl: "http://127.0.0.1:61290" });
    const vm = makeVM({ mode: "failed", run, agents: allIdleAgents(), recentSteps: makeSteps(4) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("http://127.0.0.1:61290");
    expect(joined).toContain("[muted]Inspect[/]");
  });

  it("includes warning line in completed mode", () => {
    const run = makeRun({ runStatus: "completed", stage: "completed", warning: "Some tests are slow" });
    const vm = makeVM({ mode: "completed", run, agents: allIdleAgents(), recentSteps: makeSteps(8) });
    const lines = renderViewModelLines(vm, m);
    const joined = lines.join(" ");
    expect(joined).toContain("[warning]⚠[/]");
    expect(joined).toContain("Some tests are slow");
  });

  it("all lines have the same visible width using plain theme", () => {
    const run = makeRun({ runStatus: "completed", stage: "completed" });
    const vm = makeVM({ mode: "completed", run, agents: allIdleAgents(), recentSteps: makeSteps(8) });
    const lines = renderViewModelLines(vm, a);
    const widths = lines.map(l => visibleWidth(l));
    for (let i = 0; i < widths.length; i++) {
      expect(widths[i]).toBe(widths[0]);
    }
    expect(widths[0]).toBe(76);
  });

  it("all lines have same width for running mode", () => {
    const run = makeRun({ runStatus: "running", stage: "exploring", currentTool: "read", currentToolArgs: "src/main.ts", toolStatus: "ok" });
    const agents = allIdleAgents();
    agents[0] = { ...agents[0], status: "running" };
    const recent = makeSteps(4);
    recent[0] = { ...recent[0], agent: "explorer" };
    const vm = makeVM({ mode: "running", run, agents, recentSteps: recent });
    const lines = renderViewModelLines(vm, a);
    const widths = lines.map(l => visibleWidth(l));
    for (let i = 0; i < widths.length; i++) {
      expect(widths[i]).toBe(widths[0]);
    }
  });

  it("all lines have same width for idle mode", () => {
    const vm = makeVM({ mode: "idle", config: validConfig });
    const lines = renderViewModelLines(vm, a);
    const widths = lines.map(l => visibleWidth(l));
    for (let i = 0; i < widths.length; i++) {
      expect(widths[i]).toBe(widths[0]);
    }
  });

  it("all lines have same width for waiting mode", () => {
    const run = makeRun({ runStatus: "running", stage: "reviewing_code", waitingFor: "Decision" });
    const vm = makeVM({ mode: "waiting", run, agents: allIdleAgents(), recentSteps: makeSteps(6) });
    const lines = renderViewModelLines(vm, a);
    const widths = lines.map(l => visibleWidth(l));
    for (let i = 0; i < widths.length; i++) {
      expect(widths[i]).toBe(widths[0]);
    }
  });
});

describe("statusText", () => {
  const m = markerTheme();

  it("returns colored idle status", () => {
    const vm = makeVM({ mode: "idle" });
    const text = statusText(vm, m);
    expect(text).toContain("[accent]●[/]");
    expect(text).toContain("orchestrator: idle · ready");
  });

  it("returns colored running status", () => {
    const run = makeRun({ runStatus: "running" });
    const vm = makeVM({ mode: "running", run, agents: allIdleAgents(), recentSteps: makeSteps(2) });
    const text = statusText(vm, m);
    expect(text).toContain("[accent]→[/]");
    expect(text).toContain("running");
  });

  it("returns colored completed status", () => {
    const run = makeRun({ runStatus: "completed", stage: "completed" });
    const vm = makeVM({ mode: "completed", run, agents: allIdleAgents(), recentSteps: makeSteps(8) });
    const text = statusText(vm, m);
    expect(text).toContain("[success]✓[/]");
    expect(text).toContain("completed");
  });

  it("returns colored waiting status", () => {
    const run = makeRun({ runStatus: "running", stage: "reviewing_code", waitingFor: "Decision" });
    const vm = makeVM({ mode: "waiting", run, agents: allIdleAgents(), recentSteps: makeSteps(6) });
    const text = statusText(vm, m);
    expect(text).toContain("[warning]⏳[/]");
    expect(text).toContain("waiting for you");
  });

  it("returns colored config_error status", () => {
    const vm = makeVM({ mode: "config_error", config: errorConfig });
    const text = statusText(vm, m);
    expect(text).toContain("[warning]⚠[/]");
  });

  it("returns colored failed status", () => {
    const run = makeRun({ runStatus: "failed", stage: "implementing" });
    const vm = makeVM({ mode: "failed", run, agents: allIdleAgents(), recentSteps: makeSteps(4) });
    const text = statusText(vm, m);
    expect(text).toContain("[error]✗[/]");
    expect(text).toContain("failed");
  });
});
