import { useEffect, useRef, useState } from "react";
import type { OrchestratorViewModel } from "../../dashboard-types.js";

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) {
    const h = Math.floor(m / 60);
    return `${h}h${String(m % 60).padStart(2, "0")}m`;
  }
  return `${m}:${String(sec).padStart(2, "0")}`;
}

export function useElapsedTime(snapshot: OrchestratorViewModel | null): string {
  const [text, setText] = useState("");
  const baseRef = useRef(0);
  const atRef = useRef(0);

  useEffect(() => {
    const run = snapshot?.run;
    if (!run || run.runStatus !== "running") {
      setText("");
      return;
    }
    baseRef.current = run.elapsedMs;
    atRef.current = Date.now();
    setText(formatElapsed(run.elapsedMs));

    const id = setInterval(() => {
      const mode = snapshot?.mode;
      if (mode !== "running" && mode !== "waiting") {
        clearInterval(id);
        return;
      }
      setText(formatElapsed(baseRef.current + (Date.now() - atRef.current)));
    }, 1000);

    return () => clearInterval(id);
  }, [snapshot?.run?.id, snapshot?.run?.elapsedMs, snapshot?.run?.runStatus, snapshot?.mode]);

  return text;
}
