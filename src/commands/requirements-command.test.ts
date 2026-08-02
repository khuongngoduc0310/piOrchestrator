import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { ExtensionCommandContext, TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import type { AgentExecutor, AgentRunOptions } from "../agents/agent-runner-contracts.js";
import { AgentCancelledError } from "../agents/agent-runner.js";
import type { AgentResult, InterviewAnswer, InterviewQuestion, InterviewerAssessment, OrchestratorConfig } from "../types.js";
import type { AgentHistoryResponse, AgentInspection, AgentTranscript, AgentTranscriptArtifact } from "../types.js";
import { MAX_INTERVIEW_ROUNDS } from "../types.js";
import { DEFAULT_CONFIG } from "../config/config.js";
import { runRequirementsCommand, questionPresentation, reviewPresentation, commitPresentation, mapTuiChoice, type RequirementsCommandDependencies } from "./requirements-command.js";
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

const MULTI_QUESTIONS: InterviewQuestion[] = [
  {
    id: "q1",
    kind: "multiple",
    text: "Which platforms?",
    options: [
      { id: "windows", text: "Windows", recommended: true },
      { id: "macos", text: "macOS" },
      { id: "linux", text: "Linux" }
    ]
  },
  ...Array.from({ length: 4 }, (_, index): InterviewQuestion => ({
    id: `q${index + 2}`,
    kind: "single",
    text: `Question ${index + 2}?`,
    options: [
      { id: "yes", text: "Yes", recommended: true },
      { id: "no", text: "No" }
    ]
  }))
];

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

class TranscriptingExecutor implements AgentExecutor {
  readonly runs: Array<{ options: AgentRunOptions; envelope: Envelope }> = [];
  constructor(private readonly script: (envelope: Envelope) => AgentResult) {}

  async preflight(): Promise<void> {}

  async run(options: AgentRunOptions): Promise<AgentResult> {
    const envelope = JSON.parse(options.task) as Envelope;
    this.runs.push({ options, envelope });
    options.onUsage?.({
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0 },
      provider: "test-provider",
      model: "test-model",
      api: "test-api",
      stopReason: "done"
    });
    let result: AgentResult;
    try {
      result = this.script(envelope);
    } catch (error) {
      options.onTranscript?.({
        schemaVersion: 1,
        messages: [{ role: "user", content: [{ type: "text", text: options.task }], timestamp: 1 }],
        truncated: false
      });
      throw error;
    }
    const transcript: AgentTranscript = result.transcript ?? {
      schemaVersion: 1,
      messages: [
        { role: "user", content: [{ type: "text", text: options.task }], timestamp: 1 },
        { role: "assistant", content: [{ type: "text", text: result.text }], timestamp: 2, stopReason: "done" }
      ],
      truncated: false
    };
    options.onTranscript?.(transcript);
    return { ...result, transcript };
  }
}

function abortError(): Error {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function uiContext(resolver?: (title: string, options: string[]) => string | undefined | Promise<string | undefined>) {
  const selects: string[] = [];
  const inputs: string[] = [];
  const select = vi.fn((title: string, options: string[], params?: { signal?: AbortSignal }) => {
    const result = resolver ? resolver(title, options) : selects.shift();
    const promise = Promise.resolve(result);
    const signal = params?.signal;
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const onAbort = (): void => reject(abortError());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        value => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        error => {
          signal.removeEventListener("abort", onAbort);
          reject(error);
        }
      );
    });
  });
  const input = vi.fn(async () => inputs.shift());
  const notify = vi.fn();
  const terminalInputs: TerminalInputHandler[] = [];
  const onTerminalInput = vi.fn((handler: TerminalInputHandler) => {
    terminalInputs.push(handler);
    return () => {
      const index = terminalInputs.indexOf(handler);
      if (index !== -1) terminalInputs.splice(index, 1);
    };
  });
  const ctx = { hasUI: true, ui: { select, input, notify, onTerminalInput } } as unknown as ExtensionCommandContext;
  return { ctx, selects, inputs, notify, select, onTerminalInput, terminalInputs };
}

const REVIEW_TITLE = "Was the goal clear?";
const REVIEW_YES_LABEL = "Yes — the goal is clear, proceed (recommended)";
const REVIEW_NO_LABEL = "No — I still have doubts";

const BACK_ACTION_LABEL = "← Back to questions";
const COMMIT_QUESTION_TEXT = "All questions are answered. Finish this round?";
const COMMIT_FINISH_LABEL = "Finish round (recommended)";

interface HubAnswer {
  /** Select labels consumed while answering this question (may span re-presented dialogs). */
  selects: string[];
}

/**
 * Drives a full round through the hub: pick each question, answer it in its
 * dialog, step back to the hub, then finish the round via the commit question.
 */
function hubSequence(questions: InterviewQuestion[], answers: HubAnswer[]): string[] {
  const queue: string[] = [];
  for (let index = 0; index < questions.length; index++) {
    queue.push(`○ ${index + 1}. ${questions[index].text}`);
    queue.push(...answers[index].selects);
    queue.push(BACK_ACTION_LABEL);
  }
  queue.push(`○ ${questions.length + 1}. ${COMMIT_QUESTION_TEXT}`);
  queue.push(COMMIT_FINISH_LABEL);
  return queue;
}

function allYes(questions: InterviewQuestion[]): HubAnswer[] {
  return questions.map(() => ({ selects: ["Yes (recommended)"] }));
}

/** Returned by a hub-walker onFirst hook to dismiss the dialog instead of answering. */
const DISMISS = Symbol("dismiss");

/**
 * Resolver that walks a round without pre-queued labels: pick the first open
 * question in the hub, answer it once, step back, and finish via the commit
 * question. `onFirst` lets a test intercept a question's first dialog visit
 * (returning DISMISS dismisses the dialog without answering it).
 */
