# piOrchestrator — Manual `/requirements` Interview Tests

**Disposable fixture:** `../workflow-routes/pocket-ledger-template/`

Eight scenarios covering the `/requirements` interview command: the happy
path, multi-round refinement, multi-select and custom answers, arrow-key
navigation, the dashboard-vs-TUI decision race, handoff into a workflow,
cancellation, and robustness edge cases. Each scenario starts from a clean
fixture copy so no run affects another.

---

## Fixture setup

### Prerequisites

- Node.js `>=22.19.0`
- A running Pi instance with a configured provider (tested with
  `anthropic/claude-sonnet-4-5`).
- The piOrchestrator extension installed and loaded.

### Prepare a clean copy

```powershell
# PowerShell
$fixture = "C:\Temp\requirements-test"
Copy-Item -Recurse "docs\manual-testing\workflow-routes\pocket-ledger-template" $fixture
Set-Location $fixture
git init
git add -A
git commit -m "initial baseline"
npm install
npm test
```

```bash
# shell
fixture=/tmp/requirements-test
cp -r docs/manual-testing/workflow-routes/pocket-ledger-template "$fixture"
cd "$fixture"
git init
git add -A
git commit -m "initial baseline"
npm install
npm test
```

The fixture's six baseline tests must pass.

### Start Pi from the fixture root

```bash
cd /path/to/requirements-test
pi
```

### One-time settings

Run once per fixture:

```
/orchestrator-settings
```

Choose **Agent settings**, then assign **interviewer** and **explorer** a
model that Pi can reach (the interview preflight requires both). The
interviewer must remain read-only; do not grant it `write`, `edit`, or
`bash` tools. Use the default thinking level if the model supports it.

The interview itself only needs `interviewer` and `explorer`; the other
agents are only required for Scenario 5 (handoff into a workflow), where
the chosen route's agents are exercised as usual.

The agent defaults (all other agents omitted for brevity; only roles the
interview touches):

```json
{
  "schemaVersion": 2,
  "dashboard": { "enabled": true, "port": 0 },
  "agents": {
    "interviewer": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium", "tools": ["read", "grep", "find", "ls"], "promptFile": "interviewer.md" },
    "explorer": { "model": "anthropic/claude-sonnet-4-5", "tools": ["read", "grep", "find", "ls"], "promptFile": "explorer.md" }
  }
}
```

The interview writes its artifacts under
`.pi/orchestrator/requirements/<session-id>/` in the fixture root.

### Reset between scenarios

After each scenario, verify the state, then delete the fixture and prepare a
fresh copy from the template. Re-run `/orchestrator-settings` on each fresh
copy.

---

## Scenarios

### Scenario 1: Happy path — single round

Goal input, one question round, `clear` assessment, artifact written.

#### Steps

```
/requirements

Goal: Add and document a summarizeByCategory(transactions) function.
It must return an object whose keys are transaction categories and whose
values are net category totals, adding credits and subtracting debits.
Transactions without a category must use "uncategorized".
An empty transaction list must return an empty object.
```

Answer each of the 5–7 questions through the question-set hub: the TUI
shows a select dialog listing every question in the round, marked `○` when
unanswered and `✓` when answered. Use the arrow keys to move to a question
(Up/Down move one row; while the hub is open, Right also moves down and
Left moves up), press Enter to open its answer dialog, and after each
answer you return to the hub. Once every question is answered the round
auto-completes — there is no **Continue** button. Prefer the recommended
option on most questions; choose a non-recommended option on at least one.
On the completion dialog choose **Done** (decline the handoff — Scenario 5
covers it).

#### Expected behavior

- A browser dashboard tab opens (dashboard enabled by default); the session
  appears as an active run with status `running` and, while a question is
  pending, `waiting` with a pending-decision panel.
- As questions are answered, the dashboard's **Interview record** section
  grows live, grouped under **Round 1 / Round 2** headings. Each entry shows
  the question and its options as a filled-in questionnaire: picked options
  are checked (✓), the recommended option is tagged `recommended`, and a typed
  custom answer appears in its own "Custom answer:" box.
