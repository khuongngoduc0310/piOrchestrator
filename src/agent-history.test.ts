import { describe, expect, it } from "vitest";
import { buildAgentHistory } from "./agent-history.js";
import type { WorkflowState } from "./workflow-types.js";

describe("buildAgentHistory", () => {
  it("aggregates measured usage while preserving unavailable invocations", () => {
    const state = {
      runId: "run-1",
      steps: [
        {
          id: "step-1",
          label: "Explore",
          agent: "explorer",
          invocations: [
            {
              sequence: 1,
              mode: "execute",
              status: "succeeded",
              startedAt: "2026-01-01T00:00:00.000Z",
              completedAt: "2026-01-01T00:00:02.000Z",
              messageCount: 2,
              truncated: false,
              transcriptArtifact: "transcript.json",
              provider: "test",
              model: "model-a",
              usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, reasoning: 4, totalTokens: 155, cost: 0.25 }
            },
            {
              sequence: 2,
              mode: "correct_output",
              status: "failed",
              startedAt: "2026-01-01T00:00:03.000Z",
              messageCount: 0,
              truncated: false
            }
          ]
        },
        {
          id: "step-2",
          label: "Plan",
          agent: "planner",
          invocations: [{
            sequence: 1,
            mode: "execute",
            status: "succeeded",
            startedAt: "2026-01-01T00:01:00.000Z",
            completedAt: "2026-01-01T00:01:01.000Z",
            messageCount: 2,
            truncated: false,
            usage: { input: 50, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.1 }
          }]
        }
      ]
    } as unknown as WorkflowState;

    const history = buildAgentHistory(state);

    expect(history.total).toMatchObject({ invocationCount: 3, measuredInvocationCount: 2 });
    expect(history.total.usage).toMatchObject({ input: 150, output: 30, cacheRead: 30, totalTokens: 215, reasoning: 4, cost: 0.35 });
    expect(history.agents.find(agent => agent.name === "explorer")).toMatchObject({ invocationCount: 2, measuredInvocationCount: 1 });
    expect(history.invocations[0]).toMatchObject({ agent: "planner", durationMs: 1_000 });
    expect(history.invocations[1]).toMatchObject({ agent: "explorer", sequence: 2, usage: undefined });
    expect(history.invocations[2]).toMatchObject({ hasTranscript: true, durationMs: 2_000 });
  });
});
