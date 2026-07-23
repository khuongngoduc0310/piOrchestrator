import type { AgentName } from "../types.js";
import {
  MAX_SELECTED_LESSONS,
  MAX_SELECTED_LESSONS_BYTES,
  type MemoryDocument,
  type MemoryLesson,
  type MemoryLessonRef,
} from "./memory-types.js";

export interface SelectionResult {
  revision: number;
  lessons: MemoryLessonRef[];
  totalBytes: number;
  excludedCount: number;
}

export function selectMemoryLessons(
  doc: MemoryDocument | null,
  role: AgentName,
  request: string,
  relevantFilePaths: string[],
  maxCount: number = MAX_SELECTED_LESSONS,
  maxBytes: number = MAX_SELECTED_LESSONS_BYTES
): SelectionResult {
  if (!doc || doc.lessons.length === 0) {
    return { revision: 0, lessons: [], totalBytes: 0, excludedCount: 0 };
  }

  const requestTerms = extractTerms(request);
  const normalizedRequest = normalizeText(request);
  const pathTerms = relevantFilePaths.map(normalizePathForMatch);
  const scored: Array<{ lesson: MemoryLesson; score: number }> = [];
  let excludedCount = 0;

  for (const lesson of doc.lessons) {
    let score = 0;
    const roleMatch = lesson.scope.roles.length === 0 || lesson.scope.roles.includes(role);
    if (!roleMatch) {
      excludedCount++;
      continue;
    }
    if (roleMatch) score += 4;

    const pathMatch = lesson.scope.paths.length > 0 && pathTerms.some(rp =>
      lesson.scope.paths.some(sp => repositoryPathMatches(rp, sp))
    );
    if (pathMatch) score += 3;

    const keywordMatch = lesson.scope.keywords.length > 0 && lesson.scope.keywords.some(keyword =>
      keywordMatches(normalizedRequest, requestTerms, keyword)
    );
    if (keywordMatch) score += 2;

    const categoryMatch = lesson.scope.categories.length > 0 && lesson.scope.categories.some(category =>
      requestTerms.includes(category.toLowerCase())
    );
    if (categoryMatch) score += 1;

    const hasTopicalScope = lesson.scope.paths.length > 0 || lesson.scope.keywords.length > 0 || lesson.scope.categories.length > 0;
    if (hasTopicalScope && !pathMatch && !keywordMatch && !categoryMatch) {
      excludedCount++;
      continue;
    }
    scored.push({ lesson, score });
  }

  scored.sort((a, b) => b.score - a.score || a.lesson.createdAt.localeCompare(b.lesson.createdAt) || a.lesson.id.localeCompare(b.lesson.id));

  const selected: MemoryLessonRef[] = [];
  let totalBytes = 0;
  for (let index = 0; index < scored.length; index++) {
    const { lesson } = scored[index];
    if (selected.length >= maxCount) {
      excludedCount += scored.length - index;
      break;
    }
    const ref = lessonRef(lesson);
    const candidate = [...selected, ref];
    const nextTotal = Buffer.byteLength(JSON.stringify({ advisoryOnly: true, selectedAtRevision: doc.revision, lessons: candidate }), "utf8");
    if (nextTotal > maxBytes) {
      excludedCount++;
      continue;
    }
    selected.push(ref);
    totalBytes = nextTotal;
  }

  return { revision: doc.revision, lessons: selected, totalBytes, excludedCount };
}

function lessonRef(lesson: MemoryLesson): MemoryLessonRef {
  return {
    id: lesson.id,
    title: lesson.title,
    guidance: lesson.guidance,
    scope: structuredClone(lesson.scope),
    evidence: lesson.evidence.map(e => ({ path: e.path, detail: e.detail })),
    trust: "human-approved-project-memory",
  };
}

export function repositoryPathMatches(relevantPath: string, scopedPath: string): boolean {
  const relevant = normalizePathForMatch(relevantPath);
  const scoped = normalizePathForMatch(scopedPath).replace(/\/+$/, "");
  return relevant === scoped || relevant.startsWith(`${scoped}/`);
}

function normalizePathForMatch(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "").toLowerCase();
}

function extractTerms(text: string): string[] {
  const cleaned = text.replace(/[^a-zA-Z0-9\s_-]/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
  const words = cleaned.split(" ").filter(w => w.length >= 3);
  const unique = [...new Set(words)];
  const stopWords = new Set(["the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her", "was", "one", "our", "out", "has", "have", "been", "some", "same", "into", "than", "that", "this", "with", "from", "they", "been", "also", "its", "over", "such", "will", "what", "when", "where", "which", "their", "there", "about", "would", "could", "should", "after", "before", "between"]);
  return unique.filter(w => !stopWords.has(w) && w.length > 2);
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function keywordMatches(request: string, requestTerms: string[], keyword: string): boolean {
  const normalized = normalizeText(keyword);
  if (!normalized) return false;
  return normalized.includes(" ")
    ? (` ${request} `).includes(` ${normalized} `)
    : requestTerms.includes(normalized);
}
