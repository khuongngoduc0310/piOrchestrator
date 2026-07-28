import React from "react";
import type { WorkflowMilestone } from "../../workflow-types.js";
import { MarkdownPreview } from "./MarkdownPreview.js";

export function MilestoneInspector({ milestone }: { milestone: WorkflowMilestone }) {
  return <article className="milestone-document" data-inspected-milestone={milestone.id}>
    <time>{milestone.occurredAt.replace("T", " ").slice(0, 19)}</time>
    <h3>{milestone.title}</h3>
    <MarkdownPreview markdown={milestone.details} />
  </article>;
}
