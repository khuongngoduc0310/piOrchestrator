import { useCallback, useEffect, useRef, useState } from "react";
import { getArtifact, getRunState } from "../api.js";
import type { OrchestratorViewModel } from "../../dashboard-types.js";

interface ArtifactViewerProps {
  snapshot: OrchestratorViewModel | null;
  selectedArtifact: string | null;
  runId: string | null;
  onCloseArtifact: () => void;
  onOpenArtifact: (name: string) => void;
}

export function ArtifactViewer({
  snapshot,
  selectedArtifact,
  runId,
  onCloseArtifact,
}: ArtifactViewerProps) {
  if (!snapshot) return null;

  const run = snapshot.run;
  const recentSteps = snapshot.recentSteps ?? [];

  // Collect unique artifact names
  const names = new Map<string, true>();
  const list: string[] = [];
  for (const step of recentSteps) {
    addUnique(step.artifact, names, list);
    addUnique(step.rawArtifact, names, list);
    addUnique(step.mutationArtifact, names, list);
  }
  if (run?.failedArtifact && !names.has(run.failedArtifact)) {
    list.push(run.failedArtifact);
  }

  return (
    <>
      <h2 className="section-heading">Recent Artifacts</h2>
      <div id="artifact-list" className="artifact-list">
        {list.length === 0 ? (
          <span className="muted" style={{ fontSize: ".85em" }}>
            No artifacts yet
          </span>
        ) : (
          list.map((name) => (
            <ArtifactButton
              key={name}
              name={name}
              runId={runId}
              onOpenArtifact={onCloseArtifact}
            />
          ))
        )}
      </div>
      {selectedArtifact && runId && (
        <ArtifactContent
          key={`${runId}:${selectedArtifact}`}
          runId={runId}
          name={selectedArtifact}
          onClose={onCloseArtifact}
        />
      )}
    </>
  );
}

function addUnique(
  value: string | undefined | null,
  map: Map<string, true>,
  list: string[],
) {
  if (value && !map.has(value)) {
    map.set(value, true);
    list.push(value);
  }
}

function ArtifactButton({
  name,
  runId,
  onOpenArtifact,
}: {
  name: string;
  runId: string | null;
  onOpenArtifact: (name: string) => void;
}) {
  return (
    <button
      type="button"
      className="artifact-btn"
      data-artifact={name}
      onClick={() => runId && onOpenArtifact(name)}
    >
      {name}
    </button>
  );
}

function ArtifactContent({
  runId,
  name,
  onClose,
}: {
  runId: string;
  name: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<{ text: string; size: number; truncated: boolean } | null>(null);
  const [error, setError] = useState(false);
  const [wrapped, setWrapped] = useState(true);
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    setData(null);
    setError(false);
    getArtifact(runId, name)
      .then((result) => {
        if (req === reqRef.current) {
          setData(result);
        }
      })
      .catch(() => {
        if (req === reqRef.current) {
          setError(true);
        }
      });
  }, [runId, name]);

  return (
    <div id="artifact-viewer" className="artifact-viewer panel">
      <div className="viewer-header">
        <h3>{name}</h3>
        <div>
          <button
            className="wrap-toggle"
            type="button"
            onClick={() => setWrapped((w) => !w)}
          >
            {wrapped ? "No wrap" : "Wrap"}
          </button>
          <button
            className="close-btn"
            style={{ marginLeft: 6 }}
            type="button"
            onClick={onClose}
          >
            Close
          </button>
        </div>
      </div>
      <div className="viewer-meta" id="artifact-meta">
        {data
          ? `Size: ${data.size} bytes${data.truncated ? " (truncated)" : ""}`
          : ""}
      </div>
      <pre
        id="artifact-content"
        style={{ whiteSpace: wrapped ? "pre-wrap" : "pre" }}
      >
        {error
          ? "(error loading artifact)"
          : data
            ? data.text
            : "Loading…"}
      </pre>
    </div>
  );
}
