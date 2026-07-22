import {
  CANDIDATE_LEDGER_SCHEMA_VERSION,
  CANDIDATE_STATES,
  MAX_CANDIDATES_PER_RUN,
  type CandidateLedger,
  type CandidateLedgerEntry,
  type CandidateState
} from "./memory-types.js";
import {
  MemoryValidationError,
  isRecord,
  memoryString,
  validDate,
  validateMemoryId,
  validateRevision
} from "./memory-validation-core.js";
import { validateCandidate } from "./candidate-validation.js";

const LEGAL_CANDIDATE_TRANSITIONS: Readonly<Record<CandidateState, readonly CandidateState[]>> = {
  proposed: ["machine_approved", "machine_rejected"],
  machine_approved: ["duplicate", "pending", "declined", "promotion_pending"],
  machine_rejected: [],
  duplicate: [],
  pending: ["declined", "promotion_pending"],
  declined: [],
  promotion_pending: ["pending", "duplicate", "promotion_failed", "promoted"],
  promotion_failed: ["declined", "promotion_pending"],
  promoted: []
};

export function isLegalCandidateTransition(from: CandidateState, to: CandidateState): boolean {
  return LEGAL_CANDIDATE_TRANSITIONS[from].includes(to);
}

function candidateState(v: unknown): CandidateState {
  if (typeof v !== "string" || !CANDIDATE_STATES.includes(v as CandidateState)) {
    throw new MemoryValidationError(`invalid candidate state: ${String(v)}`);
  }
  return v as CandidateState;
}

function validateLedgerEntry(v: unknown, index: number): CandidateLedgerEntry {
  if (!isRecord(v)) throw new MemoryValidationError(`candidates[${index}] must be an object`);
  const candidate = validateCandidate(v, index);
  const state = candidateState(v.state);
  if (!Array.isArray(v.transitions)) throw new MemoryValidationError(`candidates[${index}].transitions must be an array`);
  let replayed: CandidateState = "proposed";
  const transitions = v.transitions.map((item, transitionIndex) => {
    if (!isRecord(item)) throw new MemoryValidationError(`candidates[${index}].transitions[${transitionIndex}] must be an object`);
    const from = candidateState(item.from);
    const to = candidateState(item.to);
    if (from !== replayed || !isLegalCandidateTransition(from, to)) {
      throw new MemoryValidationError(`illegal candidate transition ${from} -> ${to}`);
    }
    replayed = to;
    return {
      from,
      to,
      at: validDate(item.at, "transition.at"),
      reason: item.reason === undefined ? undefined : memoryString(item.reason, 500)
    };
  });
  if (state !== replayed) throw new MemoryValidationError(`candidate ${candidate.id} state does not match its transitions`);
  return {
    ...candidate,
    state,
    updatedAt: validDate(v.updatedAt, "candidate.updatedAt"),
    transitions
  };
}

export function validateCandidateLedger(v: unknown): CandidateLedger {
  if (!isRecord(v)) throw new MemoryValidationError("candidate ledger must be an object");
  if (v.schemaVersion !== CANDIDATE_LEDGER_SCHEMA_VERSION) {
    throw new MemoryValidationError(`unsupported candidate ledger schema version ${String(v.schemaVersion)}`);
  }
  if (!Array.isArray(v.candidates)) throw new MemoryValidationError("candidates must be an array");
  if (v.candidates.length > MAX_CANDIDATES_PER_RUN) {
    throw new MemoryValidationError(`candidates must not exceed ${MAX_CANDIDATES_PER_RUN} items`);
  }
  const ledger: CandidateLedger = {
    schemaVersion: CANDIDATE_LEDGER_SCHEMA_VERSION,
    revision: validateRevision(v.revision),
    runId: validateMemoryId(v.runId),
    projectPath: memoryString(v.projectPath, 1024),
    finalChecksDigest: memoryString(v.finalChecksDigest, 64),
    extensionVersion: memoryString(v.extensionVersion, 64),
    updatedAt: validDate(v.updatedAt, "updatedAt"),
    candidates: v.candidates.map(validateLedgerEntry)
  };
  const ids = new Set<string>();
  for (const candidate of ledger.candidates) {
    if (ids.has(candidate.id)) throw new MemoryValidationError(`duplicate candidate id: ${candidate.id}`);
    ids.add(candidate.id);
  }
  return ledger;
}

export function transitionCandidateState(
  ledger: CandidateLedger,
  candidateId: string,
  to: CandidateState,
  reason?: string,
  at: string = new Date().toISOString()
): CandidateLedger {
  const validated = validateCandidateLedger(ledger);
  const id = validateMemoryId(candidateId);
  const candidate = validated.candidates.find(item => item.id === id);
  if (!candidate) throw new MemoryValidationError(`candidate not found: ${id}`);
  if (!isLegalCandidateTransition(candidate.state, to)) {
    throw new MemoryValidationError(`illegal candidate transition ${candidate.state} -> ${to}`);
  }
  const timestamp = validDate(at, "transition.at");
  candidate.transitions.push({
    from: candidate.state,
    to,
    at: timestamp,
    reason: reason === undefined ? undefined : memoryString(reason, 500)
  });
  candidate.state = to;
  candidate.updatedAt = timestamp;
  validated.updatedAt = timestamp;
  return validated;
}
