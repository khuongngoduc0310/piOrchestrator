import { wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { BuilderOutput, DocumenterOutput, ExplorerOutput, PlannerOutput, ReviewOutput, TesterOutput } from "../agent-task-types.js";
import type { DebuggerOutput } from "../workflow-shared.js";
import type { StructuredAgentResponse } from "./agent-session.js";

type Th = { fg(color: string, text: string): string; bold(text: string): string };

function accent(th: Th, t: string) { return th.fg("accent", t); }
function success(th: Th, t: string) { return th.fg("success", t); }
function errorCol(th: Th, t: string) { return th.fg("error", t); }
function muted(th: Th, t: string) { return th.fg("muted", t); }
function dim(th: Th, t: string) { return th.fg("dim", t); }

function heading(th: Th, label: string): string {
  return accent(th, label);
}

function numbered(th: Th, index: number, text: string, indent: number): string[] {
  const num = `${index + 1}. `;
  const prefix = " ".repeat(indent) + num;
  const maxInner = 76 - visibleWidth(prefix);
  const lines: string[] = [];
  const wrapped = wrapTextWithAnsi(text, Math.max(1, maxInner));
  if (wrapped.length === 0) return [prefix + dim(th, "(empty)")];
  const cont = " ".repeat(indent + num.length);
  for (let i = 0; i < wrapped.length; i++) {
    lines.push(i === 0 ? prefix + wrapped[i] : cont + wrapped[i]);
  }
  return lines;
}

function section(th: Th, lines: string[], label: string, contents: string[], emptyText?: string): void {
  if (contents.length === 0 && !emptyText) return;
  lines.push("");
  lines.push(heading(th, label));
  if (contents.length === 0 && emptyText) {
    lines.push(muted(th, emptyText));
  } else {
    for (const c of contents) lines.push(c);
  }
}

function visibleWidth(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, "").length;
}

function evidenceLines(th: Th, items: Array<{ path: string; detail: string }>): string[] {
  const result: string[] = [];
  for (const ev of items) {
    result.push(accent(th, ev.path));
    const wrapped = wrapTextWithAnsi(ev.detail, 72);
    for (const w of wrapped) result.push("  " + muted(th, w));
  }
  return result;
}

function commandReportLines(th: Th, commands: Array<{ command: string; status: string; evidence: string }>): string[] {
  const result: string[] = [];
  for (const cmd of commands) {
    const sym = cmd.status === "passed" ? success(th, "\u2713") : errorCol(th, "\u2717");
    result.push(`${sym} ${cmd.command}`);
    if (cmd.evidence) {
      const wrapped = wrapTextWithAnsi(cmd.evidence, 72);
      for (const w of wrapped) result.push("  " + dim(th, w));
    }
  }
  return result;
}

// ── role-specific renderers ──

function renderExplorer(th: Th, output: ExplorerOutput): string[] {
  const lines: string[] = [];
  section(th, lines, "Architecture", wrapTextWithAnsi(output.architecture, 74));
  section(th, lines, "Relevant files", output.relevantFiles.map(f => accent(th, f)), "None");
  section(th, lines, "Conventions", output.conventions.map(c => muted(th, c)), "None");
  section(th, lines, "Similar implementations", output.similarImplementations.map(s => muted(th, s)), "None");
  section(th, lines, "Commands", output.commands.map(c => dim(th, c)), "None");
  section(th, lines, "Risks", output.risks.map(r => muted(th, r)), "None");
  section(th, lines, "Known lessons", output.knownLessons.map(l => muted(th, l)), "None");
  if (output.evidence.length > 0) {
    section(th, lines, "Evidence", evidenceLines(th, output.evidence));
  }
  return lines;
}

function renderPlanner(th: Th, output: PlannerOutput): string[] {
  const lines: string[] = [];
  section(th, lines, "Route", [accent(th, output.route)]);
  section(th, lines, "Summary", wrapTextWithAnsi(output.summary, 74));
  section(th, lines, "Assumptions", output.assumptions.map(a => muted(th, a)), "None");
  section(th, lines, "Acceptance criteria", output.acceptanceCriteria.map((ac, i) => numbered(th, i, ac, 0)[0]));
  if (output.tasks.length > 0) {
    lines.push("");
    lines.push(heading(th, "Tasks"));
    for (const task of output.tasks) {
      lines.push("");
      lines.push(accent(th, `${task.id}: ${task.description}`));
      if (task.files.length > 0) {
        lines.push(muted(th, "Files:") + " " + task.files.join(", "));
      }
      if (task.dependencies.length > 0) {
        lines.push(muted(th, "Depends on:") + " " + task.dependencies.join(", "));
      }
      if (task.verification.length > 0) {
        lines.push(muted(th, "Verification:") + " " + task.verification.join("; "));
      }
    }
  }
  section(th, lines, "Risks", output.risks.map(r => muted(th, r)), "None");
  return lines;
}

