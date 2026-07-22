import {
  AGENT_NAMES,
  ACCEPTANCE_COVERAGE_STATUSES,
  BUILT_IN_TOOLS,
  COMMAND_STATUSES,
  DEBUGGER_CATEGORIES,
  LESSON_CATEGORIES,
  PRE_IMPLEMENTATION_RESULTS,
  THINKING_LEVELS,
  type AcceptanceCoverage,
  type AgentConfig,
  type AgentName,
  type BuilderOutput,
  type CommandReport,
  type DebuggerOutput,
  type DocumenterOutput,
  type ExplorerOutput,
  type OrchestratorConfig,
  type PlanTask,
  type PlannerOutput,
  type ProposedLesson,
  type RepositoryEvidence,
  type ReviewOutput,
  SCHEMA_VERSION,
  type TesterOutput
} from "./types.js";
import { RoleCapabilityError, validateRoleTools } from "./role-capabilities.js";
import {
  MAX_CANDIDATES_PER_RUN,
  MAX_CANDIDATE_GUIDANCE_BYTES,
  MAX_CANDIDATE_TITLE_BYTES,
  MAX_EVIDENCE_DETAIL_BYTES,
  MAX_EVIDENCE_PER_LESSON
} from "./memory-types.js";
import { normalizeRepositoryPath, RepositoryPathError } from "./path-validation.js";

export class ValidationError extends Error {
  constructor(public readonly path: string, message: string) {
    super(`${path}: ${message}`);
    this.name = "ValidationError";
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new ValidationError(path, "expected an object");
  return value;
}

function string(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string") throw new ValidationError(path, "expected a string");
  if (!allowEmpty && !value.trim()) throw new ValidationError(path, "must not be empty");
  return value;
}

function boundedString(value: unknown, path: string, maxBytes: number): string {
  const result = string(value, path);
  if (Buffer.byteLength(result, "utf8") > maxBytes) throw new ValidationError(path, `must not exceed ${maxBytes} bytes`);
  return result;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new ValidationError(path, "expected a boolean");
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value)) {
    throw new ValidationError(path, "expected a finite integer");
  }
  if (value < minimum) throw new ValidationError(path, `must be >= ${minimum}`);
  return value;
}

function boundedInteger(value: unknown, path: string, minimum: number, maximum: number): number {
  const result = integer(value, path, minimum);
  if (result > maximum) throw new ValidationError(path, `must be <= ${maximum}`);
  return result;
}

function array<T>(value: unknown, path: string, reader: (item: unknown, path: string) => T): T[] {
  if (!Array.isArray(value)) throw new ValidationError(path, "expected an array");
  return value.map((item, index) => reader(item, `${path}[${index}]`));
}

function strings(value: unknown, path: string): string[] {
  return array(value, path, (item, itemPath) => string(item, itemPath));
}

function uniqueStrings(value: unknown, path: string, maximum = 20): string[] {
  const result = strings(value, path);
  if (result.length > maximum) throw new ValidationError(path, `must not contain more than ${maximum} items`);
  const seen = new Set<string>();
  for (let index = 0; index < result.length; index++) {
    if (seen.has(result[index])) throw new ValidationError(`${path}[${index}]`, "must not contain duplicates");
    seen.add(result[index]);
  }
  return result;
}

function repositoryPath(value: unknown, path: string, allowTrailingSlash = false): string {
  const result = string(value, path);
  try {
    return normalizeRepositoryPath(result, allowTrailingSlash);
  } catch (error) {
    if (error instanceof RepositoryPathError) throw new ValidationError(path, error.message);
    throw error;
  }
}

function repositoryPaths(value: unknown, path: string, allowTrailingSlash = false): string[] {
  return array(value, path, (item, itemPath) => repositoryPath(item, itemPath, allowTrailingSlash));
}

function enumValue<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new ValidationError(path, `expected one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseStructuredJson(text: string, label = "output"): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new ValidationError(label, "assistant returned empty output");

  try {
    return JSON.parse(trimmed) as unknown;
  } catch (rawError) {
    const markers = trimmed.match(/```/g)?.length ?? 0;
    const fenced = /```(?:json)?\s*\n?([\s\S]*?)\n?```/i.exec(trimmed);
    if (markers === 2 && fenced) {
      try {
        return JSON.parse(fenced[1].trim()) as unknown;
      } catch (fencedError) {
        const detail = fencedError instanceof Error ? fencedError.message : String(fencedError);
        throw new ValidationError(label, `invalid JSON (${detail})`);
      }
    }
    if (markers > 0) throw new ValidationError(label, "malformed JSON fence");
    const detail = rawError instanceof Error ? rawError.message : String(rawError);
    throw new ValidationError(label, `invalid JSON (${detail})`);
  }
}

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

