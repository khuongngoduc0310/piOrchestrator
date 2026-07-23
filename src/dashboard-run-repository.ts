import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { AGENT_NAMES, type AgentName, type AgentTranscriptArtifact } from "./agent-types.js";
import { readSafeArtifact } from "./checkpoint-store.js";
import { validateWorkflowStateForResume } from "./checkpoint-validation.js";
import type { AgentInspection } from "./dashboard-types.js";
import type { WorkflowState } from "./workflow-types.js";

const DEFAULT_MAX_RUNS = 1_000;
const DEFAULT_MAX_STATE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_ARTIFACT_BYTES = 16 * 1024 * 1024;
const DEFAULT_ARTIFACT_PREVIEW_BYTES = 512 * 1024;

export interface HistoricalRunSummary {
  id: string;
  request: string;
  route?: WorkflowState["route"];
  status: WorkflowState["status"];
  stage: WorkflowState["stage"];
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  activeAgent?: AgentName;
  message?: string;
}

export interface HistoricalArtifactContent {
  name: string;
  text: string;
  truncated: boolean;
  isJson: boolean;
  sizeBytes: number;
  returnedBytes: number;
}

export interface DashboardRunRepositoryOptions {
  maxRuns?: number;
  maxStateBytes?: number;
  maxTranscriptBytes?: number;
  maxArtifactBytes?: number;
  artifactPreviewBytes?: number;
}

export class DashboardRunRepository {
  readonly runsDir: string;
  private readonly maxRuns: number;
  private readonly maxStateBytes: number;
  private readonly maxTranscriptBytes: number;
  private readonly maxArtifactBytes: number;
  private readonly artifactPreviewBytes: number;

  constructor(readonly cwd: string, options: DashboardRunRepositoryOptions = {}) {
    this.runsDir = path.join(cwd, CONFIG_DIR_NAME, "orchestrator", "runs");
    this.maxRuns = positiveInteger(options.maxRuns ?? DEFAULT_MAX_RUNS, "maxRuns");
    this.maxStateBytes = positiveInteger(options.maxStateBytes ?? DEFAULT_MAX_STATE_BYTES, "maxStateBytes");
    this.maxTranscriptBytes = positiveInteger(options.maxTranscriptBytes ?? DEFAULT_MAX_TRANSCRIPT_BYTES, "maxTranscriptBytes");
    this.maxArtifactBytes = positiveInteger(options.maxArtifactBytes ?? DEFAULT_MAX_ARTIFACT_BYTES, "maxArtifactBytes");
    this.artifactPreviewBytes = positiveInteger(options.artifactPreviewBytes ?? DEFAULT_ARTIFACT_PREVIEW_BYTES, "artifactPreviewBytes");
    if (this.artifactPreviewBytes > this.maxArtifactBytes) {
      throw new Error("artifactPreviewBytes must not exceed maxArtifactBytes");
    }
  }

  async listRuns(limit = 100): Promise<HistoricalRunSummary[]> {
    const requested = positiveInteger(limit, "limit");
    const candidates = await this.enumerateRunDirectories();
    const summaries: HistoricalRunSummary[] = [];
    for (const candidate of candidates) {
      if (summaries.length >= Math.min(requested, this.maxRuns)) break;
      try {
        const state = await this.loadRun(candidate.id);
        if (state) summaries.push(toSummary(state));
      } catch {
        // A historical listing remains usable when an individual run is corrupt.
      }
    }
    return summaries;
  }

  async loadRun(runId: string): Promise<WorkflowState | undefined> {
    const runDir = await this.openRunDirectory(runId);
    if (!runDir) return undefined;
    const text = await readSafeArtifact(runDir, "state.json", this.maxStateBytes);
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Invalid state.json for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const state = validateWorkflowStateForResume(value, `run ${runId} state`);
    if (state.runId !== runId) throw new Error(`Run state ID does not match directory: ${runId}`);
    return state;
  }

  async getAgentInspection(runId: string, name: AgentName): Promise<AgentInspection | undefined> {
    if (!(AGENT_NAMES as readonly string[]).includes(name)) throw new Error(`Invalid agent name: ${name}`);
    const state = await this.loadRun(runId);
    if (!state) return undefined;
    const agent = state.agents[name];
    if (!agent) throw new Error(`Run ${runId} has no persisted state for agent ${name}`);
    const steps = state.steps.filter(step => step.agent === name);
    return {
      name,
      status: agent.status,
      model: agent.model,
      summary: agent.summary,
      error: agent.error,
      startedAt: agent.startedAt,
      completedAt: agent.completedAt,
      currentTool: state.activeAgent === name ? state.currentTool : undefined,
      currentToolArgs: state.activeAgent === name ? state.currentToolArgs : undefined,
      toolStatus: state.activeAgent === name ? state.toolStatus : undefined,
      agentOutput: state.activeAgent === name ? state.agentOutput : undefined,
      steps,
      toolEvents: [],
      hasArtifact: steps.some(step => step.artifact !== undefined),
      hasRawArtifact: steps.some(step => step.rawArtifact !== undefined)
    };
  }

