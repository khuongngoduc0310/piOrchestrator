# Per-Agent Model Settings Plan

## Goal

Add a project-local interactive settings command that lets the user choose an authenticated Pi model and compatible thinking level for each orchestrator role, review all changes, and save them atomically without starting a workflow.

## Decisions

- Entry point: new `/orchestrator-settings` interactive command.
- Scope: model and thinking level for all seven roles (`explorer`, `planner`, `reviewer`, `tester`, `builder`, `debugger`, `documenter`).
- Catalog: models currently authenticated and available through Pi's `ctx.modelRegistry` only.
- Persistence: stage changes in memory, review them, validate the complete configuration, then perform one atomic save.
- Existing `/agent-model` remains supported as a direct single-role shortcut.
- Project scope remains authoritative: settings are stored in `<cwd>/.pi/orchestrator/config.json` through existing config helpers.

## Current State

- `OrchestratorConfig.agents` already stores a model, optional thinking level, tools, and prompt file per role.
- `/agent-model <agent> <provider/model> [thinking]` updates one role at a time.
- `Orchestrator.validateAgentModel()` constructs a candidate config and runs full model preflight before `updateAgentModel()` writes it.
- `PiSdkAgentExecutor.preflight()` resolves every configured model, verifies availability/authentication, and validates role prompt paths.
- `loadConfig()` and `saveConfig()` are the authoritative validated, atomic persistence path.

No persisted schema migration is required.

## Proposed User Flow

1. Run `/orchestrator-settings` from the application root.
2. The command refuses to open while an orchestration workflow is active.
3. Refresh `ctx.modelRegistry`, read `getAvailable()`, canonicalize models as `provider/id`, deduplicate, and sort deterministically by provider then model ID.
4. Load the project config and show a main menu containing each role's staged model/thinking setting plus **Save changes** and **Cancel**.
5. Selecting a role opens a searchable standard Pi model picker populated only with available models.
6. After model selection, show a thinking picker containing **Use model default** plus only levels supported by that model. Non-reasoning models offer `off` (and default) only.
7. Return to the role menu so any number of agents can be changed. No file is written during these edits.
8. **Save changes** shows a final old → new summary and asks for confirmation.
9. On confirmation, reload the latest config, merge only staged model/thinking fields (preserving checks, limits, tools, prompts, and dashboard settings), validate the full candidate with agent preflight, then call atomic `saveConfig()` once.
10. Validation or persistence failure leaves the file unchanged and returns an actionable error. **Cancel** or Escape at any level produces no partial write.

Example main menu:

```text
Orchestrator Agent Models

  explorer     anthropic/claude-sonnet-4-5 · low
  planner      anthropic/claude-sonnet-4-5 · high
  reviewer     anthropic/claude-sonnet-4-5 · high
  tester       anthropic/claude-sonnet-4-5 · high
  builder      openai/gpt-5.2-codex · high       (changed)
  debugger     anthropic/claude-sonnet-4-5 · high
  documenter   anthropic/claude-sonnet-4-5 · medium

  Save changes
  Cancel
```

## Compatibility and Safety Rules

- Use `ctx.ui.select()`/`confirm()` rather than a TUI-only custom component so the wizard also works through Pi RPC dialogs.
- Require `ctx.hasUI`; JSON and print modes report an actionable message and never write defaults implicitly.
- Use model objects from `ctx.modelRegistry.getAvailable()` rather than accepting arbitrary text.
- Refresh the registry before reading it; registry refresh failure or an empty catalog stops without changing config.
- Keep unavailable currently configured models visible in the role summary, but never offer them as selectable values. The user can replace all invalid roles in one staged transaction.
- Derive thinking choices from the selected model's reasoning capability and `thinkingLevelMap`; preserve the optional `thinking` field via **Use model default**.
- Perform a second active-workflow check immediately before validation/save to close the settings-vs-workflow race.
- Validate all seven roles together before persistence. One invalid/unavailable model rejects the whole staged update.
- Reload the config immediately before applying staged settings so unrelated edits made while the wizard was open are not overwritten.
- Keep `updateAgentModel()` and the existing command behavior compatible; share the new batch update/validation path where practical.
- Do not change the current Pi session's primary model; settings affect only orchestrator-created role sessions.

## Proposed Files

- `src/agent-settings.ts` (new) — model catalog normalization, supported-thinking calculation, staged settings wizard, review summary, and cancellation result.
- `src/types.ts` — small draft/selection result types if they are shared across modules.
- `src/config.ts` — batch helper that reloads the latest config and applies only model/thinking fields before atomic save.
- `src/orchestrator.ts` — expose full candidate-agent-settings validation and workflow-running guard without starting a run.
- `src/index.ts` — register `/orchestrator-settings`; keep `/agent-model` backward compatible and route shared logic through the same validation/persistence rules.
- `src/agent-settings.test.ts` (new) — wizard, catalog, thinking compatibility, staging, cancellation, and failure tests.
- `src/config.test.ts` — batch update preservation and atomic failure tests.
- `src/orchestrator.test.ts` and/or command tests — active-run rejection and full-preflight-before-save coverage.
- `README.md` — command usage, project-local scope, available-model filtering, thinking behavior, and distinction from Pi's primary `/model` setting.

## Implementation Steps

- [x] Define staged per-agent model/thinking contracts without changing `OrchestratorConfig` or schema version.
- [x] Implement deterministic available-model catalog normalization from `ctx.modelRegistry`, including provider/model identity, display labels, deduplication, and empty/error handling.
- [x] Implement a pure supported-thinking-level helper using model reasoning metadata and `thinkingLevelMap`, including the model-default option.
- [x] Implement the nested standard-dialog wizard: role menu → model picker → thinking picker → staged summary → confirm/cancel.
- [x] Add a batch config mutation helper that reloads current config and changes only `agents[*].model` and `agents[*].thinking`.
- [x] Add full candidate preflight validation and active-run guards before save; ensure no validation path starts agents or project checks.
- [x] Register `/orchestrator-settings` and retain `/agent-model` compatibility, ideally sharing candidate validation and atomic persistence.
- [x] Add unit/integration coverage for staging multiple roles, supported thinking choices, cancel/Escape, non-UI mode, no available models, refresh failure, validation failure, persistence failure, active workflow, and unrelated-config preservation.
- [x] Update README and command examples.
- [x] Run `npm run typecheck`, `npm test`, and `npm pack --dry-run`.

## Verification Scenarios

- All seven roles display their current project-local model and thinking values.
- The picker contains only authenticated models returned by Pi and uses canonical `provider/id` values even when IDs contain slashes.
- A reasoning model exposes only its supported levels; a non-reasoning model cannot be saved with unsupported thinking.
- Editing several roles and cancelling leaves the config byte-for-byte unchanged.
- Confirming several changes invokes one full preflight and one atomic config write.
- If any role fails resolution/authentication/preflight, none of the staged changes are written.
- Checks, dashboard, limits, tools, and prompt files remain unchanged after saving model settings.
- Settings cannot be changed while a workflow is active, including if one starts while the wizard is open.
- `/agent-model` continues to work with `retain`, `clear`, and explicit thinking levels.
- `/orchestrate` uses the newly saved role models on its next invocation.
- `/orchestrator-settings` does not change Pi's active chat model shown by `/model`.

## Non-Goals

- Changing provider credentials or implementing `/login`.
- Showing unauthenticated models or accepting arbitrary manual model strings in the wizard.
- Changing role tools, prompts, retry limits, checks, or dashboard settings.
- Global defaults shared across projects.
- Mutating the model used by the current parent Pi conversation.
