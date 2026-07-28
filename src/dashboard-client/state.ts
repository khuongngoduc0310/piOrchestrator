import type {
  DashboardRunHistoryItem,
  OrchestratorViewModel,
  PendingDecisionInfo,
} from "../dashboard-types.js";
import type { DashboardDecisionAction } from "../dashboard-types.js";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "disconnected";
export type AgentMode = "auto" | "pinned" | "closed";
export type DashboardView = "run" | "agent-history";
export type PreviewStatus = "idle" | "loading" | "loaded" | "error";
export type SubmissionStatus = "idle" | "submitting" | "submitted" | "error";

export interface DashboardState {
  liveSnapshot: OrchestratorViewModel | null;
  displayedSnapshot: OrchestratorViewModel | null;
  runs: DashboardRunHistoryItem[];
  selectedRunId: string | null;
  connection: ConnectionState;
  agentMode: AgentMode;
  selectedAgent: string | null;
  selectedInvocation: string | null;
  inspectorTab: "transcript" | "files";
  transcriptQuery: string;
  selectedDiffFile: number;
  selectedArtifact: string | null;
  view: DashboardView;
  pendingDecision: PendingDecisionInfo | null;
  currentDecisionId: string | null;
  allowedActions: DashboardDecisionAction[];
  planMarkdown: string | null;
  previewStatus: PreviewStatus;
  previewError: string | null;
  submissionStatus: SubmissionStatus;
  submissionError: string | null;
}

export const INITIAL_STATE: DashboardState = {
  liveSnapshot: null,
  displayedSnapshot: null,
  runs: [],
  selectedRunId: null,
  connection: "connecting",
  agentMode: "auto",
  selectedAgent: null,
  selectedInvocation: null,
  inspectorTab: "transcript",
  transcriptQuery: "",
  selectedDiffFile: 0,
  selectedArtifact: null,
  view: "run",
  pendingDecision: null,
  currentDecisionId: null,
  allowedActions: [],
  planMarkdown: null,
  previewStatus: "idle",
  previewError: null,
  submissionStatus: "idle",
  submissionError: null,
};

export type DashboardAction =
  | { type: "liveSnapshotReceived"; snapshot: OrchestratorViewModel }
  | { type: "displayLiveRun" }
  | { type: "runSelected"; runId: string }
  | { type: "historicalSnapshotLoaded"; runId: string; snapshot: OrchestratorViewModel }
  | { type: "connectionChanged"; connection: DashboardState["connection"] }
  | { type: "runsLoaded"; runs: DashboardRunHistoryItem[] }
  | { type: "agentPinned"; agent: string }
  | { type: "agentAutoSelected"; agent: string | null }
  | { type: "agentAutoFollowed"; agent: string | null }
  | { type: "agentClosed" }
  | { type: "invocationSelected"; key: string }
  | { type: "inspectorTabSelected"; tab: "transcript" | "files" }
  | { type: "transcriptQueryChanged"; query: string }
  | { type: "diffFileSelected"; index: number }
  | { type: "artifactSelected"; name: string }
  | { type: "artifactClosed" }
  | { type: "viewSelected"; view: DashboardView }
  | { type: "pendingDecisionUpdated"; decision: PendingDecisionInfo | null }
  | { type: "planPreviewRetryRequested" }
  | { type: "planPreviewLoaded"; decisionId: string; markdown: string; actions: DashboardDecisionAction[] }
  | { type: "planPreviewError"; decisionId: string; error: string }
  | { type: "decisionSubmitting" }
  | { type: "decisionSubmitted" }
  | { type: "decisionError"; error: string }
  | { type: "decisionDismissed" };

