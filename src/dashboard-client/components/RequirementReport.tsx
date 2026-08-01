import React from "react";
import type { RequirementsSummary } from "../../dashboard-types.js";

export interface RequirementReportProps {
  requirement: RequirementsSummary;
}

export function RequirementReport({ requirement }: RequirementReportProps) {
  return (
    <section className="requirement-report-section" aria-labelledby="requirement-report-heading">
      <div className="section-title-row">
        <div>
          <div className="section-kicker">REQUIREMENTS</div>
          <h2 id="requirement-report-heading">Requirement</h2>
        </div>
      </div>
      <div className="requirement-goal">{requirement.goal}</div>
      {requirement.summary.length > 0 && (
        <p className="requirement-summary">{requirement.summary}</p>
      )}
      <RequirementList label="Scope" items={requirement.scope} />
      <RequirementList label="Constraints" items={requirement.constraints} />
      <RequirementList label="Acceptance criteria" items={requirement.acceptanceCriteria} />
      <RequirementList label="Open questions" items={requirement.openQuestions} emptyText="None" />
    </section>
  );
}

function RequirementList({ label, items, emptyText }: { label: string; items: string[]; emptyText?: string }) {
  return (
    <div className="requirement-list">
      <h3 className="requirement-list-label">{label}</h3>
      {items.length === 0 ? (
        <span className="muted" style={{ fontSize: ".85em" }}>{emptyText ?? ""}</span>
      ) : (
        <ul>
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
