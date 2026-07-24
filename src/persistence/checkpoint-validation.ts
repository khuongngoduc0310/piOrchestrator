import { AGENT_NAMES, SCHEMA_VERSION, WORKFLOW_ROUTES, type CheckResult, type OrchestratorConfig, type WorkflowState } from "../types.js";
import { validateOrchestratorConfig } from "../config/config-validation.js";
import {
  CHECKPOINT_CURSOR_KINDS,
  CHECKPOINT_SCHEMA_VERSION,
  type CheckpointPointer,
  type WorkflowCheckpoint
} from "./checkpoint-types.js";
import { ValidationError, array, boolean, enumValue, integer, record, string } from "../validation-core.js";
import { normalizeRepositoryPath } from "../workspace/path-validation.js";
import type { ValidatedFileAttestation } from "../workspace/workspace-attestation.js";

const STAGES = [
  "idle", "preflight", "exploring", "planning", "reviewing_plan", "human_review_plan",
  "human_review_revision", "human_confirm_mutation", "baseline", "creating_tests", "implementing",
  "testing", "debugging", "reviewing_code", "reviewing_repository", "documenting",
  "screening_lessons", "human_review_lessons", "promoting_memory", "reviewing_lessons",
  "paused", "completed", "failed", "cancelled"
] as const;
const STATE_STATUSES = ["running", "paused", "completed", "failed", "cancelled"] as const;
const STEP_STATUSES = ["running", "succeeded", "failed", "cancelled"] as const;
const SHA256 = /^[a-f0-9]{64}$/;
const CHECKPOINT_FILE = /^checkpoint-(\d{6})\.json$/;

function isoDate(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || !Number.isFinite(Date.parse(result))) {
    throw new ValidationError(path, "expected an ISO date-time");
  }
  return result;
}

function sha256(value: unknown, path: string): string {
  const result = string(value, path);
  if (!SHA256.test(result)) throw new ValidationError(path, "expected a lowercase SHA-256 digest");
  return result;
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) string(value, path, true);
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(path, "expected a finite number >= 0");
  }
  return value;
}

function validateUsage(value: unknown, path: string): void {
  const usage = record(value, path);
  for (const field of ["input", "output", "cacheRead", "cacheWrite", "cost"] as const) {
    nonNegativeNumber(usage[field], `${path}.${field}`);
  }
  for (const field of ["totalTokens", "reasoning", "cacheWrite1h"] as const) {
    if (usage[field] !== undefined) nonNegativeNumber(usage[field], `${path}.${field}`);
  }
  if (usage.costBreakdown !== undefined) {
    const costs = record(usage.costBreakdown, `${path}.costBreakdown`);
    for (const field of ["input", "output", "cacheRead", "cacheWrite"] as const) {
      nonNegativeNumber(costs[field], `${path}.costBreakdown.${field}`);
    }
  }
}

function repositoryPath(value: unknown, path: string): string {
  const result = string(value, path);
  try {
    const normalized = normalizeRepositoryPath(result);
    if (normalized !== result) throw new ValidationError(path, "must be a normalized repository-relative path");
    return normalized;
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError(path, error instanceof Error ? error.message : String(error));
  }
}

function validateBaselineContext(value: unknown, path: string): WorkflowCheckpoint["baselineContext"] {
  const baseline = record(value, path);
  optionalString(baseline.gitHead, `${path}.gitHead`);
  boolean(baseline.hasUncommittedChanges, `${path}.hasUncommittedChanges`);
  boolean(baseline.hasStagedChanges, `${path}.hasStagedChanges`);
  for (const field of ["diffVsHead", "stagedDiff", "diffArtifact", "stagedArtifact", "statusPorcelain"] as const) {
    optionalString(baseline[field], `${path}.${field}`);
  }
  array(baseline.untrackedFiles, `${path}.untrackedFiles`, (entry, entryPath) => string(entry, entryPath));
  return value as WorkflowCheckpoint["baselineContext"];
}

function validateBaselineReviewContext(value: unknown, path: string): WorkflowCheckpoint["baselineReviewContext"] {
  const review = record(value, path);
  validateBaselineContext(review.summary, `${path}.summary`);
  const artifacts = record(review.artifacts, `${path}.artifacts`);
  string(artifacts.baselineJson, `${path}.artifacts.baselineJson`);
  optionalString(artifacts.headDiffPatch, `${path}.artifacts.headDiffPatch`);
  optionalString(artifacts.stagedDiffPatch, `${path}.artifacts.stagedDiffPatch`);
  return value as WorkflowCheckpoint["baselineReviewContext"];
}

