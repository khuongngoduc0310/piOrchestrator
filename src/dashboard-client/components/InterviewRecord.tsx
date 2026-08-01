import React from "react";
import type { DashboardInterviewQAndA } from "../../dashboard-types.js";

export interface InterviewRecordProps {
  qa: DashboardInterviewQAndA[];
}

export function InterviewRecord({ qa }: InterviewRecordProps) {
  const groups = groupByRound(qa);
  return (
    <section className="interview-record-section" aria-labelledby="interview-record-heading">
      <div className="section-title-row">
        <div>
          <div className="section-kicker">INTERVIEW RECORD</div>
          <h2 id="interview-record-heading">Answered questions</h2>
        </div>
        <span className="count-label">{qa.length}</span>
      </div>
      {qa.length === 0 ? (
        <span className="muted" style={{ fontSize: ".85em" }}>
          No answers yet — questions appear here as you answer them.
        </span>
      ) : (
        groups.map(([round, entries]) => (
          <div key={round} className="qa-round">
            <h3 className="qa-round-heading">Round {round}</h3>
            <div className="interview-record-list">
              {entries.map((entry, index) => (
                <QaEntry key={`${round}:${index}`} entry={entry} />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function QaEntry({ entry }: { entry: DashboardInterviewQAndA }) {
  return (
    <div className="qa-entry">
      <div className="qa-question-row">
        <span className="qa-question">{entry.questionText}</span>
        {entry.kind === "multiple" && <span className="qa-kind">multi-select</span>}
      </div>
      {entry.options.length > 0 ? (
        <ul className="qa-options">
          {entry.options.map(option => (
            <li
              key={option.id}
              className={`qa-option${option.picked ? " picked" : ""}`}
            >
              <span className="qa-option-text">{option.text}</span>
              {option.recommended && <span className="qa-option-recommended">recommended</span>}
            </li>
          ))}
        </ul>
      ) : (
        <div className="qa-answer">
          {entry.answerText.length > 0 ? (
            <span>{entry.answerText}</span>
          ) : (
            <span>custom answer</span>
          )}
        </div>
      )}
      {entry.customText !== undefined && (
        <div className="qa-custom-answer">Custom answer: {entry.customText}</div>
      )}
    </div>
  );
}

function groupByRound(qa: DashboardInterviewQAndA[]): Array<[number, DashboardInterviewQAndA[]]> {
  const groups = new Map<number, DashboardInterviewQAndA[]>();
  for (const entry of qa) {
    const group = groups.get(entry.round);
    if (group) {
      group.push(entry);
    } else {
      groups.set(entry.round, [entry]);
    }
  }
  return [...groups.entries()].sort(([a], [b]) => a - b);
}
