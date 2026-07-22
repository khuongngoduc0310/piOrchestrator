import type { BuilderOutput, CheckResult, CompletionSummary, DebuggerOutput, DocumenterOutput, PlannerOutput, ReviewApprovalSource, ReviewOutput } from "./types.js";
import { formatPlanForReview } from "./plan-review.js";

const MAX_BYTES = 8192;

function truncateToBytes(text: string, max: number): string {
  const encoder = new TextEncoder();
  const encoded = encoder.encode(text);
  if (encoded.length <= max) return text;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  return decoder.decode(encoded.slice(0, max)) + "\n\n*(truncated — see run artifacts for the full report)*";
}

function changedFilesSummary(changedFiles: string[], limit = 8): string {
  if (changedFiles.length === 0) return "None";
  const lines = changedFiles.slice(0, limit).map(f => `- \`${f}\``).join("\n");
  if (changedFiles.length > limit) {
    return `${lines}\n- *+${changedFiles.length - limit} more*`;
  }
  return lines;
}

function checkResultsTable(checks: CheckResult[]): string {
  const passed = checks.filter(c => c.passed).length;
  const total = checks.length;
  const lines: string[] = [];
  for (const c of checks) {
    const icon = c.passed ? "✓" : "✗";
    const duration = c.durationMs ? `, ${msToCompact(c.durationMs)}` : "";
    lines.push(`- ${icon} \`${c.command}\` — exit ${c.exitCode ?? "—"}${duration}`);
  }
  lines.push("");
  lines.push(`**Result:** ${passed}/${total} checks passed`);
  return lines.join("\n");
}

function evidenceSummary(evidence: Array<{ path: string; detail: string }>): string {
  if (evidence.length === 0) return "None";
  return evidence.map(e => `- \`${e.path}\` — ${e.detail}`).join("\n");
}

export function formatStartedRun(request: string, runId: string, runDir: string): string {
  return truncateToBytes(
    `## Workflow started\n\n**Request:** ${request}\n\n**Run:** \`${runId}\`\n\n**Artifacts:** \`${runDir}\`\n`,
    MAX_BYTES
  );
}

export function formatApprovedPlan(plan: PlannerOutput): string {
  return truncateToBytes(
    `## Plan approved\n\n${formatPlanForReview(plan)}`,
    MAX_BYTES
  );
}

export function formatBaselineReport(
  checks: CheckResult[],
  diagnosis: DebuggerOutput,
  fixPlan: PlannerOutput
): string {
  const text = `## Baseline repair\n\n` +
    `Baseline checks were not all green. Diagnosed and planned repair.\n\n` +
    `### Check results\n\n${checkResultsTable(checks)}\n\n` +
    `### Diagnosis\n\n**Root cause:** ${diagnosis.rootCause}\n\n` +
    `**Recommended fix:** ${diagnosis.recommendedFix}\n\n` +
    `**Affected files:**\n${diagnosis.affectedFiles.map(f => `- \`${f}\``).join("\n")}\n\n` +
    `### Repair plan summary\n\n${fixPlan.summary}\n`;
  return truncateToBytes(text, MAX_BYTES);
}

export function formatVerifiedImplementation(
  plan: PlannerOutput,
  builderOutputs: BuilderOutput[],
  checks: CheckResult[],
  worktreeIsolation: boolean,
  artifactPath: string
): string {
  const allChanged = builderOutputs.flatMap(b => b.changedFiles);
  const uniqueChanged = [...new Set(allChanged)];
  const text = `## Implementation verified\n\n` +
    `**Plan:** ${plan.summary}\n\n` +
    `### Changed files\n\n${changedFilesSummary(uniqueChanged)}\n\n` +
    `### Check results\n\n${checkResultsTable(checks)}\n`;
  return truncateToBytes(text, MAX_BYTES);
}

