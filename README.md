# piOrchestrator

A deterministic, sequential multi-agent workflow extension for the Pi coding agent.

## Workflow

Explorer → Planner → Plan Reviewer → green baseline → Tester → Builder/check retries → Code Reviewer/fix reviews → Documenter → Lesson Reviewer → final checks.

The orchestrator owns every transition, validation decision, and retry limit. Agents cannot advance workflow state themselves.

## Requirements and install

- Node.js `>=22.19.0` (required by Pi `0.81.1`)
- A configured Pi model/provider for every role
- Git with an existing `HEAD` when mutation worktree isolation is enabled

```bash
npm install
npm run typecheck
npm test
pi install ./
```

Pi loads this package directly from `src/index.ts`; there is no separate build command or zip-packaging script.

## Persistent command-line UI

When Pi starts, piOrchestrator shows an adaptive terminal panel in the Pi widget area:

### Idle

```text
┌ piOrchestrator ───────────────────────────────────────┐
│ IDLE · ready                                         │
│ Project: 7 agents configured · 2 checks              │
│ /orchestrate <request> · /orchestrator-settings      │
└───────────────────────────────────────────────────────┘
```

### Running

```text
┌ piOrchestrator · d238f168 ────────────────────────────┐
│ RUNNING · phase 5/8 · attempt 1/3 · 01:24            │
│ planner: ✓  reviewer: ✓  baseline: ✓  tests: →  build │
│ Active: tester · deepseek/deepseek-v4-flash          │
│ Request: add a pause and resume button                │
│ Recent: ✓ tests · → implement plan                    │
│ Artifacts: …/.pi/orchestrator/runs/d238f168…          │
└───────────────────────────────────────────────────────┘
```

### Completed or failed

```text
┌ piOrchestrator · d238f168 ────────────────────────────┐
│ FAILED · exploring · 00:20                           │
│ ! Explorer output could not be validated              │
│ Failed artifact: 001-exploring-invalid-output.txt      │
└───────────────────────────────────────────────────────┘
```

The panel persists across workflow runs and clears only on Pi session shutdown.

## Commands

```text
/orchestrate Add validation to the transaction API
/orchestrator-status
/orchestrator-ui
/orchestrator-cancel
/orchestrator-settings
/orchestrator-inspect
/orchestrator-memory inspect [lesson-id]
/orchestrator-memory pending [run-id]
/orchestrator-memory approve <run-id> <candidate-id>
/orchestrator-memory decline <run-id> <candidate-id>
/orchestrator-memory remove <lesson-id>
/agent-model builder openai/gpt-5.2-codex high
/agent-model builder openai/gpt-5.2-codex retain
/agent-model builder openai/gpt-5.2-codex clear
```

`/orchestrator-settings` opens a project-local wizard for choosing the model and compatible thinking level for every role. It lists only models currently authenticated and available through Pi, stages any number of changes, shows an old → new review, and validates all roles before one atomic save. Cancelling or a failed validation writes nothing. **Use model default** removes that role's explicit thinking override.

`/agent-model` remains the direct single-role shortcut. `retain` keeps the role's current thinking setting; `clear` removes the explicit setting. Both commands resolve and check the complete role configuration before writing. These settings affect orchestrator-created role sessions only; they do not change the active parent chat model selected by Pi's `/model` command.

## Configuration

The first command creates the project-local config at:

```text
.pi/orchestrator/config.json
```

Pi's exported config directory name is used internally, so rebranded Pi distributions may use a different directory. Newly generated configs begin with `"checks": []`. On the first `/orchestrate`, the extension inspects the current project root's `package.json`, proposes supported checks, and asks you to **Approve**, **Edit**, or **Cancel**. Approved checks are saved atomically and the same invocation continues into baseline verification.

Discovery is deliberately limited to Pi's current working directory; it never searches child folders or silently changes the workflow root. Start Pi from the directory containing the project's `package.json`. Node projects using npm, pnpm, Yarn, or Bun are supported. The `packageManager` field is authoritative, otherwise one lockfile is used; conflicting lockfiles are not guessed. Existing scripts are proposed in `test`, `typecheck`, `lint`, `build` order, and React Scripts tests receive non-watch flags. If nothing safe is discovered, choose **Edit commands** to enter one command per line. TUI and RPC modes can approve checks; JSON/print modes never auto-approve.

