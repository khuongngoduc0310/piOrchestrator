import React, { useState } from "react";
import type { OrchestratorViewModel } from "../../dashboard-types.js";

export function LiveConsole({ snapshot }: { snapshot: OrchestratorViewModel | null }) {
  const [open, setOpen] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const run = snapshot?.run;
  return <section className={`live-console${open ? " open" : ""}`} aria-label="Live output console">
    <div className="console-bar"><button type="button" aria-expanded={open} onClick={() => setOpen(value => !value)}><span aria-hidden="true">&gt;_</span> LIVE OUTPUT <span className="console-count">{run?.agentOutput?.length ?? 0} lines</span></button>{open && <label><input type="checkbox" checked={showTools} onChange={event => setShowTools(event.target.checked)} /> Show tool activity</label>}</div>
    {open && <div className="console-output" role="log" aria-live="polite">{showTools && run?.currentTool && <div className="console-tool">tool / {run.currentTool} {run.currentToolArgs ?? ""}</div>}{run?.agentOutput?.length ? run.agentOutput.map((line, index) => <div key={index}><span>{String(index + 1).padStart(3, "0")}</span> {line}</div>) : <div className="muted">No live output captured.</div>}</div>}
  </section>;
}
