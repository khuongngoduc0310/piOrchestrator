import type { AgentSummary } from "../../dashboard-types.js";

interface AgentGridProps {
  agents: AgentSummary[];
  selectedAgent: string | null;
  onSelectAgent: (name: string) => void;
}

export function AgentGrid({ agents, selectedAgent, onSelectAgent }: AgentGridProps) {
  return (
    <div id="agent-grid" className="agent-grid" role="group">
      {agents.map((agent) => {
        const statusClass = agent.status === "succeeded"
          ? "succeeded"
          : agent.status === "running"
            ? "running"
            : agent.status === "failed"
              ? "failed"
              : agent.status === "cancelled"
                ? "cancelled"
                : "idle";
        const isSelected = agent.name === selectedAgent;

        return (
          <button
            key={agent.name}
            type="button"
            className={`agent-card${isSelected ? " selected" : ""}`}
            data-agent={agent.name}
            aria-pressed={isSelected}
            onClick={() => onSelectAgent(agent.name)}
          >
            <span className="agent-name">
              <span className={`status-dot ${statusClass}`} aria-hidden="true" />
              {agent.name}
            </span>
            <span className="muted">{agent.model ?? ""}</span>
            <br />
            {statusLabel(agent.status)}
            {agent.summary && (
              <>
                <br />
                <span className="agent-summary">{trunc(agent.summary, 80)}</span>
              </>
            )}
            {agent.error && (
              <>
                <br />
                <span className="error-text">{trunc(agent.error, 80)}</span>
              </>
            )}
          </button>
        );
      })}
    </div>
  );
}

function statusLabel(s: AgentSummary["status"]): string {
  switch (s) {
    case "succeeded":
      return "✓ Succeeded";
    case "running":
      return "→ Running";
    case "failed":
      return "! Failed";
    case "cancelled":
      return "— Cancelled";
    default:
      return "● Idle";
  }
}

function trunc(v: string | null | undefined, m: number): string {
  if (!v) return "";
  return v.length <= m ? v : v.slice(0, m - 1) + "…";
}