- The interviewer asks 5–7 questions presented through a question-set hub:
  the hub select lists every question of the round with `○ N. <question>`
  for unanswered and `✓ N. <question> — <answer summary>` for answered
  ones, plus **Cancel interview**. Arrow keys navigate the list (Up/Down
  and, while the hub is open, also Left/Right — they are rewritten to
  Up/Down); Enter opens the chosen question's answer dialog; after an
  answer you return to the hub. The round ends as soon as every question
  is answered — the hub never offers **Continue**.
- While an answer dialog is open, Right and Left switch to the next or
  previous question: the dialog closes softly, the hub reopens, and
  pressing Enter on the same row re-opens the *target* question's dialog.
  Right on the last question or Left on the first one is a no-op (the
  dialog closes and the hub reopens).
- Answer dialogs list the question options with `(recommended)` markers,
  plus **✏️ Type my own answer** and **Cancel interview**; dismissing an
  answer dialog with Escape returns to the hub (nothing is lost).
- Before the round is done, return to an already-answered question from the
  hub (`✓`-marked) and change the answer — the record keeps exactly one
  entry per question, in set order, with the revised answer.
- The assessment after the round returns `clear`; the session finalizes
  without a second round.
- A "Requirements saved to …" info toast appears.
- Artifacts exist:
  - `.pi/orchestrator/requirements/<session-id>/requirements.json` —
    `schemaVersion: 1`, populated `goal`, `summary`, `scope`,
    `constraints`, `acceptanceCriteria`, `qa` (one entry per question), and
    `handoffRequest`.
  - `.pi/orchestrator/requirements/<session-id>/requirements.md` — markdown
    with `# Requirements:`, `## Scope`, `## Constraints`,
    `## Acceptance criteria`, `## Interview record`.
- The dashboard session shows status `completed` and the artifact path.
- After completion the dashboard's artifact index lists `requirements.md`
  and `requirements.json`, which open in the artifact viewer (the markdown
  shows the full `## Interview record`); the Interview record section keeps
  showing the answers from the completed session.
- After completion the workspace also shows a structured **Requirement**
  section above the Interview record: the goal, summary, and bulleted lists
  for scope, constraints, acceptance criteria, and open questions (open
  questions shows "None" when the report has none).
- `git status` is clean; no source or test files changed.

#### Pass criteria

- Session status `completed`; exactly one `ask_questions` + `assess` round.
- Both artifact files written with the contents above; `qa` has one entry
  per question asked.
- The non-recommended pick appears in the `qa` entry for that question.
- `git diff --exit-code` is clean.

#### Failure indicators

- Session ends `failed` (see Troubleshooting for model/preflight errors).
- Artifact missing or `requirements.json` rejected — re-run and check for a
  validation error toast.
- Files in the fixture changed.

---

### Scenario 2: Multi-round interview

A vague goal forces `more_information_needed`, and round 2 questions build on
prior answers.

#### Steps

```
/requirements

Goal: Make the ledger better
```

Answer the round 1 questions minimally or vaguely (e.g. choose options that
leave scope open). When the round-2 questions appear, answer them concretely.

#### Expected behavior

- Round 1 assessment returns `more_information_needed`; the interview does
  not finalize.
- Round 2 questions reference information from round 1 (follow-up questions,
  not duplicates).
- The interview record in both artifacts contains every question and answer
  from both rounds, in order.
- Finalization happens after the round whose assessment returns `clear`.

#### Pass criteria

- At least two `ask_questions` rounds ran (visible in the dashboard session
  transcript/step list).
- The final `requirements.json` `qa` has entries from both rounds; the
  artifact `goal` is the original goal.

#### Failure indicators

- The interviewer finalizes after round 1 despite the vague goal (assessment
  `clear` too early).
- Round 2 questions repeat round 1 questions verbatim instead of following up.

---

