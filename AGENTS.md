# Repository Guide

## Toolchain

- Use Node.js `>=22.19.0` and npm; `package-lock.json` is the dependency source of truth.
- Install with `npm install`. Validate with `npm run typecheck` and `npm test`.
- For focused type checks, use `npm run typecheck:server` or `npm run typecheck:dashboard`; `npm run prepack` rebuilds the dashboard and runs both type checks plus the full test suite.
- Run one test file with `npm test -- src/config/config.test.ts`; add `-t "test name"` to select one test.
- There is no extension build step: Pi loads `src/index.ts` directly. Dashboard source lives in `src/dashboard-client/`; committed `src/dashboard-dist/` assets are what the package ships. Regenerate them with `npm run build:dashboard` after frontend changes.
- This is ESM with `moduleResolution: NodeNext`; keep `.js` suffixes on relative imports in TypeScript source.

## Architecture

- `src/index.ts` is the Pi extension entrypoint and owns lifecycle hooks and slash-command registration.
- `/orchestrate` is an interactive, argument-free command: collect the workflow route with `ctx.ui.select`, then collect the request with `ctx.ui.input`; keep controller and dashboard guidance consistent with that flow.
- `src/orchestrator.ts` is a thin public facade. Mutable services/state and workflow phases live under `src/orchestration/`; SDK agent execution belongs under `src/agents/`, checks under `src/checks/`, and workspace policy under `src/workspace/`.
- All user-selected routes share exploration/planning, then dispatch through fixed route templates. Check setup is deferred until a mutation route is approved; read-only and planning-only routes run neither checks nor mutation agents.
- `prompts/*.md` are runtime contracts, not documentation. Changes to agent tasks or responses usually require coordinated edits to `src/agent-task-types.ts`, `src/agents/agent-output-validation.ts`, the relevant prompt, and contract tests such as `src/agents/prompts.test.ts` and `src/validation.test.ts`.
- Agent sessions are in-memory Pi SDK sessions, not subprocesses. `src/agents/agent-session.ts` disables nested extensions, skills, prompt templates, and shell access; project checks are separate orchestrator-owned `pi.exec` calls.

## Safety And State

- Plan `files` and `testSupportFiles` are exact repository-relative mutation permissions, not directories or globs. Role tool limits and before/after workspace validation are enforced in `src/agents/role-capabilities.ts`, `src/agents/agent-session.ts`, and `src/workspace/workspace-guard.ts`.
- Project config and run artifacts normally live under `.pi/orchestrator/` and are gitignored runtime state. The actual directory name comes from Pi's exported `CONFIG_DIR_NAME`; do not hard-code `.pi` in source logic.
- Permanent project memory is stored under Pi's global agent directory, keyed to the project path, not in the repository run directory.
- Persisted config, memory, checkpoints, and finalization state are validated and fail closed; malformed data must not be silently replaced or normalized on disk. Checkpoints are immutable numbered files with a validated latest-pointer digest.
- Tests are colocated as `src/**/*.test.ts` and `src/**/*.test.tsx`. Workspace tests create real temporary Git repositories; most orchestration tests use dependency-injected agents/check runners and temporary directories.