function validateWorktreeHandle(value: unknown, path: string): WorkflowCheckpoint["worktreeHandle"] {
  if (value === undefined) return undefined;
  const handle = record(value, path);
  for (const field of ["repositoryRoot", "sourceCwd", "worktreeRoot", "effectiveCwd", "baselineCommit"] as const) {
    string(handle[field], `${path}.${field}`);
  }
  string(handle.projectRelativePath, `${path}.projectRelativePath`, true);
  return value as WorkflowCheckpoint["worktreeHandle"];
}

function validateFileAttestation(value: unknown, path: string): ValidatedFileAttestation {
  const attestation = record(value, path);
  const state = enumValue(attestation.state, `${path}.state`, ["present", "deleted"] as const);
  const result: ValidatedFileAttestation = {
    path: repositoryPath(attestation.path, `${path}.path`),
    state,
    agent: enumValue(attestation.agent, `${path}.agent`, AGENT_NAMES),
    stepId: string(attestation.stepId, `${path}.stepId`),
    invocation: integer(attestation.invocation, `${path}.invocation`, 1)
  };
  if (state === "present") {
    return {
      ...result,
      hash: sha256(attestation.hash, `${path}.hash`),
      mode: integer(attestation.mode, `${path}.mode`),
      ...(attestation.symlinkTarget === undefined
        ? {}
        : { symlinkTarget: string(attestation.symlinkTarget, `${path}.symlinkTarget`, true) })
    };
  }
  if (attestation.hash !== undefined || attestation.mode !== undefined || attestation.symlinkTarget !== undefined) {
    throw new ValidationError(path, "deleted attestations must not contain file content fields");
  }
  return result;
}

export function validateWorkflowStateForResume(value: unknown, path = "state"): WorkflowState {
  const state = record(value, path);
  if (integer(state.schemaVersion, `${path}.schemaVersion`) !== SCHEMA_VERSION) {
    throw new ValidationError(`${path}.schemaVersion`, `expected ${SCHEMA_VERSION}`);
  }
  string(state.extensionVersion, `${path}.extensionVersion`);
  string(state.runId, `${path}.runId`);
  string(state.request, `${path}.request`);
  enumValue(state.route, `${path}.route`, WORKFLOW_ROUTES);
  string(state.cwd, `${path}.cwd`);
  string(state.runDir, `${path}.runDir`);
  enumValue(state.stage, `${path}.stage`, STAGES);
  enumValue(state.status, `${path}.status`, STATE_STATUSES);
  integer(state.attempt, `${path}.attempt`);
  isoDate(state.startedAt, `${path}.startedAt`);
  isoDate(state.updatedAt, `${path}.updatedAt`);
  const agents = record(state.agents, `${path}.agents`);
  for (const name of AGENT_NAMES) {
    const agent = record(agents[name], `${path}.agents.${name}`);
    enumValue(agent.status, `${path}.agents.${name}.status`, ["idle", ...STEP_STATUSES] as const);
    string(agent.model, `${path}.agents.${name}.model`, true);
  }
  array(state.steps, `${path}.steps`, (entry, entryPath) => {
    const step = record(entry, entryPath);
    string(step.id, `${entryPath}.id`);
    integer(step.sequence, `${entryPath}.sequence`, 1);
    enumValue(step.stage, `${entryPath}.stage`, STAGES);
    string(step.label, `${entryPath}.label`);
    enumValue(step.status, `${entryPath}.status`, STEP_STATUSES);
    isoDate(step.startedAt, `${entryPath}.startedAt`);
    if (step.invocations !== undefined) {
      array(step.invocations, `${entryPath}.invocations`, (item, itemPath) => {
        const invocation = record(item, itemPath);
        integer(invocation.sequence, `${itemPath}.sequence`, 1);
        enumValue(invocation.mode, `${itemPath}.mode`, ["execute", "correct_output"] as const);
        enumValue(invocation.status, `${itemPath}.status`, STEP_STATUSES);
        isoDate(invocation.startedAt, `${itemPath}.startedAt`);
        if (invocation.completedAt !== undefined) isoDate(invocation.completedAt, `${itemPath}.completedAt`);
        integer(invocation.messageCount, `${itemPath}.messageCount`);
        boolean(invocation.truncated, `${itemPath}.truncated`);
        if (invocation.usage !== undefined) validateUsage(invocation.usage, `${itemPath}.usage`);
        for (const field of ["provider", "model", "api", "stopReason"] as const) {
          optionalString(invocation[field], `${itemPath}.${field}`);
        }
        return item;
      });
    }
    return entry;
  });
  if (state.latestCheckpoint !== undefined) {
    const cp = record(state.latestCheckpoint, `${path}.latestCheckpoint`);
    integer(cp.number, `${path}.latestCheckpoint.number`, 1);
    enumValue(cp.cursor, `${path}.latestCheckpoint.cursor`, CHECKPOINT_CURSOR_KINDS);
    isoDate(cp.createdAt, `${path}.latestCheckpoint.createdAt`);
  }
  if (state.resumeBlockedReason !== undefined) {
    string(state.resumeBlockedReason, `${path}.resumeBlockedReason`);
  }
  return value as WorkflowState;
}

