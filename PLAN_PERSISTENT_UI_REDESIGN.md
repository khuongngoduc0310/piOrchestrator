# Persistent Terminal and Browser UI Redesign Plan

## Goal

Keep the piOrchestrator command-line UI visible for the entire Pi session and redesign both the terminal panel and browser dashboard around one consistent, read-only presentation model.

The terminal panel should appear immediately on `session_start`, remain visible while idle, expand during a workflow, retain the final result afterward, and disappear only during `session_shutdown`. Existing slash commands remain the interaction mechanism.

## Confirmed Decisions

- Visibility: entire Pi session, including before the first run.
- Terminal design: adaptive panel—compact while idle, richer while running or showing a result.
- Scope: terminal UI and browser dashboard.
- Interaction: display status and command hints; do not add keyboard navigation or actions inside the panel.
- Existing browser command remains `/orchestrator-ui`.
- Existing workflow, configuration, artifacts, and persisted `WorkflowState` contracts remain authoritative.

## Design Principles

1. **One presentation model:** terminal and browser must derive labels, phase progress, agent status, warnings, and config summaries from the same pure view-model builder.
2. **No startup mutation:** rendering the idle panel must not create or rewrite `.pi/orchestrator/config.json`.
3. **No false precision:** progress is based on canonical workflow phases, not guessed token/time completion. Repeated retries stay within their owning phase.
4. **Adaptive density:** idle uses 3–4 lines, running uses approximately 8–12 lines, and completed/failed states collapse to a concise summary.
5. **Width safety:** all terminal lines must respect the render width; long requests and artifact paths are truncated safely.
6. **Read-only UI:** UI rendering never advances state, edits configuration, starts checks, or changes models.
7. **Graceful degradation:** missing or malformed config produces an informative persistent panel without replacing the config or preventing normal Pi use.
8. **Lifecycle safety:** timers, widgets, status entries, SSE clients, and dashboard resources are cleaned up on session shutdown/reload.

## Proposed Terminal Design

### Idle

```text
┌ piOrchestrator ───────────────────────────────────────┐
│ IDLE · ready                                         │
│ Project: 7 agents configured · 2 checks              │
│ /orchestrate <request> · /orchestrator-settings      │
└───────────────────────────────────────────────────────┘
```

Missing configuration:

```text
┌ piOrchestrator ───────────────────────────────────────┐
│ IDLE · setup required                                 │
│ Project checks are not configured                    │
│ Run /orchestrate <request> to begin setup            │
└───────────────────────────────────────────────────────┘
```

Malformed configuration:

```text
┌ piOrchestrator ───────────────────────────────────────┐
│ CONFIG ERROR · workflow unavailable                  │
│ .pi/orchestrator/config.json could not be validated  │
│ Fix the config, then run /orchestrate again           │
└───────────────────────────────────────────────────────┘
```

### Running

```text
┌ piOrchestrator · d238f168 ────────────────────────────┐
│ IMPLEMENTING · phase 5/8 · attempt 1/3 · 01:24       │
│ Explore ✓  Plan ✓  Baseline ✓  Tests ✓  Build →      │
│ Active: builder · deepseek/deepseek-v4-flash         │
│ Request: add a pause and resume button                │
│ Checks: 2 configured · last result: waiting           │
│ Recent: ✓ acceptance tests · → implement plan         │
│ Artifacts: …/.pi/orchestrator/runs/d238f168…          │
│ /orchestrator-status · /orchestrator-cancel           │
└───────────────────────────────────────────────────────┘
```

### Completed or failed

```text
┌ piOrchestrator · d238f168 ────────────────────────────┐
│ FAILED · exploring · 00:20                            │
│ ! Explorer output could not be validated              │
│ Failed artifact: …/001-explorer-invalid-output.txt    │
│ /orchestrator-status · /orchestrate <request>         │
└───────────────────────────────────────────────────────┘
```

The existing footer status remains, but becomes shorter and complementary, for example:

```text
orchestrator: implementing · builder · 5/8
```

## Proposed Browser Dashboard

Keep the server local-only and dependency-free, but replace the current two-card page with a responsive dashboard:

