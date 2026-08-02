import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { DashboardDecisionAction, DashboardDecisionQuestion, InterviewAnswer, InterviewQuestion, InterviewerAssessment } from "../types.js";
import { beginDecisionRace, type RaceWinner } from "../ui/decision-race.js";
import { RequirementsArrowTranslator } from "./requirements-keys.js";
import type { Deferred, InterviewActionResult, InterviewPresentation, QuestionChannel, TuiPrompt } from "./requirements-channel-types.js";
import {
  BACK_ACTION_LABEL,
  CANCEL_ACTION_LABEL,
  COMMIT_FINISH_ACTION,
  COMMIT_KEEP_ACTION,
  COMMIT_QUESTION,
  commitPresentation,
  mapTuiChoice,
  questionPresentation,
  REVIEW_QUESTION,
  REVIEW_YES_OPTION_ID,
  reviewPresentation,
  tuiQuestionLabels,
  type InterviewPresent
} from "./requirements-presentation.js";
import { RequirementsCancelledError, RequirementsDeferredError, type RequirementsSession } from "./requirements-session.js";

let decisionCounter = 0;

function nextDecisionId(): string {
  decisionCounter++;
  return `requirements-decision-${Date.now()}-${decisionCounter}`;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

interface InterviewInteraction {
  label: string;
  content: string;
  actions: readonly DashboardDecisionAction[];
  question: DashboardDecisionQuestion;
  prompt: (signal: AbortSignal) => Promise<InterviewActionResult | undefined>;
}

interface SetQuestionState {
  question: InterviewQuestion;
  picked: string[];
  customText?: string;
}

/** Mutable per-question state shared between the question's driver and the TUI hub. */
function hubQuestionLabel(channel: QuestionChannel, index: number): string {
  const marker = channel.completed ? "✓" : "○";
  if (!channel.completed) return `${marker} ${index + 1}. ${channel.question.text}`;
  const detail = channel.customText !== undefined
    ? "custom answer"
    : channel.picked
      .map(id => channel.question.options.find(option => option.id === id)?.text ?? id)
      .join(", ");
  return `${marker} ${index + 1}. ${channel.question.text} — ${detail}`;
}

interface SetDriverContext {
  round: number;
  setController: AbortController;
  /** Re-evaluates the commit question's armed state after every action. */
  armCommit: () => void;
  /** Marks the set committed (Finish round) and ends it. */
  setCommitted: () => void;
}

/** Shared round-commit flag; the hub and the drivers read it to tell commit aborts from cancels. */
interface CommittedRef {
  value: boolean;
}

/**
 * TUI arrow-key switch request: closes the answer dialog softly so the hub
 * loop can follow the target question. Called by the TUI arrow translator.
 */
export function requestSwitch(channel: QuestionChannel, target: "next" | "previous"): void {
  channel.switchTarget = target;
  channel.dialogAbort?.abort();
}

export async function askSet(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  questions: InterviewQuestion[],
  round: number
): Promise<void> {
  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  const channels: QuestionChannel[] = [
    ...questions.map(question => ({
      question,
      picked: [],
      completed: false,
      generation: 0,
      isCommit: false,
      armed: false,
      driverEnded: false
    })),
    {
      question: COMMIT_QUESTION,
      picked: [],
      completed: false,
      generation: 0,
      isCommit: true,
      armed: false,
      driverEnded: false
    }
  ];
  const commitChannel = channels[channels.length - 1];
  const setController = new AbortController();
  const committedRef: CommittedRef = { value: false };
  const setCommitted = (): void => {
    if (committedRef.value) return;
    committedRef.value = true;
    if (!setController.signal.aborted) setController.abort(new Error("Round committed"));
  };
  const armCommit = (): void => {
    const allAnswered = channels.every(candidate => candidate.isCommit || candidate.completed);
    if (allAnswered === commitChannel.armed) return;
    commitChannel.armed = allAnswered;
    publishQuestionSet(session, channels, round);
  };
  const onSessionAbort = (): void => {
    setController.abort(new Error("Requirements session ended"));
  };
  session.controller.signal.addEventListener("abort", onSessionAbort, { once: true });
  const translator = new RequirementsArrowTranslator(ctx, requestSwitch);
  try {
    armCommit();
    const driver: SetDriverContext = { round, setController, armCommit, setCommitted };
    const drivers = channels.map(channel =>
      driveQuestion(session, ctx, channels, channel, driver).catch(error => {
        if (!setController.signal.aborted) setController.abort(error);
        throw error;
      })
    );
    translator.register();
    const hubTask = (canPrompt
      ? hubLoop(session, ctx, channels, round, setController.signal, translator, committedRef).catch(error => {
          if (!setController.signal.aborted) setController.abort(error);
          throw error;
        })
      : Promise.resolve()
    ).finally(() => translator.setHubOpen(false));
    const [driversResult, hubResult] = await Promise.allSettled([Promise.all(drivers), hubTask]);
    if (!channels.every(channel => channel.isCommit || channel.completed)) {
      if (driversResult.status === "rejected") throw driversResult.reason;
      if (hubResult.status === "rejected") throw hubResult.reason;
      throw new Error("The question set ended without completing every question");
    }
    session.replaceRound(round, channels
      .filter(channel => !channel.isCommit)
      .map(channel => ({
        question: channel.question,
        answer: {
          questionId: channel.question.id,
          selectedOptionIds: channel.picked,
          ...(channel.customText !== undefined ? { customText: channel.customText } : {})
        },
        round
      })));
    session.publish();
  } finally {
    session.controller.signal.removeEventListener("abort", onSessionAbort);
    translator.unregister();
    if (!setController.signal.aborted) setController.abort(new Error("Question set complete"));
    session.pendingQuestions = [];
    session.publish();
  }
}

/** Recomputes whether the channel currently holds an answer. */
function refreshCompleted(channel: QuestionChannel): void {
  channel.completed = channel.picked.length > 0 || channel.customText !== undefined;
}

/** Waits until the channel is armed (commit question) or the set closes. */
async function waitForArmed(channel: QuestionChannel, setSignal: AbortSignal): Promise<void> {
  while (!channel.armed && !setSignal.aborted) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Drives one question's presentations until the question is answered or the set closes. */
async function driveQuestion(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  channels: QuestionChannel[],
  channel: QuestionChannel,
  driver: SetDriverContext
): Promise<void> {
  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  const setSignal = driver.setController.signal;
  if (channel.isCommit) {
    await waitForArmed(channel, setSignal);
    if (setSignal.aborted) {
      channel.driverEnded = true;
      return;
    }
  }
  while (true) {
    if (setSignal.aborted) {
      channel.driverEnded = true;
      return;
    }
    if (channel.isCommit && !channel.armed) {
      await waitForArmed(channel, setSignal);
      if (setSignal.aborted) {
        channel.driverEnded = true;
        return;
      }
      continue;
    }
    const question = channel.question;
    const picked = [...channel.picked];
    const presented = channel.isCommit
      ? commitPresentation(session)
      : questionPresentation(session, question, picked);
    const label = question.kind === "multiple" && picked.length > 0
      ? `${question.text} (${picked.length} selected)`
      : question.text;
    const race = beginDecisionRace<InterviewActionResult | undefined>({
      decisionId: nextDecisionId(),
      label,
      dashboard: session.dashboard,
      presentation: {
        format: "markdown",
        content: presented.content,
        actions: presented.actions,
        question: presented.question
      },
      signal: setSignal
    });
    race.register();
    channel.generation++;
    channel.decisionId = race.decisionId;
    channel.label = label;
    channel.presentation = presented;
    channel.prompt = undefined;
    channel.wake = undefined;
    publishQuestionSet(session, channels, driver.round);
    let winner: RaceWinner<InterviewActionResult | undefined>;
    try {
      winner = await race.race(canPrompt, signal => parkTuiPrompt(channel, signal));
    } catch (error) {
      channel.prompt = undefined;
      channel.decisionId = undefined;
      channel.label = undefined;
      channel.presentation = undefined;
      if (setSignal.aborted) {
        channel.driverEnded = true;
        return;
      }
      throw error;
    }
    channel.prompt = undefined;
    channel.decisionId = undefined;
    channel.label = undefined;
    channel.presentation = undefined;
    winner.acknowledge?.();
    const result = winner.result;
    if (result === undefined) continue;
    if (result.action === "cancel") {
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    if (channel.isCommit) {
      if (result.action === COMMIT_FINISH_ACTION) {
        if (!channels.every(candidate => candidate.isCommit || candidate.completed)) {
          // The gate reopened (e.g. a pick was reverted elsewhere); a stale
          // Finish round must not commit an incomplete set.
          resolveWake(channel);
          publishQuestionSet(session, channels, driver.round);
          continue;
        }
        channel.completed = true;
        resolveWake(channel);
        publishQuestionSet(session, channels, driver.round);
        driver.setCommitted();
        channel.driverEnded = true;
        return;
      }
      if (result.action === COMMIT_KEEP_ACTION) {
        resolveWake(channel);
        publishQuestionSet(session, channels, driver.round);
        continue;
      }
      resolveWake(channel);
      continue;
    }
    if (result.action === `custom:${question.id}`) {
      if (question.kind === "single") channel.picked = [];
      channel.customText = result.feedback;
      refreshCompleted(channel);
      // Re-publish this channel with the race that just answered it so the set
      // never transiently drops a presented question (the shared clear below
      // the race already ran; the re-present publish in the same tick replaces
      // this pre-pick presentation).
      channel.decisionId = race.decisionId;
      channel.label = label;
      channel.presentation = presented;
      resolveWake(channel);
      publishQuestionSet(session, channels, driver.round);
      driver.armCommit();
      continue;
    }
    const prefix = `opt:${question.id}:`;
    if (result.action.startsWith(prefix)) {
      const optionId = result.action.slice(prefix.length);
      if (question.options.some(option => option.id === optionId)) {
        if (question.kind === "single") {
          channel.picked = [optionId];
          channel.customText = undefined;
        } else {
          const index = channel.picked.indexOf(optionId);
          if (index === -1) channel.picked.push(optionId);
          else channel.picked.splice(index, 1);
        }
      }
      refreshCompleted(channel);
      // See the custom-action handler above: re-set the answered race's fields
      // so this channel is never omitted from the published set.
      channel.decisionId = race.decisionId;
      channel.label = label;
      channel.presentation = presented;
      resolveWake(channel);
      publishQuestionSet(session, channels, driver.round);
      driver.armCommit();
      continue;
    }
    throw new Error(`Unexpected interview action: ${result.action}`);
  }
}

/** Parks the TUI answer prompt on the channel; the hub coroutine drives the dialog. */
function parkTuiPrompt(channel: QuestionChannel, signal: AbortSignal): Promise<InterviewActionResult | undefined> {
  let resolve!: (result: InterviewActionResult | undefined) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<InterviewActionResult | undefined>((res, rej) => { resolve = res; reject = rej; });
  const onAbort = (): void => reject(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  channel.prompt = { signal, resolve, promise };
  return promise;
}

/** Resolves the hub's pending wake, telling it the driver consumed the answer. */
function resolveWake(channel: QuestionChannel): void {
  const wake = channel.wake;
  channel.wake = undefined;
  if (wake !== undefined) wake.resolve();
}

/** Waits for the driver to park a prompt or end. */
async function waitForPrompt(channel: QuestionChannel): Promise<TuiPrompt | undefined> {
  while (true) {
    if (channel.driverEnded) return undefined;
    if (channel.prompt !== undefined) return channel.prompt;
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Runs the TUI answer dialog for a parked prompt, returning the mapped action. */
async function tuiAnswerDialog(
  ctx: ExtensionCommandContext,
  channel: QuestionChannel,
  signal: AbortSignal
): Promise<InterviewActionResult | undefined> {
  const question = channel.question;
  const picked = [...channel.picked];
  const label = question.kind === "multiple" && picked.length > 0
    ? `${question.text} (${picked.length} selected)`
    : question.text;
  const dialogController = new AbortController();
  channel.dialogAbort = dialogController;
  try {
    const dialogSignal = AbortSignal.any([signal, dialogController.signal]);
    const labels = [
      ...tuiQuestionLabels(question, picked, question.id !== COMMIT_QUESTION.id),
      BACK_ACTION_LABEL
    ];
    const choice = await ctx.ui.select(label, labels, { signal: dialogSignal });
    if (choice === undefined) return undefined;
    const mapped = mapTuiChoice(question, choice);
    if (mapped?.action === `custom:${question.id}`) {
      channel.customInputOpen = true;
      try {
        const text = await ctx.ui.input(`Your own answer for: ${question.text}`, undefined, { signal: dialogSignal });
        if (text === undefined) return undefined;
        return { action: `custom:${question.id}`, feedback: text.trim() };
      } finally {
        channel.customInputOpen = false;
      }
    }
    return mapped;
  } catch (error) {
    if (channel.switchTarget !== undefined || (error instanceof Error && error.name === "AbortError")) return undefined;
    throw error;
  } finally {
    channel.dialogAbort = undefined;
  }
}

/**
 * Opens the question's TUI answer dialog on behalf of the hub, resolving the
 * parked prompt with the user's answer and awaiting the driver's consumption.
 * The dialog stays open after an answer so the user can revise it in place.
 */
async function answerQuestionViaTui(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  channel: QuestionChannel,
  round: number,
  translator?: RequirementsArrowTranslator
): Promise<void> {
  translator?.setDialogChannel(channel);
  try {
    while (true) {
      const prompt = await waitForPrompt(channel);
      if (prompt === undefined) return;
      const result = await tuiAnswerDialog(ctx, channel, prompt.signal);
      if (result === undefined) return;
      const wake = deferred<void>();
      channel.wake = wake;
      prompt.resolve(result);
      await wake.promise;
    }
  } finally {
    translator?.setDialogChannel(undefined);
  }
}

/** The round's question hub: pick a question to answer, finish the round, or cancel. */
async function hubLoop(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  channels: QuestionChannel[],
  round: number,
  setSignal: AbortSignal,
  translator?: RequirementsArrowTranslator,
  committedRef?: CommittedRef
): Promise<void> {
  translator?.setHubOpen(true);
  let hubPosition = 0;
  while (true) {
    const realChannels = channels.filter(channel => !channel.isCommit);
    const answeredCount = realChannels.filter(channel => channel.completed).length;
    const entries = channels
      .map((channel, index) => ({ channel, index, label: hubQuestionLabel(channel, index) }))
      .filter(entry => !entry.channel.isCommit || entry.channel.armed);
    translator?.setHubListCount(entries.length);
    translator?.setHubPosition(hubPosition);
    const hubChoices = [
      ...entries.map(entry => entry.label),
      CANCEL_ACTION_LABEL
    ];
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(`Questions (round ${round}) — ${answeredCount}/${realChannels.length} answered`, hubChoices, { signal: setSignal });
    } catch (error) {
      if (committedRef?.value === true) return;
      throw error;
    }
    if (choice === undefined || choice === CANCEL_ACTION_LABEL) {
      if (committedRef?.value === true) return;
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    const chosen = entries.find(entry => entry.label === choice);
    if (chosen === undefined) continue;
    hubPosition = chosen.index;
    const target = followSwitchTarget(channels, channels[chosen.index]);
    if (target === undefined) continue;
    await answerQuestionViaTui(session, ctx, target, round, translator);
    if (committedRef?.value === true) return;
  }
}

/** Follows chained arrow-key switch requests, clearing each consumed target. */
function followSwitchTarget(channels: QuestionChannel[], channel: QuestionChannel): QuestionChannel | undefined {
  let current = channel;
  while (current.switchTarget !== undefined) {
    const target = current.switchTarget;
    current.switchTarget = undefined;
    const index = channels.indexOf(current);
    const nextIndex = target === "next" ? index + 1 : index - 1;
    if (nextIndex < 0 || nextIndex >= channels.length) return undefined;
    current = channels[nextIndex];
  }
  if (current.isCommit && !current.armed) return undefined;
  return current;
}

/** Publishes the round's question set as dashboard-answerable pending questions. */
function publishQuestionSet(
  session: RequirementsSession,
  channels: QuestionChannel[],
  round: number
): void {
  session.status = "waiting";
  session.waitingFor = `Answering questions (round ${round})`;
  session.pendingDecision = undefined;
  session.pendingQuestions = [];
  for (const channel of channels) {
    const decisionId = channel.decisionId;
    const presentation = channel.presentation;
    const label = channel.label;
    if (decisionId === undefined || presentation === undefined || label === undefined) continue;
    session.pendingQuestions.push({
      decisionId,
      questionId: channel.question.id,
      kind: channel.question.kind,
      label,
      content: presentation.content,
      actions: presentation.actions,
      question: presentation.question,
      answered: channel.completed
    });
  }
  session.publish();
}

async function askQuestion(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  state: SetQuestionState,
  round: number,
  present: InterviewPresent = questionPresentation
): Promise<InterviewAnswer | undefined> {
  const question = state.question;
  const picked: string[] = [...state.picked];
  while (true) {
    const presented = present(session, question, picked);
    const label = question.kind === "multiple" && picked.length > 0
      ? `${question.text} (${picked.length} selected)`
      : question.text;
    const interaction: InterviewInteraction = {
      label,
      content: presented.content,
      actions: presented.actions,
      question: presented.question,
      prompt: async signal => {
        const choice = await ctx.ui.select(label, tuiQuestionLabels(question, picked), { signal });
        if (choice === undefined) return undefined;
        const mapped = mapTuiChoice(question, choice);
        if (mapped?.action === `custom:${question.id}`) {
          const text = await ctx.ui.input(`Your own answer for: ${question.text}`, undefined, { signal });
          if (text === undefined) return undefined;
          return { action: `custom:${question.id}`, feedback: text.trim() };
        }
        return mapped;
      }
    };
    const result = await raceDecision(session, ctx, interaction, session.controller.signal, { deferOnUndefined: false });
    if (result === undefined) return undefined;
    if (result.action === "cancel") {
      throw new RequirementsCancelledError("Requirements interview cancelled by the user; no artifact was written");
    }
    if (result.action === `custom:${question.id}`) {
      if (question.kind === "single") {
        return { questionId: question.id, selectedOptionIds: [], customText: result.feedback };
      }
      return { questionId: question.id, selectedOptionIds: picked, customText: result.feedback };
    }
    const prefix = `opt:${question.id}:`;
    if (result.action.startsWith(prefix)) {
      const optionId = result.action.slice(prefix.length);
      if (question.options.some(option => option.id === optionId)) {
        if (question.kind === "single") {
          picked.length = 0;
          picked.push(optionId);
          return { questionId: question.id, selectedOptionIds: picked };
        }
        const index = picked.indexOf(optionId);
        if (index === -1) picked.push(optionId);
        else picked.splice(index, 1);
      }
      if (question.kind === "single") return { questionId: question.id, selectedOptionIds: picked };
      continue;
    }
    throw new Error(`Unexpected interview action: ${result.action}`);
  }
}

export async function askReview(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  assessment: InterviewerAssessment,
  round: number
): Promise<{ clear: boolean; feedback?: string } | undefined> {
  const answer = await askQuestion(
    session,
    ctx,
    { question: REVIEW_QUESTION, picked: [] },
    round,
    (s, question, picked) => reviewPresentation(assessment, s, question, picked)
  );
  if (answer === undefined) return undefined;
  if (answer.selectedOptionIds.includes(REVIEW_YES_OPTION_ID)) return { clear: true };
  return {
    clear: false,
    ...(answer.customText !== undefined ? { feedback: answer.customText } : {})
  };
}

async function raceDecision(
  session: RequirementsSession,
  ctx: ExtensionCommandContext,
  interaction: InterviewInteraction,
  signal: AbortSignal,
  options: { deferOnUndefined?: boolean } = {}
): Promise<InterviewActionResult | undefined> {
  if (signal.aborted) throw new RequirementsCancelledError("Requirements interview cancelled");
  const canPrompt = ctx.hasUI && ctx.mode !== "json" && ctx.mode !== "print";
  if (!canPrompt && !session.dashboard.isListening) {
    throw new RequirementsDeferredError(interaction.label);
  }
  const decisionId = nextDecisionId();
  const race = beginDecisionRace<InterviewActionResult | undefined>({
    decisionId,
    label: interaction.label,
    dashboard: session.dashboard,
    presentation: {
      format: "markdown",
      content: interaction.content,
      actions: interaction.actions,
      question: interaction.question
    },
    signal
  });
  race.register();
  session.pendingDecision = {
    id: decisionId,
    kind: "requirements_question",
    label: interaction.label,
    requestedAt: session.timestamp(),
    dashboardAvailable: true
  };
  session.status = "waiting";
  session.waitingFor = interaction.label;
  session.publish();

  let winner: RaceWinner<InterviewActionResult | undefined>;
  try {
    winner = await race.race(canPrompt, interaction.prompt);
  } catch (error) {
    session.status = "running";
    session.waitingFor = undefined;
    session.pendingDecision = undefined;
    session.publish();
    throw error;
  }

  session.status = "running";
  session.waitingFor = undefined;
  session.pendingDecision = undefined;
  session.publish();
  winner.acknowledge?.();

  if (winner.result === undefined) {
    if (options.deferOnUndefined === false) return undefined;
    throw new RequirementsDeferredError(interaction.label);
  }
  return winner.result;
}
