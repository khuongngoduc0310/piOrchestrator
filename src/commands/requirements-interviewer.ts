import {
  AgentCancelledError,
  AgentIncompleteResponseError,
  type AgentExecutor,
  type AgentRunOptions
} from "../agents/agent-runner.js";
import type { SpawnExplorerResult } from "../agents/agent-runner-contracts.js";
import { agentRemainingTimeoutMs, spawnExplorerRunOptions } from "../agents/explorer-spawn.js";
import { AGENT_TASK_SCHEMA_VERSION, type AgentTaskEnvelope, type InterviewerOutput, type InterviewerTask } from "../agent-task-types.js";
import { type AgentUsageSnapshot } from "../agent-types.js";
import { type OrchestratorConfig } from "../config-types.js";
import { parseInterviewerOutput, ValidationError } from "../validation.js";
import type { InterviewerCallRecord, RequirementsSession } from "./requirements-session.js";

/**
 * The interviewer is read-only, so a failed output is cheap to retry: schema
 * failures get up to two `correct_output` attempts before the session fails.
 */
const MAX_INTERVIEWER_CORRECTIONS = 2;
/** Byte cap for `correction.validationError`, which is embedded in the retry envelope. */
const MAX_CORRECTION_ERROR_BYTES = 500;

/** Why a previous interviewer call failed; carried by the `correct_output` retry envelope. */
type InterviewerCorrectionInfo =
  | {
      attempt: 1 | 2;
      reason: "schema_validation_failed";
      fieldPath?: string;
      validationError?: string;
    }
  | {
      attempt: 1;
      reason: "incomplete_response";
      validationError?: string;
    };

function cappedCorrectionError(message: string): string {
  if (Buffer.byteLength(message, "utf8") <= MAX_CORRECTION_ERROR_BYTES) return message;
  let truncated = message;
  while (Buffer.byteLength(truncated, "utf8") > MAX_CORRECTION_ERROR_BYTES - "… (truncated)".length) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}… (truncated)`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function interviewerCall(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  task: InterviewerTask
): Promise<InterviewerOutput> {
  const expectedAction = task.action;
  let attempt = 0;
  let text = (await runInterviewer(session, executor, config, "execute", task, undefined)).text;
  for (;;) {
    try {
      const parsed = parseInterviewerOutput(text);
      assertRequestedAction(parsed, expectedAction);
      return parsed;
    } catch (error) {
      if (attempt >= MAX_INTERVIEWER_CORRECTIONS) {
        throw new Error(`Interviewer returned invalid output: ${messageOf(error)}`);
      }
      attempt += 1;
      const fieldPath = error instanceof ValidationError && /^[a-zA-Z0-9_.[\]-]+$/.test(error.path) ? error.path : undefined;
      const corrected = await runInterviewer(session, executor, config, "correct_output", task, {
        attempt: attempt as 1 | 2,
        reason: "schema_validation_failed",
        ...(fieldPath ? { fieldPath } : {}),
        validationError: cappedCorrectionError(messageOf(error))
      });
      text = corrected.text;
    }
  }
}

function assertRequestedAction(output: InterviewerOutput, expected: InterviewerTask["action"]): void {
  if (output.action !== expected) {
    throw new ValidationError("action", `expected ${expected} but interviewer returned ${output.action}`);
  }
}

async function runInterviewer(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  mode: "execute" | "correct_output",
  task: InterviewerTask,
  correction: InterviewerCorrectionInfo | undefined
) {
  const deadlineStartedAt = Date.now();
  const remaining = agentRemainingTimeoutMs(config.limits.agentTimeoutMs, deadlineStartedAt);
  const envelope: AgentTaskEnvelope<InterviewerTask> = mode === "correct_output"
    ? {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode,
        task,
        memoryContext: null,
        correction: correction!
      }
    : {
        taskSchemaVersion: AGENT_TASK_SCHEMA_VERSION,
        mode,
        task,
        memoryContext: null
      };
  const envelopeText = JSON.stringify(envelope, null, 2);
  const call = session.recordCall((task as { round?: number }).round ?? session.round, task.action, mode);
  if (mode === "correct_output") call.taskText = envelopeText;
  const run: AgentRunOptions = {
    name: "interviewer",
    task: envelopeText,
    cwd: session.cwd,
    extensionRoot: session.deps.extensionRoot,
    config: config.agents.interviewer,
    timeoutMs: remaining,
    signal: session.controller.signal,
    allowedWritePaths: [],
    onTranscript: next => session.updateCall(call, {
      transcript: next,
      messageCount: next.messages.length,
      truncated: next.truncated
    }),
    onEvent: event => {
      if (event.toolName !== undefined) {
        session.updateCall(call, { toolName: event.toolName, toolArgs: event.args });
      }
    },
    onUsage: snapshot => session.updateCall(call, usagePatch(snapshot)),
    spawnExplorer: question => runSpawnedExplorer(session, executor, config, deadlineStartedAt, question)
  };
  try {
    const result = await executor.run(run);
    await session.finishCall(call, "succeeded", {
      outputText: result.text,
      usage: result.usage,
      ...(result.response ? {
        provider: result.response.provider,
        model: result.response.model,
        api: result.response.api,
        stopReason: result.response.stopReason
      } : {})
    });
    return result;
  } catch (error) {
    const cancelled = error instanceof AgentCancelledError || session.controller.signal.aborted;
    const message = error instanceof Error ? error.message : String(error);
    await session.finishCall(call, cancelled ? "cancelled" : "failed", {
      outputText: message,
      error: message,
      ...(error instanceof AgentIncompleteResponseError ? {
        usage: error.usage,
        provider: error.provider,
        model: error.model,
        stopReason: error.stopReason
      } : {})
    });
    if (error instanceof AgentIncompleteResponseError && mode === "execute") {
      // A truncated response is common for long JSON and cheap to retry
      // (read-only): ask once for the complete output. A truncated
      // correction run is not retried; the session fails closed.
      return runInterviewer(session, executor, config, "correct_output", task, {
        attempt: 1,
        reason: "incomplete_response",
        validationError: cappedCorrectionError(message)
      });
    }
    throw error;
  }
}

function usagePatch(snapshot: AgentUsageSnapshot): Partial<InterviewerCallRecord> {
  return {
    usage: snapshot.usage,
    provider: snapshot.provider,
    model: snapshot.model,
    api: snapshot.api,
    stopReason: snapshot.stopReason
  };
}

async function runSpawnedExplorer(
  session: RequirementsSession,
  executor: AgentExecutor,
  config: OrchestratorConfig,
  deadlineStartedAt: number,
  question: string
): Promise<SpawnExplorerResult> {
  const child = spawnExplorerRunOptions({
    question,
    cwd: session.cwd,
    extensionRoot: session.deps.extensionRoot,
    explorerConfig: config.agents.explorer,
    timeoutMs: agentRemainingTimeoutMs(config.limits.agentTimeoutMs, deadlineStartedAt),
    signal: session.controller.signal
  });
  try {
    const result = await executor.run(child);
    return { text: result.text, usage: result.usage, transcript: result.transcript };
  } catch (error) {
    if (error instanceof AgentCancelledError) throw error;
    const usage = error instanceof AgentIncompleteResponseError ? error.usage : undefined;
    return { text: `Explorer sub-agent failed: ${messageOf(error)}`, usage };
  }
}
