# piOrchestrator

A deterministic, sequential multi-agent workflow extension for the Pi coding agent.

## Workflow

Every route begins with Explorer → Planner → Plan Reviewer. Read-only routes then report their route-specific result; approved mutation routes continue through deferred check setup and a green baseline into their fixed mutation/review/finalization phases.

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

Pi loads this package directly from `src/index.ts`; there is no extension build step. The browser dashboard is a React application built with Vite. Prebuilt assets are committed under `src/dashboard-dist/` so `pi install ./` works without running the dashboard build. Run `npm run build:dashboard` to regenerate them after modifying the frontend source.

## Persistent command-line UI

When Pi starts, piOrchestrator shows an adaptive terminal panel in the Pi widget area:

### Idle

```text
┌ piOrchestrator ───────────────────────────────────────┐
│ IDLE · ready                                         │
│ Project: 7 agents configured · 2 checks              │
│ /orchestrate · /orchestrator-settings                │
└───────────────────────────────────────────────────────┘
```

### Running

```text
┌ piOrchestrator · d238f168 ────────────────────────────┐
│ RUNNING · phase 5/8 · attempt 1/3 · 01:24            │
│ expl✓ plan✓ revi✓ test→ buil· debu· docu·             │
│ Active: tester · deepseek/deepseek-v4-flash          │
│ Request: add a pause and resume button                │
│ Recent: ✓ tests · → implement plan                    │
│ Artifacts: …/.pi/orchestrator/runs/d238f168…          │
└───────────────────────────────────────────────────────┘
```

### Paused, completed, or failed

```text
┌ piOrchestrator · d238f168 ────────────────────────────┐
│ FAILED · exploring · 00:20                           │
│ ! Explorer output could not be validated              │
│ Failed artifact: 001-exploring-invalid-output.txt      │
└───────────────────────────────────────────────────────┘
```

The panel shows idle setup guidance, live route/phase/agent activity, durable human-decision waits, paused resume information, and terminal outcomes. It keeps the latest run visible until another run starts and clears on Pi session shutdown. A completed read-only run does not claim that configured checks passed.

## Commands

