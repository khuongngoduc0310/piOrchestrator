import type { DashboardDecisionPresentation } from "../dashboard-types.js";
import type { DashboardDecisionSubmission, DashboardServer } from "./dashboard.js";

export interface RaceWinner<T> {
  source: "dashboard" | "prompt";
  result: T | undefined;
  acknowledge?: (error?: unknown) => void;
}

export interface DecisionRaceOptions {
  decisionId: string;
  label: string;
  dashboard: DashboardServer;
  presentation: DashboardDecisionPresentation;
  signal: AbortSignal;
}

/**
 * A single dashboard-vs-prompt decision race. Registration must happen before
 * the caller advertises the pending decision, so every advertised decision is
 * answerable; `race()` then lets whichever channel answers first win and
 * cleans up the loser. `dispose()` cancels a race that never completed.
 */
export interface DecisionRace<T> {
  readonly decisionId: string;
  readonly hasDashboardWaiter: boolean;
  register(): void;
  race(canPrompt: boolean, prompt: (signal: AbortSignal) => Promise<T | undefined>): Promise<RaceWinner<T>>;
  dispose(reason: unknown): void;
}

export function beginDecisionRace<T>(options: DecisionRaceOptions): DecisionRace<T> {
  const gateController = new AbortController();
  const cancelGate = (): void => gateController.abort(options.signal.reason);
  options.signal.addEventListener("abort", cancelGate, { once: true });

  let dashboardWait: Promise<DashboardDecisionSubmission> | undefined;

  return {
    decisionId: options.decisionId,
    get hasDashboardWaiter(): boolean {
      return dashboardWait !== undefined;
    },
    register(): void {
      if (!options.dashboard.isListening) return;
      try {
        dashboardWait = options.dashboard.registerDecision(options.decisionId, options.presentation, gateController.signal);
      } catch (error) {
        this.dispose(error);
        throw error;
      }
      void dashboardWait.catch(() => undefined);
    },
    async race(canPrompt, prompt) {
      const candidates: Promise<RaceWinner<T>>[] = [];
      if (dashboardWait) {
        candidates.push(dashboardWait.then(({ acknowledge, ...result }) => ({
          source: "dashboard" as const,
          result: result as unknown as T,
          acknowledge
        })));
      }
      if (canPrompt) candidates.push(prompt(gateController.signal).then(result => ({ source: "prompt" as const, result })));
      if (candidates.length === 0) {
        throw new Error(`${options.label} has no answer channel: neither the dashboard nor the TUI can respond`);
      }

      let winner: RaceWinner<T>;
      try {
        winner = await Promise.race(candidates);
      } catch (error) {
        if (dashboardWait) void dashboardWait.then(submission => submission.acknowledge(error), () => undefined);
        options.dashboard.unregisterDecision(options.decisionId, error);
        if (!gateController.signal.aborted) gateController.abort(error);
        options.signal.removeEventListener("abort", cancelGate);
        throw error;
      }

      if (winner.source === "prompt") {
        const reason = new Error("Prompt completed first");
        options.dashboard.unregisterDecision(options.decisionId, reason);
        if (dashboardWait) void dashboardWait.then(submission => submission.acknowledge(reason), () => undefined);
      }
      if (!gateController.signal.aborted) gateController.abort(new Error(`${winner.source} decision completed first`));
      options.signal.removeEventListener("abort", cancelGate);
      return winner;
    },
    dispose(reason: unknown): void {
      options.dashboard.unregisterDecision(options.decisionId, reason);
      if (!gateController.signal.aborted) gateController.abort(reason);
      options.signal.removeEventListener("abort", cancelGate);
    }
  };
}