```text
┌ Header ─────────────────────────────────────────────────────┐
│ piOrchestrator   RUNNING   d238f168   elapsed 01:24         │
│ Request: add a pause and resume button                      │
├ Workflow phases ────────────────────────────────────────────┤
│ Explore ✓ → Plan ✓ → Baseline ✓ → Tests ✓ → Build → …      │
├ Agent grid ─────────────────────────────────────────────────┤
│ Explorer ✓   Planner ✓   Reviewer ✓   Tester ✓              │
│ Builder →    Debugger ·  Documenter ·                       │
│ Each card: status, model, last summary/error                 │
├ Current activity ───────────────┬ Run details ───────────────┤
│ Builder is implementing         │ checks, attempt, artifacts │
├ Recent timeline ────────────────────────────────────────────┤
│ timestamp · status · stage · agent · message · artifact     │
└──────────────────────────────────────────────────────────────┘
```

Browser behavior:

- Render a useful idle/config-summary page when no run exists instead of only “Waiting for a run…”.
- Show a compact phase rail, agent cards, current activity, recent timeline, run metadata, warnings, and failure details.
- Use responsive CSS for narrow windows and accessible status text in addition to color.
- Keep HTML escaping, CSP, `no-store`, `nosniff`, localhost binding, and no external scripts/assets.
- Send the current snapshot immediately when an SSE client connects, then stream subsequent updates and heartbeats.
- Keep `/api/state` for compatibility if practical; either return the presentation snapshot directly or add `/api/view` while preserving the existing raw-state route.

## Shared Presentation Model

Add a UI-only type separate from persisted `WorkflowState`:

```ts
interface OrchestratorViewModel {
  mode: "idle" | "running" | "completed" | "failed" | "cancelled" | "config_error";
  cwd: string;
  config: {
    status: "missing" | "valid" | "invalid";
    agentCount: number;
    checkCount: number;
    message?: string;
  };
  run?: {
    id: string;
    request: string;
    status: WorkflowState["status"];
    stage: Stage;
    phaseIndex: number;
    phaseCount: number;
    activeAgent?: AgentName;
    attempt: number;
    maxAttempts: number;
    elapsedMs: number;
    artifactPath: string;
    failedArtifact?: string;
    message?: string;
    warning?: string;
  };
  agents: Array<{ name: AgentName; model: string; status: AgentStatus["status"]; summary?: string; error?: string }>;
  recentSteps: StepRecord[];
  commands: string[];
}
```

This model is not persisted and does not require a config schema migration.

Canonical UI phases should group internal stages into stable user-facing milestones:

1. Setup / preflight
2. Explore
3. Plan and plan review
4. Baseline
5. Acceptance tests
6. Build, check, and debug retries
7. Code review and fixes
8. Documentation, lessons, and final verification

`testing` is assigned using the current/recent step label (`after-tests`, implementation attempt, review fix, or final checks) so progress does not visibly jump backward. Completed is 8/8; failed/cancelled retain the last reached phase.

## Configuration Summary Without Side Effects

`loadConfig()` currently creates a default config when none exists, so it should not be called merely to draw the startup panel.

Add a read-only inspection helper that:

- Reads the config if present.
- Returns `missing` on `ENOENT` without creating it.
- Applies the same merge and validation rules as normal loading when present.
- Returns a bounded display error for malformed/unreadable files without rewriting them.
- Reports configured agent/check counts only; it does not perform model preflight or execute checks.

Normal `/orchestrate` and settings behavior continues using authoritative `loadConfig()`/`saveConfig()`.

## Lifecycle and Update Flow

1. `src/index.ts` registers `session_start`.
2. On session start, a UI controller attaches to the current extension context, inspects config read-only, builds the idle view model, and renders the persistent widget/footer.
3. Workflow transitions continue persisting `WorkflowState`, then ask the UI controller to publish a fresh view model to terminal and dashboard.
4. Agent-settings saves and first-run check approval refresh the config summary.
5. A one-second timer runs only while a workflow is active to refresh elapsed time; transition updates remain event-driven.
6. Completion/failure stops the timer but retains the final panel.
7. `session_shutdown` stops timers/dashboard/SSE clients and clears the terminal widget/footer.
8. `session_start` after `/reload`, `/new`, `/resume`, or `/fork` creates a fresh controller/context and renders idle again.

The extension must not retain a command/event context across session replacement after shutdown.

## Proposed Files