export function dashboardReducer(
  state: DashboardState,
  action: DashboardAction,
): DashboardState {
  switch (action.type) {
    case "liveSnapshotReceived": {
      const live = action.snapshot;
      const displayed =
        state.selectedRunId && state.selectedRunId !== (live.run?.id ?? null)
          ? state.displayedSnapshot
          : live;
      return { ...state, liveSnapshot: live, displayedSnapshot: displayed };
    }
    case "displayLiveRun": {
      if (!state.liveSnapshot) return state;
      return {
        ...state,
        displayedSnapshot: state.liveSnapshot,
        selectedRunId: state.liveSnapshot.run?.id ?? null,
      };
    }
    case "runSelected": {
      return {
        ...state,
        selectedRunId: action.runId,
        selectedAgent: null,
        agentMode: "auto",
        selectedInvocation: null,
        inspectorTab: "transcript",
        transcriptQuery: "",
        selectedDiffFile: 0,
        selectedArtifact: null,
      };
    }
    case "historicalSnapshotLoaded": {
      if (state.selectedRunId !== action.runId) return state;
      return { ...state, displayedSnapshot: action.snapshot };
    }
    case "connectionChanged": {
      return { ...state, connection: action.connection };
    }
    case "runsLoaded": {
      return { ...state, runs: action.runs };
    }
    case "agentPinned": {
      return {
        ...state,
        selectedAgent: action.agent,
        agentMode: "pinned",
        selectedInvocation: null,
        inspectorTab: "transcript",
      };
    }
    case "agentAutoSelected": {
      if (state.agentMode !== "auto") return state;
      return {
        ...state,
        selectedAgent: action.agent,
        selectedInvocation: null,
      };
    }
    case "agentAutoFollowed": {
      return {
        ...state,
        agentMode: "auto",
        selectedAgent: action.agent,
        selectedInvocation: null,
      };
    }
    case "agentClosed": {
      return {
        ...state,
        agentMode: "closed",
        selectedAgent: null,
        selectedInvocation: null,
      };
    }
    case "invocationSelected": {
      return { ...state, selectedInvocation: action.key };
    }
    case "inspectorTabSelected": {
      return { ...state, inspectorTab: action.tab };
    }
    case "transcriptQueryChanged": {
      return { ...state, transcriptQuery: action.query };
    }
    case "diffFileSelected": {
      return { ...state, selectedDiffFile: action.index };
    }
    case "artifactSelected": {
      return { ...state, selectedArtifact: action.name };
    }
    case "artifactClosed": {
      return { ...state, selectedArtifact: null };
    }
    case "viewSelected": {
      return { ...state, view: action.view };
    }
    case "pendingDecisionUpdated": {
      if (!action.decision) {
        return {
          ...state,
          pendingDecision: null,
          currentDecisionId: null,
          allowedActions: [],
          planMarkdown: null,
          previewStatus: "idle",
          previewError: null,
          submissionStatus: "idle",
          submissionError: null,
        };
      }
      const decisionId = action.decision.id;
      // Same decision from repeated SSE snapshot — preserve loaded state
      if (decisionId === state.currentDecisionId) {
        return { ...state, pendingDecision: action.decision };
      }
      // New decision — clear everything and start fresh
      return {
        ...state,
        currentDecisionId: decisionId,
        pendingDecision: action.decision,
        allowedActions: [],
        planMarkdown: null,
        previewStatus: "loading",
        previewError: null,
        submissionStatus: "idle",
        submissionError: null,
      };
    }
    case "planPreviewRetryRequested": {
      if (!state.currentDecisionId) return state;
      return {
        ...state,
        planMarkdown: null,
        allowedActions: [],
        previewStatus: "loading",
        previewError: null,
      };
    }
    case "planPreviewLoaded": {
      if (action.decisionId !== state.currentDecisionId) return state;
      return {
        ...state,
        planMarkdown: action.markdown,
        allowedActions: action.actions,
        previewStatus: "loaded",
        previewError: null,
      };
    }
    case "planPreviewError": {
      if (action.decisionId !== state.currentDecisionId) return state;
      return { ...state, previewStatus: "error", previewError: action.error };
    }
    case "decisionSubmitting": {
      return { ...state, submissionStatus: "submitting", submissionError: null };
    }
    case "decisionSubmitted": {
      return { ...state, submissionStatus: "submitted" };
    }
    case "decisionError": {
      return { ...state, submissionStatus: "error", submissionError: action.error };
    }
    case "decisionDismissed": {
      return { ...state, submissionStatus: "idle", submissionError: null };
    }
  }
}

export function isViewingLiveRun(state: DashboardState): boolean {
  const liveRunId = state.liveSnapshot?.run?.id ?? null;
  const displayedRunId = state.displayedSnapshot?.run?.id ?? liveRunId;
  return state.view === "run" && liveRunId !== null &&
    (state.selectedRunId === null || state.selectedRunId === liveRunId) &&
    displayedRunId === liveRunId;
}
