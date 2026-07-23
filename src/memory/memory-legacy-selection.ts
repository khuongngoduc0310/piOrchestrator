import type { AgentName } from "../agent-types.js";
import {
  MAX_SELECTED_LESSONS,
  MAX_SELECTED_LESSONS_BYTES,
  type MemoryLesson,
  type MemoryLessonRef
} from "./memory-types.js";
import { repositoryPathMatches } from "./memory-selection.js";

/** @deprecated Use selectMemoryLessons from memory-selection.ts for workflow selection. */
export function selectLessons(
  lessons: MemoryLesson[],
  role: AgentName,
  requestTerms: string[],
  relevantPaths: string[],
  maxCount: number = MAX_SELECTED_LESSONS,
  maxBytes: number = MAX_SELECTED_LESSONS_BYTES
): MemoryLessonRef[] {
  const scored: Array<{ lesson: MemoryLesson; score: number; bytes: number }> = [];
  const requestLower = requestTerms.map(term => term.toLowerCase());
  for (const lesson of lessons) {
    let score = 0;
    if (lesson.scope.roles.length > 0 && !lesson.scope.roles.includes(role)) continue;
    score += 4;
    if (lesson.scope.paths.length > 0 && relevantPaths.some(relevant =>
      lesson.scope.paths.some(scoped => repositoryPathMatches(relevant, scoped)))) score += 3;
    if (lesson.scope.keywords.length > 0 && requestLower.some(term =>
      lesson.scope.keywords.some(keyword => term.includes(keyword.toLowerCase()) || keyword.toLowerCase().includes(term)))) score += 2;
    if (lesson.scope.categories.length > 0 && requestLower.some(term =>
      lesson.scope.categories.some(category => term.includes(category.toLowerCase())))) score += 1;
    if (score > 0) {
      const bytes = Buffer.byteLength(JSON.stringify(serializedLessonRef(lesson)), "utf8");
      scored.push({ lesson, score, bytes });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.lesson.createdAt.localeCompare(b.lesson.createdAt));
  const selected: MemoryLessonRef[] = [];
  let totalBytes = 0;
  for (const item of scored) {
    if (selected.length >= maxCount) break;
    const nextTotal = selected.length === 0 ? item.bytes + 2 : totalBytes + item.bytes + 1;
    if (nextTotal > maxBytes) continue;
    selected.push(serializedLessonRef(item.lesson));
    totalBytes = nextTotal;
  }
  return selected;
}

function serializedLessonRef(lesson: MemoryLesson): MemoryLessonRef {
  return {
    id: lesson.id,
    title: lesson.title,
    guidance: lesson.guidance,
    scope: structuredClone(lesson.scope),
    evidence: lesson.evidence.map(item => ({ path: item.path, detail: item.detail })),
    trust: "human-approved-project-memory"
  };
}
