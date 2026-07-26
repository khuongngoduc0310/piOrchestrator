# Pi Orchestrator Improvement Plan

## Context

The extension is a compact deterministic workflow: explorer → planner/review → baseline → test authoring → implementation/debug loop → code review → documentation/lesson review. It persists run artifacts and exposes terminal/browser status. The selected next milestone is **reliability first**, with no new runtime validation dependency and compatibility for existing `.pi/orchestrator/config.json` files that use the documented/default built-in tools. Role sessions will intentionally reject custom extension tool names, stop before edits on any red/empty baseline, and remove the currently broken zip-packaging command.

### Review findings

**Critical correctness**

- `src/orchestrator.ts` runs a second builder after each failed check, then starts the next attempt with another builder before rechecking. The final debugger-directed fix can therefore be left completely untested when the retry limit is reached.
- `reviewRevisions` is unused. Code review allows only one fix, never re-reviews it, and treats malformed/unrecognized review JSON as implicit acceptance.
- Baseline failures are saved but otherwise ignored; the workflow mutates the tree and later demands all checks pass, potentially asking agents to repair unrelated pre-existing failures.
- Repeated calls overwrite artifacts such as `planning-planner.json` and `implementing-builder.json`, losing revisions and attempt history. Checks after review fixes are not saved.

**Boundary and process reliability**

- `safeJson` accepts unvalidated `any`; only selected reviewer decisions are inspected. All other advertised JSON contracts are unchecked.
- `src/agent-runner.ts` passes the complete accumulated payload on the command line (likely to exceed Windows command-line limits), buffers stderr/events without limits, has no timeout, ignores a final non-newline JSON record, and can succeed with an empty final answer.
- Child termination is not robust for nested tool processes. The SDK already exposed by the peer dependency provides in-memory sessions, typed events, model resolution, abort, and disposal, so process-level CLI integration is unnecessary.
- `src/checks.ts` has no timeout/output bound and no spawn-error path. Pi's existing `ExtensionAPI.exec()` already supports cwd, timeout, and `AbortSignal` and should be reused.
- Fire-and-forget event writes can race; state/config JSON writes are not atomic.

**State and configuration**

- Agent status remains `running` when a call fails and conflates process success with reviewer approval. Transitioning to `failed`/`cancelled` also loses the stage that actually failed.
- `loadConfig` catches missing, malformed, and unreadable files identically and may overwrite a user's invalid config with defaults. It performs no range, enum, path, or shape validation and has no forward-compatible default merge.
- `src/index.ts` and UI helpers use `any` despite exported Pi context types. Cancel reports success when nothing is running; duplicate starts throw outside the workflow error path.
- `.pi` is hardcoded even though Pi exports `CONFIG_DIR_NAME` specifically for rebranded distributions.

**Quality and packaging**

- There are no tests. `node --test` does not target any project test files.
- `README.md` instructs `npm run build`, but there is no build script. `pack:zip` points to missing `scripts/pack.mjs`; no lint script exists.
- Generated default checks assume every target has npm `test`, `lint`, and `build` scripts. This extension itself does not satisfy those defaults. A generic orchestrator should require explicit project checks rather than guess an ecosystem.
- Prompts are one-line role descriptions. They do not fully specify schemas, failure behavior, scope boundaries, or evidence requirements.
- Tool restrictions are not an OS sandbox; tester/builder still share the working tree. This remains a follow-up isolation milestone, not something to disguise as solved here.

TypeScript currently passes via `node_modules\\.bin\\tsc.cmd --noEmit`. The working directory is not a Git checkout, and the available shell wrapper could not provide useful npm test output; verification must include a normal Node/npm environment.

## Approach

Keep the workflow sequential, but turn its external boundaries and loop rules into explicit, testable contracts:

1. Replace nested `pi` CLI spawning with the peer package's SDK (`createAgentSession`, `ModelRuntime`, `resolveCliModel`, `DefaultResourceLoader`, and `SessionManager.inMemory`). Use a fresh, disposed session per role, preserve project context files, disable nested extension/skill/prompt discovery for deterministic role execution, and expose only validated built-in tools.
2. Add dependency-free, path-aware validation functions for config and each agent output. JSON may be raw or in one JSON fence, but prose, missing fields, invalid enums, duplicate task IDs, and dangling task dependencies fail the step with an actionable artifact.
3. Introduce narrow injectable interfaces for agent execution, checks, clock/IDs, and persistence. The production check adapter should use `ExtensionAPI.exec()` with timeout/abort; tests should use fakes rather than real models or shell commands.
4. Make every mutation followed by checks before another mutation. Require a green, non-empty baseline before test creation so pre-existing failures stop safely rather than being silently absorbed into the task.
5. Persist a versioned run manifest plus uniquely numbered step artifacts using queued/atomic writes. Keep aggregate status for UI, but add step history and preserve the failing stage.
6. Treat resume/worktrees, parallel agents, run-history UI, and cost optimization as later milestones. This milestone records sufficient ordered checkpoints for future resume but does not offer unsafe partial-run resume.

