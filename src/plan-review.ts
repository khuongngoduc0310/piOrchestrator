import type { PlannerOutput, PlanTask } from "./types.js";

function topologicalSort(tasks: PlanTask[]): PlanTask[] {
  const visited = new Set<string>();
  const result: PlanTask[] = [];
  const taskMap = new Map(tasks.map(t => [t.id, t]));

  function visit(task: PlanTask) {
    if (visited.has(task.id)) return;
    visited.add(task.id);
    for (const depId of task.dependencies) {
      const dep = taskMap.get(depId);
      if (dep) visit(dep);
    }
    result.push(task);
  }

  for (const task of tasks) {
    visit(task);
  }

  return result;
}

export function formatPlanForReview(plan: PlannerOutput): string {
  const lines: string[] = [];

  lines.push("# Implementation Plan");
  lines.push("");

  lines.push("## Summary");
  lines.push("");
  lines.push(plan.summary);
  lines.push("");

  if (plan.acceptanceCriteria.length > 0) {
    lines.push("## Acceptance Criteria");
    lines.push("");
    for (const c of plan.acceptanceCriteria) {
      lines.push(`- [ ] ${c}`);
    }
    lines.push("");
  }

  const sorted = topologicalSort(plan.tasks);
  if (sorted.length > 0) {
    lines.push("## Tasks");
    lines.push("");
    for (let i = 0; i < sorted.length; i++) {
      const task = sorted[i];
      const num = i + 1;
      lines.push(`### ${num}. ${task.id}`);
      lines.push("");
      lines.push(task.description);
      lines.push("");
      if (task.files.length > 0) {
        lines.push(`**Files:** ${task.files.join(", ")}`);
        lines.push("");
      }
      if (task.dependencies.length > 0) {
        const depLabels = task.dependencies.map(d => {
          const dep = sorted.find(t => t.id === d);
          return dep ? `${sorted.indexOf(dep) + 1}. ${dep.id}` : d;
        });
        lines.push(`**Depends on:** ${depLabels.join(", ")}`);
        lines.push("");
      }
      if (task.verification.length > 0) {
        lines.push("**Verification:**");
        for (const v of task.verification) {
          lines.push(`- ${v}`);
        }
        lines.push("");
      }
    }
  }

  if (plan.assumptions.length > 0) {
    lines.push("## Assumptions");
    lines.push("");
    for (const a of plan.assumptions) {
      lines.push(`- ${a}`);
    }
    lines.push("");
  }

  if (plan.risks.length > 0) {
    lines.push("## Risks");
    lines.push("");
    for (const r of plan.risks) {
      lines.push(`- ${r}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