### Scenario 3: Multi-select and custom answers

Exercise a `multiple` question and the **✏️ Type my own answer** path.

#### Steps

Run an interview (any goal). Watch for a question the interviewer marks as
select-many (`multiple` kind — the prompt text says to pick all that apply):

- Pick two options, verify the dialog label updates ("… (2 selected)") and
  that picked options are prefixed with `✓` on re-presentation, then choose
  **Done**.
- Choose an already-picked option again — it is **un-picked** (the `✓`
  disappears and the selection count drops).
- On a different question, choose **✏️ Type my own answer** and type a short
  custom answer.

#### Expected behavior

- A multi-select question loops until **Done**: each pick is recorded in the
  dialog's "Selected so far" line and the "Done" action only appears for
  multi-select questions (and only after at least one pick; the dashboard
  disables **Done** until a pick is made). Re-picking a `✓`-marked option
  un-picks it; un-picking everything hides **Done** again.
- A single-choice question answers on the first pick; re-answering it from
  the hub replaces the previous pick.
- The custom-answer path opens an input prompt ("Your own answer for: …").
  On a single-choice question a custom answer replaces any picked option;
  on a multi-select question it is recorded alongside the current picks.
- The final `requirements.json` `qa` entry for the multi-select question has
  both picked option IDs in `selectedOptionIds`; the custom question has an
  empty `selectedOptionIds` and the typed text in `customText`.
- `requirements.md` shows `- Answer: <option A>, <option B>` for the
  multi-select question and `- Answer: custom answer` plus
  `- Custom: <typed text>` for the custom question.

#### Pass criteria

- Both answer shapes recorded exactly as above in the JSON and markdown
  artifacts.
- The custom text is trimmed of surrounding whitespace.

#### Failure indicators

- The multi-select question answers on the first pick without a **Done**
  action.
- The custom text is missing from `customText` / the markdown `Custom` line.

---

### Scenario 4: Decision race — dashboard answers while TUI is open

Both channels may answer the same pending question; the first to respond
wins and the other channel is closed.

#### Steps

Start an interview with the dashboard open. When the first question is
pending:

1. Answer **one question from the dashboard** (pending-decision panel —
   choose an option, or choose the custom action and submit feedback) while
   the TUI select dialog is still open. The TUI dialog should disappear.
2. On the next question, answer **from the TUI** while the dashboard still
   shows the same question. The dashboard's pending decision should
   disappear.

#### Expected behavior

- A dashboard submission wins the race: the TUI prompt is cancelled, the
  question is recorded once, and the interview continues.
- A TUI answer wins the race: the dashboard decision is removed, and the
  question is recorded once (no duplicate `qa` entry).
- While a question is pending, the dashboard shows the session with a
  pending-decision panel and the option list, including the same
  recommended markers as the TUI.

#### Pass criteria

- Both race directions tested; the `qa` record contains exactly one entry
  per question (no duplicates, no losses).
- The interview completes with status `completed` and valid artifacts.

#### Failure indicators

- Answering from both channels records two `qa` entries for one question.
- The TUI dialog does not close when the dashboard answers first.
- The dashboard still shows a pending decision after the TUI answered.

---

### Scenario 5: Handoff into a workflow

Complete an interview, then start a read-only workflow with the resulting
requirements document.

#### Steps

Run an interview as in Scenario 1. On the completion dialog choose
**Start a workflow with these requirements**, then select the
`planning_only` route from the route chooser.

#### Expected behavior

- A workflow starts in the background; the dashboard shows it as an active
  run with the route's phase sequence
  (`preflight → exploring → planning → reviewing_plan → human_review_plan`).
- The workflow request contains the handoff document: `Goal: <goal>` plus
  the scope, constraints, and acceptance criteria from the interview.
- `planning_only` runs no checks and no mutation agents; the fixture stays
  clean.
- During the plan-approval gate the workflow pauses for human review as
  usual.

#### Pass criteria

- The workflow reaches `human_review_plan` and pauses (approve or cancel the
  gate as you prefer).
