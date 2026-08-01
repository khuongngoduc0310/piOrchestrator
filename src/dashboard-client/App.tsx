import React, { useEffect, useReducer, useRef, useState } from "react";
import type { WorkflowMilestone } from "../workflow-types.js";
import type { HumanDecisionAction } from "../orchestration/human-decision-types.js";
import { dashboardReducer, INITIAL_STATE, isSelectedLiveRun, isViewingLiveRun } from "./state.js";
import type { DashboardAction, DashboardView } from "./state.js";
import { useDashboardStream } from "./hooks/useDashboardStream.js";
import { useElapsedTime } from "./hooks/useElapsedTime.js";
import { getDecisionPreview, getRunState, submitDecision } from "./api.js";
import { isNarrowWorkspace } from "./workspace.js";
import { MissionHeader } from "./components/MissionHeader.js";
import { RunSidebar } from "./components/RunSidebar.js";
import { PhaseRail } from "./components/PhaseRail.js";
import { CurrentAgents } from "./components/CurrentAgents.js";
import { AgentGrid } from "./components/AgentGrid.js";
import { AgentInspector } from "./components/AgentInspector.js";
import { Timeline } from "./components/Timeline.js";
import { MilestoneRail } from "./components/MilestoneRail.js";
import { ArtifactViewer } from "./components/ArtifactViewer.js";
import { MilestoneInspector } from "./components/MilestoneInspector.js";
import { AgentHistory } from "./components/AgentHistory.js";
import { Callout } from "./components/Callout.js";
import { LiveConsole } from "./components/LiveConsole.js";
import { CommandPalette, type PaletteCommand } from "./components/CommandPalette.js";
import { CompletionReport } from "./components/CompletionReport.js";
import { DecisionPanel } from "./components/DecisionPanel.js";
import { InterviewDecisionPanel } from "./components/InterviewDecisionPanel.js";
import { InterviewSetPanel } from "./components/InterviewSetPanel.js";
import { InterviewRecord } from "./components/InterviewRecord.js";
import { RequirementReport } from "./components/RequirementReport.js";

