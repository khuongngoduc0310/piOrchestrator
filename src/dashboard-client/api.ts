import type {
  AgentInspection,
  AgentHistoryResponse,
  DashboardRunHistoryItem,
  InvocationDiffView,
  OrchestratorViewModel,
} from "../dashboard-types.js";
import type { AgentTranscript } from "../agent-types.js";
import type { DashboardDecisionAction } from "../dashboard-types.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";

export class DashboardApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DashboardApiError";
  }
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) throw new DashboardApiError(res.status, `HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

async function fetchWithMeta(
  url: string,
  signal?: AbortSignal,
): Promise<{ text: string; size: number; truncated: boolean }> {
  const res = await fetch(url, { cache: "no-store", signal });
  if (!res.ok) throw new DashboardApiError(res.status, `HTTP ${res.status}`);
  const text = await res.text();
  return {
    text,
    size: Number(res.headers.get("x-artifact-size") ?? 0),
    truncated: res.headers.get("x-artifact-truncated") === "true",
  };
}

export function getCurrentState(signal?: AbortSignal) {
  return fetchJson<OrchestratorViewModel | null>("/api/state", signal);
}

export function listRuns(signal?: AbortSignal) {
  return fetchJson<DashboardRunHistoryItem[]>("/api/runs", signal);
}

export function getRunState(runId: string, signal?: AbortSignal) {
  return fetchJson<OrchestratorViewModel>(
    `/api/runs/${encodeURIComponent(runId)}/state`,
    signal,
  );
}

export function getAgentInspection(
  runId: string,
  agent: string,
  signal?: AbortSignal,
) {
  return fetchJson<AgentInspection | null>(
    `/api/runs/${encodeURIComponent(runId)}/agents/${encodeURIComponent(agent)}`,
    signal,
  );
}

export function getAgentHistory(runId: string, signal?: AbortSignal) {
  return fetchJson<AgentHistoryResponse>(
    `/api/runs/${encodeURIComponent(runId)}/agent-history`,
    signal,
  );
}

export function getTranscript(
  runId: string,
  stepId: string,
  sequence: number,
  signal?: AbortSignal,
) {
  return fetchJson<AgentTranscript>(
    `/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/invocations/${sequence}/transcript`,
    signal,
  );
}

export function getDiff(
  runId: string,
  stepId: string,
  sequence: number,
  signal?: AbortSignal,
) {
  return fetchJson<InvocationDiffView>(
    `/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/invocations/${sequence}/diff`,
    signal,
  );
}

export function getArtifact(
  runId: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ text: string; size: number; truncated: boolean }> {
  return fetchWithMeta(
    `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(name)}`,
    signal,
  );
}

export async function getDecisionPreview(
  decisionId: string,
  signal?: AbortSignal,
): Promise<{ format: string; content: string; actions: DashboardDecisionAction[] }> {
  const res = await fetch(
    `/api/decisions/${encodeURIComponent(decisionId)}/preview`,
    { cache: "no-store", signal },
  );
  if (res.status === 409) throw new DashboardApiError(409, "Decision is no longer active");
  if (!res.ok) throw new DashboardApiError(res.status, `HTTP ${res.status}`);
  return res.json() as Promise<{ format: string; content: string; actions: DashboardDecisionAction[] }>;
}

export async function submitDecision(
  id: string,
  action: HumanDecisionAction,
  feedback?: string,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/decision", {
    method: "POST",
    cache: "no-store",
    signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, action, feedback }),
  });
  if (!res.ok) throw new DashboardApiError(res.status, `HTTP ${res.status}`);
  await res.json();
}
