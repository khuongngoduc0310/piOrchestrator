import type { PlannerOutput } from "../types.js";
import { normalizeRepositoryPath } from "../workspace/path-validation.js";
import { deriveMutationPathScope } from "../workspace/workspace-guard.js";

function normalizedUnique(files: readonly string[]): string[] {
  return [...new Set(files.map(file => normalizeRepositoryPath(file)))].sort();
}

export function filesOutsidePlan(plan: PlannerOutput, files: readonly string[]): string[] {
  const approved = new Set(deriveMutationPathScope(plan).planFiles);
  return normalizedUnique(files).filter(file => !approved.has(file));
}

export function validateFailureScopeRevision(
  previousPlan: PlannerOutput,
  revisedPlan: PlannerOutput,
  requiredFiles: readonly string[]
): PlannerOutput {
  if (revisedPlan.route !== previousPlan.route) throw new Error("Failure scope revision changed the selected route");
  if (JSON.stringify(revisedPlan.acceptanceCriteria) !== JSON.stringify(previousPlan.acceptanceCriteria)) {
    throw new Error("Failure scope revision changed approved acceptance criteria");
  }

  const previousFiles = deriveMutationPathScope(previousPlan).planFiles;
  const revisedFiles = deriveMutationPathScope(revisedPlan).planFiles;
  const previousSet = new Set(previousFiles);
  const revisedSet = new Set(revisedFiles);
  const required = filesOutsidePlan(previousPlan, requiredFiles);

  const removed = previousFiles.filter(file => !revisedSet.has(file));
  if (removed.length > 0) throw new Error(`Failure scope revision removed approved files: ${removed.join(", ")}`);

  const added = revisedFiles.filter(file => !previousSet.has(file));
  const requiredSet = new Set(required);
  const unrelated = added.filter(file => !requiredSet.has(file));
  const missing = required.filter(file => !revisedSet.has(file));
  if (unrelated.length > 0) throw new Error(`Failure scope revision added unrelated files: ${unrelated.join(", ")}`);
  if (missing.length > 0) throw new Error(`Failure scope revision omitted required files: ${missing.join(", ")}`);
  if (added.length === 0) throw new Error("Failure scope revision did not add any required files");

  return revisedPlan;
}