- `src/ui-model.ts` (new) — presentation contracts, canonical phase derivation, config/run summary, elapsed time, recent-step and failed-artifact selection.
- `src/ui-controller.ts` (new) — session attach/detach, read-only config refresh, running timer, terminal/dashboard publication.
- `src/terminal-ui.ts` — replace raw string-array rendering with adaptive, width-aware idle/running/result components and concise footer status.
- `src/dashboard.ts` — consume the shared view model, publish idle and running snapshots, send an immediate SSE snapshot, and retain server lifecycle/security behavior.
- `src/dashboard-page.ts` (new, optional) — move the redesigned dependency-free HTML/CSS/JS out of the server implementation for testability and readability.
- `src/config.ts` — add non-mutating config inspection while keeping `loadConfig()` and `saveConfig()` authoritative.
- `src/orchestrator.ts` — publish presentation updates through the controller instead of calling terminal/dashboard rendering independently; expose config/run snapshots without changing workflow control.
- `src/index.ts` — attach UI on `session_start`, refresh it after settings operations, and detach/clear on `session_shutdown`.
- `src/types.ts` — only shared UI summary types if they are not kept in `ui-model.ts`; do not change persisted schema version.
- `src/terminal-ui.test.ts` (new) — adaptive rendering and width guarantees.
- `src/ui-model.test.ts` (new) — phase mapping, idle/config-error states, failure artifacts, elapsed time, and command hints.
- `src/dashboard.test.ts` (new) — idle/raw state APIs, redesigned HTML, immediate SSE snapshot, security headers, publish, and shutdown.
- `src/config.test.ts`, `src/orchestrator.test.ts`, and command/lifecycle tests — no-startup-write behavior, refresh events, timer cleanup, and retained final UI.
- `README.md` — persistent UI behavior and coordinated terminal/browser screenshots or text examples.

## Implementation Steps

- [x] Define the non-persisted `OrchestratorViewModel` and canonical eight-phase mapping.
- [x] Implement pure derivation for idle, running, completed, failed, cancelled, missing-config, and config-error views.
- [x] Add read-only config inspection that never creates or rewrites a config.
- [x] Introduce a session-scoped UI controller with attach, refresh, publish, running timer, and shutdown cleanup.
- [x] Register `session_start` and ensure reload/session replacement never reuses stale contexts.
- [x] Redesign terminal rendering as an adaptive width-aware panel with concise footer status and command hints.
- [x] Route orchestrator transitions, agent/check completion, settings saves, and check setup through one presentation refresh path.
- [x] Redesign the browser dashboard around the same view model while preserving localhost-only binding and security headers.
- [x] Add immediate SSE snapshots, heartbeat cleanup, responsive layout, HTML escaping, and accessible non-color status labels.
- [x] Preserve `/api/state` compatibility and `/orchestrator-ui` behavior.
- [x] Add focused unit/integration tests for lifecycle, rendering widths, phase mapping, config errors, SSE, timers, completion/failure retention, and non-UI modes.
- [x] Update README and run `npm run typecheck`, `npm test`, and `npm pack --dry-run`.

## Verification Scenarios

- Starting Pi in a project with no orchestrator config immediately shows an idle/setup panel but creates no files.
- Starting Pi with a valid config shows accurate agent/check counts before any workflow runs.
- Starting Pi with malformed config shows a persistent bounded error and leaves the file byte-for-byte unchanged.
- `/orchestrate` changes the same panel from idle to running without replacing it with a second widget.
- Long requests, Windows paths, model names, and errors never exceed terminal width.
- Retry/debug/review loops remain in the correct canonical phase and progress never regresses visually.
- Elapsed time updates while running and stops after completion, failure, or cancellation.
- Completed and failed summaries remain visible until another run, reload, or session shutdown.
- `/orchestrator-settings` and first-run check approval refresh idle/config counts.
- Browser dashboard renders a useful idle view before a run and receives an immediate SSE snapshot on connection.
- Terminal and browser show the same status, active agent, phase, warning, and recent steps.
- JSON/print modes do not create terminal components or timers.
- Reload/new/resume/fork and process shutdown leave no duplicate widgets, timers, servers, or SSE clients.
- Existing workflow state/artifacts and all slash commands remain compatible.

## Non-Goals

- Adding clickable terminal actions or keyboard shortcuts.
- Allowing the browser dashboard to mutate workflow state.
- Automatically opening a browser or starting a dashboard port merely because Pi started.
- Restoring the latest historical run from disk into a new Pi session in this iteration.
- Changing agent prompts, tools, context passing, workflow order, retry policy, or persisted configuration schema.
