# Enhanced `/orchestrator-settings` — Full Configuration Editor

## Current state

`/orchestrator-settings` only edits **agent models and thinking levels** via `agent-settings.ts`. Everything else requires manual `config.json` editing.

## Goal

Make the settings wizard a one-stop shop for editing all workflow configuration.

## Settings that should be editable

| Category | Field | Type | Current default | Why expose |
|---|---|---|---|---|
| **Agent models** | `agents.*.model` | string | `anthropic/claude-sonnet-4-5` | ✅ Already done |
| **Agent thinking** | `agents.*.thinking` | ThinkingLevel \| unset | varies per agent | ✅ Already done |
| **Limits — retries** | `limits.planRevisions` | 0-1000 | 2 | User may want more/fewer plan iterations |
| **Limits — retries** | `limits.implementationRetries` | 0-1000 | 3 | User may want more builder retries for complex tasks |
| **Limits — retries** | `limits.reviewRevisions` | 0-1000 | 2 | User may want more code review cycles |
| **Limits — timeouts** | `limits.agentTimeoutMs` | 1-2.1B (ms) | 20 min | Long-running agents may need more time |
| **Limits — timeouts** | `limits.checkTimeoutMs` | 1-2.1B (ms) | 10 min | Slow test suites may need more time |
| **Limits — output** | `limits.maxOutputBytes` | 1-100MB | 256KB | Large test output may be truncated |
| **Limits — isolation** | `limits.worktreeIsolation` | boolean | false | User may want safe builder isolation |
| **Human-in-loop** | `humanInTheLoop.planApproval` | boolean | false | User may want to review plans |
| **Human-in-loop** | `humanInTheLoop.planRevisionApproval` | boolean | false | User may want to review revisions |
| **Human-in-loop** | `humanInTheLoop.confirmBeforeMutation` | boolean | false | User may want mutation guard |
| **Dashboard** | `dashboard.enabled` | boolean | true | User may want to disable the dashboard |
| **Dashboard** | `dashboard.port` | 0-65535 | 0 (OS-assigned) | User may want a fixed port |

**Not included** (handled elsewhere or too dangerous):
- `checks` — already managed by `/orchestrate` setup wizard
- `agents.*.tools` — changing tools could break agent capabilities
- `agents.*.promptFile` — changing prompts is an advanced operation; file editing is more appropriate
- `schemaVersion` — internal

## Approach

### New file: `src/config-settings.ts`

A new settings module that mirrors `agent-settings.ts` but for all config fields. The wizard structure:

1. **Category selection** — "(1) Agent models" and "(2) Workflow settings"
   - Agent models → existing `configureAgentModels` (unchanged)
   - Workflow settings → new wizard for limits, human-in-loop, dashboard

2. **Workflow settings sub-wizard** (new) — categories:

   ```
   ┌ Workflow settings ─────────────────────────────┐
   │ (1) Retry limits     planRevisions: 2           │
   │                       implementationRetries: 3  │
   │                       reviewRevisions: 2        │
   │ (2) Timeouts         agentTimeoutMs: 20m        │
   │                       checkTimeoutMs: 10m       │
   │                       maxOutputBytes: 256KB     │
   │ (3) Isolation        worktreeIsolation: off     │
   │ (4) Human review     planApproval: off          │
   │                       planRevisionApproval: off │
   │                       confirmBeforeMutation: on │
   │ (5) Dashboard        enabled: on · port: 0      │
   │ ────────────────────────────────────────────────│
   │ Save all · Cancel                               │
   └────────────────────────────────────────────────┘
   ```

3. **Sub-category editing** — each category opens a selector to edit individual fields:

   **Retry limits**: Select a field → input a number
   ```
   ┌ Retry limits ──────────────────────────────────┐
   │ planRevisions: 2  (number of plan review cycles)│
   │ implementationRetries: 3  (builder retries)     │
   │ reviewRevisions: 2  (code review cycles)        │
   │ ────────────────────────────────────────────────│
   │ Back                                            │
   └────────────────────────────────────────────────┘
   ```

   **Timeouts**: Select → input seconds
   ```
   ┌ Timeouts ──────────────────────────────────────┐
   │ agentTimeoutMs: 1200000  (20 min)               │
   │ checkTimeoutMs: 600000  (10 min)                │
   │ maxOutputBytes: 262144  (256 KB)                │
   │ ────────────────────────────────────────────────│
   │ Back                                            │
   └────────────────────────────────────────────────┘
   ```

   **Isolation**: Toggle on/off
   ```
   ┌ Builder isolation ─────────────────────────────┐
   │ [✓] Use git worktree for builder isolation      │
   │ ────────────────────────────────────────────────│
   │ Back                                            │
   └────────────────────────────────────────────────┘
   ```

   **Human review**: Multi-select checkboxes
   ```
   ┌ Human-in-the-loop ─────────────────────────────┐
   │ [ ] Review plan before approval                 │
   │ [ ] Review plan revisions                       │
   │ [ ] Confirm before code changes                 │
   │ ────────────────────────────────────────────────│
   │ Back                                            │
   └────────────────────────────────────────────────┘
   ```

   **Dashboard**: Toggle + port number
   ```
   ┌ Dashboard ─────────────────────────────────────┐
   │ [✓] Enable dashboard                            │
   │ Port: 0  (0 = OS-assigned)                      │
   │ ────────────────────────────────────────────────│
   │ Back                                            │
   └────────────────────────────────────────────────┘
   ```

4. **Save** — collects all changes across all categories from the staged config, shows a review summary, and calls `saveConfig()`.

### Reuse

- Uses the same `ctx.ui.select`, `ctx.ui.confirm`, `ctx.ui.input` pattern as `agent-settings.ts`
- Reads/writes config via `loadConfig()` / `saveConfig()` from `config.ts`
- Staging pattern: read config at start, stage changes in memory, save atomically on confirmation
- For limits, convert between ms and human-readable for display (e.g., `600000` → `600s` / `10 min`)

## Files to modify

| File | Change |
|---|---|
| `src/config-settings.ts` (new) | Workflow settings wizard (limits, human-in-loop, dashboard) |
| `src/config-settings.test.ts` (new) | Tests for the settings wizard |
| `src/index.ts` | Update `/orchestrator-settings` handler to show both "Agent models" and "Workflow settings" options |
| `src/types.ts` | No changes needed |
| `src/config.ts` | No changes needed |
| `src/validation.ts` | No changes needed |

## Steps

- [ ] **config-settings.ts**: Create `configureWorkflowSettings(cwd, ctx)` with category selection
- [ ] **config-settings.ts**: Implement retry limits editing sub-wizard
- [ ] **config-settings.ts**: Implement timeouts editing sub-wizard
- [ ] **config-settings.ts**: Implement isolation toggle sub-wizard
- [ ] **config-settings.ts**: Implement human-in-loop toggles sub-wizard
- [ ] **config-settings.ts**: Implement dashboard settings sub-wizard
- [ ] **config-settings.ts**: Add save flow with review summary
- [ ] **index.ts**: Update `/orchestrator-settings` to offer "Agent models" and "Workflow settings"
- [ ] **config-settings.test.ts**: Unit tests for each sub-wizard
- [ ] **Run tests**: Verify `npx vitest run` passes

## Verification

1. `npx vitest run` — all tests pass
2. `/orchestrator-settings` → select "Workflow settings" → edit retry limits → save → verify config.json updated
3. `/orchestrator-settings` → select "Workflow settings" → enable human-in-loop → save → verify config.json updated
4. Manual: run workflow after changing limits → verify new limits take effect
