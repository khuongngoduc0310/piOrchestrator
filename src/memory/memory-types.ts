import type { AgentName } from "../agent-types.js";

export const MEMORY_SCHEMA_VERSION = 1;

export const MAX_MEMORY_BYTES = 102_400;
export const MAX_LESSONS_PER_DOC = 100;
export const MAX_LESSON_TITLE_BYTES = 200;
export const MAX_LESSON_GUIDANCE_BYTES = 2000;
export const MAX_EVIDENCE_PER_LESSON = 10;
export const MAX_EVIDENCE_PATH_BYTES = 400;
export const MAX_EVIDENCE_DETAIL_BYTES = 500;
export const MAX_SELECTED_LESSONS = 20;
export const MAX_SELECTED_LESSONS_BYTES = 8000;
export const MAX_CANDIDATE_TITLE_BYTES = 200;
export const MAX_CANDIDATE_GUIDANCE_BYTES = 2000;
export const MAX_CANDIDATES_PER_RUN = 20;
export const CANDIDATE_LEDGER_SCHEMA_VERSION = 1;
export const MAX_CANDIDATE_LEDGER_BYTES = 102_400;

export const CANDIDATE_STATES = [
  "proposed",
  "machine_approved",
  "machine_rejected",
  "duplicate",
  "pending",
  "declined",
  "promotion_pending",
  "promotion_failed",
  "promoted",
] as const;
export type CandidateState = (typeof CANDIDATE_STATES)[number];

export interface MemoryEvidence {
  path: string;
  detail: string;
  contentHash?: string;
}

export interface MemoryLesson {
  id: string;
  contentDigest: string;
  title: string;
  guidance: string;
  scope: {
    roles: AgentName[];
    paths: string[];
    categories: string[];
    keywords: string[];
  };
  evidence: MemoryEvidence[];
  provenance: {
    sourceRunId: string;
    candidateId: string;
    finalChecksDigest: string;
    approvedAt: string;
    extensionVersion: string;
  };
  createdAt: string;
}

export interface MemoryDocument {
  schemaVersion: number;
  revision: number;
  updatedAt: string;
  projectPath: string;
  lessons: MemoryLesson[];
}

export interface CandidateLesson {
  id: string;
  contentDigest: string;
  title: string;
  guidance: string;
  scope: {
    roles: AgentName[];
    paths: string[];
    categories: string[];
    keywords: string[];
  };
  evidence: Array<{ path: string; detail: string; contentHash?: string }>;
}

export interface CandidateScreening {
  candidateId: string;
  eligible: boolean;
  reason: string;
}

export interface CandidateStateTransition {
  from: CandidateState;
  to: CandidateState;
  at: string;
  reason?: string;
}

export interface CandidateLedgerEntry extends CandidateLesson {
  state: CandidateState;
  updatedAt: string;
  transitions: CandidateStateTransition[];
}

export interface CandidateLedger {
  schemaVersion: number;
  revision: number;
  runId: string;
  projectPath: string;
  finalChecksDigest: string;
  extensionVersion: string;
  updatedAt: string;
  candidates: CandidateLedgerEntry[];
}

export interface MemoryLessonRef {
  id: string;
  title: string;
  guidance: string;
  scope: MemoryLesson["scope"];
  evidence: Array<{ path: string; detail: string }>;
  trust: "human-approved-project-memory";
}

export interface MemoryContext {
  advisoryOnly: true;
  selectedAtRevision: number;
  lessons: MemoryLessonRef[];
}

export interface PromotionResult {
  promoted: string[];
  duplicates: string[];
  failed: Array<{ candidateId: string; error: string }>;
  revision: number;
  error?: string;
  retryable?: boolean;
}

export type MemoryMode = "disabled" | "empty" | "valid";
