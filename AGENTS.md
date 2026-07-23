# Repository Guide

## Toolchain

- Use Node.js `>=22.19.0` and npm; `package-lock.json` is the dependency source of truth.
- Install with `npm install`. Validate with `npm run typecheck` and `npm test`.
- Run one test file with `npm test -- src/config.test.ts`; add `-t "test name"` to select one test.
- There is no build step: Pi loads `src/index.ts` directly. Install the extension locally with `pi install ./` when an end-to-end Pi check is needed.
- This is ESM with `moduleResolution: NodeNext`; keep `.js` suffixes on relative imports in TypeScript source.

## Architecture

- `src/index.ts` is the Pi extension entrypoint and owns lifecycle hooks and slash-command registration.
- `/orchestrate` is an interactive, argument-free command: collect the workflow route with `ctx.ui.select`, then collect the request with `ctx.ui.input`; keep controller and dashboard guidance consistent with that flow.
- `src/orchestrator.ts` is a thin public facade. Mutable services/state live in `src/orchestrator-runtime.ts`; workflow phases are split across `src/orchestrator-*.ts` modules.
- All user-selected routes share exploration/planning, then dispatch through fixed route templates. Check setup is deferred until a mutation route is approved; read-only and planning-only routes run neither checks nor mutation agents.
- `prompts/*.md` are runtime contracts, not documentation. Changes to agent tasks or responses usually require coordinated edits to `src/agent-task-types.ts`, `src/agent-output-validation.ts`, the relevant prompt, and contract tests such as `src/prompts.test.ts` and `src/validation.test.ts`.
- Agent sessions are in-memory Pi SDK sessions, not subprocesses. `src/agent-session.ts` disables nested extensions, skills, prompt templates, and shell access.

## Safety And State

- Plan `files` are exact repository-relative mutation permissions, not directories or globs. Role tool limits and before/after workspace validation are enforced in `src/role-capabilities.ts`, `src/agent-session.ts`, and `src/workspace-guard.ts`.
- Project config and run artifacts normally live under `.pi/orchestrator/` and are gitignored runtime state. The actual directory name comes from Pi's exported `CONFIG_DIR_NAME`; do not hard-code `.pi` in source logic.
- Permanent project memory is stored under Pi's global agent directory, keyed to the project path, not in the repository run directory.
- Config, stores, checkpoints, and finalization use atomic/durable writes. Preserve fail-closed behavior: malformed persisted data must not be silently replaced or normalized on disk.
- Worktree-isolation tests create real temporary Git repositories. Other tests use dependency-injected agents/check runners and temporary directories; keep tests colocated as `src/*.test.ts`.
