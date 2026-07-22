# Approved Check Setup Plan

## Context

Today `/orchestrate` calls `loadConfig(cwd)`, which creates `.pi/orchestrator/config.json` with `checks: []`, then immediately fails in `Orchestrator.runWorkflow()`. The safe default prevents arbitrary guessed commands from executing, but forces a manual edit and a second invocation.

The requested change is to preserve explicit user approval while making first-run setup complete in one `/orchestrate` command: discover credible project checks, show the exact commands, ask the user, atomically save approved checks, and continue the same workflow.

Current Pi extension APIs already provide `ctx.ui.confirm`, `ctx.ui.select`, `ctx.ui.input`, and `ctx.ui.editor`. Existing config loading/validation and `saveConfig()` should remain authoritative.

## Approach

1. Add deterministic, read-only Node project check discovery separate from orchestration. Discovery is limited to Pi's current `ctx.cwd`; it does not search child directories or silently change the workflow root.
2. Read `package.json` and identify npm, pnpm, Yarn, or Bun from the authoritative `packageManager` field first, then a single matching lockfile. Conflicting lockfiles produce no automatic suggestion rather than guessing; no lockfile falls back to npm.
3. Suggest only existing package scripts in fixed order: `test`, `typecheck`, `lint`, then `build`. Skip the default failing `npm init` test placeholder. Add non-watch flags only for recognized runners (initially React Scripts, including `--watchAll=false --passWithNoTests`).
4. On empty checks, use `ctx.ui.select()` with **Approve suggested checks**, **Edit commands**, and **Cancel**. Display the exact commands in the prompt. Editing opens `ctx.ui.editor()` prefilled with one command per line; blank lines are removed and at least one command is required.
5. If approved/edited, update `config.checks`, call existing atomic `saveConfig()`, and continue the same `/orchestrate` invocation into model preflight/baseline. If cancelled, leave `checks: []`, notify the user, and return before creating a run ID/artifact directory.
6. Never prompt or rewrite when the user already configured non-empty checks. In JSON/print mode (`ctx.hasUI === false`), leave the config untouched and stop with the existing actionable config path; RPC/TUI can use dialogs.
7. Discovery never executes commands and never asks an LLM. The existing green baseline remains the authority after approval.

## Files to modify

- `src/check-discovery.ts` (new) — current-root `package.json`, package-manager, script, and command suggestion logic.
- `src/check-setup.ts` (new) — Pi select/editor approval flow and approved config persistence.
- `src/orchestrator.ts` — invoke setup after `loadConfig()` but before run state/artifact creation, then continue with the returned config.
- `src/types.ts` — package-manager/discovery result types if shared.
- `src/index.ts` — no structural change expected unless setup notification behavior benefits from a dedicated message.
- `src/check-discovery.test.ts` and `src/check-setup.test.ts` (new), plus orchestration tests.
- `README.md` and `examples/config.json` — document first-run approval and fallback behavior.

## Reuse

- `loadConfig()`, `saveConfig()`, and `configPath()` in `src/config.ts`.
- `ExtensionCommandContext` and `ctx.ui.confirm()` from the Pi extension SDK.
- Existing empty-check hard stop as the final invariant if setup cannot produce an approved list.
- Current `runChecks()` behavior; discovery does not execute commands.
- Existing fake-agent/check test architecture in `src/orchestrator.test.ts`.

## Steps

- [x] Define `PackageManager`, `CheckDiscoveryResult`, and setup-result contracts without changing the persisted config schema.
- [x] Implement current-root discovery: safely parse `package.json`, honor supported `packageManager` values, detect exactly one lockfile, reject conflicting lockfiles, and extract only the ordered supported scripts.
- [x] Build commands for npm/pnpm/Yarn/Bun and add React Scripts non-watch test arguments; skip placeholder tests and return diagnostics when nothing safe is discoverable.
- [x] Implement the TUI/RPC setup flow with `select` → optional multiline `editor`, exact command display, normalization, cancel handling, and no implicit approval in non-UI modes.
- [x] Integrate setup immediately after `loadConfig()` and before run ID/store/dashboard creation. Persist approved checks atomically, continue the same invocation, and retain the empty-check invariant as a defensive fallback.
- [x] Preserve non-empty configured checks byte-for-meaning (no prompt, discovery, or rewrite) and limit all discovery to `ctx.cwd`.
- [x] Add unit/integration coverage for all four package managers, `packageManager` precedence, lockfile conflicts, ordered scripts, React Scripts, placeholder/no-script projects, approve/edit/cancel/non-UI paths, same-invocation continuation, and existing-check bypass.
- [x] Update README/examples to explain first-run approval and current-root-only discovery; run typecheck, tests, and package dry-run.

## Verification

- Fresh Node/React project in the current cwd: `/orchestrate` proposes only existing `test`/`typecheck`/`lint`/`build` scripts, approval writes config, and the same invocation reaches baseline.
- Approve: exact suggestions are persisted before any command executes.
- Edit: edited newline-delimited commands are normalized, validated, persisted, and used by the same invocation.
- Cancel/Escape: config remains `checks: []`; no run ID, dashboard, agents, or checks are created, and cancellation is not reported as a failed workflow.
- Existing checks: no filesystem discovery dialog and no config rewrite.
- Missing/malformed package manifest, conflicting lockfiles, placeholder tests, or no supported scripts: no commands are guessed; the user may edit custom commands or cancel.
- Non-UI mode: no implicit approval, write, or command execution.
- React Scripts tests use a non-watch invocation suitable for automation.
- npm, pnpm, Yarn, and Bun command strings and precedence rules have table-driven tests.
- Starting Pi at `C:\Projects\FlappyBird` does not inspect its child; documentation directs the user to start at `C:\Projects\FlappyBird\Flappy-Bird-with-Neural-Network`.

## Decisions

- Discovery scope: current `ctx.cwd` only.
- Approval flow: Approve / Edit / Cancel.
- Ecosystem scope: Node `package.json` projects using npm, pnpm, Yarn, or Bun.
