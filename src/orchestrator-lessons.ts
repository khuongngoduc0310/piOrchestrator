import { createCandidateLedger, saveCandidateLedger, setCandidateState } from "./candidate-store.js";
import { promoteLessons } from "./memory-store.js";
import { candidateLessonId, deduplicateAgainstMemory, permanentLessonId, validateCandidates, validateNewLesson } from "./memory-validation.js";
import { formatDocumentationReport } from "./session-messages.js";
import { parseDocumenterOutput, parseReviewOutput } from "./validation.js";
import type { CandidateLesson } from "./memory-types.js";
import type { DocumenterOutput } from "./types.js";
import type { ReviewResult, WorkflowContext } from "./orchestrator-context.js";
import type { OrchestratorRuntime } from "./orchestrator-runtime.js";
import { countCandidateStates, EXTENSION_VERSION, projectTrusted } from "./orchestrator-helpers.js";
import { runAgentStep } from "./orchestrator-agent-step.js";
import { promptHumanMemoryApproval } from "./orchestrator-human-gates.js";
import { persist, publishSessionMessage } from "./orchestrator-state.js";
import { saveWorkflowCheckpoint } from "./orchestrator-checkpoints.js";
import { assertDocumenterComplete } from "./mutation-completion.js";

export interface LessonPreparation {
  documentation: DocumenterOutput;
  proposedCandidates: CandidateLesson[];
  duplicateCandidateIds: Set<string>;
  machineEligibleCount: number;
  machineRejectedCount: number;
  duplicateCount: number;
}

export interface LessonCounts {
  humanApprovedCount: number;
  humanDeclinedCount: number;
  promotedCount: number;
  promotionFailedCount: number;
  pendingCount: number;
}

export interface SerializedLessonPreparation extends Omit<LessonPreparation, "duplicateCandidateIds"> {
  duplicateCandidateIds: string[];
}

export function serializeLessonPreparation(value: LessonPreparation): SerializedLessonPreparation {
  return { ...value, duplicateCandidateIds: [...value.duplicateCandidateIds] };
}

export function hydrateLessonPreparation(value: SerializedLessonPreparation): LessonPreparation {
  return { ...value, duplicateCandidateIds: new Set(value.duplicateCandidateIds) };
}

