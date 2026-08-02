# Repository Guide

## Communication

- Keep responses concise: answer directly, shortly and concisely, avoid preamble and summaries, and match the requested level of detail (one word when possible, more only when the user asks for detail).
- Report tool actions in one line; don't repeat file content back unless asked.

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
- `/requirements` is an interactive, argument-free interview: an in-memory `RequirementsSession` in `src/commands/requirements-command.ts` owns the session lifecycle and interview loop (a deliberate exception to the orchestration-state rule, kept in the command because it never touches workflow state); `src/agents/explorer-spawn.ts` builds spawned-explorer runs, and `src/ui/decision-race.ts` owns the shared dashboard-vs-prompt decision race used by both the requirements session and the orchestration human gates.
- `src/orchestrator.ts` is a thin public facade. Mutable services/state and workflow phases live under `src/orchestration/`; SDK agent execution belongs under `src/agents/`, checks under `src/checks/`, and workspace policy under `src/workspace/`.
- All user-selected routes share exploration/planning, then dispatch through fixed route templates. Check setup is deferred until a mutation route is approved; read-only and planning-only routes run neither checks nor mutation agents.
- `prompts/*.md` are runtime contracts, not documentation. Changes to agent tasks or responses usually require coordinated edits to `src/agent-task-types.ts`, `src/agents/agent-output-validation.ts`, the relevant prompt, and contract tests such as `src/agents/prompts.test.ts` and `src/validation.test.ts`.
- Agent sessions are in-memory Pi SDK sessions, not subprocesses. `src/agents/agent-session.ts` disables nested extensions, skills, prompt templates, and shell access; project checks are separate orchestrator-owned `pi.exec` calls. Planner, reviewer, debugger, and interviewer may spawn read-only `explorer` sub-agents through the orchestrator-owned `spawn_explorer` tool; spawned runs use the dedicated `prompts/explorer-spawn.md` contract and their usage is folded into the parent step.

## Safety And State

- Plan `files` and `testSupportFiles` are exact repository-relative mutation permissions, not directories or globs. Role tool limits and before/after workspace validation are enforced in `src/agents/role-capabilities.ts`, `src/agents/agent-session.ts`, and `src/workspace/workspace-guard.ts`.
- Project config and run artifacts normally live under `.pi/orchestrator/` and are gitignored runtime state. The actual directory name comes from Pi's exported `CONFIG_DIR_NAME`; do not hard-code `.pi` in source logic.
- Permanent project memory is stored under Pi's global agent directory, keyed to the project path, not in the repository run directory.
- Persisted config, memory, checkpoints, and finalization state are validated and fail closed; malformed data must not be silently replaced or normalized on disk. Checkpoints are immutable numbered files with a validated latest-pointer digest.
- Tests are colocated as `src/**/*.test.ts` and `src/**/*.test.tsx`. Workspace tests create real temporary Git repositories; most orchestration tests use dependency-injected agents/check runners and temporary directories.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **piOrchestrator** (4518 symbols, 14414 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/piOrchestrator/context` | Codebase overview, check index freshness |
| `gitnexus://repo/piOrchestrator/clusters` | All functional areas |
| `gitnexus://repo/piOrchestrator/processes` | All execution flows |
| `gitnexus://repo/piOrchestrator/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
