import {
  ACCEPTANCE_COVERAGE_STATUSES,
  AGENT_NAMES,
  COMMAND_STATUSES,
  DEBUGGER_CATEGORIES,
  LESSON_CATEGORIES,
  PRE_IMPLEMENTATION_RESULTS,
  type AcceptanceCoverage,
  type BuilderOutput,
  type CommandReport,
  type DebuggerOutput,
  type DocumenterOutput,
  type ExplorerOutput,
  type PlanTask,
  type PlannerOutput,
  type ProposedLesson,
  type RepositoryEvidence,
  type ReviewOutput,
  type TesterOutput
} from "./types.js";
import {
  MAX_CANDIDATES_PER_RUN,
  MAX_CANDIDATE_GUIDANCE_BYTES,
  MAX_CANDIDATE_TITLE_BYTES,
  MAX_EVIDENCE_DETAIL_BYTES,
  MAX_EVIDENCE_PER_LESSON
} from "./memory-types.js";
import {
  ValidationError,
  array,
  boundedString,
  enumValue,
  integer,
  parseStructuredJson,
  record,
  repositoryPath,
  repositoryPaths,
  string,
  strings,
  uniqueStrings
} from "./validation-core.js";

function evidence(value: unknown, path: string): RepositoryEvidence {
  const item = record(value, path);
  return {
    path: repositoryPath(item.path, `${path}.path`),
    detail: boundedString(item.detail, `${path}.detail`, MAX_EVIDENCE_DETAIL_BYTES)
  };
}

function evidenceList(value: unknown, path: string, requireOne = true): RepositoryEvidence[] {
  const result = array(value, path, evidence);
  if (requireOne && result.length === 0) throw new ValidationError(path, "must contain repository evidence");
  return result;
}

function commandReport(value: unknown, path: string): CommandReport {
  const item = record(value, path);
  return {
    command: string(item.command, `${path}.command`),
    status: enumValue(item.status, `${path}.status`, COMMAND_STATUSES),
    evidence: string(item.evidence, `${path}.evidence`)
  };
}

export function validateExplorerOutput(value: unknown, path = "explorer"): ExplorerOutput {
  const item = record(value, path);
  return {
    architecture: string(item.architecture, `${path}.architecture`),
    relevantFiles: repositoryPaths(item.relevantFiles, `${path}.relevantFiles`),
    conventions: strings(item.conventions, `${path}.conventions`),
    similarImplementations: strings(item.similarImplementations, `${path}.similarImplementations`),
    commands: strings(item.commands, `${path}.commands`),
    risks: strings(item.risks, `${path}.risks`),
    knownLessons: strings(item.knownLessons, `${path}.knownLessons`),
    evidence: evidenceList(item.evidence, `${path}.evidence`)
  };
}

function planTask(value: unknown, path: string): PlanTask {
  const item = record(value, path);
  return {
    id: string(item.id, `${path}.id`),
    description: string(item.description, `${path}.description`),
    files: repositoryPaths(item.files, `${path}.files`),
    dependencies: strings(item.dependencies, `${path}.dependencies`),
    verification: strings(item.verification, `${path}.verification`)
  };
}