export function App() {
  const [state, dispatch] = useReducer(dashboardReducer, INITIAL_STATE);
  const dispatchAction = dispatch as React.Dispatch<DashboardAction>;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && isNarrowWorkspace(window.innerWidth));
  const [selectedMilestone, setSelectedMilestone] = useState<WorkflowMilestone | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const submittingRef = useRef(false);

  useDashboardStream(dispatchAction);
  const liveRunId = state.liveSnapshot?.run?.id ?? null;
  const displayedRunId = state.displayedSnapshot?.run?.id ?? null;
  const snap = state.selectedRunId === null
    ? state.displayedSnapshot ?? state.liveSnapshot
    : displayedRunId === state.selectedRunId
      ? state.displayedSnapshot
      : liveRunId === state.selectedRunId
        ? state.liveSnapshot
        : null;
  const runId = state.selectedRunId ?? snap?.run?.id ?? null;
  const elapsedText = useElapsedTime(snap);
  const approvalActive = Boolean(isSelectedLiveRun(state) && state.pendingDecision?.dashboardAvailable && state.pendingDecision) ||
    (isSelectedLiveRun(state) && state.questionSet.length > 0);
  const agentHistoryStructureRevision = (snap?.agents ?? [])
    .map(agent => `${agent.name}:${agent.status}:${agent.invocationCount ?? 0}`)
    .join("|");

  useEffect(() => {
    function resize() { setNarrow(isNarrowWorkspace(window.innerWidth)); }
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, []);

  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        if (approvalActive) return;
        event.preventDefault();
        setPaletteOpen(open => !open);
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [approvalActive]);

  useEffect(() => {
    if (approvalActive) setPaletteOpen(false);
  }, [approvalActive]);

  useEffect(() => {
    setSelectedMilestone(null);
    setInspectorOpen(false);
  }, [runId]);

  useEffect(() => {
    if (state.previewStatus !== "loading" || !state.currentDecisionId || !state.pendingDecision?.dashboardAvailable) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const id = state.currentDecisionId;
    getDecisionPreview(id, controller.signal).then(result => {
      if (!controller.signal.aborted) dispatchAction({ type: "planPreviewLoaded", decisionId: id, markdown: result.content, actions: result.actions, question: result.question ?? null });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) dispatchAction({ type: "planPreviewError", decisionId: id, error: error instanceof Error ? error.message : "Failed to load preview" });
    });
    return () => controller.abort();
  }, [state.previewStatus, state.currentDecisionId, state.pendingDecision?.dashboardAvailable]);

  useEffect(() => {
    const active = snap?.run?.activeAgent ?? null;
    if (state.agentMode === "auto" && state.selectedAgent !== active) dispatchAction({ type: "agentAutoSelected", agent: active });
  }, [state.agentMode, state.selectedAgent, snap?.run?.activeAgent]);

  function selectAgent(agent: string) {
    dispatchAction(state.selectedAgent === agent && state.agentMode === "pinned" ? { type: "agentClosed" } : { type: "agentPinned", agent });
    setSelectedMilestone(null);
    setInspectorOpen(true);
  }

  function openArtifact(name: string) {
    dispatchAction({ type: "artifactSelected", name });
    setSelectedMilestone(null);
    setInspectorOpen(true);
  }

  function selectMilestone(milestone: WorkflowMilestone) {
    setSelectedMilestone(milestone);
    dispatchAction({ type: "artifactClosed" });
    setInspectorOpen(true);
  }

  function selectView(view: DashboardView) { dispatchAction({ type: "viewSelected", view }); }

  function selectRun(id: string) {
    if (state.liveSnapshot?.run?.id === id) {
      dispatchAction({ type: "displayLiveRun" });
      return;
    }
    dispatchAction({ type: "runSelected", runId: id });
    getRunState(id).then(snapshot => dispatchAction({ type: "historicalSnapshotLoaded", runId: id, snapshot })).catch(() => {});
  }

  async function submit(action: HumanDecisionAction, feedback?: string) {
    const decisionId = state.currentDecisionId;
    if (!decisionId || submittingRef.current) return;
    submittingRef.current = true;
    dispatchAction({ type: "decisionSubmitting" });
    try { await submitDecision(decisionId, action, feedback); dispatchAction({ type: "decisionSubmitted", decisionId }); }
    catch (error) { dispatchAction({ type: "decisionError", decisionId, error: error instanceof Error ? error.message : "Submission failed" }); }
    finally { submittingRef.current = false; }
  }

  async function submitQuestion(decisionId: string, action: HumanDecisionAction, feedback?: string) {
    if (submittingRef.current) return;
    submittingRef.current = true;
    dispatchAction({ type: "questionSubmitting", decisionId });
    try { await submitDecision(decisionId, action, feedback); dispatchAction({ type: "questionSubmitted", decisionId }); }
    catch (error) { dispatchAction({ type: "questionError", decisionId, error: error instanceof Error ? error.message : "Submission failed" }); }
    finally { submittingRef.current = false; }
  }

  const commands: PaletteCommand[] = [
    { id: "panel-workspace", label: "Open workspace", group: "Panel", run: () => selectView("run") },
    { id: "panel-history", label: "Open agent history", group: "Panel", run: () => selectView("agent-history") },
    ...(snap?.run?.runStatus === "completed" ? [{ id: "panel-report", label: "Open completion report", group: "Panel", run: () => selectView("report") } satisfies PaletteCommand] : []),
    ...state.runs.map(run => ({ id: `run-${run.id}`, label: `${run.route ?? "workflow"}: ${run.request}`, group: "Run", run: () => selectRun(run.id) })),
    ...(snap?.agents ?? []).map(agent => ({ id: `agent-${agent.name}`, label: `Inspect ${agent.name}`, group: "Agent", run: () => selectAgent(agent.name) })),
    { id: "action-runs", label: "Open run index", group: "Action", run: () => setSidebarOpen(true) },
    { id: "action-console", label: "Open live workspace", group: "Action", run: () => { dispatchAction({ type: "displayLiveRun" }); selectView("run"); } },
  ];

  const showDecision = isSelectedLiveRun(state) && state.pendingDecision?.dashboardAvailable && state.pendingDecision && state.submissionStatus !== "submitted";

  return <div className="mission-shell">
    <a href="#mission-main" className="skip-link">Skip to mission workspace</a>
    <MissionHeader snapshot={snap} connection={state.connection} elapsedText={elapsedText} view={state.view} onView={selectView} onOpenRuns={() => setSidebarOpen(true)} onOpenPalette={() => setPaletteOpen(true)} />
    <div className="mission-body">
      {(!narrow || sidebarOpen) && <RunSidebar runs={state.runs} selectedRunId={runId} open={sidebarOpen} dispatch={dispatchAction} onClose={() => setSidebarOpen(false)} />}
      {narrow && sidebarOpen && <button type="button" className="drawer-scrim" aria-label="Close run drawer" onClick={() => setSidebarOpen(false)} />}

      {state.view === "report" ? <CompletionReport key={runId} snapshot={snap} runId={runId} onConsole={() => selectView("run")} onArtifacts={() => { selectView("run"); setInspectorOpen(true); }} onHistory={() => selectView("agent-history")} /> : state.view === "agent-history" ? <main id="mission-main" className="workspace history-workspace" tabIndex={-1}><AgentHistory key={runId} runId={runId} revision={snap?.run?.transcriptRevision} structureRevision={agentHistoryStructureRevision} /></main> : <>
        <main id="mission-main" className="workspace" tabIndex={-1}>
          <Callout snapshot={snap} onOpenArtifact={openArtifact} />
          <PhaseRail run={snap?.run ?? null} />
          <CurrentAgents key={runId} snapshot={snap} runId={runId} onSelectAgent={selectAgent} />
          <section className="roster-section" aria-labelledby="roster-heading"><div className="section-title-row"><div><div className="section-kicker">TEAM STATUS</div><h2 id="roster-heading">Agent roster</h2></div><span className="count-label">{snap?.agents.length ?? 0}</span></div><AgentGrid agents={snap?.agents ?? []} selectedAgent={state.selectedAgent} onSelectAgent={selectAgent} /></section>
          <div className="event-columns">
            <section aria-labelledby="operations-heading"><div className="section-kicker">EPHEMERAL EXECUTION</div><h2 id="operations-heading">Operational steps</h2><Timeline steps={snap?.timelineSteps ?? snap?.recentSteps ?? []} onOpenArtifact={openArtifact} /></section>
            <MilestoneRail milestones={snap?.milestones ?? []} selectedId={selectedMilestone?.id ?? null} onSelect={selectMilestone} />
          </div>
          <section className="artifact-index" aria-label="Artifact index"><ArtifactViewer snapshot={snap} selectedArtifact={null} runId={runId} onCloseArtifact={() => {}} onOpenArtifact={openArtifact} /></section>
          {snap?.run?.requirement && <RequirementReport requirement={snap.run.requirement} />}
          {snap?.run?.qa !== undefined && <InterviewRecord qa={snap.run.qa} />}
        </main>
        {(!narrow || inspectorOpen) && <aside className={`context-inspector${inspectorOpen ? " open" : ""}`} aria-label="Context inspector">
          <div className="inspector-heading"><div><span className="section-kicker">CONTEXT DOCK</span><h2>{selectedMilestone ? "Milestone" : state.selectedArtifact ? "Artifact" : state.selectedAgent ? "Agent" : "Inspector"}</h2></div><button type="button" className="icon-btn" onClick={() => { setInspectorOpen(false); setSelectedMilestone(null); dispatchAction({ type: "artifactClosed" }); }} aria-label="Close inspector">x</button></div>
          {selectedMilestone ? <MilestoneInspector milestone={selectedMilestone} /> : state.selectedArtifact ? <ArtifactViewer snapshot={snap} selectedArtifact={state.selectedArtifact} runId={runId} onCloseArtifact={() => dispatchAction({ type: "artifactClosed" })} onOpenArtifact={openArtifact} /> : state.selectedAgent ? <AgentInspector snapshot={snap} runId={runId} selectedAgent={state.selectedAgent} agentMode={state.agentMode} selectedInvocation={state.selectedInvocation} inspectorTab={state.inspectorTab} transcriptQuery={state.transcriptQuery} selectedDiffFile={state.selectedDiffFile} dispatch={dispatchAction} onOpenArtifact={openArtifact} /> : <p className="empty-state">Select an agent, artifact, invocation, or milestone.</p>}
        </aside>}
        {narrow && inspectorOpen && <button type="button" className="inspector-scrim" aria-label="Close context inspector" onClick={() => setInspectorOpen(false)} />}
      </>}
    </div>
    {state.view === "run" && isViewingLiveRun(state) && <LiveConsole snapshot={snap} />}
    {!approvalActive && <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />}
    {isSelectedLiveRun(state) && state.questionSet.length > 0 && <InterviewSetPanel key={runId} runId={runId} questions={state.questionSet} focusIndex={state.questionFocusIndex} onFocus={(index) => dispatchAction({ type: "questionFocusMoved", index })} submissions={state.questionSubmissions} errors={state.questionErrors} onSubmitAction={submitQuestion} onDismissError={(decisionId) => dispatchAction({ type: "questionDismissed", decisionId })} />}
    {showDecision && <div className="decision-overlay">{state.pendingDecision!.kind === "requirements_question" ? <InterviewDecisionPanel key={state.currentDecisionId!} decisionId={state.currentDecisionId!} label={state.pendingDecision!.label} content={state.planMarkdown} question={state.decisionQuestion} allowedActions={state.allowedActions} previewStatus={state.previewStatus} previewError={state.previewError} submissionStatus={state.submissionStatus} submissionError={state.submissionError} currentDecisionId={state.currentDecisionId} onRetryPreview={() => dispatchAction({ type: "planPreviewRetryRequested" })} onSubmitAction={submit} onDismissError={() => dispatchAction({ type: "decisionDismissed" })} /> : <DecisionPanel key={state.currentDecisionId!} decisionId={state.currentDecisionId!} kind={state.pendingDecision!.kind} label={state.pendingDecision!.label} planMarkdown={state.planMarkdown} allowedActions={state.allowedActions} previewStatus={state.previewStatus} previewError={state.previewError} submissionStatus={state.submissionStatus} submissionError={state.submissionError} onRetryPreview={() => dispatchAction({ type: "planPreviewRetryRequested" })} onSubmitAction={submit} onDismissError={() => dispatchAction({ type: "decisionDismissed" })} />}</div>}
    {isSelectedLiveRun(state) && state.submissionStatus === "submitted" && <div className="decision-overlay"><div className="decision-submitted" role="status"><strong>Decision submitted</strong><p>The server accepted the decision. Waiting for workflow continuation.</p></div></div>}
  </div>;
}