## Files to modify

- `src/types.ts` — validated config/output types, step history, failure metadata, timeout/output limits.
- `src/validation.ts` (new) — dependency-free JSON extraction and path-aware guards for config and role contracts.
- `src/agent-runner.ts` — SDK-backed `AgentExecutor`, model preflight/cache, timeout/abort/dispose, final-message and usage capture.
- `src/checks.ts` — injectable `ExtensionAPI.exec()` adapter, sequential execution, timeout/output truncation metadata, cancellation semantics.
- `src/orchestrator.ts` — corrected plan/implementation/review loops, green-baseline gate, final verification, failure-safe step wrapper.
- `src/store.ts` — schema-versioned manifest, sequence-based artifacts, serialized event queue, atomic JSON replacement, flush on shutdown.
- `src/config.ts` — distinguish ENOENT from invalid config, merge new defaults without rewriting valid existing config, use `CONFIG_DIR_NAME`, validate updates.
- `src/index.ts` — typed command contexts, guarded start/cancel/model update, argument completions.
- `src/dashboard.ts` — listen-error handling, orderly async close/SSE cleanup, render step/failure state.
- `src/terminal-ui.ts` — typed context and accurate failed/cancelled rendering/cleanup.
- `prompts/{explorer,planner,reviewer,tester,builder,debugger,documenter}.md` — exact JSON contracts, scope/evidence rules, and role-specific failure expectations.
- `src/**/*.test.ts` (new) — validation, config, runner, checks, store, and orchestrator scenarios.
- `package.json` / `package-lock.json` — add Vitest as a dev-only test runner, declare the Node engine floor, and remove invalid scripts.
- `README.md` and `examples/config.json` — document strict baseline policy, limits, artifacts, failure behavior, and corrected commands.

## Reuse

- Keep `Orchestrator` as the only workflow-state authority (`src/orchestrator.ts`). Agents report facts/results; they never choose transitions or retries.
- Keep the `.pi/orchestrator/runs/<run-id>/` convention and JSONL event log from `RunStore` (`src/store.ts`).
- Keep sequential `runChecks` ordering and existing per-agent model/tool configuration.
- Keep the local-only SSE dashboard and terminal widget, while making lifecycle/error handling accurate.
- Reuse Pi SDK APIs already supplied by `@earendil-works/pi-coding-agent`: `createAgentSession`, `ModelRuntime`, `resolveCliModel`, `DefaultResourceLoader`, `SessionManager.inMemory`, `CONFIG_DIR_NAME`, typed `ExtensionCommandContext`, and `ExtensionAPI.exec`.
- Reuse SDK `AgentSession.subscribe`, `abort`, and `dispose` instead of maintaining a second JSONL CLI protocol/process lifecycle.

## Steps

