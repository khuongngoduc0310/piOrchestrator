import { useCallback, useEffect, useReducer, useRef } from "react";
import { dashboardReducer, INITIAL_STATE, isViewingLiveRun } from "./state.js";
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
import { DecisionPanel } from "./components/DecisionPanel.js";
import { getDecisionPreview, submitDecision } from "./api.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";

export function App() {
  const [state, dispatch] = useReducer(dashboardReducer, INITIAL_STATE);
  const dispatchAction = dispatch as React.Dispatch<DashboardAction>;
  const abortRef = useRef<AbortController | null>(null);

  useDashboardStream(dispatchAction);

  const snap = state.displayedSnapshot ?? state.liveSnapshot;
  const displayedRunId = state.selectedRunId ?? snap?.run?.id ?? null;
  const hasRun = Boolean(snap?.run);
  const elapsedText = useElapsedTime(snap);
  const currentSection = useSectionNavigation(hasRun && state.view === "run");

  const handleSelectAgent = useCallback(
    (agent: string) => {
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

  // Fetch preview when a new decision enters loading state
  useEffect(() => {
    if (state.previewStatus !== "loading" || !state.currentDecisionId || !state.pendingDecision?.dashboardAvailable) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    const id = state.currentDecisionId;
    getDecisionPreview(id, ac.signal)
      .then((result) => {
        if (ac.signal.aborted) return;
        dispatchAction({
          type: "planPreviewLoaded",
          decisionId: id,
          markdown: result.content,
          actions: result.actions,
        });
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        const msg = err instanceof Error ? err.message : "Failed to load preview";
        dispatchAction({ type: "planPreviewError", decisionId: id, error: msg });
      });
    return () => { ac.abort(); };
  }, [state.previewStatus, state.currentDecisionId, state.pendingDecision?.dashboardAvailable, dispatchAction]);

  const handleRetryPreview = useCallback(() => {
    if (!state.currentDecisionId) return;
    dispatchAction({ type: "planPreviewRetryRequested" });
  }, [state.currentDecisionId, dispatchAction]);

  const handleSubmitAction = useCallback(
    async (action: HumanDecisionAction, feedback?: string) => {
      if (!state.currentDecisionId) return;
      dispatchAction({ type: "decisionSubmitting" });
      try {
        await submitDecision(state.currentDecisionId, action, feedback);
        dispatchAction({ type: "decisionSubmitted" });
      } catch (err) {
        dispatchAction({
          type: "decisionError",
          error: err instanceof Error ? err.message : "Submission failed",
        });
      }
    },
    [state.currentDecisionId, dispatchAction],
  );

  const handleDismissError = useCallback(() => {
    dispatchAction({ type: "decisionDismissed" });
  }, [dispatchAction]);

  useEffect(() => {
    const activeAgent = snap?.run?.activeAgent ?? null;
    if (state.agentMode === "auto" && state.selectedAgent !== activeAgent) {
      dispatchAction({ type: "agentAutoSelected", agent: activeAgent });
    }
  }, [state.agentMode, snap?.run?.activeAgent, state.selectedAgent, dispatchAction]);

  const showOverlay =
    isViewingLiveRun(state) &&
    state.pendingDecision?.dashboardAvailable &&
    state.pendingDecision &&
    state.submissionStatus !== "submitted";

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
              runId={displayedRunId}
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
            steps={snap?.timelineSteps ?? snap?.recentSteps ?? []}
            milestones={snap?.milestones ?? []}
            onOpenArtifact={handleOpenArtifact}
          />
        </section>

        <section id="artifacts" aria-label="Artifacts" tabIndex={-1}>
          <ArtifactViewer
            snapshot={snap}
            selectedArtifact={state.selectedArtifact}
            runId={displayedRunId}
            onCloseArtifact={handleCloseArtifact}
            onOpenArtifact={handleOpenArtifact}
          />
        </section>
      </main> : <main>
        <AgentHistory
          runId={displayedRunId}
          revision={snap?.run?.transcriptRevision}
        />
      </main>}

      {showOverlay && (
        <div className="decision-overlay">
          <DecisionPanel
            decisionId={state.currentDecisionId!}
            kind={state.pendingDecision!.kind}
            label={state.pendingDecision!.label}
            planMarkdown={state.planMarkdown}
            allowedActions={state.allowedActions}
            previewStatus={state.previewStatus}
            previewError={state.previewError}
            submissionStatus={state.submissionStatus}
            submissionError={state.submissionError}
            onRetryPreview={handleRetryPreview}
            onSubmitAction={handleSubmitAction}
            onDismissError={handleDismissError}
          />
        </div>
      )}

      {isViewingLiveRun(state) && state.submissionStatus === "submitted" && (
        <div className="decision-overlay">
          <div className="panel decision-submitted">
            <div className="decision-submitted-icon">&#10003;</div>
            <h2>Decision submitted</h2>
            <p className="muted">
              The workflow will continue based on your decision.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