function hubWalkerResolver(options: {
  review?: string;
  onFirst?: (title: string) => string | typeof DISMISS | undefined;
  onHub?: (title: string, options: string[]) => string | undefined;
} = {}) {
  const answered = new Set<string>();
  let currentRound = -1;
  return (title: string, choices: string[]): string | undefined => {
    if (title.startsWith("Questions (round")) {
      const match = /round (\d+)/.exec(title);
      const round = match ? Number(match[1]) : -1;
      if (round !== currentRound) {
        currentRound = round;
        answered.clear();
      }
      const result = options.onHub
        ? options.onHub(title, choices)
        : choices.find(choice => choice.startsWith("○ ")) ?? "Cancel interview";
      return result;
    }
    if (title === REVIEW_TITLE) return options.review ?? REVIEW_YES_LABEL;
    if (title === COMMIT_QUESTION_TEXT) return COMMIT_FINISH_LABEL;
    if (answered.has(title)) return BACK_ACTION_LABEL;
    const first = options.onFirst?.(title);
    if (first === DISMISS) return undefined;
    answered.add(title);
    if (first !== undefined) return first;
    return "Yes (recommended)";
  };
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
              assessment: { goal: "Build a CLI", summary: "Scope is vague", openQuestions: ["Where does it run?"] }
            })
          };
        }
        insightsLog.push([...envelope.task.insights]);
        return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "Looks good" } }) };
      }
      case "finalize":
        return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
      default:
        throw new Error(`unexpected action ${envelope.task.action}`);
    }
  };
}