function agentConfig(name: AgentName, value: unknown, path: string): AgentConfig {
  const item = record(value, path);
  const tools = array(item.tools, `${path}.tools`, (tool, toolPath) => {
    if (typeof tool === "string" && !BUILT_IN_TOOLS.includes(tool as (typeof BUILT_IN_TOOLS)[number])) {
      throw new ValidationError(toolPath, `custom extension tool ${JSON.stringify(tool)} is unsupported; migrate to a built-in-only SDK role session`);
    }
    return enumValue(tool, toolPath, BUILT_IN_TOOLS);
  });
  if (tools.length === 0) throw new ValidationError(`${path}.tools`, "must contain at least one built-in tool");
  try {
    validateRoleTools(name, tools);
  } catch (error) {
    if (error instanceof RoleCapabilityError) throw new ValidationError(`${path}.tools`, error.message);
    throw error;
  }
  const result: AgentConfig = {
    model: string(item.model, `${path}.model`),
    tools,
    promptFile: string(item.promptFile, `${path}.promptFile`)
  };
  if (item.thinking !== undefined) result.thinking = enumValue(item.thinking, `${path}.thinking`, THINKING_LEVELS);
  return result;
}

export function validateOrchestratorConfig(value: unknown, path = "config"): OrchestratorConfig {
  const item = record(value, path);
  const dashboard = record(item.dashboard, `${path}.dashboard`);
  const limits = record(item.limits, `${path}.limits`);
  const agentsValue = record(item.agents, `${path}.agents`);
  const agents = {} as Record<AgentName, AgentConfig>;
  for (const name of AGENT_NAMES) agents[name] = agentConfig(name, agentsValue[name], `${path}.agents.${name}`);
  const checks = strings(item.checks, `${path}.checks`);
  const schemaVersion = integer(item.schemaVersion, `${path}.schemaVersion`, 1);
  if (schemaVersion > SCHEMA_VERSION) {
    throw new ValidationError(`${path}.schemaVersion`, `unsupported future version ${schemaVersion}`);
  }
  const port = integer(dashboard.port, `${path}.dashboard.port`, 0);
  if (port > 65_535) throw new ValidationError(`${path}.dashboard.port`, "must be <= 65535");
  const humanInTheLoopValue = item.humanInTheLoop !== undefined ? record(item.humanInTheLoop, `${path}.humanInTheLoop`) : {};
  return {
    schemaVersion,
    checks,
    dashboard: {
      enabled: boolean(dashboard.enabled, `${path}.dashboard.enabled`),
      port
    },
    limits: {
      planRevisions: boundedInteger(limits.planRevisions, `${path}.limits.planRevisions`, 0, 1_000),
      implementationRetries: boundedInteger(limits.implementationRetries, `${path}.limits.implementationRetries`, 0, 1_000),
      reviewRevisions: boundedInteger(limits.reviewRevisions, `${path}.limits.reviewRevisions`, 0, 1_000),
      agentTimeoutMs: boundedInteger(limits.agentTimeoutMs, `${path}.limits.agentTimeoutMs`, 1, 2_147_483_647),
      checkTimeoutMs: boundedInteger(limits.checkTimeoutMs, `${path}.limits.checkTimeoutMs`, 1, 2_147_483_647),
      maxOutputBytes: boundedInteger(limits.maxOutputBytes, `${path}.limits.maxOutputBytes`, 1, 100_000_000),
      worktreeIsolation: boolean(limits.worktreeIsolation ?? false, `${path}.limits.worktreeIsolation`)
    },
    agents,
    humanInTheLoop: {
      planApproval: boolean(humanInTheLoopValue.planApproval ?? false, `${path}.humanInTheLoop.planApproval`),
      planRevisionApproval: boolean(humanInTheLoopValue.planRevisionApproval ?? false, `${path}.humanInTheLoop.planRevisionApproval`),
      confirmBeforeMutation: boolean(humanInTheLoopValue.confirmBeforeMutation ?? false, `${path}.humanInTheLoop.confirmBeforeMutation`)
    }
  };
}
