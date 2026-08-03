import { ACCEPTANCE_COVERAGE_STATUSES, COMMAND_STATUSES, INTERVIEW_QUESTION_KINDS, LESSON_CATEGORIES, MAX_INTERVIEW_CUSTOM_BYTES, MAX_INTERVIEW_OPTIONS, MAX_INTERVIEW_OPTION_BYTES, MAX_INTERVIEW_QUESTIONS, MAX_INTERVIEW_QUESTION_BYTES, MIN_INTERVIEW_OPTIONS, MIN_INTERVIEW_QUESTIONS, PRE_IMPLEMENTATION_RESULTS, type AcceptanceCoverage, type BuilderOutput, type CommandReport, type DocumenterOutput, type ExplorerOutput, type IndexedAcceptanceCriterion, type InterviewAnswer, type InterviewQAndA, type InterviewQuestion, type InterviewerOutput, type InterviewOption, type PlanTask, type PlannerOutput, type ProposedLesson, type RequirementsDocument, type ReviewOutput, type TesterOutput } from "../agent-task-types.js";
import { AGENT_NAMES, SUPPORTED_HANDOFF_ROLES } from "../agent-types.js";
import { DEBUGGER_CATEGORIES, WORKFLOW_ROUTES, type DebuggerOutput, type RepositoryEvidence } from "../workflow-shared.js";
import { validateAutomatedCriterionIndexes } from "../orchestration/acceptance-criteria.js";
import {
  MAX_CANDIDATES_PER_RUN,
  MAX_CANDIDATE_GUIDANCE_BYTES,
  MAX_CANDIDATE_TITLE_BYTES,
  MAX_EVIDENCE_DETAIL_BYTES,
  MAX_EVIDENCE_PER_LESSON
} from "../memory/memory-types.js";
import {
  ValidationError,
  array,
  boolean,
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
} from "../validation-core.js";

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
  const testSupportFiles = item.testSupportFiles === undefined
    ? undefined
    : repositoryPaths(item.testSupportFiles, `${path}.testSupportFiles`);
  return {
    id: string(item.id, `${path}.id`),
    description: string(item.description, `${path}.description`),
    files: repositoryPaths(item.files, `${path}.files`),
    ...(testSupportFiles ? { testSupportFiles } : {}),
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
  const route = enumValue(item.route, `${path}.route`, WORKFLOW_ROUTES);
  const tasks = array(item.tasks, `${path}.tasks`, planTask);
  validateTaskGraph(tasks, `${path}.tasks`);
  const acceptanceCriteria = strings(item.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (acceptanceCriteria.length === 0) throw new ValidationError(`${path}.acceptanceCriteria`, "must not be empty");
  const automatedIndexes = array(
    item.automatedAcceptanceCriteria,
    `${path}.automatedAcceptanceCriteria`,
    (v: unknown, p: string) => integer(v, p)
  );
  validateAutomatedCriterionIndexes(route, acceptanceCriteria, automatedIndexes, path);
  for (let index = 0; index < tasks.length; index++) {
    if (tasks[index].files.length === 0 && (tasks[index].testSupportFiles?.length ?? 0) === 0) {
      throw new ValidationError(`${path}.tasks[${index}].files`, "must not be empty unless testSupportFiles is non-empty");
    }
    const files = new Set(tasks[index].files);
    const overlap = (tasks[index].testSupportFiles ?? []).filter(file => files.has(file));
    if (overlap.length > 0) throw new ValidationError(`${path}.tasks[${index}].testSupportFiles`, `duplicates files: ${overlap.join(", ")}`);
    if (tasks[index].verification.length === 0) throw new ValidationError(`${path}.tasks[${index}].verification`, "must not be empty");
  }
  return {
    route,
    summary: string(item.summary, `${path}.summary`),
    assumptions: strings(item.assumptions, `${path}.assumptions`),
    acceptanceCriteria,
    automatedAcceptanceCriteria: automatedIndexes,
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

function mutationBlocker(item: Record<string, unknown>, path: string): BuilderOutput["blocker"] {
  if (item.blocker === undefined || item.blocker === null) return undefined;
  const blocked = record(item.blocker, `${path}.blocker`);
  const kind = enumValue(blocked.kind, `${path}.blocker.kind`, ["scope", "baseline_repair", "prerequisite_repair", "role_handoff", "environment", "tooling", "insufficient_evidence"] as const);
  const reason = string(blocked.reason, `${path}.blocker.reason`);
  if (kind === "scope") {
    const requiredFiles = repositoryPaths(blocked.requiredFiles, `${path}.blocker.requiredFiles`);
    if (requiredFiles.length === 0) throw new ValidationError(`${path}.blocker.requiredFiles`, "must not be empty for a scope blocker");
    return { kind: "scope", reason, requiredFiles };
  }
  if (kind === "role_handoff") {
    const requestedRole = enumValue(blocked.requestedRole, `${path}.blocker.requestedRole`, SUPPORTED_HANDOFF_ROLES);
    return { kind: "role_handoff", reason, requestedRole, requestedCapability: string(blocked.requestedCapability, `${path}.blocker.requestedCapability`), question: string(blocked.question, `${path}.blocker.question`), evidence: evidenceList(blocked.evidence, `${path}.blocker.evidence`) };
  }
  if (kind === "baseline_repair") {
    return { kind: "baseline_repair", reason, failedCheckCommands: strings(blocked.failedCheckCommands, `${path}.blocker.failedCheckCommands`), evidence: evidenceList(blocked.evidence, `${path}.blocker.evidence`) };
  }
  if (kind === "prerequisite_repair") {
    return { kind: "prerequisite_repair", reason, affectedFiles: repositoryPaths(blocked.affectedFiles, `${path}.blocker.affectedFiles`), evidence: evidenceList(blocked.evidence, `${path}.blocker.evidence`), verification: strings(blocked.verification, `${path}.blocker.verification`) };
  }
  if (kind === "insufficient_evidence") {
    const rawRoles = strings(blocked.suggestedRoles, `${path}.blocker.suggestedRoles`);
    const validRoles = ["explorer", "planner", "reviewer", "tester", "builder", "debugger", "documenter"] as const;
    const suggestedRoles = rawRoles.map((role, i) => enumValue(role, `${path}.blocker.suggestedRoles[${i}]`, validRoles));
    return { kind: "insufficient_evidence", reason, questions: strings(blocked.questions, `${path}.blocker.questions`), suggestedRoles, inspectedEvidence: evidenceList(blocked.inspectedEvidence, `${path}.blocker.inspectedEvidence`) };
  }
  return { kind, reason, diagnostics: strings(blocked.diagnostics, `${path}.blocker.diagnostics`), retryCondition: string(blocked.retryCondition, `${path}.blocker.retryCondition`), affectedCommands: strings(blocked.affectedCommands, `${path}.blocker.affectedCommands`) };
}

function mutationBase(value: unknown, path: string): BuilderOutput {
  const item = record(value, path);
  const blocker = mutationBlocker(item, path);
  return {
    summary: string(item.summary, `${path}.summary`),
    changedFiles: repositoryPaths(item.changedFiles, `${path}.changedFiles`),
    commands: array(item.commands, `${path}.commands`, commandReport),
    assumptions: strings(item.assumptions, `${path}.assumptions`),
    unresolvedIssues: strings(item.unresolvedIssues, `${path}.unresolvedIssues`),
    ...(blocker ? { blocker } : {})
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

export function validateTesterOutput(value: unknown, expectedCriteria: readonly IndexedAcceptanceCriterion[], path = "tester"): TesterOutput {
  const item = record(value, path);
  const base = mutationBase(item, path);
  const coverage = array(item.acceptanceCoverage, `${path}.acceptanceCoverage`, acceptanceCoverage);
  if (coverage.length !== expectedCriteria.length) {
    throw new ValidationError(`${path}.acceptanceCoverage`, `must contain exactly ${expectedCriteria.length} items for automated criteria`);
  }
  const expectedByIndex = new Map(expectedCriteria.map(c => [c.index, c.text]));
  const seen = new Set<number>();
  for (let index = 0; index < coverage.length; index++) {
    const entry = coverage[index];
    if (!expectedByIndex.has(entry.criterionIndex)) {
      throw new ValidationError(`${path}.acceptanceCoverage[${index}].criterionIndex`, "is not in the automated acceptance criteria set");
    }
    if (seen.has(entry.criterionIndex)) throw new ValidationError(`${path}.acceptanceCoverage[${index}].criterionIndex`, "must be unique");
    seen.add(entry.criterionIndex);
    const expectedText = expectedByIndex.get(entry.criterionIndex)!;
    if (entry.criterion !== expectedText) {
      throw new ValidationError(`${path}.acceptanceCoverage[${index}].criterion`, "must exactly match the indexed acceptance criterion");
    }
  }
  return {
    ...base,
    testsAdded: strings(item.testsAdded, `${path}.testsAdded`),
    acceptanceCoverage: coverage
  };
}

export function parseTesterOutput(text: string, expectedCriteria: readonly IndexedAcceptanceCriterion[]): TesterOutput {
  return validateTesterOutput(parseStructuredJson(text, "tester output"), expectedCriteria);
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
  const blocker = mutationBlocker(item, path);
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
    unresolvedIssues: strings(item.unresolvedIssues, `${path}.unresolvedIssues`),
    ...(blocker ? { blocker } : {})
  };
}

export function parseExplorerOutput(text: string): ExplorerOutput { return validateExplorerOutput(parseStructuredJson(text, "explorer output")); }
export function parsePlannerOutput(text: string): PlannerOutput { return validatePlannerOutput(parseStructuredJson(text, "planner output")); }
export function parseReviewOutput(text: string): ReviewOutput { return validateReviewOutput(parseStructuredJson(text, "reviewer output")); }
export function parseBuilderOutput(text: string): BuilderOutput { return validateBuilderOutput(parseStructuredJson(text, "builder output")); }
export function parseDebuggerOutput(text: string): DebuggerOutput { return validateDebuggerOutput(parseStructuredJson(text, "debugger output")); }
export function parseDocumenterOutput(text: string): DocumenterOutput { return validateDocumenterOutput(parseStructuredJson(text, "documenter output")); }

function interviewOption(value: unknown, path: string): InterviewOption {
  const item = record(value, path);
  const result: InterviewOption = {
    id: string(item.id, `${path}.id`),
    text: boundedString(item.text, `${path}.text`, MAX_INTERVIEW_OPTION_BYTES)
  };
  if (item.recommended !== undefined) result.recommended = boolean(item.recommended, `${path}.recommended`);
  return result;
}

function interviewQuestion(value: unknown, path: string): InterviewQuestion {
  const item = record(value, path);
  const options = array(item.options, `${path}.options`, interviewOption);
  if (options.length < MIN_INTERVIEW_OPTIONS) {
    throw new ValidationError(`${path}.options`, `must contain at least ${MIN_INTERVIEW_OPTIONS} options`);
  }
  if (options.length > MAX_INTERVIEW_OPTIONS) {
    throw new ValidationError(`${path}.options`, `must not contain more than ${MAX_INTERVIEW_OPTIONS} options`);
  }
  const ids = new Set<string>();
  const labels = new Set<string>();
  let recommendedCount = 0;
  for (let index = 0; index < options.length; index++) {
    const option = options[index];
    if (ids.has(option.id)) throw new ValidationError(`${path}.options[${index}].id`, `duplicate option id ${JSON.stringify(option.id)}`);
    ids.add(option.id);
    if (labels.has(option.text)) throw new ValidationError(`${path}.options[${index}].text`, "must not contain duplicate option labels");
    labels.add(option.text);
    if (option.recommended) recommendedCount++;
  }
  if (recommendedCount !== 1) throw new ValidationError(`${path}.options`, "must mark exactly one option as recommended");
  return {
    id: string(item.id, `${path}.id`),
    kind: enumValue(item.kind, `${path}.kind`, INTERVIEW_QUESTION_KINDS),
    text: boundedString(item.text, `${path}.text`, MAX_INTERVIEW_QUESTION_BYTES),
    options
  };
}

function interviewAnswer(value: unknown, question: InterviewQuestion, path: string): InterviewAnswer {
  const item = record(value, path);
  const questionId = string(item.questionId, `${path}.questionId`);
  if (questionId !== question.id) throw new ValidationError(`${path}.questionId`, `must match question id ${JSON.stringify(question.id)}`);
  const optionIds = new Set(question.options.map(option => option.id));
  const selectedOptionIds = array(item.selectedOptionIds, `${path}.selectedOptionIds`, (entry, entryPath) => string(entry, entryPath));
  for (let index = 0; index < selectedOptionIds.length; index++) {
    if (!optionIds.has(selectedOptionIds[index])) {
      throw new ValidationError(`${path}.selectedOptionIds[${index}]`, `unknown option id ${JSON.stringify(selectedOptionIds[index])}`);
    }
  }
  if (question.kind === "single" && selectedOptionIds.length > 1) {
    throw new ValidationError(`${path}.selectedOptionIds`, "must not contain more than one option for a single-choice question");
  }
  const customText = item.customText === undefined || item.customText === null
    ? undefined
    : boundedString(item.customText, `${path}.customText`, MAX_INTERVIEW_CUSTOM_BYTES);
  if (selectedOptionIds.length === 0 && customText === undefined) {
    throw new ValidationError(`${path}`, "must select an option or provide a custom answer");
  }
  const answer: InterviewAnswer = { questionId, selectedOptionIds };
  if (customText !== undefined) answer.customText = customText;
  return answer;
}

function interviewQAndA(value: unknown, path: string): InterviewQAndA {
  const item = record(value, path);
  const question = interviewQuestion(item.question, `${path}.question`);
  return { question, answer: interviewAnswer(item.answer, question, `${path}.answer`) };
}

export function validateInterviewerOutput(value: unknown, path = "interviewer"): InterviewerOutput {
  const item = record(value, path);
  const action = enumValue(item.action, `${path}.action`, ["ask_questions", "assess", "finalize"] as const);
  if (action === "ask_questions") {
    const questions = array(item.questions, `${path}.questions`, interviewQuestion);
    if (questions.length < MIN_INTERVIEW_QUESTIONS) {
      throw new ValidationError(`${path}.questions`, `must contain at least ${MIN_INTERVIEW_QUESTIONS} questions`);
    }
    if (questions.length > MAX_INTERVIEW_QUESTIONS) {
      throw new ValidationError(`${path}.questions`, `must not contain more than ${MAX_INTERVIEW_QUESTIONS} questions`);
    }
    const ids = new Set<string>();
    for (let index = 0; index < questions.length; index++) {
      if (ids.has(questions[index].id)) throw new ValidationError(`${path}.questions[${index}].id`, `duplicate question id ${JSON.stringify(questions[index].id)}`);
      ids.add(questions[index].id);
    }
    return { action: "ask_questions", questions };
  }
  if (action === "assess") {
    const assessment = record(item.assessment, `${path}.assessment`);
    const openQuestions = assessment.openQuestions === undefined
      ? undefined
      : strings(assessment.openQuestions, `${path}.assessment.openQuestions`);
    return {
      action: "assess",
      assessment: {
        goal: string(assessment.goal, `${path}.assessment.goal`),
        summary: string(assessment.summary, `${path}.assessment.summary`),
        ...(openQuestions ? { openQuestions } : {})
      }
    };
  }
  const report = record(item.report, `${path}.report`);
  const scope = strings(report.scope, `${path}.report.scope`);
  if (scope.length === 0) throw new ValidationError(`${path}.report.scope`, "must not be empty");
  const constraints = strings(report.constraints, `${path}.report.constraints`);
  if (constraints.length === 0) throw new ValidationError(`${path}.report.constraints`, "must not be empty");
  const acceptanceCriteria = strings(report.acceptanceCriteria, `${path}.report.acceptanceCriteria`);
  if (acceptanceCriteria.length === 0) throw new ValidationError(`${path}.report.acceptanceCriteria`, "must not be empty");
  return {
    action: "finalize",
    report: {
      goal: string(report.goal, `${path}.report.goal`),
      summary: string(report.summary, `${path}.report.summary`),
      openQuestions: strings(report.openQuestions, `${path}.report.openQuestions`),
      scope,
      constraints,
      acceptanceCriteria,
      qa: array(report.qa, `${path}.report.qa`, interviewQAndA)
    }
  };
}

export function parseInterviewerOutput(text: string): InterviewerOutput {
  return validateInterviewerOutput(parseStructuredJson(text, "interviewer output"));
}

export function validateRequirementsDocument(value: unknown, path = "requirements"): RequirementsDocument {
  const item = record(value, path);
  const schemaVersion = integer(item.schemaVersion, `${path}.schemaVersion`, 1);
  if (schemaVersion !== 1) throw new ValidationError(`${path}.schemaVersion`, "must be 1");
  const scope = strings(item.scope, `${path}.scope`);
  if (scope.length === 0) throw new ValidationError(`${path}.scope`, "must not be empty");
  const constraints = strings(item.constraints, `${path}.constraints`);
  if (constraints.length === 0) throw new ValidationError(`${path}.constraints`, "must not be empty");
  const acceptanceCriteria = strings(item.acceptanceCriteria, `${path}.acceptanceCriteria`);
  if (acceptanceCriteria.length === 0) throw new ValidationError(`${path}.acceptanceCriteria`, "must not be empty");
  return {
    schemaVersion: 1,
    goal: string(item.goal, `${path}.goal`),
    summary: string(item.summary, `${path}.summary`),
    scope,
    constraints,
    acceptanceCriteria,
    openQuestions: strings(item.openQuestions, `${path}.openQuestions`),
    qa: array(item.qa, `${path}.qa`, interviewQAndA),
    handoffRequest: string(item.handoffRequest, `${path}.handoffRequest`),
    createdAt: string(item.createdAt, `${path}.createdAt`)
  };
}
