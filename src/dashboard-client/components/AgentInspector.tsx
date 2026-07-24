import { useCallback, useEffect, useRef, useState } from "react";
import type {
  AgentSummary,
  OrchestratorViewModel,
} from "../../dashboard-types.js";
import { getAgentInspection } from "../api.js";
import type { AgentInspection } from "../../dashboard-types.js";
import type {
  AgentMode,
  DashboardAction,
} from "../state.js";
import { TranscriptViewer } from "./TranscriptViewer.js";
import { DiffViewer } from "./DiffViewer.js";

interface AgentInspectorProps {
  snapshot: OrchestratorViewModel | null;
  runId: string | null;
  selectedAgent: string | null;
  agentMode: AgentMode;
  selectedInvocation: string | null;
  inspectorTab: "transcript" | "files";
  transcriptQuery: string;
  selectedDiffFile: number;
  dispatch: React.Dispatch<DashboardAction>;
  onOpenArtifact: (name: string) => void;
}

interface FlattenedInvocation {
  stepId: string;
  label: string;
  sequence: number;
  key: string;
  mode: string;
  status: string;
  changedFileCount?: number;
}

export function AgentInspector({
  snapshot,
  runId,
  selectedAgent,
  agentMode,
  selectedInvocation,
  inspectorTab,
  transcriptQuery,
  selectedDiffFile,
  dispatch,
  onOpenArtifact,
}: AgentInspectorProps) {
  const [inspection, setInspection] = useState<AgentInspection | null>(null);
  const [loading, setLoading] = useState(false);
  const [invocations, setInvocations] = useState<FlattenedInvocation[]>([]);
  const reqRef = useRef(0);
  const selectedItem = invocations.find(item => item.key === selectedInvocation) ?? null;

  const agents = snapshot?.agents ?? [];
  const summary = agents.find((a) => a.name === selectedAgent);

  useEffect(() => {
    if (!selectedAgent || !runId || agentMode === "closed") {
      reqRef.current += 1;
      setInspection(null);
      setInvocations([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    const req = ++reqRef.current;
    setInspection(null);
    setInvocations([]);
    setLoading(true);
    getAgentInspection(runId, selectedAgent, controller.signal)
      .then((data) => {
        if (req === reqRef.current) {
          setInspection(data);
          setLoading(false);
          if (data) {
            const flat: FlattenedInvocation[] = [];
            for (const step of data.steps ?? []) {
              for (const inv of step.invocations ?? []) {
                flat.push({
                  stepId: step.id,
                  label: step.label,
                  sequence: inv.sequence,
                  key: `${step.id}:${inv.sequence}`,
                  mode: inv.mode,
                  status: inv.status,
                  changedFileCount: inv.changedFileCount,
                });
              }
            }
            setInvocations(flat);
          } else {
            setInvocations([]);
          }
        }
      })
      .catch(() => {
        if (req === reqRef.current && !controller.signal.aborted) {
          setLoading(false);
          setInspection(null);
          setInvocations([]);
        }
      });
    return () => controller.abort();
  }, [runId, selectedAgent, agentMode, summary?.invocationCount, summary?.status]);

  const handleClose = useCallback(() => {
    dispatch({ type: "agentClosed" });
  }, [dispatch]);

  const handleAutoFollow = useCallback(() => {
    dispatch({ type: "agentAutoFollowed", agent: snapshot?.run?.activeAgent ?? null });
  }, [dispatch, snapshot?.run?.activeAgent]);

  const handleSelectInvocation = useCallback(
    (item: FlattenedInvocation) => {
      dispatch({ type: "invocationSelected", key: item.key });
    },
    [dispatch],
  );

  const handleSelectTab = useCallback(
    (tab: "transcript" | "files") => {
      dispatch({ type: "inspectorTabSelected", tab });
    },
    [dispatch],
  );

  if (!selectedAgent || agentMode === "closed") return null;

  return (
    <div id="agent-inspector" className="agent-inspector panel">
      {loading && !inspection && (
        <div className="empty-state">
          <p>Loading agent history…</p>
        </div>
      )}

      {!loading && !inspection && (
        <div className="empty-state">
          <p>No agent history available</p>
        </div>
      )}

      {inspection && (
        <>
          <div
            className="closable-header"
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: 8,
            }}
          >
            <h3>
              {inspection.name}{" "}
              <span className="muted">{inspection.status}</span>
            </h3>
            <div className="inspector-controls">
              <button
                type="button"
                className="close-btn"
                onClick={handleAutoFollow}
              >
                {agentMode === "auto" ? "Following active" : "Auto follow"}
              </button>
              <button
                type="button"
                className="close-btn"
                onClick={handleClose}
              >
                Close
              </button>
            </div>
          </div>

          {inspection.model && (
            <div className="meta">Model: {inspection.model}</div>
          )}
          {inspection.startedAt && (
            <div className="meta">
              Started: {inspection.startedAt.slice(0, 19).replace("T", " ")}
            </div>
          )}
          {inspection.completedAt && (
            <div className="meta">
              Completed:{" "}
              {inspection.completedAt.slice(0, 19).replace("T", " ")}
            </div>
          )}
          {inspection.summary && (
            <p className="meta">{inspection.summary}</p>
          )}
          {inspection.error && (
            <p className="error-text">{inspection.error}</p>
          )}
          {inspection.currentTool && (
            <div className="tool-row">
              Tool: {inspection.currentTool}
              {inspection.currentToolArgs
                ? ` · ${inspection.currentToolArgs.slice(0, 120)}`
                : ""}
            </div>
          )}

          {invocations.length > 0 && (
            <>
              <div className="meta">Conversation history</div>
              <div
                className="invocation-list"
                aria-label="Agent invocations"
              >
                {invocations.map((item) => {
                  const fileInfo =
                    item.changedFileCount === undefined
                      ? ""
                      : ` · ${item.changedFileCount} files`;
                  const selected = item.key === selectedInvocation;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      className={`invocation-btn${selected ? " selected" : ""}`}
                      title={item.status}
                      onClick={() => handleSelectInvocation(item)}
                    >
                      {item.label} · {item.mode.replace("_", " ")} #
                      {item.sequence}
                      {fileInfo}
                    </button>
                  );
                })}
              </div>

              {selectedItem && (
                <InvocationPanel
                  key={selectedItem.key}
                  runId={runId!}
                  item={selectedItem}
                  inspectorTab={inspectorTab}
                  transcriptQuery={transcriptQuery}
                  selectedDiffFile={selectedDiffFile}
                  dispatch={dispatch}
                  onSelectTab={handleSelectTab}
                />
              )}
            </>
          )}

          {invocations.length === 0 && (
            <div className="empty-state">
              No invocations captured for this agent
            </div>
          )}

          {inspection.steps && inspection.steps.length > 0 && (
            <details>
              <summary>Steps ({inspection.steps.length})</summary>
              <ul className="step-list">
                {inspection.steps.map((step) => (
                  <li key={step.id}>
                    {step.startedAt
                      ? step.startedAt.slice(11, 19) + " "
                      : ""}
                    {step.label}
                    {step.message ? ` · ${step.message}` : ""}
                    {step.artifact && (
                      <ArtifactBtn name={step.artifact} onOpen={onOpenArtifact} />
                    )}
                    {step.rawArtifact && (
                      <ArtifactBtn name={step.rawArtifact} onOpen={onOpenArtifact} />
                    )}
                    {step.mutationArtifact && (
                      <ArtifactBtn name={step.mutationArtifact} onOpen={onOpenArtifact} />
                    )}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </div>
  );
}

function ArtifactBtn({
  name,
  onOpen,
}: {
  name: string;
  onOpen: (name: string) => void;
}) {
  return (
    <button
      type="button"
      className="artifact-btn"
      data-artifact={name}
      style={{ marginLeft: 6 }}
      onClick={() => onOpen(name)}
    >
      {name}
    </button>
  );
}

function InvocationPanel({
  runId,
  item,
  inspectorTab,
  transcriptQuery,
  selectedDiffFile,
  dispatch,
  onSelectTab,
}: {
  runId: string;
  item: FlattenedInvocation;
  inspectorTab: "transcript" | "files";
  transcriptQuery: string;
  selectedDiffFile: number;
  dispatch: React.Dispatch<DashboardAction>;
  onSelectTab: (tab: "transcript" | "files") => void;
}) {
  return (
    <div id="invocation-panel">
      <div className="inspector-controls">
        <div className="inspector-tabs">
          <button
            type="button"
            className={`close-btn inspector-tab${inspectorTab === "transcript" ? " active" : ""}`}
            onClick={() => onSelectTab("transcript")}
          >
            Transcript
          </button>
          <button
            type="button"
            className={`close-btn inspector-tab${inspectorTab === "files" ? " active" : ""}`}
            onClick={() => onSelectTab("files")}
          >
            Files
            {item.changedFileCount !== undefined
              ? ` (${item.changedFileCount})`
              : ""}
          </button>
        </div>
        {inspectorTab === "transcript" && (
          <input
            className="transcript-search"
            type="search"
            placeholder="Search transcript"
            aria-label="Search transcript"
            value={transcriptQuery}
            onChange={(e) =>
              dispatch({ type: "transcriptQueryChanged", query: e.target.value })
            }
          />
        )}
      </div>

      <div id="invocation-content">
        {inspectorTab === "transcript" ? (
          <TranscriptViewer
            runId={runId}
            stepId={item.stepId}
            sequence={item.sequence}
            query={transcriptQuery}
          />
        ) : (
          <DiffViewer
            runId={runId}
            stepId={item.stepId}
            sequence={item.sequence}
            selectedDiffFile={selectedDiffFile}
            onSelectDiffFile={(index) =>
              dispatch({ type: "diffFileSelected", index })
            }
          />
        )}
      </div>
    </div>
  );
}