export function formatApprovedReview(
  review: ReviewOutput,
  checks: CheckResult[],
  revisions: number,
  approvalSource: ReviewApprovalSource
): string {
  let text: string;
  if (approvalSource === "reviewer") {
    text = `## Code review complete\n\n**Decision:** approved\n` +
      `**Implementation checks:** ${checks.filter(c => c.passed).length}/${checks.length} passed\n` +
      `**Review revisions:** ${revisions}\n`;
  } else {
    const issues = review.blockingIssues.length > 0
      ? `\n### Blocking issues\n\n${review.blockingIssues.map(i => `- ${i}`).join("\n")}\n`
      : "";
    text = `## Code review complete\n\n**Decision:** accepted by user after review requested changes\n` +
      `**Implementation checks:** ${checks.filter(c => c.passed).length}/${checks.length} passed\n` +
      `**Review revisions:** ${revisions}${issues}\n`;
  }

  if (review.evidence.length > 0) {
    text += `\n### Evidence\n\n${evidenceSummary(review.evidence)}\n`;
  }
  if (review.suggestions.length > 0) {
    text += `\n### Suggestions\n\n${review.suggestions.map(s => `- ${s}`).join("\n")}\n`;
  }
  return truncateToBytes(text, MAX_BYTES);
}

export function formatDocumentationReport(
  output: DocumenterOutput,
  lessonStatus: "approved" | "rejected" | "skipped",
  lessonReview?: ReviewOutput
): string {
  const changed = output.changedFiles.length > 0;
  const title = changed ? "Documentation updated" : "Documentation reviewed";

  let text = `## ${title}\n\n**Summary:** ${output.summary}\n\n`;

  if (changed) {
    text += `### Changed files\n\n${changedFilesSummary(output.changedFiles)}\n\n`;
    if (output.documentationChanges.length > 0) {
      text += `### Changes\n\n${output.documentationChanges.map(d => `- ${d}`).join("\n")}\n\n`;
    }
  }

  if (output.commands.length > 0) {
    text += `### Verification performed\n\n${output.commands.map(c => `- \`${c.command}\` — ${c.status}: ${c.evidence}`).join("\n")}\n\n`;
  }

  if (output.proposedLessons.length > 0) {
    text += `### Proposed lessons\n\n` +
      `${output.proposedLessons.map((l, i) => `- **${i + 1}. ${l.title}** — \`${l.evidence.map(e => e.path).join(", ")}\``).join("\n")}\n\n`;
    if (lessonStatus === "rejected" && lessonReview) {
      text += `**Lesson review:** rejected\n`;
      if (lessonReview.blockingIssues.length > 0) {
        text += `${lessonReview.blockingIssues.map(i => `- ${i}`).join("\n")}\n\n`;
      }
    } else if (lessonStatus === "approved") {
      text += `**Lesson review:** machine-approved; pending human decision\n\n`;
    }
  } else {
    text += `**Lessons:** none proposed; review skipped\n\n`;
  }

  text += `**Lesson screening status:** ${lessonStatus}\n`;
  return truncateToBytes(text, MAX_BYTES);
}

export function formatCompletedRun(
  summary: CompletionSummary,
  dashboardUrl?: string,
  runDir?: string,
  warning?: string,
  extensionVersion?: string
): string {
  const elapsed = summary.checks.length > 0
    ? msToElapsed(Math.max(...summary.checks.map(c => c.completedAt ? new Date(c.completedAt).getTime() : 0)) - Math.min(...summary.checks.map(c => c.startedAt ? new Date(c.startedAt).getTime() : 0)))
    : "—";

  let text = `## Workflow completed\n\n**Request:** ${summary.request}\n\n**Result:** completed in ${elapsed}\n\n`;

  text += `### Delivered\n\n${summary.planSummary}\n\n`;

  const allFiles = [...new Set(summary.changedFiles)];
  if (allFiles.length > 0) {
    text += `### Workflow-reported changes\n\n${changedFilesSummary(allFiles)}\n\n`;
  } else {
    text += `### Workflow-reported changes\n\nNo file changes were reported.\n\n`;
  }

  if (summary.testsAdded.length > 0) {
    text += `### Tests added\n\n${summary.testsAdded.map(t => `- ${t}`).join("\n")}\n\n`;
  }

  if (summary.checks.length > 0) {
    text += `### Final verification\n\n${checkResultsTable(summary.checks)}\n\n`;
  }

  text += `### Review\n\n- Outcome: ${summary.review.outcome}\n`;
  text += `- Evidence items: ${summary.review.evidenceCount}\n`;
  if (summary.review.suggestions.length > 0) {
    text += `- Suggestions: ${summary.review.suggestions.length}\n`;
  } else {
    text += `- Suggestions: none\n`;
  }
  if (summary.review.blockingIssues.length > 0) {
    text += `- Blocking issues: ${summary.review.blockingIssues.length}\n`;
  }
  text += `- Revisions: ${summary.review.revisions}\n\n`;

  text += `### Documentation and lessons\n\n`;
  text += `- Documentation: ${summary.documentation.changed ? "updated" : "reviewed; no changes required"}\n`;
  text += `- Lesson screening: ${summary.lessons.status}\n`;
  if (summary.lessons.count > 0) {
    text += `- Lessons proposed: ${summary.lessons.count}\n`;
  }
  const mem = summary.memory;
  if (mem.mode === "valid") {
    text += `\n### Memory\n\n`;
    text += `- Mode: active (revision ${mem.loadedRevision})\n`;
    if (mem.selectedCount > 0) text += `- Lessons selected for agents: ${mem.selectedCount}\n`;
    text += `- Candidates: ${mem.candidates.proposed} proposed`;
    if (mem.candidates.machineEligible > 0) text += ` · ${mem.candidates.machineEligible} eligible`;
    if (mem.candidates.machineRejected > 0) text += ` · ${mem.candidates.machineRejected} rejected`;
    if (mem.candidates.humanApproved > 0) text += ` · ${mem.candidates.humanApproved} human-approved`;
    if (mem.candidates.promoted > 0) text += ` · ${mem.candidates.promoted} promoted`;
    if (mem.candidates.humanDeclined > 0) text += ` · ${mem.candidates.humanDeclined} declined`;
    if (mem.candidates.pending > 0) text += ` · ${mem.candidates.pending} pending`;
    if (mem.candidates.promotionFailed > 0) text += ` · ${mem.candidates.promotionFailed} failed to promote`;
    text += `\n`;
  } else if (mem.mode === "disabled") {
    text += `\n**Memory:** disabled\n`;
  }
  text += `\n### Run details\n\n`;
  text += `- Baseline repaired: ${summary.baselineRepaired ? "yes" : "no"}\n`;
  text += `- Implementation attempts: ${summary.attempts}\n`;
  if (extensionVersion) text += `- Extension version: ${extensionVersion}\n`;
  if (dashboardUrl) text += `- Dashboard: \`${dashboardUrl}\`\n`;
  if (runDir) text += `- Artifacts: \`${runDir}\`\n`;
  if (warning) text += `\n**Warning:** ${warning}\n`;

  return truncateToBytes(text, MAX_BYTES);
}