- [x] **Define contracts and limits.** Extend `src/types.ts` with thinking-level enums, `schemaVersion`, per-step records, `failedStage`, timeout/output caps, and explicit role output interfaces. Add `src/validation.ts` with small `isRecord`/field readers and role-specific validators; include task graph checks and precise error paths.
- [x] **Load configuration safely and compatibly.** In `src/config.ts`, create defaults only on ENOENT; report malformed/unreadable config without overwriting it; recursively merge missing new fields (`agentTimeoutMs`, `checkTimeoutMs`, and `maxOutputBytes`) into existing configs in memory; atomically save explicit updates; validate non-empty models/prompts, built-in tool names (`read`, `write`, `edit`, `bash`, `grep`, `find`, `ls`), thinking levels, finite non-negative retry counts, ports, commands, and limits. Keep existing configured checks and all current keys/built-in values valid. For newly generated configs, use `checks: []` and stop with the exact config path until the user supplies project-specific checks instead of guessing npm scripts. Reject custom extension tool names with a migration error because deterministic SDK role sessions do not load nested extensions. Use Pi's `CONFIG_DIR_NAME` (currently still `.pi`). Validate `/agent-model` before writing, with an explicit way to retain or clear thinking.
- [x] **Move agents to in-process SDK sessions.** Refactor `src/agent-runner.ts` behind an `AgentExecutor` interface. Initialize/cache `ModelRuntime`, pre-resolve all configured models before mutations, verify prompt paths remain under `prompts/`, create an in-memory session with only configured built-in tools and project context, subscribe to typed events, collect the final assistant text/usage, and stream only bounded/sanitized lifecycle/tool metadata to the store rather than retaining full event payloads in memory. Enforce timeout and caller abort through `session.abort()`, reject empty/incomplete results, and always unsubscribe/dispose in `finally`.
- [x] **Harden checks with existing Pi execution.** Pass a narrow exec adapter from `ExtensionAPI.exec` into `src/checks.ts`; retain platform shell selection and sequential ordering, but add per-command timeout, abort distinction, bounded captured output with truncation flags, start/end timestamps, and explicit execution-error results. Reject an empty check list for coding workflows.
- [x] **Make storage ordered and crash-tolerant.** Give every step a monotonic sequence/ID and artifact name (including revision/attempt), serialize event appends, atomically replace state/manifest JSON through same-directory temp files, record raw invalid output separately, and flush pending writes during completion/cancellation/shutdown. Do not overwrite earlier planner/builder/reviewer artifacts.
- [x] **Correct orchestration semantics.** Add a common `runAgentStep` wrapper that marks success/failure and persists in `finally`. Validate explorer/plan/review/debug/lesson outputs before use. Revise/re-review plans up to `planRevisions`, failing unless a validated approval is reached. Require all baseline commands green before tester mutation. For each implementation attempt: call builder once, run and save checks immediately, stop on green, otherwise diagnose only if another attempt remains. For code review: validate a decision, apply at most `reviewRevisions` fixes, check each fix, and re-review until approved or exhausted. Validate lesson review separately; a valid `changes_requested` marks proposed lessons rejected and emits a warning rather than failing verified code, while malformed/execution failures still fail the step. Run and save a final check set after documentation; complete only from a fully verified state.
- [x] **Improve extension/UI failure behavior.** Type command/UI contexts, catch duplicate starts and preflight errors, make cancel truthful/idempotent, expose the failed stage and artifact location in status, clear status/widget on shutdown, and make dashboard bind/close/SSE errors non-hanging. Display ordered steps rather than inferring completion solely from stage array position.
- [x] **Strengthen prompts.** Expand every role prompt with the exact matching JSON shape. Require repository evidence from read-only roles, unique/dependency-valid plan tasks, structured changed-files/commands reports from mutating roles, no unrelated fixes, no test weakening, and explicit reviewer blocking criteria. Keep orchestrator validation authoritative rather than trusting prompt compliance.
- [x] **Add automated coverage.** Use Vitest as a dev-only TypeScript-capable runner and fakes for agent/check adapters. Cover config migration/error preservation, empty new-config checks, fenced/raw/malformed output, task graph validation, successful flow, plan exhaustion, immediate first-pass success, retry recovery, final-attempt failure, review re-review/exhaustion, baseline rejection before mutation, timeout/cancel, failed-agent status, artifact uniqueness/order, and store flush behavior.
- [x] **Repair package/docs.** Add the Node version required by Pi `0.81.1` (`>=22.19.0`), make test/typecheck instructions real, remove the unsupported `pack:zip` script, and document generated config migration, built-in-only role tools, strict green baseline, limits, artifacts, SDK execution, and non-sandbox limitations.

### Deferred follow-up milestones

1. Git-aware pre/post step snapshots, allowed-path/diff enforcement, isolated builder worktrees, then safe parallelizable tasks.
2. Explicit `/orchestrator-resume` with workspace fingerprint/checkpoint validation and run-history dashboard.
3. Token/cost/model quality telemetry and model routing based on observed performance.

## Verification

- Run `npm run typecheck` against the installed Pi SDK and `npm test`; require tests to fail the command when no tests are discovered.
- Unit-test every local validator with valid, malformed, extra-prose, boundary, and backward-compatible config cases.
- Run fake-adapter orchestration tests for success, malformed output, plan/review exhaustion, green-baseline enforcement, retry recovery, final-attempt failure, timeout, cancellation, and persistence-write failure. Assert mutating agents are never called after an unsafe baseline and every builder/reviewer fix is checked/re-reviewed.
- Add an SDK runner test with a fake/session factory to assert model preflight, tool allowlisting, event/final-text capture, abort, timeout, unsubscribe, and `dispose()`; do not call a paid model in automated tests.
- Manually install/load in Pi and verify `/orchestrate`, duplicate start, `/orchestrator-status`, `/orchestrator-cancel`, `/agent-model`, terminal cleanup, dashboard live/terminal states, malformed config preservation, and unique artifacts for repeated stages.
- Run one disposable-project smoke workflow with a real configured model and green checks. Inspect that no nested Pi process is created and that cancellation leaves a terminal state plus flushed event log.
- Exercise Windows and POSIX shell adapters for success, missing executable, non-zero exit, timeout, cancellation, and output truncation.
- Verify existing current-shape config files load unchanged in meaning and gain new defaults in memory; historical run artifact compatibility is not required.

## Out of scope

- No new runtime schema package.
- No automatic repair of or continuation past a red/empty baseline.
- No loading of project/global extension tools inside role sessions; only validated Pi built-ins are allowed.
- No worktree isolation, parallel mutation, full resume command, or run-history UI in this milestone.
- No claim that Pi tool allowlists are an OS sandbox.
