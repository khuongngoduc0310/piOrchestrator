import type { IndexedAcceptanceCriterion, PlannerOutput, WorkflowRoute } from "../agent-task-types.js";

export { type IndexedAcceptanceCriterion };

export function automatedCriteria(
  plan: Pick<PlannerOutput, "acceptanceCriteria" | "automatedAcceptanceCriteria">
): IndexedAcceptanceCriterion[] {
  return plan.automatedAcceptanceCriteria.map(index => ({
    index,
    text: plan.acceptanceCriteria[index]
  }));
}

export function allCriteriaIndexed(plan: PlannerOutput): IndexedAcceptanceCriterion[] {
  return plan.acceptanceCriteria.map((text, index) => ({ index, text }));
}

export const ROUTES_REQUIRING_AUTOMATED_CRITERIA: ReadonlySet<WorkflowRoute> = new Set([
  "implementation", "bug_fix"
] as WorkflowRoute[]);

export const ROUTES_BARRING_AUTOMATED_CRITERIA: ReadonlySet<WorkflowRoute> = new Set([
  "documentation_only"
] as WorkflowRoute[]);

export const ROUTES_REQUIRING_FULL_AUTOMATED_COVERAGE: ReadonlySet<WorkflowRoute> = new Set([
  "tests_only"
] as WorkflowRoute[]);

export function validateAutomatedCriterionIndexes(
  route: WorkflowRoute,
  criteria: readonly string[],
  indexes: readonly number[],
  basePath: string
): void {
  const path = `${basePath}.automatedAcceptanceCriteria`;
  const seen = new Set<number>();

  for (let i = 0; i < indexes.length; i++) {
    const idx = indexes[i];
    if (idx < 0) throw new Error(`${path}[${i}]: must not be negative`);
    if (idx >= criteria.length) throw new Error(`${path}[${i}]: criterion index ${idx} is outside acceptanceCriteria (0..${criteria.length - 1})`);
    if (seen.has(idx)) throw new Error(`${path}[${i}]: duplicate criterion index ${idx}`);
    seen.add(idx);
  }

  if (ROUTES_REQUIRING_FULL_AUTOMATED_COVERAGE.has(route) && indexes.length !== criteria.length) {
    throw new Error(`${path}: ${route} requires every acceptance criterion to be automated (${criteria.length} criteria, ${indexes.length} automated)`);
  }

  if (ROUTES_BARRING_AUTOMATED_CRITERIA.has(route) && indexes.length > 0) {
    throw new Error(`${path}: ${route} cannot declare automated acceptance criteria`);
  }

  if (ROUTES_REQUIRING_AUTOMATED_CRITERIA.has(route) && indexes.length === 0) {
    throw new Error(`${path}: ${route} requires at least one automated acceptance criterion`);
  }
}