```text
/orchestrate
/orchestrator-status
/orchestrator-resume [exact-run-id]
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

`/orchestrator-settings` opens a project-local wizard for agent models or workflow settings. Agent settings list authenticated models and compatible thinking levels, stage role changes, show an old → new review, and validate every role before an atomic save; **Use model default** removes a role's explicit thinking override. Workflow settings cover retry limits, timeouts/output limits, mutation isolation, human review, and dashboard behavior, with review before an atomic save. Cancelling or failed validation writes nothing.

`/agent-model` remains the direct single-role shortcut. `retain` keeps the role's current thinking setting; `clear` removes the explicit setting. Both commands resolve and check the complete role configuration before writing. These settings affect orchestrator-created role sessions only; they do not change the active parent chat model selected by Pi's `/model` command.

`/orchestrator-resume [exact-run-id]` continues a paused, failed, or cancelled run from its latest validated checkpoint. Without an argument it opens an interactive browser that prioritizes paused decisions before other recent resumable runs; selecting one requires confirmation. With an exact run ID the command resumes immediately without browsing. A paused run reopens its durable pending decision rather than guessing an answer. Resume requires the same project path, extension version, normalized configuration, project-memory content, and workspace contents. Isolated runs additionally require their original registered detached worktree at the expected commit. The command never accepts an abbreviated run ID and never repeats a Tester, Builder, review fix, or Documenter that completed at the checkpoint.

## Configuration

The first command that loads configuration creates the project-local config at:

```text
.pi/orchestrator/config.json
```

Pi's exported config directory name is used internally, so rebranded Pi distributions may use a different directory. Newly generated configs begin with `"checks": []`. `/orchestrate` does not perform check setup up front: read-only and planning-only routes complete without checks. After a mutation route's plan is approved, the extension inspects the current project root's `package.json`, proposes supported checks, and asks you to **Approve**, **Edit**, or **Cancel**. Approved checks are saved atomically and the same invocation continues into baseline verification.

Discovery is deliberately limited to Pi's current working directory; it never searches child folders or silently changes the workflow root. Start Pi from the directory containing the project's `package.json`. Node projects using npm, pnpm, Yarn, or Bun are supported. The `packageManager` field is authoritative, otherwise one lockfile is used; conflicting lockfiles are not guessed. Existing scripts are proposed in `test`, `typecheck`, `lint`, `build` order, and React Scripts tests receive non-watch flags. If nothing safe is discovered, choose **Edit commands** to enter one command per line. TUI and RPC modes can approve checks; JSON/print modes never auto-approve.

Human participation is configured through the Autonomous, Balanced, Controlled, or Custom profile in `/orchestrator-settings`. The `humanInTheLoop.diagnosisApproval` custom setting accepts `"never"`, `"low_confidence"`, or `"always"`. It applies only to the initial actionable diagnosis produced for `bug_fix`: low-confidence mode pauses only when Debugger reports low confidence, while always mode pauses for every actionable bug diagnosis. Diagnosis approval occurs before diagnosis-driven scope expansion and mutation confirmation, which remain separate decisions. Cancelling stops before Tester, Builder, or worktree creation; non-interactive runs pause durably and can be continued with `/orchestrator-resume` without rerunning the initial diagnosis.

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
    "worktreeIsolation": true
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

### Workflow routes

Run `/orchestrate`, select one validated route, then enter the request in the interactive prompt. The Planner must preserve that route while the orchestrator owns its phase sequence:

- `implementation` runs check setup, baseline verification, Tester, Builder and retries, code review and fixes, documentation, final checks, and optional worktree synchronization.
- `review_only` runs Explorer, Planner approval, and a repository Reviewer, then reports findings without project checks or mutation-capable agents. A reviewer `changes_requested` decision is a successful findings report on this route and never invokes Builder.
- `documentation_only` permits only Documenter changes to documentation-classified plan files, with green baseline and final checks.
- `tests_only` starts from a green baseline and permits only Tester changes to test-classified or narrowly classified test-support plan paths. It adds or updates tests for existing expected behavior and must leave final checks green; it does not intentionally create a red test-first handoff to Builder.
- `investigation_only` runs a read-only evidence and diagnosis workflow without checks or mutation agents.
- `bug_fix` requires a green baseline, diagnoses root cause before regression tests, applies any configured durable diagnosis approval before scope expansion or mutation, then runs Builder, review, documentation, and final checks.
- `quick_implementation` skips test-first generation but retains baseline, Builder verification, code review, documentation, and final checks.
- `planning_only` completes after exploration and approved planning without checks or mutation agents.

Task `files` are exact mutation authorization paths for mutating routes and inspection targets for read-only routes. Unknown routes, Planner route changes, role/route mismatches, and attempts to derive mutation scope from read-only plans fail closed.

## Reliability policy

- Every role receives the same version-3 task envelope with an authoritative `task` object and nullable advisory `memoryContext`.
- Every structured role response is parsed as raw JSON or exactly one fenced JSON block and validated with dependency-free, role-specific validators. Incidental prose around one fence is ignored; ambiguous multiple fences are rejected.
- A malformed read-only role response receives one correction attempt with mutation-capable tools removed. Malformed Tester, Builder, and Documenter output is not retried because the first session may already have changed files. If a valid mutating-role response reports the wrong `changedFiles`, one read-only correction session receives the observed file delta and may correct only its output; the workspace is re-audited and any correction-time mutation fails closed.
- Plans require unique task IDs, valid dependencies, and an acyclic graph.
- Tester reports map every approved acceptance criterion to explicit coverage and the observed pre-implementation result; code review receives that coverage directly.
- Discovered checks are never executed or saved without explicit approval. Existing non-empty checks bypass discovery and are never rewritten.
- Mutation routes require all configured baseline commands to pass before agent mutation. Check setup is deferred until after route approval, so read-only routes do not require or execute project checks. Cancelled setup, empty checks, or red baselines stop specialized mutation and bug-fix workflows safely.
- Every Tester, Builder, review-fix, and Documenter mutation is followed by saved checks before further mutation or completion; the final check set runs after all agent sessions.
- With worktree isolation enabled, no worktree is created during exploration or planning. It is created from an exact snapshot of the current Git workspace only when the approved workflow enters its mutation phase, after any required mutation confirmation; all mutation agents and checks then use it. The main workspace is updated only after final checks and mutation-policy validation pass. Additions, deletions, renames, binaries, modes, and symlinks are synchronized conflict-safely; a conflicting worktree is retained with a recovery patch.
- The extension never deletes project files based on temporary-looking filenames. Unexpected mutations are reported and, when isolation is enabled, discarded with the worktree.
- Required human gates fail closed outside TUI/RPC mode. Explicit rejection and `/orchestrator-cancel` are recorded as cancellation rather than workflow failure.
- Builder fixes are checked immediately. Code-review fixes are checked and re-reviewed until approved or the configured limit is exhausted.
- Timeouts, cancellation, execution errors, non-zero checks, malformed output, and reviewer decisions remain distinct in state/artifacts.
- A valid lesson `changes_requested` decision rejects the proposed lessons with a warning but does not invalidate already reviewed and verified code. Malformed or failed lesson review still fails the workflow.
- Proposed memory lessons carry bounded role, path, category, and keyword scope and are validated before machine or human review.

## SDK execution

Roles run as fresh in-memory Pi SDK sessions, not nested `pi` subprocesses. Models are pre-resolved before mutation, events are reduced to bounded lifecycle/tool metadata, and every session is aborted/disposed on timeout, cancellation, or completion. Each invocation also records its Pi conversation transcript (user, assistant, collapsed reasoning, tool calls, and tool results) without retaining system prompts or sharing conversation memory between invocations. Project checks reuse `ExtensionAPI.exec` with per-command timeout and bounded stdout/stderr.

The programmatic `Orchestrator.start()` and `Orchestrator.resume()` promises represent controller completion, including durable recording of a failed, cancelled, or paused workflow. After either promise resolves, callers must inspect `getState().status` for the workflow outcome. Setup failures that occur before workflow state is initialized still reject the promise.

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
- immutable `checkpoint-*.json` files plus `checkpoint-latest.json` for validated continuation state
- `finalization-intent.json` and completion markers around worktree synchronization and memory promotion

Repeated planner, builder, debugger, and reviewer calls never overwrite earlier artifacts. `/orchestrator-status` reports the failed stage and artifact directory.

### Checkpoint resume

Checkpoints are written only after a role output and its workspace delta have both passed validation, or after a phase reaches another stable boundary. A resumed run appends to the original step and event history and marks stale running records as interrupted.

Resume fails closed when any safety binding differs, an artifact or checkpoint digest is invalid, a worktree is missing or changed, another process owns the run lease, or finalization may already have applied external side effects. In those cases, use `/orchestrator-inspect <run-id>` and the retained artifacts or recovery worktree; the extension does not guess, silently roll back, or replay uncertain synchronization and memory-promotion operations.

## Browser dashboard

The optional dashboard binds only to `127.0.0.1` and uses Server-Sent Events to stream live state. Port `0` lets the OS choose a local port. When enabled, the dashboard starts and opens automatically for new and resumed workflows. `/orchestrator-ui` can explicitly start or display it at any time. Dashboard failure is reported as a nonfatal warning and does not stop the workflow.

The dashboard is designed as a focused operations console. Sticky section tabs (Overview, Agents, Timeline, Artifacts) let you navigate between areas while live updates preserve focus, scroll position, and open inspectors. The layout is responsive: two-column desktop overview collapses to a single column on mobile.

Key areas:

- **Status header** — workflow mode, connection indicator (Live/Reconnecting/Disconnected), elapsed time, run ID, and request.
- **Current activity callout** — most important state first: waiting-for-input (amber), failure (red), completed (green), or normal progress.
- **Workflow phases** — eight canonical phases with complete/current/pending visual state. Review-fix and final checks map to the correct phase without regression.
- **Run history** — switch between the active workflow and validated persisted runs without leaving the dashboard. Historical state, transcripts, diffs, and artifacts are read through bounded nonsymlink-safe endpoints.
- **Agent grid and inspector** — per-agent status, model, and summary. Auto-follow the active agent, pin an agent manually, or close the inspector. Each invocation has searchable transcript and file tabs.
- **Invocation file diffs** — every successful, failed, timed-out, or cancelled invocation records structured Git-tree metadata and a binary-capable patch without changing the real index. The viewer provides a changed-file tree and highlighted unified diff; non-Git workspaces retain changed-file audit metadata but report textual patches unavailable.
- **Recent timeline** — keyed step updates that preserve DOM state. Each entry shows time, status, label, agent, attempt, message, and artifact controls.
- **Artifact viewer** — recent artifact list with size and truncation metadata. The viewer supports line wrapping and persistent content across workflow updates.

When no workflow has run, the dashboard shows one of three states: ready with agent and check counts, setup-deferred for missing configuration, or a configuration-error message if the config file is invalid, without creating or modifying files. Its setup and overview guidance makes clear that read-only routes need no project checks and that checks/file changes appear only for routes that use them.

The dashboard is a React application built into self-contained local assets under `src/dashboard-dist/`. It is read-only, bound to localhost with security headers (X-Content-Type-Options, CSP, cache control, no-store), and requires no external network dependencies. SSE clients receive the current state immediately upon connection.

## Project memory

Project memory is available only for trusted projects. It is stored under Pi's agent directory and bound to the current project path. Explicit role scopes are hard eligibility filters, path scopes use repository-segment boundaries, and selected memory is bounded by count and serialized UTF-8 size. Memory remains advisory evidence and must be verified against the repository.

Candidates move through durable machine-review, pending, declined, promotion, duplicate, failure, or promoted states. Deferring a decision keeps a candidate pending; declining is terminal. Malformed, oversized, unsupported, or project-mismatched memory is never overwritten.

## Current limitations and next milestones

- Sequential execution only; checkpoint resume does not introduce parallel tasks.
- Worktree isolation requires Git and an existing `HEAD`. Submodule mutation is not supported.
- Permanent-memory promotion always requires explicit human approval.
- Tool and diff restrictions do not provide an operating-system sandbox.

Recommended follow-ups are token/cost/model-quality telemetry and safe parallelization of independent read-only work.
