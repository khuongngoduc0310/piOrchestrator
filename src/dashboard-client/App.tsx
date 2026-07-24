import { useCallback, useEffect, useReducer } from "react";
import { dashboardReducer, INITIAL_STATE } from "./state.js";
import type { DashboardAction } from "./state.js";
import { useDashboardStream } from "./hooks/useDashboardStream.js";
import { useElapsedTime } from "./hooks/useElapsedTime.js";
import { useSectionNavigation } from "./hooks/useSectionNavigation.js";
import { Header } from "./components/Header.js";
import { Callout } from "./components/Callout.js";
import { PhaseRail } from "./components/PhaseRail.js";
import { Overview } from "./components/Overview.js";
import { AgentGrid } from "./components/AgentGrid.js";
import { AgentInspector } from "./components/AgentInspector.js";
import { Timeline } from "./components/Timeline.js";
import { ArtifactViewer } from "./components/ArtifactViewer.js";
import { AgentHistory } from "./components/AgentHistory.js";

export function App() {
  const [state, dispatch] = useReducer(dashboardReducer, INITIAL_STATE);
  const dispatchAction = dispatch as React.Dispatch<DashboardAction>;

  useDashboardStream(dispatchAction);

  const snap = state.displayedSnapshot ?? state.liveSnapshot;
  const hasRun = Boolean(snap?.run);
  const elapsedText = useElapsedTime(snap);
  const currentSection = useSectionNavigation(hasRun && state.view === "run");

  const handleSelectAgent = useCallback(
    (agent: string) => {
      // Pin the agent on click
      if (agent === state.selectedAgent && state.agentMode === "pinned") {
        dispatchAction({ type: "agentClosed" });
      } else {
        dispatchAction({ type: "agentPinned", agent });
      }
    },
    [state.selectedAgent, state.agentMode, dispatchAction],
  );

  const handleOpenArtifact = useCallback(
    (name: string) => {
      if (state.selectedArtifact === name) return;
      dispatchAction({ type: "artifactSelected", name });
    },
    [state.selectedArtifact, dispatchAction],
  );

  const handleCloseArtifact = useCallback(() => {
    dispatchAction({ type: "artifactClosed" });
  }, [dispatchAction]);

  useEffect(() => {
    if (
      state.agentMode === "auto" &&
      snap?.run?.activeAgent &&
      state.selectedAgent !== snap.run.activeAgent
    ) {
      dispatchAction({ type: "agentPinned", agent: snap.run.activeAgent });
    }
  }, [state.agentMode, snap?.run?.activeAgent, state.selectedAgent, dispatchAction]);

  return (
    <div className="shell">
      <a href="#overview" className="skip-link">
        Skip to current activity
      </a>

      <Header
        snapshot={snap}
        connection={state.connection}
        runs={state.runs}
        selectedRunId={state.selectedRunId}
        elapsedText={elapsedText}
        dispatch={dispatchAction}
      />

      <nav className="view-tabs" aria-label="Dashboard views">
        <button type="button" className={state.view === "run" ? "active" : ""} onClick={() => dispatchAction({ type: "viewSelected", view: "run" })}>Run</button>
        <button type="button" className={state.view === "agent-history" ? "active" : ""} onClick={() => dispatchAction({ type: "viewSelected", view: "agent-history" })}>Agent history</button>
      </nav>

      <nav
        id="section-nav"
        aria-label="Dashboard sections"
        hidden={!hasRun || state.view !== "run"}
      >
        {["overview", "agents", "timeline", "artifacts"].map((section) => (
          <a
            key={section}
            href={`#${section}`}
            className="section-link"
            aria-current={
              currentSection === section ? "location" : undefined
            }
          >
            {section.charAt(0).toUpperCase() + section.slice(1)}
          </a>
        ))}
      </nav>

      {state.view === "run" ? <main>
        <section id="overview" aria-label="Current overview" tabIndex={-1}>
          <Callout
            snapshot={snap}
            onOpenArtifact={handleOpenArtifact}
          />
          <PhaseRail run={snap?.run ?? null} />

          <div className="overview-grid">
            <Overview
              snapshot={snap}
              onSelectAgent={handleSelectAgent}
            />
          </div>
        </section>

        <section id="agents" aria-label="Agents" tabIndex={-1}>
          <h2 className="section-heading">Agents</h2>
          <div className="agents-layout">
            <AgentGrid
              agents={snap?.agents ?? []}
              selectedAgent={state.selectedAgent}
              onSelectAgent={handleSelectAgent}
            />
            <AgentInspector
              snapshot={snap}
              runId={state.selectedRunId}
              selectedAgent={state.selectedAgent}
              agentMode={state.agentMode}
              selectedInvocation={state.selectedInvocation}
              inspectorTab={state.inspectorTab}
              transcriptQuery={state.transcriptQuery}
              selectedDiffFile={state.selectedDiffFile}
              dispatch={dispatchAction}
              onOpenArtifact={handleOpenArtifact}
            />
          </div>
        </section>

        <section id="timeline" aria-label="Timeline" tabIndex={-1}>
          <h2 className="section-heading">Timeline</h2>
          <Timeline
            steps={snap?.recentSteps ?? []}
            onOpenArtifact={handleOpenArtifact}
          />
        </section>

        <section id="artifacts" aria-label="Artifacts" tabIndex={-1}>
          <ArtifactViewer
            snapshot={snap}
            selectedArtifact={state.selectedArtifact}
            runId={state.selectedRunId}
            onCloseArtifact={handleCloseArtifact}
            onOpenArtifact={handleOpenArtifact}
          />
        </section>
      </main> : <main>
        <AgentHistory
          runId={state.selectedRunId ?? snap?.run?.id ?? null}
          revision={snap?.run?.transcriptRevision}
        />
      </main>}
    </div>
  );
}
