import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentExecutor, AgentRunOptions } from "../agents/agent-runner-contracts.js";
import { AgentCancelledError } from "../agents/agent-runner.js";
import type { AgentResult, InterviewQuestion, OrchestratorConfig } from "../types.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { runRequirementsCommand } from "./requirements-command.js";
import { WORKFLOW_ROUTE_CHOICES } from "./route-selection.js";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";

const directories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-requirements-command-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

const QUESTIONS: InterviewQuestion[] = Array.from({ length: 5 }, (_, index) => ({
  id: `q${index + 1}`,
  kind: "single",
  text: `Question ${index + 1}?`,
  options: [
    { id: "yes", text: "Yes", recommended: true },
    { id: "no", text: "No" }
  ]
}));

const REPORT = {
  goal: "Build a CLI",
  summary: "A small CLI that prints help",
  openQuestions: [],
  scope: ["src"],
  constraints: ["No new dependencies"],
  acceptanceCriteria: ["CLI prints help"],
  qa: QUESTIONS.map(question => ({ question, answer: { questionId: question.id, selectedOptionIds: ["yes"] } }))
};

interface Envelope {
  taskSchemaVersion: number;
  mode: string;
  task: { action: string; goal: string; round?: number; history: unknown[]; insights: string[] };
  correction?: { attempt: number; reason: string; fieldPath?: string };
}

class ScriptedExecutor implements AgentExecutor {
  readonly runs: Array<{ options: AgentRunOptions; envelope: Envelope }> = [];
  constructor(private readonly script: (envelope: Envelope) => AgentResult) {}

  async preflight(): Promise<void> {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const envelope = JSON.parse(options.task) as Envelope;
    this.runs.push({ options, envelope });
    return this.script(envelope);
  }
}

function uiContext() {
  const selects: string[] = [];
  const inputs: string[] = [];
  const select = vi.fn(async () => selects.shift());
  const input = vi.fn(async () => inputs.shift());
  const notify = vi.fn();
  const ctx = { hasUI: true, ui: { select, input, notify } } as unknown as ExtensionCommandContext;
  return { ctx, selects, inputs, notify };
}

async function testDeps(executor: AgentExecutor, startWorkflow = vi.fn(async () => undefined)) {
  const deps = {
    extensionRoot: path.resolve("."),
    executor,
    loadConfig: async (): Promise<OrchestratorConfig> => ({ ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: false, port: 0 } }),
    openBrowser: (): void => undefined,
    startWorkflow,
    id: (): string => "test-session"
  };
  return deps;
}

function successScript(insightsLog: string[][]) {
  return (envelope: Envelope): AgentResult => {
    switch (envelope.task.action) {
      case "ask_questions":
        return { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) };
      case "assess": {
        const round = envelope.task.round ?? 1;
        if (round === 1) {
          insightsLog.push([...envelope.task.insights]);
          return {
            text: JSON.stringify({
              action: "assess",
              assessment: { goal: "Build a CLI", clarity: "more_information_needed", summary: "Scope is vague", openQuestions: ["Where does it run?"] }
            })
          };
        }
        insightsLog.push([...envelope.task.insights]);
        return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", clarity: "clear", summary: "Looks good" } }) };
      }
      case "finalize":
        return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
      default:
        throw new Error(`unexpected action ${envelope.task.action}`);
    }
  };
}

