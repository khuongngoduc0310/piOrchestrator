# Human-in-the-Loop: Persist config + Waiting UI

## Context

Two improvements for the newly added human-in-the-loop feature:

1. **Persist choices to disk** — When the user selects which touchpoints they want during the initial suggestion prompt, those choices are only kept in memory and lost on restart. They need to be saved to the config file.

2. **"Waiting for you" UI** — When the orchestrator pauses for human input (plan review, mutation confirmation), the terminal UI still shows "RUNNING" with the last agent status. There's no visual indication that the workflow is waiting for the user.

## Approach

### #6: Persist to disk

In `suggestHumanTouchpoints()`, after the user makes their selections, call `saveConfig(cwd, config)` to persist to `.pi/orchestrator/config.json`.

### #7: "Waiting for you" UI

Add a `waitingFor` field to `RunSummary` so the UI can detect when the workflow is paused for human input. The orchestrator sets this field before each human interaction and clears it when the interaction completes. The terminal UI shows a "WAITING FOR YOU" panel with the reason and elapsed wait time.

## Files to modify

1. **`src/types.ts`** — Add `waitingFor?: string` to `RunSummary`; add `"waiting"` to `OrchestratorViewModel["mode"]`
2. **`src/ui-model.ts`** — Map human-waiting stages to phases in `stageToPhaseIndex`; detect waiting state and set `waiting` mode
3. **`src/ui-controller.ts`** — Add `"waiting"` mode rendering block with "WAITING FOR YOU" panel; handle status text
4. **`src/orchestrator.ts`** — Call `saveConfig()` in `suggestHumanTouchpoints()`; set `state.waitingFor` before human interactions, clear after

## Steps

- [ ] **types.ts**: Add `waitingFor?: string` to `RunSummary`; add `"waiting"` to mode union
- [ ] **orchestrator.ts**: Call `saveConfig(cwd, config)` in `suggestHumanTouchpoints()`
- [ ] **orchestrator.ts**: Set `state.waitingFor` before `promptHumanPlanReview()` calls, clear after; set before mutation confirmations, clear after
- [ ] **ui-model.ts**: Map new stages in `stageToPhaseIndex`; detect waiting stages and set mode to `"waiting"` in `buildRunViewModel`
- [ ] **ui-controller.ts**: Add `"waiting"` rendering block showing wait panel and `WAITING FOR YOU` header; update `statusText`
- [ ] **Run all tests**: Verify `npx vitest run` passes

## Verification

1. `npx vitest run` — all tests pass
2. Run a workflow with `planApproval: true` → verify terminal shows "WAITING FOR YOU" with elapsed wait time
3. Approve the plan → verify panel returns to normal running state
4. Check `.pi/orchestrator/config.json` → verify `humanInTheLoop` settings are persisted
