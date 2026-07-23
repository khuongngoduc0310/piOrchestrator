import type {
  DashboardRunHistoryItem,
  OrchestratorViewModel,
} from "../dashboard-types.js";

export type ConnectionState = "connecting" | "live" | "reconnecting" | "disconnected";
export type AgentMode = "auto" | "pinned" | "closed";
export type DashboardView = "run" | "agent-history";

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
};

export type DashboardAction =
  | { type: "liveSnapshotReceived"; snapshot: OrchestratorViewModel }
  | { type: "displayLiveRun" }
  | { type: "runSelected"; runId: string }
  | { type: "historicalSnapshotLoaded"; snapshot: OrchestratorViewModel }
  | { type: "connectionChanged"; connection: DashboardState["connection"] }
  | { type: "runsLoaded"; runs: DashboardRunHistoryItem[] }
  | { type: "agentPinned"; agent: string }
  | { type: "agentAutoFollowed" }
  | { type: "agentClosed" }
  | { type: "invocationSelected"; key: string }
  | { type: "inspectorTabSelected"; tab: "transcript" | "files" }
  | { type: "transcriptQueryChanged"; query: string }
  | { type: "diffFileSelected"; index: number }
  | { type: "artifactSelected"; name: string }
  | { type: "artifactClosed" }
  | { type: "viewSelected"; view: DashboardView };

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
    case "agentAutoFollowed": {
      const active = state.liveSnapshot?.run?.activeAgent ?? null;
      return {
        ...state,
        agentMode: "auto",
        selectedAgent: active,
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
  }
}