export async function prepareLessons(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  review: ReviewResult,
  restoredDocumentation?: DocumenterOutput
): Promise<LessonPreparation> {
  const { request, ctx, store, runId } = workflow;
  const { plan, baseline, codeReview, reviewApprovalSource, finalImplChecks, tester } = review;
  const documentation = restoredDocumentation ?? await runAgentStep(
    runtime,
    "documenter",
    "documenting",
    "Update documentation and propose lessons",
    {
      action: "document",
      request,
      plan,
      baselineChecks: baseline,
      codeReview,
      approvalSource: reviewApprovalSource,
      implementationChecks: finalImplChecks,
      builderOutputs: runtime.builderSessionOutputs,
      tester
    },
    workflow.mutationCwd,
    ctx,
    parseDocumenterOutput,
    { mutationPlan: plan }
  );
  assertDocumenterComplete(documentation);
  if (!restoredDocumentation) {
    await saveWorkflowCheckpoint(runtime, workflow, "documenter_completed", { review, documentation }, {
      exploration: review.exploration,
      plan,
      baselineChecks: baseline,
      tester,
      builderOutputs: runtime.builderSessionOutputs,
      implementationChecks: finalImplChecks,
      codeReview,
      priorCodeReviews: review.priorCodeReviews,
      reviewApprovalSource
    });
  }

  runtime.candidateLessons = validateCandidates(documentation.proposedLessons.map((lesson, index) => ({
    id: candidateLessonId(runId, index + 1),
    title: lesson.title,
    guidance: lesson.lesson,
    scope: lesson.scope,
    evidence: lesson.evidence
  })));
  const proposedCandidates = runtime.candidateLessons.slice();
  let machineEligibleCount = 0;
  let machineRejectedCount = 0;
  let duplicateCount = 0;
  const duplicateCandidateIds = new Set<string>();
  await store.saveJson("proposed-lessons.json", documentation.proposedLessons);

  if (runtime.candidateLessons.length === 0) {
    runtime.lessonStatus = "skipped";
    await store.saveJson("proposed-lessons-status.json", { status: "skipped", reason: "none_proposed" });
  } else {
    runtime.requireState().stage = "screening_lessons";
    const lessonReview = await runAgentStep(
      runtime,
      "reviewer",
      "screening_lessons",
      "Screen proposed lessons",
      { reviewType: "lessons", request, lessons: documentation.proposedLessons },
      workflow.mutationCwd,
      ctx,
      parseReviewOutput
    );
    if (lessonReview.decision === "changes_requested") {
      runtime.requireState().warning = "Proposed lessons were rejected by review; verified code remains complete";
      runtime.lessonStatus = "rejected";
      machineRejectedCount = runtime.candidateLessons.length;
      await store.saveJson("proposed-lessons-status.json", { status: "rejected", review: lessonReview });
    } else {
      const { eligible, duplicates } = runtime.memoryMode === "valid"
        ? deduplicateAgainstMemory(runtime.candidateLessons, runtime.loadedMemoryDoc!.lessons)
        : { eligible: runtime.candidateLessons.slice(), duplicates: [] };
      machineEligibleCount = eligible.length;
      duplicateCount = duplicates.length;
      for (const duplicate of duplicates) duplicateCandidateIds.add(duplicate.id);
      runtime.candidateLessons = eligible;
      runtime.lessonStatus = "approved";
      await store.saveJson("proposed-lessons-status.json", { status: "machine_approved", review: lessonReview });
      if (duplicates.length > 0) await store.saveJson("candidate-duplicates.json", duplicates.map(candidate => ({ id: candidate.id, title: candidate.title })));
    }
  }
  publishSessionMessage(runtime, formatDocumentationReport(documentation, runtime.lessonStatus), { kind: "documentation_updated" });
  const result = { documentation, proposedCandidates, duplicateCandidateIds, machineEligibleCount, machineRejectedCount, duplicateCount };
  await saveWorkflowCheckpoint(runtime, workflow, "lessons_screened", { review, preparation: serializeLessonPreparation(result) }, {
    exploration: review.exploration,
    plan,
    baselineChecks: baseline,
    tester,
    builderOutputs: runtime.builderSessionOutputs,
    implementationChecks: finalImplChecks,
    codeReview,
    priorCodeReviews: review.priorCodeReviews,
    reviewApprovalSource
  });
  return result;
}