Example limits:

```json
{
  "schemaVersion": 1,
  "checks": ["npm test", "npm run typecheck"],
  "dashboard": { "enabled": true, "port": 0 },
  "limits": {
    "planRevisions": 2,
    "implementationRetries": 3,
    "reviewRevisions": 2,
    "agentTimeoutMs": 1200000,
    "checkTimeoutMs": 600000,
    "maxOutputBytes": 262144,
    "worktreeIsolation": false
  }
}
```

Existing current-shape configs are supported. Missing `schemaVersion`, timeout, and output-limit fields are merged in memory without rewriting the file. An intentionally omitted optional agent `thinking` value remains omitted. Malformed or unreadable configs are reported and never replaced by defaults. An explicit command update writes the normalized config atomically.

### Role tools

Role sessions support only Pi's built-in tools:

```text
read, write, edit, grep, find, ls
```

Custom project/global extension tool names are rejected with a migration error. SDK role sessions disable nested extension, skill, and prompt-template discovery for deterministic execution while retaining repository context files. Role capabilities are enforced at configuration, session, tool-call, and post-session filesystem-diff boundaries. Explorer, Planner, Reviewer, and Debugger are read-only. Tester, Builder, and Documenter can modify only exact paths authorized by the approved plan. Agents do not receive shell access; project checks remain orchestrator-owned. These controls are not an OS sandbox.

## Reliability policy

- Every role receives the same version-2 task envelope with an authoritative `task` object and nullable advisory `memoryContext`.
- Every structured role response is parsed as raw JSON or exactly one fenced JSON block and validated with dependency-free, role-specific validators. Incidental prose around one fence is ignored; ambiguous multiple fences are rejected.
- A malformed read-only role response receives one correction attempt with mutation-capable tools removed. Tester, Builder, and Documenter are never rerun for output correction because their first session may already have changed files.
- Plans require unique task IDs, valid dependencies, and an acyclic graph.
- Tester reports map every approved acceptance criterion to explicit coverage and the observed pre-implementation result; code review receives that coverage directly.
- Discovered checks are never executed or saved without explicit approval. Existing non-empty checks bypass discovery and are never rewritten.
- All configured baseline commands must pass before Tester/Builder mutation. Cancelled setup, empty checks, or red baselines stop safely; pre-existing failures are not auto-repaired or ignored.
- Every Tester, Builder, review-fix, and Documenter mutation is followed by saved checks before further mutation or completion; the final check set runs after all agent sessions.
- With worktree isolation enabled, the complete mutation phase runs from an exact snapshot of the current Git workspace. The main workspace is updated only after final checks and mutation-policy validation pass. Additions, deletions, renames, binaries, modes, and symlinks are synchronized conflict-safely; a conflicting worktree is retained with a recovery patch.
- The extension never deletes project files based on temporary-looking filenames. Unexpected mutations are reported and, when isolation is enabled, discarded with the worktree.
- Required human gates fail closed outside TUI/RPC mode. Explicit rejection and `/orchestrator-cancel` are recorded as cancellation rather than workflow failure.
- Builder fixes are checked immediately. Code-review fixes are checked and re-reviewed until approved or the configured limit is exhausted.
- Timeouts, cancellation, execution errors, non-zero checks, malformed output, and reviewer decisions remain distinct in state/artifacts.
- A valid lesson `changes_requested` decision rejects the proposed lessons with a warning but does not invalidate already reviewed and verified code. Malformed or failed lesson review still fails the workflow.
- Proposed memory lessons carry bounded role, path, category, and keyword scope and are validated before machine or human review.

## SDK execution

Roles run as fresh in-memory Pi SDK sessions, not nested `pi` subprocesses. Models are pre-resolved before mutation, events are reduced to bounded lifecycle/tool metadata, and every session is aborted/disposed on timeout, cancellation, or completion. Each invocation also records its Pi conversation transcript (user, assistant, collapsed reasoning, tool calls, and tool results) without retaining system prompts or sharing conversation memory between invocations. Project checks reuse `ExtensionAPI.exec` with per-command timeout and bounded stdout/stderr.