describe("runRequirementsCommand", () => {
  it("interviews for multiple rounds and writes the requirements artifact", async () => {
    const cwd = await temporaryDirectory();
    const insightsLog: string[][] = [];
    const executor = new ScriptedExecutor(successScript(insightsLog));
    const startWorkflow = vi.fn(async () => undefined);
    const deps = await testDeps(executor, startWorkflow);
    const { ctx, selects, inputs, notify } = uiContext();

    inputs.push("Build a CLI");
    for (let round = 0; round < 2; round++) {
      for (const question of QUESTIONS) selects.push("Yes (recommended)");
    }
    selects.push("Start a workflow with these requirements");
    selects.push(WORKFLOW_ROUTE_CHOICES[0].label);

    await runRequirementsCommand(cwd, ctx, deps);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Requirements saved"), "info");
    const actions = executor.runs.map(run => run.envelope.task.action);
    expect(actions).toEqual(["ask_questions", "assess", "ask_questions", "assess", "finalize"]);
    expect(executor.runs[2].envelope.task.round).toBe(2);
    expect(insightsLog[0]).toEqual([]);
    expect(insightsLog[1]).toEqual(["Scope is vague", "Where does it run?"]);
    expect(executor.runs[4].envelope.task.history).toHaveLength(10);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8"));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.goal).toBe("Build a CLI");
    expect(await readFile(path.join(sessionDir, "requirements.md"), "utf8")).toContain("## Interview record");

    expect(startWorkflow).toHaveBeenCalledTimes(1);
    expect(startWorkflow).toHaveBeenCalledWith({
      route: "implementation",
      request: expect.stringContaining("Goal: Build a CLI") as string
    });
  });

  it("retries once with a correction field path when the interviewer returns the wrong action", async () => {
    const cwd = await temporaryDirectory();
    let call = 0;
    const executor = new ScriptedExecutor(envelope => {
      call++;
      if (envelope.task.action === "ask_questions" && call === 1) {
        return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
      }
      switch (envelope.task.action) {
        case "ask_questions":
          return { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) };
        case "assess":
          return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", clarity: "clear", summary: "ok" } }) };
        case "finalize":
          return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
        default:
          throw new Error(`unexpected action ${envelope.task.action}`);
      }
    });
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    for (const question of QUESTIONS) selects.push("Yes (recommended)");
    selects.push("Done");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(executor.runs[0].envelope.mode).toBe("execute");
    expect(executor.runs[1].envelope.mode).toBe("correct_output");
    expect(executor.runs[1].envelope.correction).toMatchObject({ attempt: 1, reason: "schema_validation_failed", fieldPath: "action" });
    expect(executor.runs[1].options.task).toContain('"fieldPath": "action"');
  });

  it("fails the session when corrected output is still invalid", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(() => ({ text: "{ broken" }));
    const deps = await testDeps(executor);
    const { ctx, inputs, notify } = uiContext();

    inputs.push("Build a CLI");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(executor.runs).toHaveLength(2);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Interviewer returned invalid output"), "error");
    expect(await exists(path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session", "requirements.json"))).toBe(false);
  });

  it("cancels when the user picks Cancel interview and writes no artifact", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(envelope =>
      envelope.task.action === "ask_questions"
        ? { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) }
        : { text: JSON.stringify({ action: "finalize", report: REPORT }) }
    );
    const deps = await testDeps(executor);
    const { ctx, selects, inputs, notify } = uiContext();

    inputs.push("Build a CLI");
    selects.push("Cancel interview");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(executor.runs).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cancelled by the user"), "warning");
    expect(await exists(path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session"))).toBe(false);
  });

  it("maps an aborted agent call to cancelled rather than failed", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(() => {
      throw new AgentCancelledError("interviewer");
    });
    const deps = await testDeps(executor);
    const { ctx, inputs, notify } = uiContext();

    inputs.push("Build a CLI");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(executor.runs).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Requirements interview cancelled"), "warning");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Requirements interview failed"), "error");
    expect(await exists(path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session"))).toBe(false);
  });

  it("maps a TUI abort rejection to cancelled rather than failed", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(envelope =>
      envelope.task.action === "ask_questions"
        ? { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) }
        : { text: JSON.stringify({ action: "finalize", report: REPORT }) }
    );
    const deps = await testDeps(executor);
    const { ctx, inputs, notify } = uiContext();
    const select = ctx.ui.select as ReturnType<typeof vi.fn>;
    select.mockRejectedValue(Object.assign(new Error("aborted"), { name: "AbortError" }));

    inputs.push("Build a CLI");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Requirements interview cancelled"), "warning");
    expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("Requirements interview failed"), "error");
  });

  it("declines the handoff when the user chooses Done", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(successScript([]));
    const startWorkflow = vi.fn(async () => undefined);
    const deps = await testDeps(executor, startWorkflow);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    for (let round = 0; round < 2; round++) {
      for (const question of QUESTIONS) selects.push("Yes (recommended)");
    }
    selects.push("Done");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(executor.runs.map(run => run.envelope.task.action)).toEqual(["ask_questions", "assess", "ask_questions", "assess", "finalize"]);
  });

  it("rejects a blank goal", async () => {
    const executor = new ScriptedExecutor(() => ({ text: "{}" }));
    const deps = await testDeps(executor);
    const { ctx, inputs, notify } = uiContext();

    inputs.push("   ");

    await runRequirementsCommand("/tmp", ctx, deps);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("No goal entered"), "warning");
    expect(executor.runs).toHaveLength(0);
  });

  it("requires an interactive UI", async () => {
    const executor = new ScriptedExecutor(() => ({ text: "{}" }));
    const deps = await testDeps(executor);
    const notify = vi.fn();
    const ctx = { hasUI: false, ui: { select: vi.fn(), input: vi.fn(), notify } } as unknown as ExtensionCommandContext;

    await runRequirementsCommand("/tmp", ctx, deps);

    expect(notify).toHaveBeenCalledWith("The requirements command requires an interactive UI.", "error");
    expect(executor.runs).toHaveLength(0);
  });

  it("fails closed when the TUI cannot prompt and the dashboard is not listening", async () => {
    const executor = new ScriptedExecutor(() => ({ text: "{}" }));
    const deps = await testDeps(executor);
    const { ctx, inputs, notify } = uiContext();
    (ctx as { mode: string }).mode = "print";

    inputs.push("Build a CLI");

    await runRequirementsCommand("/tmp", ctx, deps);

    expect(notify).toHaveBeenCalledWith(expect.stringContaining("requires a TUI dialog or the interview dashboard"), "error");
    expect(executor.runs).toHaveLength(0);
  });
});
