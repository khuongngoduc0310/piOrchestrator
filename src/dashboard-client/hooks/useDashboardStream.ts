import { useEffect, useRef } from "react";
import type { OrchestratorViewModel } from "../../dashboard-types.js";
import { getCurrentState, listRuns } from "../api.js";
import type { DashboardAction } from "../state.js";

export function useDashboardStream(dispatch: React.Dispatch<DashboardAction>): void {
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRunStatusRef = useRef("");

  useEffect(() => {
    let cancelled = false;

    getCurrentState()
      .then((data) => {
        if (cancelled) return;
        if (data) {
          dispatch({ type: "liveSnapshotReceived", snapshot: data });
          if (data.run?.id) {
            dispatch({ type: "runSelected", runId: data.run.id });
          }
        }
        return listRuns();
      })
      .then((runs) => {
        if (!cancelled && runs) {
          dispatch({ type: "runsLoaded", runs });
        }
      })
      .catch(() => {});

    const es = new EventSource("/events");

    es.onopen = () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      dispatch({ type: "connectionChanged", connection: "live" });
    };

    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as OrchestratorViewModel;
        if (!data) return;
        const key = data.run ? `${data.run.id}:${data.run.runStatus}` : "";
        dispatch({ type: "liveSnapshotReceived", snapshot: data });
        if (key && key !== lastRunStatusRef.current) {
          lastRunStatusRef.current = key;
          listRuns().then((runs) => {
            dispatch({ type: "runsLoaded", runs });
          }).catch(() => {});
        }
      } catch {
      }
    };

    es.onerror = () => {
      dispatch({ type: "connectionChanged", connection: "reconnecting" });
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = setTimeout(() => {
        dispatch({ type: "connectionChanged", connection: "disconnected" });
      }, 30000);
    };

    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      es.close();
    };
  }, [dispatch]);
}
