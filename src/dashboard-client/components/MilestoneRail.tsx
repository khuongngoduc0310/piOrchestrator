import React from "react";
import type { WorkflowMilestone } from "../../workflow-types.js";

interface MilestoneRailProps {
  milestones: WorkflowMilestone[];
  selectedId: string | null;
  onSelect: (milestone: WorkflowMilestone) => void;
}

export function MilestoneRail({ milestones, selectedId, onSelect }: MilestoneRailProps) {
  return <section className="milestone-section" aria-labelledby="milestone-heading">
    <div className="section-title-row"><div><div className="section-kicker">DURABLE EVENTS</div><h2 id="milestone-heading">Milestones</h2></div><span className="count-label">{milestones.length}</span></div>
    {milestones.length === 0 ? <p className="muted">No milestones recorded.</p> : <ol className="milestone-rail">
      {[...milestones].reverse().map(milestone => <li key={milestone.id}>
        <button type="button" className={selectedId === milestone.id ? "selected" : ""} aria-pressed={selectedId === milestone.id} onClick={() => onSelect(milestone)} data-milestone-id={milestone.id}>
          <time>{milestone.occurredAt.slice(11, 19)}</time><span><strong>{milestone.title}</strong><small>{milestone.kind}</small></span>
        </button>
      </li>)}
    </ol>}
  </section>;
}