function renderReviewer(th: Th, output: ReviewOutput): string[] {
  const lines: string[] = [];
  if (output.decision === "approved") {
    lines.push("");
    lines.push(heading(th, "Decision"));
    lines.push(success(th, "\u2713 Approved"));
  } else {
    lines.push("");
    lines.push(heading(th, "Decision"));
    lines.push(errorCol(th, "\u2717 Changes requested"));
    if (output.blockingIssues.length > 0) {
      section(th, lines, "Blocking issues", output.blockingIssues.map((bi, i) => numbered(th, i, bi, 0)[0]));
    }
  }
  section(th, lines, "Suggestions", output.suggestions.map(s => muted(th, s)), "None");
  if (output.evidence.length > 0) {
    section(th, lines, "Evidence", evidenceLines(th, output.evidence));
  }
  return lines;
}

function renderTester(th: Th, output: TesterOutput): string[] {
  const lines: string[] = [];
  section(th, lines, "Summary", wrapTextWithAnsi(output.summary, 74));
  section(th, lines, "Changed files", output.changedFiles.map(f => accent(th, f)), "None");
  section(th, lines, "Tests added", output.testsAdded.map(t => muted(th, t)), "None");
  if (output.acceptanceCoverage.length > 0) {
    lines.push("");
    lines.push(heading(th, "Acceptance coverage"));
    for (const cov of output.acceptanceCoverage) {
      const sym = cov.status === "covered" ? success(th, "\u2713") : errorCol(th, "\u2717");
      lines.push(`${sym} ${cov.criterion}`);
      if (cov.tests.length > 0) lines.push("  " + muted(th, "Tests:") + " " + cov.tests.join(", "));
      if (cov.preImplementationResult) lines.push("  " + muted(th, "Pre-implementation:") + " " + cov.preImplementationResult);
    }
  }
  section(th, lines, "Commands", commandReportLines(th, output.commands));
  section(th, lines, "Assumptions", output.assumptions.map(a => muted(th, a)), "None");
  section(th, lines, "Unresolved issues", output.unresolvedIssues.map(u => muted(th, u)), "None");
  if (output.blocker) {
    lines.push("");
    lines.push(errorCol(th, "\u26a0 Blocked") + " " + muted(th, output.blocker.reason));
  }
  return lines;
}

function renderBuilder(th: Th, output: BuilderOutput): string[] {
  const lines: string[] = [];
  section(th, lines, "Summary", wrapTextWithAnsi(output.summary, 74));
  section(th, lines, "Changed files", output.changedFiles.map(f => accent(th, f)), "None");
  section(th, lines, "Commands", commandReportLines(th, output.commands));
  section(th, lines, "Assumptions", output.assumptions.map(a => muted(th, a)), "None");
  section(th, lines, "Unresolved issues", output.unresolvedIssues.map(u => muted(th, u)), "None");
  if (output.blocker) {
    lines.push("");
    lines.push(errorCol(th, "\u26a0 Blocked") + " " + muted(th, output.blocker.reason));
  }
  return lines;
}

function renderDebugger(th: Th, output: DebuggerOutput): string[] {
  const lines: string[] = [];
  lines.push("");
  lines.push(heading(th, "Category"));
  lines.push(muted(th, output.category));
  lines.push("");
  lines.push(heading(th, "Confidence"));
  lines.push(output.confidence === "high" ? success(th, "High") : output.confidence === "medium" ? accent(th, "Medium") : errorCol(th, "Low"));
  section(th, lines, "Root cause", wrapTextWithAnsi(output.rootCause, 74));
  section(th, lines, "Recommended fix", wrapTextWithAnsi(output.recommendedFix, 74));
  section(th, lines, "Affected files", output.affectedFiles.map(f => accent(th, f)), "None");
  if (output.evidence.length > 0) {
    section(th, lines, "Evidence", evidenceLines(th, output.evidence));
  }
  return lines;
}

function renderDocumenter(th: Th, output: DocumenterOutput): string[] {
  const lines: string[] = [];
  section(th, lines, "Summary", wrapTextWithAnsi(output.summary, 74));
  section(th, lines, "Changed files", output.changedFiles.map(f => accent(th, f)), "None");
  section(th, lines, "Documentation changes", output.documentationChanges.map(d => muted(th, d)), "None");
  if (output.proposedLessons.length > 0) {
    lines.push("");
    lines.push(heading(th, "Proposed lessons"));
    for (const lesson of output.proposedLessons) {
      lines.push(accent(th, lesson.title));
      const wrapped = wrapTextWithAnsi(lesson.lesson, 72);
      for (const w of wrapped) lines.push("  " + muted(th, w));
      if (lesson.scope.roles.length > 0) lines.push("  " + muted(th, "Roles:") + " " + lesson.scope.roles.join(", "));
    }
  }
  section(th, lines, "Commands", commandReportLines(th, output.commands));
  section(th, lines, "Unresolved issues", output.unresolvedIssues.map(u => muted(th, u)), "None");
  if (output.blocker) {
    lines.push("");
    lines.push(errorCol(th, "\u26a0 Blocked") + " " + muted(th, output.blocker.reason));
  }
  return lines;
}

// ── public API ──

export function renderStructuredAgentResponse(
  response: StructuredAgentResponse,
  th: Th,
): string[] {
  switch (response.agent) {
    case "explorer": return renderExplorer(th, response.output);
    case "planner": return renderPlanner(th, response.output);
    case "reviewer": return renderReviewer(th, response.output);
    case "tester": return renderTester(th, response.output);
    case "builder": return renderBuilder(th, response.output);
    case "debugger": return renderDebugger(th, response.output);
    case "documenter": return renderDocumenter(th, response.output);
  }
}