function validateTaskGraph(tasks: PlanTask[], path: string): void {
  if (tasks.length === 0) throw new ValidationError(path, "must contain at least one task");
  const ids = new Set<string>();
  for (let index = 0; index < tasks.length; index++) {
    const id = tasks[index].id;
    if (ids.has(id)) throw new ValidationError(`${path}[${index}].id`, `duplicate task id ${JSON.stringify(id)}`);
    ids.add(id);
  }
  for (let index = 0; index < tasks.length; index++) {
    for (let dependencyIndex = 0; dependencyIndex < tasks[index].dependencies.length; dependencyIndex++) {
      const dependency = tasks[index].dependencies[dependencyIndex];
      const dependencyPath = `${path}[${index}].dependencies[${dependencyIndex}]`;
      if (dependency === tasks[index].id) throw new ValidationError(dependencyPath, "task cannot depend on itself");
      if (!ids.has(dependency)) throw new ValidationError(dependencyPath, `unknown task id ${JSON.stringify(dependency)}`);
    }
  }
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new ValidationError(path, `dependency cycle detected at ${JSON.stringify(id)}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id)?.dependencies ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const task of tasks) visit(task.id);
}

export function validatePlannerOutput(value: unknown, path = "plan"): PlannerOutput {
  const item = record(value, path);
  const tasks = array(item.tasks, `${path}.tasks`, planTask);
  validateTaskGraph(tasks, `${path}.tasks`);
  const acceptanceCriteria = strings(item.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (acceptanceCriteria.length === 0) throw new ValidationError(`${path}.acceptanceCriteria`, "must not be empty");
  for (let index = 0; index < tasks.length; index++) {
    if (tasks[index].files.length === 0) throw new ValidationError(`${path}.tasks[${index}].files`, "must not be empty");
    if (tasks[index].verification.length === 0) throw new ValidationError(`${path}.tasks[${index}].verification`, "must not be empty");
  }
  return {
    summary: string(item.summary, `${path}.summary`),
    assumptions: strings(item.assumptions, `${path}.assumptions`),
    acceptanceCriteria,
    tasks,
    risks: strings(item.risks, `${path}.risks`)
  };
}

export function validateReviewOutput(value: unknown, path = "review"): ReviewOutput {
  const item = record(value, path);
  const decision = enumValue(item.decision, `${path}.decision`, ["approved", "changes_requested"] as const);
  const blockingIssues = strings(item.blockingIssues, `${path}.blockingIssues`);
  if (decision === "approved" && blockingIssues.length > 0) {
    throw new ValidationError(`${path}.blockingIssues`, "must be empty when decision is approved");
  }
  if (decision === "changes_requested" && blockingIssues.length === 0) {
    throw new ValidationError(`${path}.blockingIssues`, "must contain at least one blocking issue");
  }
  return {
    decision,
    blockingIssues,
    suggestions: strings(item.suggestions, `${path}.suggestions`),
    evidence: evidenceList(item.evidence, `${path}.evidence`)
  };
}

function mutationBase(value: unknown, path: string): Omit<BuilderOutput, never> {
  const item = record(value, path);
  return {
    summary: string(item.summary, `${path}.summary`),
    changedFiles: repositoryPaths(item.changedFiles, `${path}.changedFiles`),
    commands: array(item.commands, `${path}.commands`, commandReport),
    assumptions: strings(item.assumptions, `${path}.assumptions`),
    unresolvedIssues: strings(item.unresolvedIssues, `${path}.unresolvedIssues`)
  };
}

export function validateBuilderOutput(value: unknown, path = "builder"): BuilderOutput {
  return mutationBase(value, path);
}

function acceptanceCoverage(value: unknown, path: string): AcceptanceCoverage {
  const item = record(value, path);
  const status = enumValue(item.status, `${path}.status`, ACCEPTANCE_COVERAGE_STATUSES);
  const tests = strings(item.tests, `${path}.tests`);
  const evidenceText = string(item.evidence, `${path}.evidence`);
  if (status === "covered" && tests.length === 0) throw new ValidationError(`${path}.tests`, "must not be empty when status is covered");
  if (status === "partially_covered" && tests.length === 0) throw new ValidationError(`${path}.tests`, "must not be empty when status is partially_covered");
  if (status === "not_covered" && tests.length > 0) throw new ValidationError(`${path}.tests`, "must be empty when status is not_covered");
  return {
    criterionIndex: integer(item.criterionIndex, `${path}.criterionIndex`),
    criterion: string(item.criterion, `${path}.criterion`),
    status,
    tests,
    preImplementationResult: enumValue(item.preImplementationResult, `${path}.preImplementationResult`, PRE_IMPLEMENTATION_RESULTS),
    evidence: evidenceText
  };
}

export function validateTesterOutput(value: unknown, acceptanceCriteria: readonly string[], path = "tester"): TesterOutput {
  const item = record(value, path);
  const base = mutationBase(item, path);
  const coverage = array(item.acceptanceCoverage, `${path}.acceptanceCoverage`, acceptanceCoverage);
  if (coverage.length !== acceptanceCriteria.length) {
    throw new ValidationError(`${path}.acceptanceCoverage`, `must contain exactly ${acceptanceCriteria.length} items`);
  }
  const seen = new Set<number>();
  for (let index = 0; index < coverage.length; index++) {
    const entry = coverage[index];
    if (entry.criterionIndex >= acceptanceCriteria.length) {
      throw new ValidationError(`${path}.acceptanceCoverage[${index}].criterionIndex`, "is outside the acceptance criteria range");
    }
    if (seen.has(entry.criterionIndex)) throw new ValidationError(`${path}.acceptanceCoverage[${index}].criterionIndex`, "must be unique");
    seen.add(entry.criterionIndex);
    if (entry.criterion !== acceptanceCriteria[entry.criterionIndex]) {
      throw new ValidationError(`${path}.acceptanceCoverage[${index}].criterion`, "must exactly match the indexed acceptance criterion");
    }
  }
  return {
    ...base,
    testsAdded: strings(item.testsAdded, `${path}.testsAdded`),
    acceptanceCoverage: coverage
  };
}

export function validateDebuggerOutput(value: unknown, path = "debugger"): DebuggerOutput {
  const item = record(value, path);
  return {
    category: enumValue(item.category, `${path}.category`, DEBUGGER_CATEGORIES),
    rootCause: string(item.rootCause, `${path}.rootCause`),
    evidence: evidenceList(item.evidence, `${path}.evidence`),
    recommendedFix: string(item.recommendedFix, `${path}.recommendedFix`),
    affectedFiles: repositoryPaths(item.affectedFiles, `${path}.affectedFiles`),
    confidence: enumValue(item.confidence, `${path}.confidence`, ["low", "medium", "high"] as const)
  };
}

function proposedLesson(value: unknown, path: string): ProposedLesson {
  const item = record(value, path);
  const scope = record(item.scope, `${path}.scope`);
  const roles = array(scope.roles, `${path}.scope.roles`, (role, rolePath) => enumValue(role, rolePath, AGENT_NAMES));
  if (roles.length > 20) throw new ValidationError(`${path}.scope.roles`, "must not contain more than 20 items");
  if (new Set(roles).size !== roles.length) throw new ValidationError(`${path}.scope.roles`, "must not contain duplicates");
  const paths = repositoryPaths(scope.paths, `${path}.scope.paths`, true);
  if (paths.length > 20) throw new ValidationError(`${path}.scope.paths`, "must not contain more than 20 items");
  if (new Set(paths).size !== paths.length) throw new ValidationError(`${path}.scope.paths`, "must not contain duplicates");
  const categories = array(scope.categories, `${path}.scope.categories`, (category, categoryPath) => enumValue(category, categoryPath, LESSON_CATEGORIES));
  if (categories.length > 20) throw new ValidationError(`${path}.scope.categories`, "must not contain more than 20 items");
  if (new Set(categories).size !== categories.length) throw new ValidationError(`${path}.scope.categories`, "must not contain duplicates");
  const keywords = uniqueStrings(scope.keywords, `${path}.scope.keywords`);
  if (roles.length + paths.length + categories.length + keywords.length === 0) {
    throw new ValidationError(`${path}.scope`, "must have at least one non-empty scope dimension");
  }
  const lessonEvidence = evidenceList(item.evidence, `${path}.evidence`);
  if (lessonEvidence.length === 0) throw new ValidationError(`${path}.evidence`, "must not be empty");
  if (lessonEvidence.length > MAX_EVIDENCE_PER_LESSON) {
    throw new ValidationError(`${path}.evidence`, `must not contain more than ${MAX_EVIDENCE_PER_LESSON} items`);
  }
  return {
    title: boundedString(item.title, `${path}.title`, MAX_CANDIDATE_TITLE_BYTES),
    lesson: boundedString(item.lesson, `${path}.lesson`, MAX_CANDIDATE_GUIDANCE_BYTES),
    scope: { roles, paths, categories, keywords },
    evidence: lessonEvidence
  };
}

export function validateDocumenterOutput(value: unknown, path = "documenter"): DocumenterOutput {
  const item = record(value, path);
  const proposedLessons = array(item.proposedLessons, `${path}.proposedLessons`, proposedLesson);
  if (proposedLessons.length > MAX_CANDIDATES_PER_RUN) {
    throw new ValidationError(`${path}.proposedLessons`, `must not contain more than ${MAX_CANDIDATES_PER_RUN} items`);
  }
  return {
    summary: string(item.summary, `${path}.summary`),
    changedFiles: repositoryPaths(item.changedFiles, `${path}.changedFiles`),
    documentationChanges: strings(item.documentationChanges, `${path}.documentationChanges`),
    proposedLessons,
    commands: array(item.commands, `${path}.commands`, commandReport),
    unresolvedIssues: strings(item.unresolvedIssues, `${path}.unresolvedIssues`)
  };
}

export function parseExplorerOutput(text: string): ExplorerOutput { return validateExplorerOutput(parseStructuredJson(text, "explorer output")); }
export function parsePlannerOutput(text: string): PlannerOutput { return validatePlannerOutput(parseStructuredJson(text, "planner output")); }
export function parseReviewOutput(text: string): ReviewOutput { return validateReviewOutput(parseStructuredJson(text, "reviewer output")); }
export function parseTesterOutput(text: string, acceptanceCriteria: readonly string[]): TesterOutput {
  return validateTesterOutput(parseStructuredJson(text, "tester output"), acceptanceCriteria);
}
export function parseBuilderOutput(text: string): BuilderOutput { return validateBuilderOutput(parseStructuredJson(text, "builder output")); }
export function parseDebuggerOutput(text: string): DebuggerOutput { return validateDebuggerOutput(parseStructuredJson(text, "debugger output")); }
export function parseDocumenterOutput(text: string): DocumenterOutput { return validateDocumenterOutput(parseStructuredJson(text, "documenter output")); }