## Run artifacts

Each run is stored under:

```text
.pi/orchestrator/runs/<run-id>/
```

Important files include:

- `state.json` and `manifest.json`: versioned current state and ordered step records
- `events.jsonl`: serialized monotonic transition/event metadata
- numbered role/check artifacts containing stage, revision, and attempt
- `*-invocation-*-transcript.json`: versioned per-invocation Pi conversation history, including partial history for failed sessions when available
- `*-invalid-output-attempt-*.txt`: raw malformed assistant output from the initial or correction attempt
- `baseline.json`, `baseline-diff.patch`, and `baseline-staged.patch`: pre-workflow state and full patches available to code review when present
- `plan.json`, `proposed-lessons.json`, and lesson review status
- `candidate-ledger.json`: validated per-candidate machine review, human decision, and promotion lifecycle
- `worktree.json` and `worktree-final.patch` when mutation isolation is enabled

Repeated planner, builder, debugger, and reviewer calls never overwrite earlier artifacts. `/orchestrator-status` reports the failed stage and artifact directory.

## Browser dashboard

The optional dashboard binds only to `127.0.0.1` and uses Server-Sent Events to stream live state. Port `0` lets the OS choose a local port. `/orchestrator-ui` starts or displays it. Dashboard failure is reported as a warning and does not hang the coding workflow.

The dashboard is designed as a focused operations console. Sticky section tabs (Overview, Agents, Timeline, Artifacts) let you navigate between areas while live updates preserve focus, scroll position, and open inspectors. The layout is responsive: two-column desktop overview collapses to a single column on mobile.

Key areas:

- **Status header** — workflow mode, connection indicator (Live/Reconnecting/Disconnected), elapsed time, run ID, and request.
- **Current activity callout** — most important state first: waiting-for-input (amber), failure (red), completed (green), or normal progress.
- **Workflow phases** — eight canonical phases with complete/current/pending visual state. Review-fix and final checks map to the correct phase without regression.
- **Agent grid and inspector** — per-agent status, model, and summary. Click any agent to select an individual invocation and inspect its live or persisted Pi-style conversation. Reasoning is collapsed by default, and tool results are displayed with their matching tool calls. The active agent is auto-followed until you manually select or close the inspector.
- **Recent timeline** — keyed step updates that preserve DOM state. Each entry shows time, status, label, agent, attempt, message, and artifact controls.
- **Artifact viewer** — recent artifact list with size and truncation metadata. The viewer supports line wrapping and persistent content across workflow updates.

When no workflow has run, the dashboard shows one of three states: ready with agent and check counts, setup-required for missing configuration, or a configuration-error message if the config file is invalid — without creating or modifying any files.

The dashboard is read-only, dependency-free at runtime, bound to localhost with security headers (X-Content-Type-Options, CSP, cache control, no-store, asset-less design). SSE clients receive the current state immediately upon connection.

## Project memory

Project memory is available only for trusted projects. It is stored under Pi's agent directory and bound to the current project path. Explicit role scopes are hard eligibility filters, path scopes use repository-segment boundaries, and selected memory is bounded by count and serialized UTF-8 size. Memory remains advisory evidence and must be verified against the repository.

Candidates move through durable machine-review, pending, declined, promotion, duplicate, failure, or promoted states. Deferring a decision keeps a candidate pending; declining is terminal. Malformed, oversized, unsupported, or project-mismatched memory is never overwritten.

## Current limitations and next milestones

- Sequential execution only; no parallel tasks or full resume command yet.
- Worktree isolation requires Git and an existing `HEAD`. Submodule mutation is not supported.
- Permanent-memory promotion always requires explicit human approval.
- Tool and diff restrictions do not provide an operating-system sandbox.

Recommended follow-ups are git-aware snapshots and isolated builder worktrees, then checkpoint-validated resume/run history, followed by token/cost/model-quality telemetry.
