import { useEffect, useRef, useState } from "react";
import { getDiff } from "../api.js";
import type { InvocationDiffView } from "../../dashboard-types.js";

interface DiffViewerProps {
  runId: string;
  stepId: string;
  sequence: number;
  selectedDiffFile: number;
  onSelectDiffFile: (index: number) => void;
}

export function DiffViewer({
  runId,
  stepId,
  sequence,
  selectedDiffFile,
  onSelectDiffFile,
}: DiffViewerProps) {
  const [data, setData] = useState<InvocationDiffView | null>(null);
  const [error, setError] = useState(false);
  const reqRef = useRef(0);

  useEffect(() => {
    const req = ++reqRef.current;
    setData(null);
    setError(false);
    getDiff(runId, stepId, sequence)
      .then((result) => {
        if (req === reqRef.current) setData(result);
      })
      .catch(() => {
        if (req === reqRef.current) setError(true);
      });
  }, [runId, stepId, sequence]);

  if (error) {
    return (
      <div className="empty-state">
        File diff is not available for this invocation
      </div>
    );
  }

  if (!data) {
    return <div className="empty-state">Loading…</div>;
  }

  const metadata = data.metadata ?? {};

  if (metadata.status !== "available") {
    return (
      <div className="empty-state">
        {metadata.unavailableReason ?? "Textual diff is unavailable"}
      </div>
    );
  }

  if (data.patchTruncated) {
    // Show truncation note via the component below
  }

  const files = metadata.files ?? [];
  if (files.length === 0) {
    return (
      <div className="empty-state">
        No file changes in this invocation
      </div>
    );
  }

  const actualIndex =
    selectedDiffFile >= files.length ? 0 : selectedDiffFile;

  const sections = patchSections(data.patch ?? "");

  return (
    <>
      {data.patchTruncated && (
        <div className="transcript-note">
          Patch preview was truncated. The persisted artifact remains
          authoritative.
        </div>
      )}
      <div className="diff-layout">
        <div className="diff-files">
          {files.map((file, index) => (
            <button
              key={index}
              type="button"
              className={`diff-file${index === actualIndex ? " selected" : ""}`}
              onClick={() => onSelectDiffFile(index)}
            >
              {file.status} {diffPath(file)}
            </button>
          ))}
        </div>
        <div className="unified-diff" aria-label="Unified diff">
          {renderFileDiff(files[actualIndex], sections[actualIndex] ?? "")}
        </div>
      </div>
    </>
  );
}

function diffPath(file: InvocationDiffView["metadata"]["files"][number]): string {
  return file.status === "D"
    ? file.oldPath ?? ""
    : file.newPath ?? file.oldPath ?? "";
}

function patchSections(patch: string): string[] {
  const sections: string[] = [];
  let current: string[] = [];
  const lines = patch.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ") && current.length > 0) {
      sections.push(current.join("\n"));
      current = [];
    }
    current.push(line);
  }
  if (current.length > 0 && current.some((l) => l.length > 0)) {
    sections.push(current.join("\n"));
  }
  return sections;
}

function renderFileDiff(
  file: InvocationDiffView["metadata"]["files"][number],
  section: string,
) {
  if (file.binary) {
    return (
      <span className="diff-line meta">
        Binary change · {file.status} · {diffPath(file)}
      </span>
    );
  }

  if (!section) {
    return (
      <span className="diff-line meta">
        No textual patch for {diffPath(file)}
      </span>
    );
  }

  const lines = section.split("\n");
  return lines.map((line, i) => {
    let cls = "diff-line";
    if (line.startsWith("@@")) {
      cls += " hunk";
    } else if (line.startsWith("+") && !line.startsWith("+++")) {
      cls += " add";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cls += " del";
    } else if (
      line.startsWith("diff --git") ||
      line.startsWith("index ") ||
      line.startsWith("---") ||
      line.startsWith("+++")
    ) {
      cls += " meta";
    }
    return (
      <span key={i} className={cls}>
        {line}
        {"\n"}
      </span>
    );
  });
}
