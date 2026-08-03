import { validateCandidates } from "../../memory/memory-validation.js";
import type {
  ImplementationPlanningResult,
  ImplementationResult,
  InvestigationResult,
  PlanningResult,
  ReadOnlyReviewResult,
  ReviewResult,
  SpecializedMutationResult
} from "../orchestrator-context.js";
import type { SerializedLessonPreparation } from "../orchestrator-lessons.js";
import { automatedCriteria } from "../acceptance-criteria.js";
import { validateCheckResults } from "../../persistence/checkpoint-validation.js";
import { assertDocumenterComplete, assertTesterComplete } from "../mutation-completion.js";
import type { AgentResolutionRequest, ReviewApprovalSource } from "../../agent-task-types.js";
import {
  validateDebuggerOutput,
  validateDocumenterOutput,
  validateExplorerOutput,
  validatePlannerOutput,
  validateReviewOutput,
  validateTesterOutput
} from "../../validation.js";
import { arrayValue, nonNegativeInteger, objectValue, stringValue } from "./shared.js";

function approvalSource(value: unknown): ReviewApprovalSource {
  if (value !== "reviewer" && value !== "user_override") throw new Error("reviewApprovalSource is invalid");
  return value;
}

export function planningResult(value: unknown): PlanningResult {
  const item = objectValue(value, "planning continuation");
  return { exploration: validateExplorerOutput(item.exploration), plan: validatePlannerOutput(item.plan) };
}

export function implementationPlanningResult(value: unknown): ImplementationPlanningResult {
  const planning = planningResult(value);
  const item = objectValue(value, "implementation planning");
  return {
    ...planning,
    baseline: validateCheckResults(item.baseline),
    scopeRevisionCount: nonNegativeInteger(item.scopeRevisionCount, "scopeRevisionCount"),
    ...(item.baselineDiagnosis === undefined ? {} : { baselineDiagnosis: validateDebuggerOutput(item.baselineDiagnosis) })
  };
}

export function implementationResult(value: unknown): ImplementationResult {
  const item = objectValue(value, "implementation continuation");
  const planning = implementationPlanningResult(item);
  let tester: ImplementationResult["tester"];
  if (item.tester === undefined) {
    if (planning.plan.route !== "quick_implementation") throw new Error("Implementation checkpoint is missing Tester output");
  } else {
    tester = validateTesterOutput(item.tester, automatedCriteria(planning.plan));
  }
  return {
    ...planning,
    tester,
    finalImplChecks: validateCheckResults(item.finalImplChecks),
    diagnosis: item.diagnosis === undefined ? undefined : validateDebuggerOutput(item.diagnosis)
  };
}

export function reviewResult(value: unknown): ReviewResult {
  const item = objectValue(value, "review continuation");
  const codeReview = validateReviewOutput(item.codeReview);
  const reviewApprovalSource = approvalSource(item.reviewApprovalSource);
  if (reviewApprovalSource === "reviewer" && codeReview.decision !== "approved") {
    throw new Error("Reviewer approval checkpoint must contain an approved review");
  }
  return {
    ...implementationResult(item),
    codeReview,
    reviewApprovalSource,
    priorCodeReviews: arrayValue(item.priorCodeReviews, "priorCodeReviews").map((entry, index) => validateReviewOutput(entry, `priorCodeReviews[${index}]`))
  };
}

export function readOnlyReviewResult(value: unknown): ReadOnlyReviewResult {
  const item = objectValue(value, "repository review continuation");
  return { ...planningResult(item), codeReview: validateReviewOutput(item.codeReview) };
}

export function investigationResult(value: unknown): InvestigationResult {
  const item = objectValue(value, "investigation continuation");
  return { ...planningResult(item), diagnosis: validateDebuggerOutput(item.diagnosis) };
}

export function specializedMutationResult(value: unknown): SpecializedMutationResult {
  const item = objectValue(value, "specialized mutation continuation");
  const planning = implementationPlanningResult(item);
  if (planning.plan.route === "tests_only") {
    const tester = validateTesterOutput(item.tester, automatedCriteria(planning.plan));
    assertTesterComplete(tester, "tests_only");
    return { ...planning, route: "tests_only", tester };
  }
  if (planning.plan.route === "documentation_only") {
    const documentation = validateDocumenterOutput(item.documentation);
    assertDocumenterComplete(documentation);
    return { ...planning, route: "documentation_only", documentation };
  }
  throw new Error("Specialized mutation checkpoint has an invalid route");
}

export function serializedLessonPreparation(value: unknown): SerializedLessonPreparation {
  const item = objectValue(value, "lesson preparation");
  const documentation = validateDocumenterOutput(item.documentation);
  const proposedCandidates = validateCandidates(item.proposedCandidates);
  const duplicateCandidateIds = arrayValue(item.duplicateCandidateIds, "duplicateCandidateIds").map((entry, index) => stringValue(entry, `duplicateCandidateIds[${index}]`));
  const candidateIds = new Set(proposedCandidates.map(candidate => candidate.id));
  if (new Set(duplicateCandidateIds).size !== duplicateCandidateIds.length || duplicateCandidateIds.some(id => !candidateIds.has(id))) {
    throw new Error("duplicateCandidateIds must be unique candidate IDs");
  }
  const duplicateCount = nonNegativeInteger(item.duplicateCount, "duplicateCount");
  if (duplicateCount !== duplicateCandidateIds.length) throw new Error("duplicateCount does not match duplicateCandidateIds");
  const machineEligibleCount = nonNegativeInteger(item.machineEligibleCount, "machineEligibleCount");
  const machineRejectedCount = nonNegativeInteger(item.machineRejectedCount, "machineRejectedCount");
  if (machineEligibleCount + machineRejectedCount + duplicateCount > proposedCandidates.length) {
    throw new Error("lesson preparation counts exceed proposed candidates");
  }
  return {
    documentation,
    proposedCandidates,
    duplicateCandidateIds,
    machineEligibleCount,
    machineRejectedCount,
    duplicateCount
  };
}

export function builderBlocker(value: unknown): NonNullable<AgentResolutionRequest> {
  const item = objectValue(value, "Builder blocker");
  const kind = stringValue(item.kind, "Builder blocker kind");
  const reason = stringValue(item.reason, "Builder blocker reason");
  if (!["scope", "baseline_repair", "prerequisite_repair", "role_handoff", "environment", "tooling", "insufficient_evidence"].includes(kind)) {
    throw new Error("Builder blocker kind is invalid");
  }
  if (kind === "scope") {
    return { kind: "scope", reason, requiredFiles: arrayValue(item.requiredFiles, "Builder blocker requiredFiles").map((entry, index) => stringValue(entry, `Builder blocker requiredFiles[${index}]`)) };
  }
  if (kind === "baseline_repair" || kind === "prerequisite_repair" || kind === "role_handoff" || kind === "insufficient_evidence" || kind === "environment" || kind === "tooling") {
    return { kind, reason, failedCheckCommands: [], evidence: [], affectedFiles: [], verification: [], requestedCapability: "", question: "", questions: [], suggestedRoles: [], inspectedEvidence: [], diagnostics: [], retryCondition: "", affectedCommands: [] } as any;
  }
  throw new Error("Unexpected builder blocker kind");
}
