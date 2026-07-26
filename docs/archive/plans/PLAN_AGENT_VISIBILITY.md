# Agent Activity Visibility — Live Feed + Post-Run Inspection

## Current state

Agent events (`tool_execution_start`, `tool_execution_end`, `auto_retry_start`, etc.) are captured by `agent-runner.ts` via `sanitizeEvent()` and stored silently to `events.jsonl`. They are never displayed live. The terminal widget only shows agent name, model, and status.

The `message_update` event (token-by-token streaming) is **not** captured at all.

## Goal

Three levels of agent visibility:

1. **Live tool feed** — terminal widget shows what tool the agent is currently using and its arguments
2. **Live output stream** — terminal widget shows the agent's latest generated text (throttled)
3. **Post-run inspect command** — `/orchestrator-inspect` lets you browse runs, drill into agents, and see their full output + event stream

## Detailed design

### 1. Types — add agent activity tracking

**`src/types.ts`** — Add to `WorkflowState`:

```typescript
export interface WorkflowState {
  // ...existing fields...
  /** Current tool the active agent is executing */
  currentTool?: string;
  /** Truncated arguments of the current tool call */
  currentToolArgs?: string;
  /** Last few lines of agent output text (throttled) */
  agentOutput?: string[];
  /** Whether the current tool is in an error/retry state */
  toolStatus?: "ok" | "error" | "retrying";
}
```

Add to `RunSummary`:

```typescript
export interface RunSummary {
  // ...existing fields...
  currentTool?: string;
  currentToolArgs?: string;
  agentOutput?: string[];
  toolStatus?: string;
}
```

### 2. Agent-runner — capture streaming text

**`src/agent-runner.ts`** — Add `message_update` to `sanitizeEvent`:

```typescript
case "message_update":
  return {
    type: event.type,
    // Extract just the latest text delta
    text: extractTextDelta(event),
  };
```

Also add `tool_execution_start` to include tool arguments:

```typescript
case "tool_execution_start":
  return {
    type: event.type,
    toolName: event.toolName,
    // Truncate args for display
    args: truncate(JSON.stringify(event.args), 200),
  };
```

### 3. Orchestrator — wire events to live state

**`src/orchestrator.ts`** — In the `onEvent` callback inside `runAgentStep`:

```typescript
onEvent: event => {
  void store.event("agent_event", { stepId: step.id, agent, event }).catch(() => undefined);

  // Update live state for UI
  if (this.state) {
    switch (event.type) {
      case "tool_execution_start":
        this.state.currentTool = event.toolName;
        this.state.currentToolArgs = event.args;
        this.state.toolStatus = undefined;
        break;
      case "tool_execution_end":
        this.state.toolStatus = event.isError ? "error" : "ok";
        break;
      case "auto_retry_start":
        this.state.toolStatus = "retrying";
        break;
      case "message_update":
        if (event.text) {
          const lines = (this.state.agentOutput ?? []).concat(event.text);
          // Keep only last N lines
          this.state.agentOutput = lines.slice(-5);
        }
        break;
    }
    // Throttled persist — only persist every 500ms to avoid flooding
    this.throttledPersist(ctx);
  }
}
```

Add a throttle mechanism:

```typescript
private persistTimer: ReturnType<typeof setTimeout> | undefined;

private throttledPersist(ctx: ExtensionCommandContext): void {
  if (this.persistTimer) return;
  this.persistTimer = setTimeout(() => {
    this.persistTimer = undefined;
    const state = this.state;
    if (state) {
      state.updatedAt = this.timestamp();
      this.dashboard.publish(state);
      // Update widget — but skip heavy store writes for ephemeral state
      if (this.onStateChange && this.config) {
        this.onStateChange(state, this.config, ctx);
      }
    }
  }, 500);
}
```

### 4. UI Controller — show live activity

**`src/ui-controller.ts`** — Add to the running state panel:

```typescript
// After "Active:" line, show current tool activity
if (run.currentTool) {
  const toolLine = `│ Tool: ${run.currentTool} ${run.currentToolArgs ? truncate(run.currentToolArgs, 50) : ""}${run.toolStatus ? ` · ${run.toolStatus}` : ""}`;
  lines.push(toolLine);
}
// Show latest agent output lines
if (run.agentOutput && run.agentOutput.length > 0) {
  const lastLines = run.agentOutput.slice(-2);
  for (const line of lastLines) {
    lines.push(`│ ${truncate(line.replace(/\n/g, "↵"), 65)}`);
  }
}
```

### 5. Inspect command — `/orchestrator-inspect`

**`src/inspect.ts`** (new) — A post-run browser:

```
/orchestrator-inspect              → List recent runs
/orchestrator-inspect <run-id>     → Show run summary
/orchestrator-inspect <run-id> <step> → Show agent output
/orchestrator-inspect <run-id> <step> events → Show event stream
```

Implementation:

```
list runs → scan .pi/orchestrator/runs/ for state.json files
  → show select menu with run IDs + requests

select a run → show run summary with all steps
  → show select menu with step labels

select a step → read the agent output artifact
  → show in editor via ctx.ui.editor()

select events → read events.jsonl lines for the step
  → show in editor
```

For runs without a UI (RPC/print mode), output to notify.

**`src/index.ts`** — Register the command:

```typescript
pi.registerCommand("orchestrator-inspect", {
  description: "Inspect agent outputs from previous runs",
  handler: async (args: string, ctx: ExtensionCommandContext) => {
    const cwd = ctx.cwd ?? process.cwd();
    await inspectRun(cwd, args.trim(), ctx);
  }
});
```

## Summary

| File | Change |
|---|---|
| `src/types.ts` | Add `currentTool`, `currentToolArgs`, `agentOutput`, `toolStatus` to `WorkflowState` and `RunSummary` |
| `src/agent-runner.ts` | Add `message_update` + `tool_execution_start` args to `sanitizeEvent` |
| `src/orchestrator.ts` | Wire `onEvent` to update live state; add `throttledPersist` |
| `src/ui-controller.ts` | Show current tool + agent output lines in running panel |
| `src/ui-model.ts` | Pass new fields from state to RunSummary |
| `src/inspect.ts` (new) | Post-run inspection command |
| `src/inspect.test.ts` (new) | Tests for inspect command |
| `src/index.ts` | Register `/orchestrator-inspect` |

## Verification

1. `npx vitest run` — all tests pass
2. Run a workflow → watch the terminal widget show live tool activity ("builder: write src/index.ts")
3. Run a workflow → watch agent output lines appear in the widget
4. `/orchestrator-inspect` → shows list of recent runs
5. `/orchestrator-inspect <run-id>` → shows step list
6. `/orchestrator-inspect <run-id> <step>` → shows agent output in editor
7. `/orchestrator-inspect <run-id> <step> events` → shows event stream