- The plan reflects the interviewed scope/constraints.
- `git diff --exit-code` is clean.
- After the workflow ends, run `/requirements` again in the same session —
  it starts a fresh session with a new session id; the two artifacts are
  independent.

#### Failure indicators

- The handoff dialog does not appear after finalization.
- The workflow starts without the requirements request (empty/fallback
  request).
- The workflow runs checks or mutation agents on a read-only route.

---

### Scenario 6: Cancellation paths

Every cancel path must end the session as `cancelled` with **no** artifact
directory.

#### Steps

1. Start an interview; on the question hub choose **Cancel interview**.
2. Start another interview; dismiss the question hub with Escape.
3. Start a third interview; answer a question, and from the hub open an
   answer dialog and dismiss it with Escape — you return to the hub with
   the question still unanswered; then complete the interview normally.
4. (Optional) Start a fourth interview and answer the first question, then
   run `/orchestrator-cancel` while the interviewer is working.

#### Expected behavior

- **Cancel interview** (from the hub or an answer dialog) ends the session
  with a "cancelled by the user" warning toast; the dashboard shows status
  `cancelled`.
- Escape on the **hub** ends the session with a cancelled/dismissed warning
  toast.
- Escape on an **answer dialog** does not cancel: it returns to the hub with
  that question still `○`-marked, and the round can be completed normally.
- `/orchestrator-cancel` during an interview replies "No active workflow to
  cancel" — the interview session is not engine-owned.
- None of the cancelled sessions created
  `.pi/orchestrator/requirements/<session-id>/`.

#### Pass criteria

- All three attempts end with status `cancelled` (never `failed`).
- No `requirements.json` or session directory exists for any cancelled
  session.

#### Failure indicators

- A cancel path ends the session as `failed` or writes a partial artifact.
- `/orchestrator-cancel` interferes with the interview session.

---

### Scenario 7: Robustness edge cases

Behavior when configuration is missing, the dashboard is off, and when the
interviewer uses the read-only explorer sub-agent.

#### 7a. Missing models (preflight)

Use a fixture **before** running `/orchestrator-settings` (or remove the
`interviewer`/`explorer` agent entries from the config), then run
`/requirements`.

- Expected: an error toast naming the missing model configuration; no
  session starts.
- Then configure models via `/orchestrator-settings` (the agent list must
  include **interviewer**) and retry — the interview succeeds.

#### 7b. Dashboard disabled

Set `"dashboard": { "enabled": false }` in the fixture config, then run an
interview.

- Expected: no browser tab opens; the interview works entirely through the
  TUI; all artifacts are written normally.

#### 7c. Explorer sub-agent grounding

Run an interview whose goal requires inspecting the repository, for
example:

```
/requirements

Goal: Add a feature consistent with the existing code style in
src/ledger.js and update the README contract for it.
```

- Expected: when the interviewer deems it useful it may call its read-only
  explorer sub-agent; the interview questions should reflect repository
  facts (file names, existing function contracts).
- The fixture's repository files are never modified by the interview.

#### 7d. Non-interactive failure (optional)

Run the extension in a non-TUI mode (e.g. `pi` with print/json mode) and
invoke `/requirements` with no dashboard listening.

- Expected: an error toast containing "requires a TUI dialog or the
  interview dashboard"; no session runs, no artifacts written.

#### Pass criteria

- 7a: preflight fails closed before any agent call; succeeds after models
  are set.
- 7b: TUI-only interview completes and writes both artifacts.
- 7c: questions are grounded in real repository facts; `git status` clean.
- 7d: fail-closed error, no artifacts.

#### Failure indicators

- The interview starts despite missing interviewer/explorer models.
- The dashboard opens despite `dashboard.enabled: false`.
- The interviewer mutates the repository or the explorer sub-agent leaves
  files behind.

---

### Scenario 8: Arrow-key navigation

The arrow keys do something useful both in the hub and inside an answer
dialog.

#### Steps