function singleRoundScript(questions: InterviewQuestion[]) {
  return (envelope: Envelope): AgentResult => {
    switch (envelope.task.action) {
      case "ask_questions":
        return { text: JSON.stringify({ action: "ask_questions", questions }) };
      case "assess":
        return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "ok" } }) };
      case "finalize": {
        const history = envelope.task.history as unknown as Array<{ question: InterviewQuestion; answer: InterviewAnswer }>;
        return { text: JSON.stringify({ action: "finalize", report: { ...REPORT, qa: history } }) };
      }
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
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_NO_LABEL);
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
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

  it("records multiple selections for a multi-select question", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(envelope => {
      if (envelope.task.action === "ask_questions") {
        return { text: JSON.stringify({ action: "ask_questions", questions: MULTI_QUESTIONS }) };
      }
      if (envelope.task.action === "assess") {
        return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "ok" } }) };
      }
      const history = envelope.task.history as unknown as Array<{ question: InterviewQuestion; answer: InterviewAnswer }>;
      return { text: JSON.stringify({ action: "finalize", report: { ...REPORT, qa: history } }) };
    });
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(...hubSequence(MULTI_QUESTIONS, [
      { selects: ["Windows (recommended)", "Linux"] },
      ...allYes(MULTI_QUESTIONS.slice(1))
    ]));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    await runRequirementsCommand(cwd, ctx, deps);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ answer: { questionId: string; selectedOptionIds: string[] } }>;
    };
    expect(saved.qa.find(entry => entry.answer.questionId === "q1")!.answer.selectedOptionIds).toEqual(["windows", "linux"]);
    const markdown = await readFile(path.join(sessionDir, "requirements.md"), "utf8");
    expect(markdown).toContain("- Answer: Windows, Linux");
  });

  it("records a custom answer typed by the user", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(envelope => {
      if (envelope.task.action === "ask_questions") {
        return { text: JSON.stringify({ action: "ask_questions", questions: MULTI_QUESTIONS }) };
      }
      if (envelope.task.action === "assess") {
        return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "ok" } }) };
      }
      const history = envelope.task.history as unknown as Array<{ question: InterviewQuestion; answer: InterviewAnswer }>;
      return { text: JSON.stringify({ action: "finalize", report: { ...REPORT, qa: history } }) };
    });
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI", "Cross-platform support");
    selects.push(...hubSequence(MULTI_QUESTIONS, [
      { selects: ["✏️ Type my own answer"] },
      ...allYes(MULTI_QUESTIONS.slice(1))
    ]));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    await runRequirementsCommand(cwd, ctx, deps);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ answer: { questionId: string; selectedOptionIds: string[]; customText?: string } }>;
    };
    const answer = saved.qa.find(entry => entry.answer.questionId === "q1")!.answer;
    expect(answer.selectedOptionIds).toEqual([]);
    expect(answer.customText).toBe("Cross-platform support");
    const markdown = await readFile(path.join(sessionDir, "requirements.md"), "utf8");
    expect(markdown).toContain("- Answer: custom answer");
    expect(markdown).toContain("- Custom: Cross-platform support");
  });

  it("answers interview questions through the live dashboard endpoint", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(envelope => {
      if (envelope.task.action === "ask_questions") {
        return { text: JSON.stringify({ action: "ask_questions", questions: MULTI_QUESTIONS }) };
      }
      if (envelope.task.action === "assess") {
        return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "ok" } }) };
      }
      const history = envelope.task.history as unknown as Array<{ question: InterviewQuestion; answer: InterviewAnswer }>;
      return { text: JSON.stringify({ action: "finalize", report: { ...REPORT, qa: history } }) };
    });
    const deps = (await testDeps(executor)) as RequirementsCommandDependencies;
    deps.loadConfig = async (): Promise<OrchestratorConfig> => ({ ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: true, port: 0 } });
    let dashboardUrl = "";
    deps.openBrowser = (url: string): void => { dashboardUrl = url; };
    const { ctx, inputs } = uiContext();
    (ctx as { mode: string }).mode = "print";
    inputs.push("Build a CLI");

    const running = runRequirementsCommand(cwd, ctx, deps);

    async function currentQuestions(): Promise<Array<{ questionId: string; decisionId?: string }>> {
      if (!dashboardUrl) return [];
      try {
        const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as { run?: { pendingQuestions?: Array<{ questionId: string; decisionId?: string }> } };
        return state.run?.pendingQuestions ?? [];
      } catch {
        return [];
      }
    }

    async function currentDecision(): Promise<{ id: string } | null> {
      if (!dashboardUrl) return null;
      try {
        const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as { run?: { pendingDecision?: { id: string } } };
        return state.run?.pendingDecision ?? null;
      } catch {
        return null;
      }
    }

    async function waitForQuestion(questionId: string): Promise<{ id: string }> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const decisionId = (await currentQuestions()).find(question => question.questionId === questionId)?.decisionId;
        if (decisionId) return { id: decisionId };
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for question ${questionId}`);
    }

    async function waitForDecision(): Promise<{ id: string }> {
      for (let attempt = 0; attempt < 500; attempt++) {
        const decision = await currentDecision();
        if (decision) return decision;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for a pending interview decision");
    }

    async function post(id: string, action: string, feedback?: string): Promise<number> {
      const response = await fetch(`${dashboardUrl}/api/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action, feedback })
      });
      return response.status;
    }

    const q1 = await waitForQuestion("q1");
    expect(await post(q1.id, "done:q1")).toBe(400);

    expect(await post(q1.id, "opt:q1:windows")).toBe(200);
    expect(await post((await waitForQuestion("q1"))!.id, "opt:q1:macos")).toBe(200);
    expect(await post((await waitForQuestion("q1"))!.id, "done:q1")).toBe(400);
    expect(await post((await waitForQuestion("q2"))!.id, "custom:q2", "  Cross-platform support  ")).toBe(200);
    expect(await post((await waitForQuestion("q3"))!.id, "opt:q3:no")).toBe(200);
    expect(await post((await waitForQuestion("q4"))!.id, "opt:q4:yes")).toBe(200);
    expect(await post((await waitForQuestion("q5"))!.id, "opt:q5:yes")).toBe(200);
    expect(await post((await waitForQuestion("commit"))!.id, "opt:commit:finish-round")).toBe(200);
    expect(await post((await waitForDecision())!.id, "opt:review:yes")).toBe(200);

    const session = (await running)!;
    expect(session.status).toBe("completed");

    const expected = [
      { questionId: "q1", selectedOptionIds: ["windows", "macos"] },
      { questionId: "q2", selectedOptionIds: [], customText: "Cross-platform support" },
      { questionId: "q3", selectedOptionIds: ["no"] },
      { questionId: "q4", selectedOptionIds: ["yes"] },
      { questionId: "q5", selectedOptionIds: ["yes"] }
    ];
    expect(session.history.map(entry => entry.answer)).toEqual(expected);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ answer: { questionId: string; selectedOptionIds: string[]; customText?: string } }>;
    };
    expect(saved.qa.map(entry => entry.answer)).toEqual(expected);

    const viewModel = session.getViewModel();
    expect(viewModel.run?.qa).toEqual([
      {
        questionText: "Which platforms?",
        kind: "multiple",
        round: 1,
        options: [
          { id: "windows", text: "Windows", recommended: true, picked: true },
          { id: "macos", text: "macOS", recommended: false, picked: true },
          { id: "linux", text: "Linux", recommended: false, picked: false }
        ],
        answerText: "Windows, macOS"
      },
      {
        questionText: "Question 2?",
        kind: "single",
        round: 1,
        options: [
          { id: "yes", text: "Yes", recommended: true, picked: false },
          { id: "no", text: "No", recommended: false, picked: false }
        ],
        answerText: "",
        customText: "Cross-platform support"
      },
      {
        questionText: "Question 3?",
        kind: "single",
        round: 1,
        options: [
          { id: "yes", text: "Yes", recommended: true, picked: false },
          { id: "no", text: "No", recommended: false, picked: true }
        ],
        answerText: "No"
      },
      {
        questionText: "Question 4?",
        kind: "single",
        round: 1,
        options: [
          { id: "yes", text: "Yes", recommended: true, picked: true },
          { id: "no", text: "No", recommended: false, picked: false }
        ],
        answerText: "Yes"
      },
      {
        questionText: "Question 5?",
        kind: "single",
        round: 1,
        options: [
          { id: "yes", text: "Yes", recommended: true, picked: true },
          { id: "no", text: "No", recommended: false, picked: false }
        ],
        answerText: "Yes"
      }
    ]);
    expect(viewModel.run?.requirement).toEqual({
      goal: "Build a CLI",
      summary: "A small CLI that prints help",
      scope: ["src"],
      constraints: ["No new dependencies"],
      acceptanceCriteria: ["CLI prints help"],
      openQuestions: []
    });
    expect(viewModel.run?.artifactNames).toEqual(["requirements.md", "requirements.json"]);
  });

  it("records dashboard answers that arrive out of question order", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = (await testDeps(executor)) as RequirementsCommandDependencies;
    deps.loadConfig = async (): Promise<OrchestratorConfig> => ({ ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: true, port: 0 } });
    let dashboardUrl = "";
    deps.openBrowser = (url: string): void => { dashboardUrl = url; };
    const { ctx, inputs } = uiContext();
    (ctx as { mode: string }).mode = "print";
    inputs.push("Build a CLI");

    const running = runRequirementsCommand(cwd, ctx, deps);

    async function waitForQuestion(questionId: string): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (dashboardUrl) {
          try {
            const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as {
              run?: { pendingQuestions?: Array<{ questionId: string; decisionId: string }> };
            };
            const decisionId = state.run?.pendingQuestions?.find(question => question.questionId === questionId)?.decisionId;
            if (decisionId) return decisionId;
          } catch {
            // dashboard not listening yet
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for question ${questionId}`);
    }

    async function post(id: string, action: string): Promise<number> {
      const response = await fetch(`${dashboardUrl}/api/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action })
      });
      return response.status;
    }

    async function waitForDecision(): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (dashboardUrl) {
          try {
            const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as { run?: { pendingDecision?: { id: string } } };
            if (state.run?.pendingDecision?.id) return state.run.pendingDecision.id;
          } catch {
            // dashboard not listening yet
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for a pending interview decision");
    }

    const q3 = await waitForQuestion("q3");
    expect(await post(q3, "opt:q3:no")).toBe(200);
    const q1 = await waitForQuestion("q1");
    expect(await post(q1, "opt:q1:yes")).toBe(200);
    expect(await post(await waitForQuestion("q2"), "opt:q2:no")).toBe(200);
    expect(await post(await waitForQuestion("q4"), "opt:q4:yes")).toBe(200);
    expect(await post(await waitForQuestion("q5"), "opt:q5:yes")).toBe(200);
    expect(await post(await waitForQuestion("commit"), "opt:commit:finish-round")).toBe(200);
    expect(await post(await waitForDecision(), "opt:review:yes")).toBe(200);

    const session = (await running)!;
    expect(session.status).toBe("completed");
    expect(session.history.map(entry => entry.question.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect(session.history.map(entry => entry.answer.selectedOptionIds)).toEqual([
      ["yes"], ["no"], ["no"], ["yes"], ["yes"]
    ]);
  });

  it("completes the round when the dashboard answers every question while the TUI hub is open", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = (await testDeps(executor)) as RequirementsCommandDependencies;
    deps.loadConfig = async (): Promise<OrchestratorConfig> => ({ ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: true, port: 0 } });
    let dashboardUrl = "";
    deps.openBrowser = (url: string): void => { dashboardUrl = url; };
    const resolver = (title: string, _options: string[]): string | undefined | Promise<string> => {
      if (title.startsWith("Questions (round")) return new Promise<string>(() => undefined);
      if (title === REVIEW_TITLE) return REVIEW_YES_LABEL;
      return "Yes (recommended)";
    };
    const { ctx, inputs, select } = uiContext(resolver);
    inputs.push("Build a CLI");

    const running = runRequirementsCommand(cwd, ctx, deps);

    async function waitForQuestion(questionId: string): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (dashboardUrl) {
          try {
            const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as {
              run?: { pendingQuestions?: Array<{ questionId: string; decisionId: string }> };
            };
            const decisionId = state.run?.pendingQuestions?.find(question => question.questionId === questionId)?.decisionId;
            if (decisionId) return decisionId;
          } catch {
            // dashboard not listening yet
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for question ${questionId}`);
    }

    async function post(id: string, action: string): Promise<number> {
      const response = await fetch(`${dashboardUrl}/api/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action })
      });
      return response.status;
    }

    for (const questionId of ["q1", "q2", "q3", "q4", "q5"]) {
      expect(await post(await waitForQuestion(questionId), `opt:${questionId}:yes`)).toBe(200);
    }
    expect(await post(await waitForQuestion("commit"), "opt:commit:finish-round")).toBe(200);

    const session = (await running)!;
    expect(session.status).toBe("completed");
    expect(session.history.map(entry => entry.question.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect(select).toHaveBeenCalledWith(
      expect.stringContaining("Questions (round"),
      expect.any(Array),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("rejects a stale Finish round once a question was un-answered after the commit armed", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(MULTI_QUESTIONS));
    const deps = (await testDeps(executor)) as RequirementsCommandDependencies;
    deps.loadConfig = async (): Promise<OrchestratorConfig> => ({ ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: true, port: 0 } });
    let dashboardUrl = "";
    deps.openBrowser = (url: string): void => { dashboardUrl = url; };
    const { ctx, inputs } = uiContext();
    (ctx as { mode: string }).mode = "print";
    inputs.push("Build a CLI");

    const running = runRequirementsCommand(cwd, ctx, deps);

    async function waitForQuestion(questionId: string): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (dashboardUrl) {
          try {
            const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as {
              run?: { pendingQuestions?: Array<{ questionId: string; decisionId: string }> };
            };
            const decisionId = state.run?.pendingQuestions?.find(question => question.questionId === questionId)?.decisionId;
            if (decisionId) return decisionId;
          } catch {
            // dashboard not listening yet
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for question ${questionId}`);
    }

    async function post(id: string, action: string): Promise<number> {
      const response = await fetch(`${dashboardUrl}/api/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id, action })
      });
      return response.status;
    }

    async function waitForDecision(): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (dashboardUrl) {
          try {
            const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as { run?: { pendingDecision?: { id: string } } };
            if (state.run?.pendingDecision?.id) return state.run.pendingDecision.id;
          } catch {
            // dashboard not listening yet
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Timed out waiting for a pending interview decision");
    }

    expect(await post(await waitForQuestion("q1"), "opt:q1:windows")).toBe(200);
    for (const questionId of ["q2", "q3", "q4", "q5"]) {
      expect(await post(await waitForQuestion(questionId), `opt:${questionId}:yes`)).toBe(200);
    }
    const staleFinish = await waitForQuestion("commit");
    expect(await post(await waitForQuestion("q1"), "opt:q1:windows")).toBe(200);
    expect(await post(staleFinish, "opt:commit:finish-round")).toBe(200);
    expect(await post(await waitForQuestion("q1"), "opt:q1:windows")).toBe(200);
    const freshFinish = await waitForQuestion("commit");
    expect(freshFinish).not.toBe(staleFinish);
    expect(await post(freshFinish, "opt:commit:finish-round")).toBe(200);
    expect(await post(await waitForDecision(), "opt:review:yes")).toBe(200);

    const session = (await running)!;
    expect(session.status).toBe("completed");
    expect(session.history.find(entry => entry.question.id === "q1")!.answer.selectedOptionIds).toEqual(["windows"]);
  });

  it("cancels the interview when the dashboard submits the cancel action", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = (await testDeps(executor)) as RequirementsCommandDependencies;
    deps.loadConfig = async (): Promise<OrchestratorConfig> => ({ ...structuredClone(DEFAULT_CONFIG), dashboard: { enabled: true, port: 0 } });
    let dashboardUrl = "";
    deps.openBrowser = (url: string): void => { dashboardUrl = url; };
    const { ctx, inputs, notify } = uiContext();
    (ctx as { mode: string }).mode = "print";
    inputs.push("Build a CLI");

    const running = runRequirementsCommand(cwd, ctx, deps);

    async function waitForQuestion(questionId: string): Promise<string> {
      for (let attempt = 0; attempt < 500; attempt++) {
        if (dashboardUrl) {
          try {
            const state = await (await fetch(`${dashboardUrl}/api/state`)).json() as {
              run?: { pendingQuestions?: Array<{ questionId: string; decisionId: string }> };
            };
            const decisionId = state.run?.pendingQuestions?.find(question => question.questionId === questionId)?.decisionId;
            if (decisionId) return decisionId;
          } catch {
            // dashboard not listening yet
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error(`Timed out waiting for question ${questionId}`);
    }

    const q1 = await waitForQuestion("q1");
    const response = await fetch(`${dashboardUrl}/api/decision`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: q1, action: "cancel" })
    });
    expect(response.status).toBe(200);

    const session = (await running)!;
    expect(session.status).toBe("cancelled");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cancelled by the user"), "warning");
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    expect(await exists(path.join(sessionDir, "requirements.json"))).toBe(false);
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
          return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "ok" } }) };
        case "finalize":
          return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
        default:
          throw new Error(`unexpected action ${envelope.task.action}`);
      }
    });
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
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
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    expect(await exists(path.join(sessionDir, "requirements.json"))).toBe(false);
    expect(await exists(path.join(sessionDir, "requirements.md"))).toBe(false);
  });

  it("lets the user revise an answer in place within a round", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(
      "○ 1. Question 1?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 2. Question 2?",
      "No",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 3. Question 3?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 4. Question 4?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 5. Question 5?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      `○ 6. ${COMMIT_QUESTION_TEXT}`,
      COMMIT_FINISH_LABEL,
      REVIEW_YES_LABEL,
      "Done"
    );

    await runRequirementsCommand(cwd, ctx, deps);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ question: { id: string }; answer: { selectedOptionIds: string[] } }>;
    };
    expect(saved.qa).toHaveLength(5);
    expect(saved.qa.filter(entry => entry.question.id === "q2")).toHaveLength(1);
    expect(saved.qa.find(entry => entry.question.id === "q2")!.answer.selectedOptionIds).toEqual(["yes"]);
    expect(saved.qa.map(entry => entry.question.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
  });

  it("un-picks a multi-select option by choosing it again", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(MULTI_QUESTIONS));
    const deps = await testDeps(executor);
    const { ctx, selects, inputs, select } = uiContext();

    inputs.push("Build a CLI");
    selects.push(
      ...hubSequence(MULTI_QUESTIONS, [
        { selects: ["Windows (recommended)", "Linux", "✓ Windows (recommended)"] },
        ...allYes(MULTI_QUESTIONS.slice(1))
      ]),
      REVIEW_YES_LABEL,
      "Done"
    );

    await runRequirementsCommand(cwd, ctx, deps);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ answer: { questionId: string; selectedOptionIds: string[] } }>;
    };
    expect(saved.qa.find(entry => entry.answer.questionId === "q1")!.answer.selectedOptionIds).toEqual(["linux"]);
    expect(select).toHaveBeenCalledWith(
      "Which platforms? (2 selected)",
      expect.arrayContaining(["✓ Windows (recommended)", "macOS", "✓ Linux"]),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("keeps prior picks when revising a multi-select question in place", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(MULTI_QUESTIONS));
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(
      "○ 1. Which platforms?",
      "Windows (recommended)",
      "macOS",
      "Linux",
      BACK_ACTION_LABEL,
      "○ 2. Question 2?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 3. Question 3?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 4. Question 4?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      "○ 5. Question 5?",
      "Yes (recommended)",
      BACK_ACTION_LABEL,
      `○ 6. ${COMMIT_QUESTION_TEXT}`,
      COMMIT_FINISH_LABEL,
      REVIEW_YES_LABEL,
      "Done"
    );

    await runRequirementsCommand(cwd, ctx, deps);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ answer: { questionId: string; selectedOptionIds: string[] } }>;
    };
    expect(saved.qa.filter(entry => entry.answer.questionId === "q1")).toHaveLength(1);
    expect(saved.qa.find(entry => entry.answer.questionId === "q1")!.answer.selectedOptionIds).toEqual(["windows", "macos", "linux"]);
  });

  it("returns to the question hub when an answer dialog is dismissed", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = await testDeps(executor);
    let escaped = false;
    const resolver = hubWalkerResolver({
      onFirst: (title: string): string | typeof DISMISS | undefined => {
        if (title === "Question 1?" && !escaped) {
          escaped = true;
          return DISMISS;
        }
        return undefined;
      }
    });
    const { ctx, inputs } = uiContext(resolver);

    inputs.push("Build a CLI");

    await runRequirementsCommand(cwd, ctx, deps);

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ answer: { questionId: string; selectedOptionIds: string[] } }>;
    };
    expect(saved.qa).toHaveLength(5);
    expect(saved.qa.find(entry => entry.answer.questionId === "q1")!.answer.selectedOptionIds).toEqual(["yes"]);
  });

  it("switches questions with arrow keys pressed while the answer dialog is open", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = await testDeps(executor);
    const picks = [
      "○ 1. Question 1?",
      "○ 1. Question 1?",
      "○ 1. Question 1?",
      "○ 2. Question 2?",
      "○ 2. Question 2?",
      "○ 4. Question 4?",
      "○ 5. Question 5?",
      "○ 2. Question 2?",
      `○ 6. ${COMMIT_QUESTION_TEXT}`
    ];
    let leftPressed = false;
    let rightPressed = false;
    let terminalPresses = 0;
    let hubSelects = 0;
    const resolver = hubWalkerResolver({
      onHub: (): string | undefined => {
        hubSelects++;
        return picks.shift();
      },
      onFirst: (title: string): string | typeof DISMISS | undefined => {
        if (title === "Question 1?" && !leftPressed) {
          leftPressed = true;
          terminalPresses++;
          terminalInputs[0]!("\x1b[D");
          return DISMISS;
        }
        if (title === "Question 2?" && !rightPressed) {
          rightPressed = true;
          terminalPresses++;
          terminalInputs[0]!("\x1b[C");
          return DISMISS;
        }
        return undefined;
      }
    });
    const { ctx, inputs, terminalInputs } = uiContext(resolver);

    inputs.push("Build a CLI");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(terminalPresses).toBe(2);
    expect(hubSelects).toBe(9);
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const saved = JSON.parse(await readFile(path.join(sessionDir, "requirements.json"), "utf8")) as {
      qa: Array<{ question: { id: string }; answer: { selectedOptionIds: string[] } }>;
    };
    expect(saved.qa.map(entry => entry.question.id)).toEqual(["q1", "q2", "q3", "q4", "q5"]);
    expect(saved.qa.every(entry => entry.answer.selectedOptionIds.includes("yes"))).toBe(true);
  });

  it("cancels when the question hub is dismissed", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = await testDeps(executor);
    const { ctx, selects, inputs, notify } = uiContext();

    inputs.push("Build a CLI");
    selects.push(undefined as unknown as string);

    await runRequirementsCommand(cwd, ctx, deps);

    expect(executor.runs).toHaveLength(1);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("cancelled by the user"), "warning");
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    expect(await exists(path.join(sessionDir, "requirements.json"))).toBe(false);
    expect(await exists(path.join(sessionDir, "requirements.md"))).toBe(false);
  });

  it("keeps the hub open once all questions are answered and finishes via the commit question", async () => {
    const cwd = await temporaryDirectory();
    const executor = new ScriptedExecutor(singleRoundScript(QUESTIONS));
    const deps = await testDeps(executor);
    const hubOptions: string[][] = [];
    const resolver = hubWalkerResolver({
      onHub: (_title: string, options: string[]): string | undefined => {
        hubOptions.push([...options]);
        return options.find(option => option.startsWith("○ ")) ?? "Cancel interview";
      }
    });
    const { ctx, inputs } = uiContext(resolver);

    inputs.push("Build a CLI");

    const session = (await runRequirementsCommand(cwd, ctx, deps))!;
    expect(session.status).toBe("completed");

    expect(hubOptions).toHaveLength(6);
    expect(hubOptions[0]).toEqual([
      "○ 1. Question 1?",
      "○ 2. Question 2?",
      "○ 3. Question 3?",
      "○ 4. Question 4?",
      "○ 5. Question 5?",
      "Cancel interview"
    ]);
    expect(hubOptions[0]).not.toContain("Continue");
    expect(hubOptions[1]).toEqual([
      "✓ 1. Question 1? — Yes",
      "○ 2. Question 2?",
      "○ 3. Question 3?",
      "○ 4. Question 4?",
      "○ 5. Question 5?",
      "Cancel interview"
    ]);
    expect(hubOptions[1]).not.toContain("Continue");
    const last = hubOptions[hubOptions.length - 1];
    expect(last[0]).toBe("✓ 1. Question 1? — Yes");
    expect(last).toContain("Cancel interview");
    expect(last).toContain(`○ 6. ${COMMIT_QUESTION_TEXT}`);
    expect(last.filter(option => option.startsWith("✓ "))).toHaveLength(5);
    expect(last).not.toContain("Continue");
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
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    expect(await exists(path.join(sessionDir, "requirements.json"))).toBe(false);
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
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_NO_LABEL);
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(startWorkflow).not.toHaveBeenCalled();
    expect(executor.runs.map(run => run.envelope.task.action)).toEqual(["ask_questions", "assess", "ask_questions", "assess", "finalize"]);
  });

  it("records the user's review feedback as insights when the goal is still unclear", async () => {
    const cwd = await temporaryDirectory();
    let insightsAtRound2: string[] = [];
    const executor = new ScriptedExecutor(envelope => {
      switch (envelope.task.action) {
        case "ask_questions":
          if (envelope.task.round === 2) insightsAtRound2 = [...envelope.task.insights];
          return { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) };
        case "assess":
          return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "Scope is vague", openQuestions: ["Where does it run?"] } }) };
        case "finalize": {
          const history = envelope.task.history as unknown as Array<{ question: InterviewQuestion; answer: InterviewAnswer }>;
          return { text: JSON.stringify({ action: "finalize", report: { ...REPORT, qa: history } }) };
        }
        default:
          throw new Error(`unexpected action ${envelope.task.action}`);
      }
    });
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI", "Performance matters most");
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push("✏️ Type my own answer");
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    await runRequirementsCommand(cwd, ctx, deps);

    expect(insightsAtRound2).toEqual(["Scope is vague", "Where does it run?", "Performance matters most"]);
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    expect(await exists(path.join(sessionDir, "requirements.json"))).toBe(true);
  });

  it("proceeds to finalize when the user answers No on the final round", async () => {
    const cwd = await temporaryDirectory();
    const insightsLog: string[][] = [];
    let finalizeInsights: string[] = [];
    const executor = new ScriptedExecutor(envelope => {
      switch (envelope.task.action) {
        case "ask_questions":
          insightsLog.push([...envelope.task.insights]);
          return { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) };
        case "assess":
          return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "Still vague" } }) };
        case "finalize": {
          finalizeInsights = [...envelope.task.insights];
          const history = envelope.task.history as unknown as Array<{ question: InterviewQuestion; answer: InterviewAnswer }>;
          return { text: JSON.stringify({ action: "finalize", report: { ...REPORT, qa: history } }) };
        }
        default:
          throw new Error(`unexpected action ${envelope.task.action}`);
      }
    });
    const deps = await testDeps(executor);
    const resolver = hubWalkerResolver({ review: REVIEW_NO_LABEL });
    const { ctx, inputs, notify } = uiContext(resolver);

    inputs.push("Build a CLI");

    const session = (await runRequirementsCommand(cwd, ctx, deps))!;
    expect(session.status).toBe("completed");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Requirements saved"), "info");
    const actions = executor.runs.map(run => run.envelope.task.action);
    expect(actions.filter(action => action === "ask_questions")).toHaveLength(MAX_INTERVIEW_ROUNDS);
    expect(actions[actions.length - 1]).toBe("finalize");
    expect(insightsLog[MAX_INTERVIEW_ROUNDS - 1]).toEqual(Array(MAX_INTERVIEW_ROUNDS - 1).fill("Still vague"));
    expect(finalizeInsights).toContain("Final round reached; finalize the report with the information gathered.");
    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    expect(await exists(path.join(sessionDir, "requirements.json"))).toBe(true);
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

  it("exposes interviewer calls through the dashboard providers and persists transcript artifacts", async () => {
    const cwd = await temporaryDirectory();
    const insightsLog: string[][] = [];
    const executor = new TranscriptingExecutor(successScript(insightsLog));
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_NO_LABEL);
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    const session = (await runRequirementsCommand(cwd, ctx, deps))!;
    expect(session.interviewerCalls).toHaveLength(5);
    expect(session.interviewerModel).toBe(DEFAULT_CONFIG.agents.interviewer.model);

    const inspection = (await session.inspectAgent("interviewer")) as AgentInspection | undefined;
    expect(inspection).toMatchObject({
      name: "interviewer",
      status: "succeeded",
      model: DEFAULT_CONFIG.agents.interviewer.model,
      summary: "Scope is vague; Where does it run?"
    });
    expect(inspection!.steps).toHaveLength(5);
    expect(inspection!.steps[0]).toMatchObject({
      id: "step-1",
      stage: "exploring",
      agent: "interviewer",
      status: "succeeded",
      label: "ask_questions · round 1"
    });
    expect(inspection!.steps[4].label).toBe("finalize · round 2");
    expect(inspection!.steps[0]!.invocations![0]!).toMatchObject({
      sequence: 1,
      mode: "execute",
      status: "succeeded"
    });
    expect(inspection!.steps[0]!.invocations![0]!.usage!.input).toBe(10);
    expect(inspection!.transcriptRevision).toBeGreaterThan(0);
    expect(await session.inspectAgent("builder")).toBeUndefined();

    const artifact = (await session.agentTranscript("step-1", 1)) as AgentTranscriptArtifact | undefined;
    expect(artifact).toMatchObject({
      schemaVersion: 1,
      stepId: "step-1",
      agent: "interviewer",
      invocation: 1,
      mode: "execute",
      status: "succeeded",
      model: DEFAULT_CONFIG.agents.interviewer.model
    });
    expect(artifact!.messages).toHaveLength(2);
    expect(await session.agentTranscript("step-1", 2)).toBeUndefined();
    expect(await session.agentTranscript("step-99", 1)).toBeUndefined();

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const transcriptFile = path.join(sessionDir, "step-1-interviewer-ask_questions-invocation-1-transcript.json");
    const outputFile = path.join(sessionDir, "step-1-interviewer-ask_questions-invocation-1-output.json");
    expect(await exists(transcriptFile)).toBe(true);
    expect(await exists(outputFile)).toBe(true);
    const persisted = JSON.parse(await readFile(transcriptFile, "utf8")) as AgentTranscriptArtifact;
    expect(persisted.stepId).toBe("step-1");
    expect(persisted.messages).toHaveLength(2);
    expect(JSON.parse(await readFile(outputFile, "utf8"))).toHaveProperty("action", "ask_questions");

    const history = await session.agentHistory();
    expect(history).toMatchObject({
      runId: "test-session",
      total: { invocationCount: 5, measuredInvocationCount: 5 },
      agents: [{ name: "interviewer", invocationCount: 5 }]
    });
    expect(history!.invocations).toHaveLength(5);
    expect(history!.invocations[0]).toMatchObject({
      key: "step-1:1",
      stepId: "step-1",
      stepLabel: "ask_questions · round 1",
      sequence: 1,
      agent: "interviewer",
      mode: "execute",
      status: "succeeded",
      hasTranscript: true,
      hasDiff: false
    });
  });

  it("persists failed interviewer calls with their streamed transcript", async () => {
    const cwd = await temporaryDirectory();
    const executor = new TranscriptingExecutor(() => {
      throw new Error("boom");
    });
    const deps = await testDeps(executor);
    const { ctx, inputs, notify } = uiContext();

    inputs.push("Build a CLI");

    const session = (await runRequirementsCommand(cwd, ctx, deps))!;
    expect(session.status).toBe("failed");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Requirements interview failed"), "error");

    expect(session.interviewerCalls).toHaveLength(1);
    expect(session.interviewerCalls[0]).toMatchObject({ status: "failed", error: "boom", mode: "execute", action: "ask_questions" });
    expect(session.interviewerCalls[0].usage!.input).toBe(10);

    const inspection = (await session.inspectAgent("interviewer")) as AgentInspection | undefined;
    expect(inspection!.status).toBe("failed");
    expect(inspection!.error).toBe("boom");
    expect(inspection!.steps).toHaveLength(1);
    expect(inspection!.steps[0]!.status).toBe("failed");

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const transcriptFile = path.join(sessionDir, "step-1-interviewer-ask_questions-invocation-1-transcript.json");
    const outputFile = path.join(sessionDir, "step-1-interviewer-ask_questions-invocation-1-output.json");
    expect(await exists(transcriptFile)).toBe(true);
    expect(await exists(outputFile)).toBe(true);
    expect(await readFile(outputFile, "utf8")).toContain("boom");

    const artifact = (await session.agentTranscript("step-1", 1)) as AgentTranscriptArtifact | undefined;
    expect(artifact!.status).toBe("failed");
    expect(artifact!.messages).toHaveLength(1);
  });

  it("persists the task envelope artifact for correct_output calls", async () => {
    const cwd = await temporaryDirectory();
    let call = 0;
    const executor = new TranscriptingExecutor(envelope => {
      call++;
      if (envelope.task.action === "ask_questions" && call === 1) {
        return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
      }
      switch (envelope.task.action) {
        case "ask_questions":
          return { text: JSON.stringify({ action: "ask_questions", questions: QUESTIONS }) };
        case "assess":
          return { text: JSON.stringify({ action: "assess", assessment: { goal: "Build a CLI", summary: "ok" } }) };
        case "finalize":
          return { text: JSON.stringify({ action: "finalize", report: REPORT }) };
        default:
          throw new Error(`unexpected action ${envelope.task.action}`);
      }
    });
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    const session = (await runRequirementsCommand(cwd, ctx, deps))!;
    expect(executor.runs[0].envelope.mode).toBe("execute");
    expect(executor.runs[1].envelope.mode).toBe("correct_output");
    expect(session.interviewerCalls).toHaveLength(4);

    const corrected = session.interviewerCalls[1];
    expect(corrected).toMatchObject({
      mode: "correct_output",
      action: "ask_questions",
      status: "succeeded"
    });
    expect(corrected.taskArtifact).toBe("step-2-interviewer-ask_questions-invocation-1-task.json");

    const sessionDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "requirements", "test-session");
    const taskFile = path.join(sessionDir, "step-2-interviewer-ask_questions-invocation-1-task.json");
    expect(await exists(taskFile)).toBe(true);
    const task = JSON.parse(await readFile(taskFile, "utf8"));
    expect(task.mode).toBe("correct_output");
    expect(task.correction).toMatchObject({ attempt: 1, reason: "schema_validation_failed", fieldPath: "action" });
    expect(await exists(path.join(sessionDir, "step-1-interviewer-ask_questions-invocation-1-task.json"))).toBe(false);

    const inspection = (await session.inspectAgent("interviewer")) as AgentInspection | undefined;
    expect(inspection!.steps[1]!.invocations![0]!.mode).toBe("correct_output");
    const history = await session.agentHistory();
    expect(history!.invocations[1]!.mode).toBe("correct_output");
  });

  it("gates run-scoped dashboard endpoints to the session run id", async () => {
    const cwd = await temporaryDirectory();
    const insightsLog: string[][] = [];
    const executor = new TranscriptingExecutor(successScript(insightsLog));
    const deps = await testDeps(executor);
    const { ctx, selects, inputs } = uiContext();

    inputs.push("Build a CLI");
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_NO_LABEL);
    selects.push(...hubSequence(QUESTIONS, allYes(QUESTIONS)));
    selects.push(REVIEW_YES_LABEL);
    selects.push("Done");

    const session = (await runRequirementsCommand(cwd, ctx, deps))!;
    const url = await session.dashboard.start(0);

    const matching = await fetch(`${url}/api/runs/test-session/agents/interviewer`);
    expect(matching.status).toBe(200);
    expect(((await matching.json()) as AgentInspection).name).toBe("interviewer");
    const wrongInspection = await fetch(`${url}/api/runs/other-run/agents/interviewer`);
    expect(wrongInspection.status).toBe(200);
    expect(await wrongInspection.json()).toBeNull();

    const matchingHistory = await fetch(`${url}/api/runs/test-session/agent-history`);
    expect(matchingHistory.status).toBe(200);
    expect(((await matchingHistory.json()) as AgentHistoryResponse).runId).toBe("test-session");
    expect((await fetch(`${url}/api/runs/other-run/agent-history`)).status).toBe(404);

    const matchingTranscript = await fetch(`${url}/api/runs/test-session/steps/step-1/invocations/1/transcript`);
    expect(matchingTranscript.status).toBe(200);
    expect((await fetch(`${url}/api/runs/other-run/steps/step-1/invocations/1/transcript`)).status).toBe(404);

    await session.dashboard.stop();
  });
});