  async getInvocationTranscript(
    runId: string,
    stepId: string,
    invocationSequence: number
  ): Promise<AgentTranscriptArtifact | undefined> {
    if (!stepId || path.basename(stepId) !== stepId || stepId === "." || stepId === "..") {
      throw new Error(`Invalid step ID: ${stepId}`);
    }
    if (!Number.isSafeInteger(invocationSequence) || invocationSequence < 1) {
      throw new Error("invocationSequence must be a positive safe integer");
    }
    const state = await this.loadRun(runId);
    if (!state) return undefined;
    const step = state.steps.find(candidate => candidate.id === stepId);
    const invocation = step?.invocations?.find(candidate => candidate.sequence === invocationSequence);
    if (!step || !invocation?.transcriptArtifact) return undefined;
    const runDir = await this.requireRunDirectory(runId);
    let text: string;
    try {
      text = await readSafeArtifact(runDir, invocation.transcriptArtifact, this.maxTranscriptBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`Invalid transcript for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const transcript = validateTranscript(value);
    if (transcript.stepId !== stepId || transcript.invocation !== invocationSequence || transcript.agent !== step.agent) {
      throw new Error(`Transcript identity does not match invocation ${stepId}/${invocationSequence}`);
    }
    return transcript;
  }

  async readArtifact(runId: string, name: string): Promise<HistoricalArtifactContent | undefined> {
    const runDir = await this.openRunDirectory(runId);
    if (!runDir) return undefined;
    let text: string;
    try {
      text = await readSafeArtifact(runDir, name, this.maxArtifactBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    const bytes = Buffer.from(text, "utf8");
    const preview = utf8Prefix(bytes, this.artifactPreviewBytes);
    return {
      name,
      text: preview.toString("utf8"),
      truncated: preview.length < bytes.length,
      isJson: name.toLowerCase().endsWith(".json"),
      sizeBytes: bytes.length,
      returnedBytes: preview.length
    };
  }

  private async enumerateRunDirectories(): Promise<Array<{ id: string; mtimeMs: number }>> {
    let names: string[];
    try {
      names = await readdir(this.runsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const candidates: Array<{ id: string; mtimeMs: number }> = [];
    for (const id of names) {
      try {
        assertBasename(id, "run ID");
        const stats = await lstat(path.join(this.runsDir, id));
        if (!stats.isSymbolicLink() && stats.isDirectory()) candidates.push({ id, mtimeMs: stats.mtimeMs });
      } catch {
        // Ignore entries that disappear, are malformed, or cannot be inspected.
      }
    }
    return candidates
      .sort((left, right) => right.mtimeMs - left.mtimeMs || right.id.localeCompare(left.id))
      .slice(0, this.maxRuns);
  }

  private async openRunDirectory(runId: string): Promise<string | undefined> {
    assertBasename(runId, "run ID");
    const runDir = path.join(this.runsDir, runId);
    try {
      const stats = await lstat(runDir);
      if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error(`Run directory must be a regular non-symlink directory: ${runId}`);
      return runDir;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async requireRunDirectory(runId: string): Promise<string> {
    const runDir = await this.openRunDirectory(runId);
    if (!runDir) throw new Error(`Run does not exist: ${runId}`);
    return runDir;
  }
}

function toSummary(state: WorkflowState): HistoricalRunSummary {
  return {
    id: state.runId,
    request: state.request,
    route: state.route,
    status: state.status,
    stage: state.stage,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt,
    activeAgent: state.activeAgent,
    message: state.message
  };
}

function validateTranscript(value: unknown): AgentTranscriptArtifact {
  if (typeof value !== "object" || value === null) throw new Error("Transcript must be an object");
  const transcript = value as Partial<AgentTranscriptArtifact>;
  if (transcript.schemaVersion !== 1 || !Array.isArray(transcript.messages) || typeof transcript.truncated !== "boolean") {
    throw new Error("Transcript has an invalid envelope");
  }
  if (typeof transcript.stepId !== "string" || !(AGENT_NAMES as readonly unknown[]).includes(transcript.agent)
    || !Number.isSafeInteger(transcript.invocation) || typeof transcript.mode !== "string"
    || typeof transcript.status !== "string" || typeof transcript.model !== "string"
    || typeof transcript.startedAt !== "string" || typeof transcript.completedAt !== "string") {
    throw new Error("Transcript has invalid invocation metadata");
  }
  return value as AgentTranscriptArtifact;
}

function utf8Prefix(bytes: Buffer, maxBytes: number): Buffer {
  if (bytes.length <= maxBytes) return bytes;
  let end = maxBytes;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  while (end > 0) {
    try {
      decoder.decode(bytes.subarray(0, end));
      return bytes.subarray(0, end);
    } catch {
      end--;
    }
  }
  return bytes.subarray(0, 0);
}

function assertBasename(value: string, label: string): void {
  if (!value || path.basename(value) !== value || value === "." || value === "..") throw new Error(`Invalid ${label}: ${value}`);
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}
