import type { AgentName, StepRecord } from "../types.js";
import type { WorkspaceDelta, WorkspaceFileSnapshot, WorkspaceSnapshot } from "./workspace-guard.js";
import { normalizeRepositoryPath } from "./path-validation.js";

export interface ValidatedFileAttestation {
  readonly path: string;
  readonly state: "present" | "deleted";
  readonly hash?: string;
  readonly mode?: number;
  readonly symlinkTarget?: string;
  readonly agent: AgentName;
  readonly stepId: string;
  readonly invocation: number;
}

export function createFileAttestations(
  agent: AgentName,
  step: StepRecord,
  delta: WorkspaceDelta,
  after: WorkspaceSnapshot
): ValidatedFileAttestation[] {
  const invocation = step.invocations?.at(-1)?.sequence ?? 1;
  return delta.changedFiles.map(rawPath => {
    const filePath = normalizeRepositoryPath(rawPath);
    const file = after.files[filePath];
    return file
      ? presentAttestation(filePath, file, agent, step.id, invocation)
      : {
          path: filePath,
          state: "deleted",
          agent,
          stepId: step.id,
          invocation
        };
  });
}

export function validateAttestedWorkspaceFiles(
  attestations: ReadonlyMap<string, ValidatedFileAttestation>,
  snapshot: WorkspaceSnapshot,
  paths: readonly string[]
): string[] {
  const violations: string[] = [];
  for (const rawPath of paths) {
    const filePath = normalizeRepositoryPath(rawPath);
    const attestation = attestations.get(filePath);
    if (!attestation) {
      violations.push(`${filePath} was not content-validated`);
      continue;
    }
    const actual = snapshot.files[filePath];
    if (attestation.state === "deleted") {
      if (actual) violations.push(`${filePath} reappeared after its validated deletion`);
      continue;
    }
    if (!actual) {
      violations.push(`${filePath} disappeared after validation`);
      continue;
    }
    if (
      actual.hash !== attestation.hash
      || actual.mode !== attestation.mode
      || actual.symlinkTarget !== attestation.symlinkTarget
    ) {
      violations.push(`${filePath} content changed after validation`);
    }
  }
  return violations;
}

function presentAttestation(
  filePath: string,
  file: WorkspaceFileSnapshot,
  agent: AgentName,
  stepId: string,
  invocation: number
): ValidatedFileAttestation {
  return {
    path: filePath,
    state: "present",
    hash: file.hash,
    mode: file.mode,
    ...(file.symlinkTarget === undefined ? {} : { symlinkTarget: file.symlinkTarget }),
    agent,
    stepId,
    invocation
  };
}