describe("questionPresentation", () => {
  it("builds a goal header and structured options for a first-round question", () => {
    const presentation = questionPresentation(
      { goal: "Build a CLI", round: 1, lastAssessmentNote: undefined },
      MULTI_QUESTIONS[0],
      []
    );

    expect(presentation.content).toContain("**Goal:** Build a CLI");
    expect(presentation.content).not.toContain("Round ");
    expect(presentation.content).not.toContain("Follow-up");
    expect(presentation.content).toContain("## Which platforms?");
    expect(presentation.question).toEqual({
      id: "q1",
      kind: "multiple",
      options: [
        { id: "windows", text: "Windows", recommended: true, picked: false },
        { id: "macos", text: "macOS", recommended: false, picked: false },
        { id: "linux", text: "Linux", recommended: false, picked: false }
      ]
    });
    expect(presentation.actions.map(action => action.value)).toEqual(["opt:q1:windows", "opt:q1:macos", "opt:q1:linux", "custom:q1", "cancel"]);
  });

  it("adds round and follow-up context for later rounds and marks picks", () => {
    const presentation = questionPresentation(
      { goal: "Build a CLI", round: 2, lastAssessmentNote: "Scope is vague; Where does it run?" },
      QUESTIONS[0],
      ["yes"]
    );

    expect(presentation.content).toContain("**Goal:** Build a CLI");
    expect(presentation.content).toContain("Round 2 of 6");
    expect(presentation.content).toContain("**Follow-up:** Scope is vague; Where does it run?");
    expect(presentation.question?.kind).toBe("single");
    expect(presentation.question?.options).toEqual([
      { id: "yes", text: "Yes", recommended: true, picked: true },
      { id: "no", text: "No", recommended: false, picked: false }
    ]);
    expect(presentation.actions.map(action => action.value)).toEqual(["opt:q1:yes", "opt:q1:no", "custom:q1", "cancel"]);
  });
});