export function validateCheckResults(value: unknown, path = "checks"): CheckResult[] {
  return array(value, path, (entry, entryPath) => {
    const check = record(entry, entryPath);
    const exitCode = check.exitCode;
    if (exitCode !== null) integer(exitCode, `${entryPath}.exitCode`, 0);
    string(check.command, `${entryPath}.command`);
    string(check.stdout, `${entryPath}.stdout`, true);
    string(check.stderr, `${entryPath}.stderr`, true);
    boolean(check.stdoutTruncated, `${entryPath}.stdoutTruncated`);
    boolean(check.stderrTruncated, `${entryPath}.stderrTruncated`);
    const passed = boolean(check.passed, `${entryPath}.passed`);
    const timedOut = boolean(check.timedOut, `${entryPath}.timedOut`);
    const cancelled = boolean(check.cancelled, `${entryPath}.cancelled`);
    optionalString(check.executionError, `${entryPath}.executionError`);
    const successfulExit = exitCode === 0 && !timedOut && !cancelled && check.executionError === undefined;
    if (passed !== successfulExit) throw new ValidationError(`${entryPath}.passed`, "is inconsistent with the command result");
    isoDate(check.startedAt, `${entryPath}.startedAt`);
    isoDate(check.completedAt, `${entryPath}.completedAt`);
    integer(check.durationMs, `${entryPath}.durationMs`);
    return entry as CheckResult;
  });
}

export function validateCheckResultsAgainstCommands(value: unknown, commands: readonly string[], path = "checks"): CheckResult[] {
  const results = validateCheckResults(value, path);
  if (results.length !== commands.length) throw new ValidationError(path, `must contain exactly ${commands.length} configured commands`);
  for (let index = 0; index < commands.length; index++) {
    if (results[index].command !== commands[index]) {
      throw new ValidationError(`${path}[${index}].command`, `must equal configured command ${JSON.stringify(commands[index])}`);
    }
  }
  return results;
}

export function validateCheckpointPointer(value: unknown, path = "checkpointPointer"): CheckpointPointer {
  const pointer = record(value, path);
  if (integer(pointer.schemaVersion, `${path}.schemaVersion`) !== CHECKPOINT_SCHEMA_VERSION) {
    throw new ValidationError(`${path}.schemaVersion`, `expected ${CHECKPOINT_SCHEMA_VERSION}`);
  }
  const checkpointNumber = integer(pointer.checkpointNumber, `${path}.checkpointNumber`, 1);
  const fileName = string(pointer.fileName, `${path}.fileName`);
  const match = CHECKPOINT_FILE.exec(fileName);
  if (!match || Number(match[1]) !== checkpointNumber) {
    throw new ValidationError(`${path}.fileName`, "must be the numbered checkpoint basename");
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    runId: string(pointer.runId, `${path}.runId`),
    checkpointNumber,
    fileName,
    digest: sha256(pointer.digest, `${path}.digest`)
  };
}

