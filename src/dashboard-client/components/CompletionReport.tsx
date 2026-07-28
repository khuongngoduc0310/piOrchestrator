import React, { useEffect, useState } from "react";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { getArtifact } from "../api.js";
import { MarkdownPreview } from "./MarkdownPreview.js";

interface CompletionReportProps {
  snapshot: OrchestratorViewModel | null;
  runId: string | null;
  onConsole: () => void;
  onArtifacts: () => void;
  onHistory: () => void;
}

export function CompletionReport({ snapshot, runId, onConsole, onArtifacts, onHistory }: CompletionReportProps) {
  const milestone = snapshot?.milestones?.find(item => item.id === "workflow-completed") ?? snapshot?.milestones?.find(item => item.kind === "completed");
  const [summary, setSummary] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    setSummary(null);
    setCopied(false);
    if (!runId) return;
    const controller = new AbortController();
    getArtifact(runId, "completion-summary.json", controller.signal).then(result => {
      try { setSummary(formatSummary(JSON.parse(result.text) as unknown)); }
      catch { setSummary(result.text); }
    }).catch(() => { if (!controller.signal.aborted) setSummary(null); });
    return () => controller.abort();
  }, [runId]);
  const content = milestone?.details ?? summary ?? snapshot?.run?.message ?? "The workflow completed without a persisted summary.";
  return <main id="mission-main" className="report-view" aria-labelledby="report-heading" tabIndex={-1}>
    <div className="report-signal" aria-hidden="true">COMPLETE</div>
    <header><div className="section-kicker">MISSION REPORT / {runId?.slice(0, 8)}</div><h1 id="report-heading">Workflow completed</h1><p>{snapshot?.run?.request}</p></header>
    <article className="report-document"><MarkdownPreview markdown={content} /></article>
    <div className="report-actions" aria-label="Report actions">
      <button type="button" onClick={onConsole}>Back to workspace and console</button>
      <button type="button" onClick={onArtifacts}>Inspect artifacts / diff</button>
      <button type="button" onClick={onHistory}>Inspect agent history</button>
      <button type="button" onClick={() => navigator.clipboard?.writeText(content).then(() => setCopied(true)).catch(() => {})}>{copied ? "Summary copied" : "Copy summary"}</button>
    </div>
  </main>;
}

function formatSummary(value: unknown): string {
  if (!value || typeof value !== "object") return String(value ?? "");
  const entries = Object.entries(value as Record<string, unknown>);
  return entries.map(([key, item]) => `## ${title(key)}\n\n${typeof item === "string" ? item : `\`${JSON.stringify(item, null, 2)}\``}`).join("\n\n");
}

function title(value: string) { return value.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/[-_]/g, " ").replace(/^./, char => char.toUpperCase()); }