describe("reviewPresentation", () => {
  const reviewQuestion: InterviewQuestion = {
    id: "review",
    kind: "single",
    text: "Was the goal clear?",
    options: [
      { id: "yes", text: "Yes — the goal is clear, proceed", recommended: true },
      { id: "no", text: "No — I still have doubts" }
    ]
  };
  const session = { goal: "Build a CLI", round: 1, lastAssessmentNote: undefined as string | undefined };

  it("presents the interviewer's synthesis and asks whether the goal was clear", () => {
    const assessment: InterviewerAssessment = {
      goal: "Build a CLI",
      summary: "Scope is vague",
      openQuestions: ["Where does it run?"]
    };
    const presentation = reviewPresentation(assessment, session, reviewQuestion, []);

    expect(presentation.content).toContain("**Goal:** Build a CLI");
    expect(presentation.content).toContain("**What the interviewer understands so far:**");
    expect(presentation.content).toContain("Scope is vague");
    expect(presentation.content).toContain("**Still open:**");
    expect(presentation.content).toContain("- Where does it run?");
    expect(presentation.content).toContain("## Was the goal clear?");
    expect(presentation.actions.map(action => action.value)).toEqual(["opt:review:yes", "opt:review:no", "custom:review", "cancel"]);
    expect(presentation.question).toEqual({
      id: "review",
      kind: "single",
      options: [
        { id: "yes", text: "Yes — the goal is clear, proceed", recommended: true, picked: false },
        { id: "no", text: "No — I still have doubts", recommended: false, picked: false }
      ]
    });
  });

  it("omits the still-open section when the interviewer lists no gaps", () => {
    const presentation = reviewPresentation(
      { goal: "Build a CLI", summary: "Everything is clear" },
      session,
      reviewQuestion,
      []
    );

    expect(presentation.content).toContain("Everything is clear");
    expect(presentation.content).not.toContain("**Still open:**");
  });
});