export function validateWorkflowCheckpoint(value: unknown, path = "checkpoint"): WorkflowCheckpoint {
  const checkpoint = record(value, path);
  if (integer(checkpoint.schemaVersion, `${path}.schemaVersion`) !== CHECKPOINT_SCHEMA_VERSION) {
    throw new ValidationError(`${path}.schemaVersion`, `expected ${CHECKPOINT_SCHEMA_VERSION}`);
  }
  const cursor = record(checkpoint.cursor, `${path}.cursor`);
  enumValue(cursor.kind, `${path}.cursor.kind`, CHECKPOINT_CURSOR_KINDS);
  if (!("continuation" in cursor)) throw new ValidationError(`${path}.cursor.continuation`, "is required");
  const bindings = record(checkpoint.bindings, `${path}.bindings`);
  if (bindings.baselineChecks !== undefined) validateCheckResults(bindings.baselineChecks, `${path}.bindings.baselineChecks`);
  if (bindings.implementationChecks !== undefined) validateCheckResults(bindings.implementationChecks, `${path}.bindings.implementationChecks`);
  const state = validateWorkflowStateForResume(checkpoint.state, `${path}.state`);
  const runId = string(checkpoint.runId, `${path}.runId`);
  if (state.runId !== runId) throw new ValidationError(`${path}.state.runId`, "must match checkpoint runId");
  const memoryMode = checkpoint.memoryMode === undefined
    ? undefined
    : enumValue(checkpoint.memoryMode, `${path}.memoryMode`, ["untrusted", "disabled", "empty", "valid", "invalid", "scope_mismatch", "unsupported"] as const);
  const selectedMemoryIds = array(checkpoint.selectedMemoryIds, `${path}.selectedMemoryIds`, (entry, entryPath) => string(entry, entryPath));
  const validatedChangedFiles = array(checkpoint.validatedChangedFiles, `${path}.validatedChangedFiles`, repositoryPath);
  const validatedFileAttestations = array(
    checkpoint.validatedFileAttestations,
    `${path}.validatedFileAttestations`,
    validateFileAttestation
  );
  const attestationPaths = new Set<string>();
  for (const [index, attestation] of validatedFileAttestations.entries()) {
    if (attestationPaths.has(attestation.path)) {
      throw new ValidationError(`${path}.validatedFileAttestations[${index}].path`, "must be unique");
    }
    attestationPaths.add(attestation.path);
  }
  const changedFileSet = new Set(validatedChangedFiles);
  if (changedFileSet.size !== validatedChangedFiles.length) {
    throw new ValidationError(`${path}.validatedChangedFiles`, "must contain unique paths");
  }
  if (
    changedFileSet.size !== attestationPaths.size
    || [...changedFileSet].some(file => !attestationPaths.has(file))
  ) {
    throw new ValidationError(`${path}.validatedChangedFiles`, "must exactly match validated file attestations");
  }
  return {
    schemaVersion: CHECKPOINT_SCHEMA_VERSION,
    checkpointNumber: integer(checkpoint.checkpointNumber, `${path}.checkpointNumber`, 1),
    runId,
    createdAt: isoDate(checkpoint.createdAt, `${path}.createdAt`),
    workspaceDigest: sha256(checkpoint.workspaceDigest, `${path}.workspaceDigest`),
    workspaceRoot: string(checkpoint.workspaceRoot, `${path}.workspaceRoot`),
    config: validateOrchestratorConfig(checkpoint.config) as OrchestratorConfig,
    configDigest: sha256(checkpoint.configDigest, `${path}.configDigest`),
    memoryMode,
    memoryRevision: integer(checkpoint.memoryRevision, `${path}.memoryRevision`),
    memoryDigest: sha256(checkpoint.memoryDigest, `${path}.memoryDigest`),
    selectedMemoryIds,
    validatedChangedFiles,
    validatedFileAttestations,
    baselineRepaired: boolean(checkpoint.baselineRepaired, `${path}.baselineRepaired`),
    baselineContext: validateBaselineContext(checkpoint.baselineContext, `${path}.baselineContext`),
    baselineReviewContext: validateBaselineReviewContext(checkpoint.baselineReviewContext, `${path}.baselineReviewContext`),
    lessonStatus: enumValue(checkpoint.lessonStatus, `${path}.lessonStatus`, ["approved", "rejected", "skipped"] as const),
    mutationConfirmed: checkpoint.mutationConfirmed !== undefined
      ? boolean(checkpoint.mutationConfirmed, `${path}.mutationConfirmed`)
      : false,
    worktreeHandle: validateWorktreeHandle(checkpoint.worktreeHandle, `${path}.worktreeHandle`),
    state,
    cursor: checkpoint.cursor as WorkflowCheckpoint["cursor"],
    bindings: checkpoint.bindings as WorkflowCheckpoint["bindings"]
  };
}

export const validateCheckpoint = validateWorkflowCheckpoint;