Start an interview. While the question hub is open:

1. Press **Right** — the selection moves down one row; press **Left** — it
   moves back up. (This mirrors pressing Down/Up; the select-list only
   binds Up/Down natively.)
2. Open a question's answer dialog. With the dialog open, press **Right** —
   the dialog closes and the hub reopens. Press Enter on the same row: the
   *next* question's dialog opens (the current question is left unanswered
   `○`-marked). Press **Left** inside a dialog to jump to the *previous*
   question instead.
3. Open the first question's dialog and press **Left** (nothing before it):
   the dialog closes, the hub reopens, and the question stays unanswered.
   Do the same with **Right** on the last question.

#### Expected behavior

- In the hub, Right/Left behave exactly like Down/Up (including list
  wrapping if the TUI select-list wraps).
- A Right/Left press inside an answer dialog never submits an answer: it
  soft-closes the dialog, returns to the hub, and the switch target is
  followed on the next Enter. The original question remains `○`-marked
  until actually answered.
- No partial answer is recorded from a switched-away dialog; the final
  `qa` entries reflect only completed answers.

#### Pass criteria

- Both directions tested from a middle question; both boundary no-ops
  tested (Left on first, Right on last).
- The interview completes with status `completed` and valid artifacts.

#### Failure indicators

- Right/Left in the hub do nothing (or move the wrong direction).
- Right/Left inside an answer dialog pick an option or otherwise submit.
- Switching leaves a stale partial answer in the `qa` record.

---

## Results matrix

Record each scenario's actual outcome in a copy of this table.

| Scenario | Session status | Rounds | Artifact written | `qa` entries | Dashboard | Handoff | Git clean |
|---|---|---|---|---|---|---|---|
| 1 Happy path | | | ✓ | = questions asked | | Done | ✓ |
| 2 Multi-round | | ≥2 | ✓ | = questions across rounds | | Done | ✓ |
| 3 Multi-select + custom | | | ✓ | incl. list + customText | | Done | ✓ |
| 4 Decision race | | | ✓ | no duplicates | both channels | Done | ✓ |
| 5 Handoff | | | ✓ | | | workflow started | ✓ |
| 6 Cancellation | cancelled | | none (no dir) | — | | — | ✓ |
| 7 Robustness | per case | | per case | | per case | per case | ✓ |
| 8 Arrow keys | | | ✓ | | | Done | ✓ |

Fill in `status` (completed / failed / cancelled), the number of interview
rounds, whether `requirements.json` + `requirements.md` were written, the
`qa` entry count, which dashboard behavior was observed, the handoff
outcome, and whether any unexpected files appeared.

---

## Troubleshooting

### The interview fails before asking anything (preflight)

The session preflights `interviewer` and `explorer` models before the first
agent call. If the error toast names a model, run `/orchestrator-settings`
→ **Agent settings** and assign both agents a reachable model. Check that
`interviewer` appears in the agent list (it is part of the defaults; a
legacy config gets the default merged in).

### "requires a TUI dialog or the interview dashboard"

The command fails closed when Pi has no interactive UI and the dashboard is
not listening (print/json mode, or `dashboard.enabled: false` in a
non-TUI session). Run Pi interactively or start the dashboard.

### No browser tab opens

Verify `dashboard.enabled` is `true` in the config. The interview itself
works fine without the dashboard; only the race and the session view are
unavailable.

### The session ends `failed` after an agent call

Check the error toast. Common causes:

- The interviewer returned invalid output twice (schema or action
  mismatch) — a retry with a correction path runs once, then the session
  fails.
- The interviewer ran out of timeout budget; raise `agentTimeoutMs` in
  settings.
- A question answer failed validation (e.g. a custom answer over the byte
  limit).

### Artifacts from earlier runs

Session artifacts live under `.pi/orchestrator/requirements/` in the
fixture root, keyed by session id. A fresh fixture copy has none; if you
reuse a fixture, previous sessions remain readable — new runs write only to
their own session directory.
