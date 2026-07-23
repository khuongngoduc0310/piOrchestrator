import type { BuilderOutput, DocumenterOutput, TesterOutput, WorkflowRoute } from "./types.js";

export type MutationOutput = BuilderOutput | TesterOutput | DocumenterOutput;

export function assertMutationComplete(output: MutationOutput, role: "Builder" | "Tester" | "Documenter"): void {
  if (output.blocker) {
    throw new Error(`${role} blocked (${output.blocker.kind}): ${output.blocker.reason}`);
  }
  if (output.unresolvedIssues.length > 0) {
    throw new Error(`${role} did not complete the requested work: ${output.unresolvedIssues.join("; ")}`);
  }
}

export function assertBuilderComplete(output: BuilderOutput, context = "the requested work"): void {
  if (output.blocker) {
    throw new Error(`Builder blocked (${output.blocker.kind}): ${output.blocker.reason}`);
  }
  if (output.unresolvedIssues.length > 0) {
    throw new Error(`Builder did not complete ${context}: ${output.unresolvedIssues.join("; ")}`);
  }
}

export function assertTesterComplete(output: TesterOutput, route: WorkflowRoute): void {
  assertMutationComplete(output, "Tester");
  const incomplete = output.acceptanceCoverage.filter(entry => entry.status !== "covered");
  if (incomplete.length > 0) {
    const criteria = incomplete.map(entry => `#${entry.criterionIndex + 1} ${entry.status}`).join(", ");
    throw new Error(`Tester did not fully cover the acceptance criteria for ${route}: ${criteria}`);
  }
}

export function assertDocumenterComplete(output: DocumenterOutput): void {
  assertMutationComplete(output, "Documenter");
}
