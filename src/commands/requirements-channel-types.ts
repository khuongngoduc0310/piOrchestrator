import type { DashboardDecisionAction, DashboardDecisionQuestion } from "../dashboard-types.js";
import type { InterviewQuestion } from "../agent-task-types.js";

/** A user action chosen from an interview presentation's decision. */
export interface InterviewActionResult {
  action: string;
  feedback?: string;
}

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

/** The TUI answer prompt the hub opens for a question's current presentation. */
export interface TuiPrompt {
  /** Gate signal of the presentation's decision race; aborts when the dashboard wins. */
  signal: AbortSignal;
  promise: Promise<InterviewActionResult | undefined>;
  resolve: (result: InterviewActionResult | undefined) => void;
}

export interface InterviewPresentation {
  content: string;
  actions: DashboardDecisionAction[];
  question: DashboardDecisionQuestion;
}

/** Mutable per-question state shared between the question's driver and the TUI hub. */
export interface QuestionChannel {
  question: InterviewQuestion;
  picked: string[];
  customText?: string;
  /** True once the question has an answer; the hub renders a ✓ label. */
  completed: boolean;
  /** Presentation counter, bumped on every re-presentation. */
  generation: number;
  /** Decision id of the current presentation; undefined while the driver cycles. */
  decisionId?: string;
  label?: string;
  presentation?: InterviewPresentation;
  /** The parked TUI prompt of the current presentation; undefined while the driver cycles. */
  prompt?: TuiPrompt;
  /** Resolved by the driver once it consumed a TUI answer and re-presented or completed. */
  wake?: Deferred<void>;
  /** True once the driver ended (set closed); the hub stops waiting on the channel. */
  driverEnded: boolean;
  /** True for the round's commit question, which ends the set when answered. */
  isCommit: boolean;
  /** True once every real question is answered; gates the commit question's presentation. */
  armed: boolean;
  /** True while the custom-answer input is open; the TUI translator leaves arrows native then. */
  customInputOpen?: boolean;
  /** Arrow-key switch request from the TUI translator. */
  switchTarget?: "next" | "previous";
  /** Aborted by the TUI translator to close the answer dialog softly on a switch request. */
  dialogAbort?: AbortController;
}