export function formatFailedRun(
  stage: string,
  message: string | unknown,
  runDir: string,
  structured?: unknown
): string {
  const details = terminationDetails(stage, message, structured);
  return truncateToBytes(
    `## Workflow failed\n\n**Stage:** ${details.stage}\n\n**Reason:** ${details.message}\n\n**Artifacts:** \`${runDir}\`\n`,
    MAX_BYTES
  );
}

export function formatCancelledRun(
  stage: string,
  message: string | unknown,
  runDir: string,
  structured?: unknown
): string {
  const details = terminationDetails(stage, message, structured);
  return truncateToBytes(
    `## Workflow cancelled\n\n**Stage:** ${details.stage}\n\n**Reason:** ${details.message}\n\n**Artifacts:** \`${runDir}\`\n`,
    MAX_BYTES
  );
}

function terminationDetails(
  fallbackStage: string,
  messageOrTermination: unknown,
  structured: unknown
): { stage: string; message: string } {
  const wrapper = recordOf(structured);
  const direct = recordOf(messageOrTermination);
  const termination = recordOf(wrapper?.termination) ?? recordOf(direct?.termination) ?? direct;
  const stoppedStage = stringOf(wrapper?.stoppedStage)
    ?? stringOf(termination?.stoppedStage)
    ?? fallbackStage;
  const message = stringOf(termination?.message)
    ?? stringOf(termination?.reason)
    ?? stringOf(messageOrTermination)
    ?? "No reason provided";
  return { stage: stoppedStage, message };
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function msToElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const remainSec = sec % 60;
  if (min < 60) return `${min}m${remainSec > 0 ? `${remainSec}s` : ""}`;
  const hr = Math.floor(min / 60);
  const remainMin = min % 60;
  return `${hr}h${remainMin}m`;
}

function msToCompact(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const sec = (ms / 1000).toFixed(1);
  return `${sec}s`;
}
