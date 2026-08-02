import { randomUUID } from "node:crypto";
import type { AgentExecutor } from "../agents/agent-runner.js";
import { buildTranscriptArtifact } from "../orchestration/orchestrator-agent-step.js";
import { RequirementsStore } from "../persistence/requirements-store.js";
import { DashboardServer } from "../ui/dashboard.js";
import { buildRequirementsViewModel, interviewQaToDashboard } from "../ui/ui-model.js";
import type {
  AgentHistoryInvocation,
  AgentHistoryResponse,
  AgentInspection,
  AgentUsageSummary,
  PendingQuestionInfo,
  RequirementsSummary
} from "../dashboard-types.js";
import {
  MAX_INTERVIEW_ROUNDS,
  type AgentInvocationRecord,
  type AgentName,
  type AgentTranscript,
  type AgentTranscriptArtifact,
  type AgentUsage,
  type InterviewQAndA,
  type OrchestratorConfig,
  type Stage,
  type StepRecord,
  type WorkflowRequest
} from "../types.js";

export interface RequirementsCommandDependencies {
  extensionRoot: string;
  executor?: AgentExecutor;
  loadConfig?: (cwd: string) => Promise<OrchestratorConfig>;
  storeFactory?: (cwd: string, sessionId: string) => RequirementsStore;
  now?: () => Date;
  id?: () => string;
  openBrowser?: (url: string) => void;
  /** When provided, the completed interview offers to start a workflow. */
  startWorkflow?: (request: WorkflowRequest) => Promise<void>;
}

export class RequirementsCancelledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequirementsCancelledError";
  }
}

export class RequirementsDeferredError extends Error {
  constructor(label: string) {
    super(`${label} was dismissed; no requirements artifact was written`);
    this.name = "RequirementsDeferredError";
  }
}

export interface InterviewerCallRecord {
  sequence: number;
  round: number;
  action: "ask_questions" | "assess" | "finalize";
  mode: "execute" | "correct_output";
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  messageCount: number;
  truncated: boolean;
  transcript?: AgentTranscript;
  transcriptArtifact?: string;
  outputArtifact?: string;
  taskArtifact?: string;
  taskText?: string;
  usage?: AgentUsage;
  provider?: string;
  model?: string;
  api?: string;
  stopReason?: string;
  toolName?: string;
  toolArgs?: string;
  error?: string;
}

const INTERVIEWER_STAGE: Stage = "exploring";

export class RequirementsSession {
  readonly sessionId: string;
  readonly startedAt: Date;
  readonly store: RequirementsStore;
  readonly dashboard: DashboardServer;
  readonly controller = new AbortController();
  goal = "";
  status: "running" | "waiting" | "completed" | "failed" | "cancelled" = "running";
  round = 0;
  waitingFor?: string;
  pendingDecision?: { id: string; kind: string; label: string; requestedAt: string; dashboardAvailable: boolean };
  pendingQuestions: PendingQuestionInfo[] = [];
  dashboardUrl?: string;
  message?: string;
  artifactPath?: string;
  interviewerStatus: "idle" | "running" | "succeeded" | "failed" | "cancelled" = "idle";
  history: InterviewQAndA[] = [];
  insights: string[] = [];
  artifactNames: string[] = [];
  requirement?: RequirementsSummary;
  lastAssessmentNote?: string;
  interviewerModel = "";
  transcriptRevision = 0;
  interviewerCalls: InterviewerCallRecord[] = [];

  constructor(
    readonly cwd: string,
    readonly deps: RequirementsCommandDependencies
  ) {
    this.sessionId = deps.id?.() ?? randomUUID();
    this.startedAt = deps.now?.() ?? new Date();
    this.store = deps.storeFactory?.(cwd, this.sessionId) ?? new RequirementsStore(cwd, this.sessionId);
    this.dashboard = new DashboardServer({
      getViewModel: () => this.getViewModel(),
      getAgentInspection: name => this.inspectAgent(name),
      getRunAgentInspection: async (runId, name) => runId === this.sessionId ? this.inspectAgent(name) : undefined,
      getAgentTranscript: (stepId, invocation) => this.agentTranscript(stepId, invocation),
      getRunAgentTranscript: async (runId, stepId, invocation) => runId === this.sessionId ? this.agentTranscript(stepId, invocation) : undefined,
      getRunAgentHistory: async runId => runId === this.sessionId ? this.agentHistory() : undefined,
      readArtifact: name => this.store.readArtifact(name),
      readRunArtifact: async (runId, name) => runId === this.sessionId ? this.store.readArtifact(name) : undefined
    });
  }

  timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }

  recordCall(round: number, action: InterviewerCallRecord["action"], mode: InterviewerCallRecord["mode"]): InterviewerCallRecord {
    const call: InterviewerCallRecord = {
      sequence: this.interviewerCalls.length + 1,
      round,
      action,
      mode,
      startedAt: this.timestamp(),
      status: "running",
      messageCount: 0,
      truncated: false
    };
    this.interviewerCalls.push(call);
    this.transcriptRevision++;
    this.publish();
    return call;
  }

  updateCall(call: InterviewerCallRecord, patch: Partial<InterviewerCallRecord>): void {
    Object.assign(call, patch);
    this.transcriptRevision++;
    this.publish();
  }

  async finishCall(
    call: InterviewerCallRecord,
    status: InterviewerCallRecord["status"],
    options: {
      outputText?: string;
      error?: string;
      usage?: AgentUsage;
      provider?: string;
      model?: string;
      api?: string;
      stopReason?: string;
    } = {}
  ): Promise<void> {
    call.status = status;
    call.completedAt = this.timestamp();
    if (options.error !== undefined) call.error = options.error;
    if (options.usage) call.usage = options.usage;
    if (options.provider) call.provider = options.provider;
    if (options.model) call.model = options.model;
    if (options.api) call.api = options.api;
    if (options.stopReason) call.stopReason = options.stopReason;
    const prefix = `step-${call.sequence}-interviewer-${call.action}-invocation-1`;
    await this.persistCallArtifacts(call, prefix, options.outputText);
    this.transcriptRevision++;
    this.publish();
  }

  private async persistCallArtifacts(call: InterviewerCallRecord, prefix: string, outputText: string | undefined): Promise<void> {
    if (call.transcript) {
      const artifact: AgentTranscriptArtifact = buildTranscriptArtifact({
        transcript: call.transcript,
        stepId: `step-${call.sequence}`,
        agent: "interviewer",
        invocation: 1,
        mode: call.mode,
        status: call.status,
        model: this.interviewerModel,
        startedAt: call.startedAt,
        completedAt: call.completedAt ?? this.timestamp()
      });
      try {
        call.transcriptArtifact = await this.store.saveRaw(`${prefix}-transcript.json`, JSON.stringify(artifact, null, 2));
      } catch {
        // Transcript persistence must not fail the interview.
      }
    }
    if (outputText !== undefined) {
      try {
        call.outputArtifact = await this.store.saveRaw(`${prefix}-output.json`, outputText);
      } catch {
        // Output persistence must not fail the interview.
      }
    }
    if (call.mode === "correct_output" && call.taskText !== undefined) {
      try {
        call.taskArtifact = await this.store.saveRaw(`${prefix}-task.json`, call.taskText);
      } catch {
        // Task persistence must not fail the interview.
      }
    }
  }

  private stepRecordFor(call: InterviewerCallRecord): StepRecord {
    const invocation: AgentInvocationRecord = {
      sequence: 1,
      mode: call.mode,
      status: call.status,
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      transcriptArtifact: call.transcriptArtifact,
      messageCount: call.messageCount,
      truncated: call.truncated,
      usage: call.usage,
      provider: call.provider,
      model: call.model,
      api: call.api,
      stopReason: call.stopReason
    };
    return {
      id: `step-${call.sequence}`,
      sequence: call.sequence,
      stage: INTERVIEWER_STAGE,
      label: `${call.action} · round ${call.round}${call.mode === "correct_output" ? " (correction)" : ""}`,
      status: call.status,
      agent: "interviewer",
      startedAt: call.startedAt,
      completedAt: call.completedAt,
      invocations: [invocation]
    };
  }

  async inspectAgent(name: AgentName): Promise<AgentInspection | undefined> {
    if (name !== "interviewer") return undefined;
    const calls = this.interviewerCalls;
    const first = calls[0];
    const last = calls[calls.length - 1];
    const running = this.interviewerStatus === "running";
    return {
      name,
      status: this.interviewerStatus,
      model: this.interviewerModel,
      summary: this.lastAssessmentNote,
      error: this.status === "failed" ? this.message : undefined,
      startedAt: first?.startedAt,
      completedAt: last?.completedAt,
      currentTool: running ? last?.toolName : undefined,
      currentToolArgs: running ? last?.toolArgs : undefined,
      steps: calls.map(call => this.stepRecordFor(call)),
      toolEvents: [],
      hasArtifact: false,
      hasRawArtifact: false,
      transcriptRevision: this.transcriptRevision
    };
  }

  async agentTranscript(stepId: string, invocation: number): Promise<AgentTranscriptArtifact | undefined> {
    if (invocation !== 1) return undefined;
    const match = /^step-(\d+)$/.exec(stepId);
    if (!match) return undefined;
    const call = this.interviewerCalls.find(candidate => candidate.sequence === Number(match[1]));
    if (!call) return undefined;
    if (call.transcript) {
      return buildTranscriptArtifact({
        transcript: call.transcript,
        stepId,
        agent: "interviewer",
        invocation: 1,
        mode: call.mode,
        status: call.status,
        model: this.interviewerModel,
        startedAt: call.startedAt,
        completedAt: call.completedAt ?? this.timestamp()
      });
    }
    if (!call.transcriptArtifact) return undefined;
    const artifact = await this.store.readArtifact(call.transcriptArtifact);
    if (!artifact) return undefined;
    try {
      return JSON.parse(artifact.text) as AgentTranscriptArtifact;
    } catch {
      return undefined;
    }
  }

  async agentHistory(): Promise<AgentHistoryResponse | undefined> {
    const summary: AgentUsageSummary = {
      invocationCount: this.interviewerCalls.length,
      measuredInvocationCount: this.interviewerCalls.length
    };
    const invocations: AgentHistoryInvocation[] = this.interviewerCalls.map(call => {
      const stepId = `step-${call.sequence}`;
      return {
        key: `${stepId}:1`,
        stepId,
        stepLabel: `${call.action} · round ${call.round}`,
        sequence: 1,
        agent: "interviewer",
        mode: call.mode,
        status: call.status,
        startedAt: call.startedAt,
        completedAt: call.completedAt,
        durationMs: call.completedAt ? Date.parse(call.completedAt) - Date.parse(call.startedAt) : undefined,
        usage: call.usage,
        provider: call.provider,
        model: call.model,
        api: call.api,
        stopReason: call.stopReason,
        changedFileCount: 0,
        hasTranscript: call.transcriptArtifact !== undefined,
        hasDiff: false
      };
    });
    return {
      runId: this.sessionId,
      total: summary,
      agents: [{ ...summary, name: "interviewer" }],
      invocations
    };
  }

  getViewModel() {
    return buildRequirementsViewModel({
      sessionId: this.sessionId,
      cwd: this.cwd,
      goal: this.goal,
      status: this.status,
      round: this.round,
      maxRounds: MAX_INTERVIEW_ROUNDS,
      waitingFor: this.waitingFor,
      pendingDecision: this.pendingDecision,
      pendingQuestions: this.pendingQuestions,
      dashboardUrl: this.dashboardUrl,
      message: this.message,
      artifactPath: this.artifactPath,
      interviewerStatus: this.interviewerStatus,
      interviewerModel: this.interviewerModel,
      transcriptRevision: this.transcriptRevision,
      qa: interviewQaToDashboard(this.history),
      artifactNames: this.artifactNames,
      requirement: this.requirement
    });
  }

  publish(): void {
    this.dashboard.publish(this.getViewModel());
  }

  /** Upserts a round's answer, replacing any prior answer for the same question in that round. */
  recordAnswer(round: number, entry: InterviewQAndA): void {
    const index = this.history.findIndex(
      existing => existing.round === round && existing.question.id === entry.question.id
    );
    if (index === -1) this.history.push(entry);
    else this.history[index] = entry;
  }

  /** Replaces a round's history entries with a set-ordered answer list. */
  replaceRound(round: number, entries: InterviewQAndA[]): void {
    this.history = this.history
      .filter(existing => existing.round !== round)
      .concat(entries);
  }
}