describe("mapTuiChoice", () => {
  const question: InterviewQuestion = {
    id: "q1",
    kind: "multiple",
    text: "Which platforms?",
    options: [
      { id: "windows", text: "Windows", recommended: true },
      { id: "macos", text: "macOS" }
    ]
  };

  it("maps an option label to its opt action", () => {
    expect(mapTuiChoice(question, "Windows (recommended)")).toEqual({ action: "opt:q1:windows" });
    expect(mapTuiChoice(question, "macOS")).toEqual({ action: "opt:q1:macos" });
  });

  it("strips the picked marker and recommendation suffix from option labels", () => {
    expect(mapTuiChoice(question, "✓ Windows (recommended)")).toEqual({ action: "opt:q1:windows" });
  });

  it("maps the custom and cancel labels to their actions", () => {
    expect(mapTuiChoice(question, "✏️ Type my own answer")).toEqual({ action: "custom:q1" });
    expect(mapTuiChoice(question, "Cancel interview")).toEqual({ action: "cancel" });
  });

  it("returns undefined for dismissed, unknown, and legacy Done labels", () => {
    expect(mapTuiChoice(question, "← Back to questions")).toBeUndefined();
    expect(mapTuiChoice(question, "Done")).toBeUndefined();
    expect(mapTuiChoice(question, "Not an option")).toBeUndefined();
    expect(mapTuiChoice(question, "Continue")).toBeUndefined();
  });
});

describe("commitPresentation", () => {
  it("offers Finish round and Keep working without a custom answer", () => {
    const presentation = commitPresentation({ goal: "Build a CLI" });

    expect(presentation.content).toContain("**Goal:** Build a CLI");
    expect(presentation.content).toContain("## All questions are answered. Finish this round?");
    expect(presentation.actions.map(action => action.value)).toEqual([
      "opt:commit:finish-round",
      "opt:commit:keep-working",
      "cancel"
    ]);
    expect(presentation.question).toEqual({
      id: "commit",
      kind: "single",
      options: [
        { id: "finish-round", text: "Finish round", recommended: true, picked: false },
        { id: "keep-working", text: "Keep working", recommended: false, picked: false }
      ]
    });
  });
});