export async function persistAndPromoteLessons(
  runtime: OrchestratorRuntime,
  workflow: WorkflowContext,
  preparation: LessonPreparation,
  finalChecksDigest: string
): Promise<LessonCounts> {
  const { cwd, runId, store, ctx } = workflow;
  runtime.candidateLedger = createCandidateLedger(cwd, runId, preparation.proposedCandidates, finalChecksDigest, EXTENSION_VERSION, runtime.timestamp());
  for (const candidate of preparation.proposedCandidates) {
    if (runtime.lessonStatus === "rejected") {
      runtime.candidateLedger = setCandidateState(runtime.candidateLedger, candidate.id, "machine_rejected", "lesson review rejected the candidate", runtime.timestamp());
      continue;
    }
    runtime.candidateLedger = setCandidateState(runtime.candidateLedger, candidate.id, "machine_approved", "lesson review approved the candidate", runtime.timestamp());
    const duplicate = preparation.duplicateCandidateIds.has(candidate.id);
    runtime.candidateLedger = setCandidateState(
      runtime.candidateLedger,
      candidate.id,
      duplicate ? "duplicate" : "pending",
      duplicate ? "content already exists in memory" : "awaiting human decision",
      runtime.timestamp()
    );
  }
  runtime.candidateLedger = await saveCandidateLedger(cwd, runtime.candidateLedger);
  await store.saveJson("pending-candidates.json", runtime.candidateLedger.candidates.filter(candidate => candidate.state === "pending"));
  await store.flush();

  const eligibleCandidates = runtime.candidateLedger.candidates.filter(candidate => candidate.state === "pending");
  if (eligibleCandidates.length > 0 && ctx.hasUI && runtime.memoryMode !== "untrusted") {
    const state = runtime.requireState();
    state.waitingFor = `Memory approval: ${eligibleCandidates.length} candidate(s)`;
    state.stage = "human_review_lessons";
    await persist(runtime, ctx);
    const decision = await promptHumanMemoryApproval(runtime, eligibleCandidates, ctx);
    state.waitingFor = undefined;
    for (const id of decision.declinedIds) runtime.candidateLedger = setCandidateState(runtime.candidateLedger, id, "declined", "human declined", runtime.timestamp());
    for (const id of decision.approvedIds) runtime.candidateLedger = setCandidateState(runtime.candidateLedger, id, "promotion_pending", "human approved", runtime.timestamp());
    runtime.candidateLedger = await saveCandidateLedger(cwd, runtime.candidateLedger);
    await store.saveJson("human-approvals.json", decision);

    if (decision.approvedIds.length > 0) {
      if (!projectTrusted(ctx)) {
        ctx.ui.notify("Project trust changed; approved lessons remain pending", "warning");
        for (const id of decision.approvedIds) runtime.candidateLedger = setCandidateState(runtime.candidateLedger, id, "pending", "project is not trusted", runtime.timestamp());
      } else if (runtime.memoryMode !== "invalid" && runtime.memoryMode !== "scope_mismatch" && runtime.memoryMode !== "unsupported") {
        state.stage = "promoting_memory";
        await persist(runtime, ctx);
        const toPromote = eligibleCandidates.filter(candidate => decision.approvedIds.includes(candidate.id));
        const now = runtime.timestamp();
        const lessons = toPromote.map(candidate => validateNewLesson(
          permanentLessonId(runId, candidate.id),
          candidate.title,
          candidate.guidance,
          candidate.scope,
          candidate.evidence,
          { sourceRunId: runId, candidateId: candidate.id, finalChecksDigest, approvedAt: now, extensionVersion: EXTENSION_VERSION }
        ));
        runtime.promotionResult = await promoteLessons(cwd, lessons, runtime.memoryRevision);
        const promotedIds = new Set(runtime.promotionResult.promoted);
        const failedIds = new Set(runtime.promotionResult.failed.map(item => item.candidateId));
        for (const candidate of toPromote) {
          const lessonId = permanentLessonId(runId, candidate.id);
          const next = promotedIds.has(lessonId)
            ? "promoted"
            : runtime.promotionResult.retryable
              ? "pending"
              : failedIds.has(candidate.id) || runtime.promotionResult.error ? "promotion_failed" : "duplicate";
          runtime.candidateLedger = setCandidateState(runtime.candidateLedger, candidate.id, next, runtime.promotionResult.error, runtime.timestamp());
        }
        await store.saveJson("promotion-result.json", runtime.promotionResult);
      } else {
        for (const id of decision.approvedIds) {
          runtime.candidateLedger = setCandidateState(runtime.candidateLedger, id, "promotion_failed", `memory is ${runtime.memoryMode}`, runtime.timestamp());
        }
      }
    }
    runtime.candidateLedger = await saveCandidateLedger(cwd, runtime.candidateLedger);
  }
  const counts = countCandidateStates(runtime.candidateLedger);
  return {
    humanApprovedCount: counts.promoted + counts.promotion_failed + counts.promotion_pending,
    humanDeclinedCount: counts.declined,
    promotedCount: counts.promoted,
    promotionFailedCount: counts.promotion_failed,
    pendingCount: counts.pending + counts.promotion_pending
  };
}
