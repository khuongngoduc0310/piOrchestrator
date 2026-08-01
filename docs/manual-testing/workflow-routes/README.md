# piOrchestrator — Manual Workflow Route Tests

**Disposable fixture:** `pocket-ledger-template/`

Eight scenarios covering every supported workflow route. Each scenario starts
from a clean fixture copy so no run affects another.

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
$fixture = "C:\Temp\pocket-ledger-test"
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
fixture=/tmp/pocket-ledger-test
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
cd /path/to/pocket-ledger-test
pi
```

### One-time settings

Run once per fixture:

```
/orchestrator-settings
```

Choose **Agent settings**, then assign every role a model that Pi can reach;
use the default thinking level if the model supports it.

Then run `/orchestrator-settings` again, choose **Workflow settings**, and
verify (or set) the following profile:

| Setting | Value |
|---|---|
| Profile | **Controlled** (or set individual toggles below) |
| Review plan before approval | ✓ |
| Approve plan revision | ✓ |
| Confirm before mutation | ✓ |
| Approve exceptional decisions | ✓ |
| Approve final delivery | ✓ |
| Bug diagnosis approval | always |

These toggles create explicit human gates at every decision point so the test
operator can verify each gate fires at the correct workflow stage.

Alternatively, set the following config directly:

```json
{
  "schemaVersion": 2,
  "checks": [],
  "dashboard": { "enabled": true, "port": 0 },
  "limits": {
    "planRevisions": 2,
    "implementationRetries": 3,
    "reviewRevisions": 2,
    "agentTimeoutMs": 1200000,
    "checkTimeoutMs": 600000,
    "maxOutputBytes": 262144,
    "worktreeIsolation": true
  },
  "agents": {
    "interviewer": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium", "tools": ["read", "grep", "find", "ls"], "promptFile": "interviewer.md" },
    "explorer": { "model": "anthropic/claude-sonnet-4-5", "tools": ["read", "grep", "find", "ls"], "promptFile": "explorer.md" },
    "planner": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high", "tools": ["read", "grep", "find", "ls"], "promptFile": "planner.md" },
    "reviewer": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high", "tools": ["read", "grep", "find", "ls"], "promptFile": "reviewer.md" },
    "tester": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high", "tools": ["read", "write", "edit", "grep", "find", "ls"], "promptFile": "tester.md" },
    "builder": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high", "tools": ["read", "write", "edit", "grep", "find", "ls"], "promptFile": "builder.md" },
    "debugger": { "model": "anthropic/claude-sonnet-4-5", "thinking": "high", "tools": ["read", "grep", "find", "ls"], "promptFile": "debugger.md" },
    "documenter": { "model": "anthropic/claude-sonnet-4-5", "thinking": "medium", "tools": ["read", "write", "edit", "grep", "find", "ls"], "promptFile": "documenter.md" }
  },
  "humanInTheLoop": {
    "planApproval": true,
    "planRevisionApproval": true,
    "confirmBeforeMutation": true,
    "importantDecisions": true,
    "finalDeliveryApproval": true,
    "diagnosisApproval": "always"
  }
}
```

### Reset between scenarios

After each scenario, verify the state, then delete the fixture and prepare a
fresh copy from the template. Re-run `/orchestrator-settings` on each fresh
copy.

---

## Scenarios

### Scenario 1: `implementation`

Full test-first implementation, code review, and documentation.

#### Request

```
/orchestrate

Select: implementation - Full test-first implementation and review
Request: Add and document a summarizeByCategory(transactions) function.
It must return an object whose keys are transaction categories and whose values
are net category totals, adding credits and subtracting debits.
Transactions without a category must use "uncategorized".
An empty transaction list must return an empty object.
Do not mutate the input array.
```

#### Human gates

| Gate | Recommended choice |
|---|---|
| Plan approval | **Approve** — scope must include `src/ledger.js`, `test/ledger.js`, `README.md` |
| Check setup (first run) | **Approve** — accept discovered `npm test` |
| Baseline | Automatic (should pass) |
| Mutation confirmation | **Confirm** |
| Code review on first pass | **Accept current implementation** or **Allow fix** |
| Final delivery | **Finish delivery** |
| Memory approval (if lessons proposed) | **Decline** or **Skip** — not needed for testing |

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → [Check setup → Baseline → human_confirm_mutation]
  → creating_tests → testing → implementing → testing
  → reviewing_code → documenting → screening_lessons → reviewing_lessons
  → final checks → completed
```

Agents invoked: Explorer, Planner, Reviewer (plan), Tester, Builder, Reviewer
(code), Documenter, Reviewer (lessons).

#### Expected changed files

- `src/ledger.js` — `summarizeByCategory` implementation added.
- `test/ledger.js` — tests added (before builder writes code).
- `README.md` — API entry added.

No other source or test file changes.

#### Pass criteria

- The route completes with `status: "completed"`.
- Final `npm test` passes.
- Tester runs **before** Builder.
- Tests cover credits, debits, uncategorized, empty input, and immutability.
- Input array is not mutated.
- `summarizeByCategory` does not modify the input.

#### Failure indicators

- Builder runs before Tester.
- Existing seeded defects are fixed (they are outside the request scope).
- Tests are weakened to avoid testing real failure.
- Files outside the approved plan change.

---

### Scenario 2: `review_only`

Read-only repository review with correctness findings.

#### Request

```
/orchestrate

Select: review_only - Read-only repository review
Request: Review src/ledger.js against the documented contracts in README.md.
Focus on balance calculation, input coercion, and exact transaction-ID lookup.
Report concrete defects in severity order with reproduction examples.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — scope must include `src/ledger.js`, `README.md`, `test/ledger.js` |
| Final delivery | **Finish delivery** |

No check setup, baseline, or mutation confirmation appears.

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → reviewing_repository → completed
```

Agents: Explorer, Planner, Reviewer (plan), Reviewer (repository).

No Tester, Builder, Documenter, or Debugger.

#### Expected findings (Reviewer may report these)

1. **Numeric-string coercion:** `calculateBalance` does not normalize string
   amounts. A credit `{ type: "credit", amount: "10.50" }` produces string
   concatenation rather than numeric addition, corrupting the balance.
2. **Loose equality in ID lookup:** `findTransactionById` uses `==` (loose
   equality), so numeric `7` can match string `"7"`.
3. Absent test coverage for both issues (bonus finding, not required).

#### Pass criteria

- Reviewer may return `changes_requested` with findings.
- The route still reaches `completed` with `findings_reported`.
- No check steps execute.
- `git diff --exit-code` is clean.
- Builder is never invoked.

#### Failure indicators

- The workflow attempts to repair the findings.
- `npm test` runs.
- Any file changes.

---

### Scenario 3: `documentation_only`

Documentation-only mutation.

#### Request

```
/orchestrate

Select: documentation_only - Documentation changes only
Request: Expand the calculateBalance documentation in README.md.
Include the transaction input shape, credit and debit behavior,
numeric-string handling, return value, non-mutation guarantee,
and one complete example.
Do not change source code or tests.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — scope must include `README.md` only |
| Check setup | **Approve** — accept `npm test` |
| Baseline | Automatic (must pass) |
| Mutation confirmation | **Confirm** |
| Final delivery | **Finish delivery** |

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → [Check setup → Baseline → human_confirm_mutation]
  → documenting → testing → final checks → completed
```

Agents: Explorer, Planner, Reviewer (plan), Documenter.

No Tester or Builder.

#### Expected changed files

- `README.md` only.

#### Pass criteria

- Only `README.md` changes.
- No permanent-memory lessons are proposed.
- Baseline and final checks are green.
- Documenter does not attempt to fix the documented numeric-string bug.
- `git diff -- src/ledger.js -- test/ledger.js` is empty.

#### Failure indicators

- `src/ledger.js` or `test/ledger.js` changes.
- Documenter proposes memory lessons.
- Tester or Builder runs.

---

### Scenario 4: `tests_only`

Test-only mutation for existing behavior.

#### Request

```
/orchestrate

Select: tests_only - Test and test-support changes only
Request: Add focused tests for the existing numeric transaction behavior
of calculateBalance: an empty ledger, credits only, debits only,
mixed credits and debits, decimal amounts, and input-array immutability.
Do not test numeric-string amounts and do not change production code.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — scope must include `test/ledger.js` only |
| Check setup | **Approve** — accept `npm test` |
| Baseline | Automatic (must pass) |
| Mutation confirmation | **Confirm** |
| Final delivery | **Finish delivery** |

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → [Check setup → Baseline → human_confirm_mutation]
  → creating_tests → testing → final checks → completed
```

Agents: Explorer, Planner, Reviewer (plan), Tester.

No Builder or Documenter.

#### Expected changed files

- `test/ledger.js` only.

#### Pass criteria

- Only `test/ledger.js` changes.
- All added tests verify existing supported behavior and pass.
- Baseline and final `npm test` are green.
- No production code changes.

#### Failure indicators

- Tests intentionally target the numeric-string defect and fail.
- Tester changes `src/ledger.js`.
- Builder or Documenter runs.
- Existing assertions are weakened or removed.

---

### Scenario 5: `investigation_only`

Read-only diagnosis with actionable evidence.

#### Request

```
/orchestrate

Select: investigation_only - Read-only diagnosis and evidence
Request: Investigate why a ledger containing a credit transaction
with amount "10.50" can return an incorrect balance.
Identify the exact execution path, root cause, affected files,
confidence, and a recommended correction.
Do not modify files.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — scope must include `src/ledger.js`, `README.md`, `test/ledger.js` |
| Final delivery | **Finish delivery** |

No check setup, baseline, or mutation confirmation.

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → debugging → completed
```

Agents: Explorer, Planner, Reviewer (plan), Debugger.

No Tester, Builder, or Documenter.

#### Expected diagnosis

- Category: `implementation_defect`.
- Root cause: amount values are not normalized before arithmetic; a numeric
  string reaches `balance += tx.amount` and produces string concatenation.
- Affected file: `src/ledger.js`.
- Confidence: at least `medium`.
- Existing numeric-only tests do not exercise the defect.
- Recommended fix normalizes amounts (`Number(amount)` or equivalent) before
  arithmetic and validates the result.

#### Pass criteria

- Diagnosis is evidence-based and actionable.
- No check steps execute.
- `git diff --exit-code` is clean.
- Builder and Tester are never invoked.

#### Failure indicators

- Debugger classifies the defect as `environment_error` or `tooling_error`.
- The route attempts to apply the recommended fix.
- Builder or Tester runs.
- Any file changes.

---

### Scenario 6: `bug_fix`

Diagnosis-first bug fix with regression tests.

#### Request

```
/orchestrate

Select: bug_fix - Diagnose and fix a confirmed bug
Request: Fix the confirmed bug where numeric-string transaction amounts
can corrupt calculateBalance. Numeric strings such as "10.50" and "2"
must be treated as their numeric values for both credits and debits.
Reject non-finite or non-numeric amounts with a clear TypeError.
Add regression tests and preserve all existing numeric behavior.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — scope must include `src/ledger.js`, `test/ledger.js`, optionally `README.md` |
| Check setup | **Approve** — accept `npm test` |
| Baseline | Automatic (must pass) |
| Diagnosis approval | **Proceed with fix** — this gate fires because the test profile requires "always" |
| Scope revision (if needed) | **Approve revised plan** — for any diagnosis-driven file additions |
| Mutation confirmation | **Confirm** |
| Code review on first pass | **Accept current implementation** or **Allow fix** |
| Final delivery | **Finish delivery** |
| Memory approval | **Decline** or **Skip** |

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → [Check setup → Baseline]
  → debugging → human_diagnosis_approval
  → [scope revision if new paths added → human_review_revision]
  → human_confirm_mutation
  → creating_tests → testing → implementing → testing
  → reviewing_code → documenting → screening_lessons → human_review_lessons
  → final checks → completed
```

Agents: Explorer, Planner, Reviewer (plan), Debugger, Tester, Builder,
Reviewer (code), Documenter, Reviewer (lessons).

#### Expected changed files

- `src/ledger.js` — fix numeric-string normalization; add validation.
- `test/ledger.js` — regression tests for numeric strings and invalid values.
- `README.md` — documentation may be updated as part of the finalize phase.

#### Pass criteria

- Regression tests (added by Tester) fail against the original code.
- After Builder fix, numeric strings work for credits and debits.
- Invalid values (`"abc"`, `NaN`, `Infinity`) throw `TypeError`.
- Existing numeric tests remain green.
- Baseline and final checks pass.
- Mutation starts only after diagnosis approval and mutation confirmation.

#### Failure indicators

- Builder fixes the bug without regression coverage.
- The unrelated loose-ID defect is also changed.
- Baseline failure is silently skipped.
- Mutation occurs before diagnosis approval.

---

### Scenario 7: `quick_implementation`

Implementation without test-first generation.

#### Request

```
/orchestrate

Select: quick_implementation - Implementation without test-first generation
Request: Add and document formatCurrency(cents, currency = "USD")
to src/ledger.js. It must use Intl.NumberFormat with locale en-US,
interpret the input as integer cents, reject non-integer values
with TypeError, and return the formatted currency string.
This quick scenario does not require new tests.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — scope must include `src/ledger.js`, `README.md` |
| Check setup | **Approve** — accept `npm test` |
| Baseline | Automatic (must pass) |
| Mutation confirmation | **Confirm** |
| Code review on first pass | **Accept current implementation** or **Allow fix** |
| Final delivery | **Finish delivery** |
| Memory approval | **Decline** or **Skip** |

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan
  → [Check setup → Baseline → human_confirm_mutation]
  → implementing → testing → reviewing_code → documenting
  → screening_lessons → reviewing_lessons → final checks → completed
```

Agents: Explorer, Planner, Reviewer (plan), Builder, Reviewer (code),
Documenter, Reviewer (lessons).

Notice the explicit absence of `creating_tests`.

#### Expected changed files

- `src/ledger.js` — `formatCurrency` implementation.
- `README.md` — API documentation added.

#### Pass criteria

- No Tester invocation occurs.
- Builder produces the function directly.
- Existing `npm test` remains green.
- Code review, documentation, and final checks still run.

#### Failure indicators

- Tester is invoked.
- The route skips baseline, code review, documentation, or final checks.
- Existing ledger behavior changes.
- Test files change despite being excluded from the plan.

---

### Scenario 8: `planning_only`

Read-only exploration and planning. No files change.

#### Request

```
/orchestrate

Select: planning_only - Read-only exploration and planning
Request: Produce an implementation plan for versioned JSON import
and export of ledger transactions. The design must validate imported data,
reject unsupported future versions, preserve transaction order,
avoid partial imports, include a backward-compatibility strategy,
and cover source, tests, and README documentation.
Do not implement it.
```

#### Human gates

| Gate | Choice |
|---|---|
| Plan approval | **Approve** — plan must use exact repository-relative paths (not globs) |
| Final delivery | **Finish delivery** |

No check setup, baseline, or mutation confirmation.

#### Expected phases and agents

```
preflight → exploring → planning → reviewing_plan → human_review_plan → completed
```

Agents: Explorer, Planner, Reviewer (plan).

No Tester, Builder, Debugger, or Documenter.

#### Expected plan characteristics

- File paths are exact and repository-relative (e.g., `src/ledger.js`,
  `src/ledger-json.js`, `test/ledger.js`, `test/ledger-json.js`, `README.md`),
  never directory globs like `src/**`.
- Acceptance criteria cover validation, version handling, ordering,
  atomicity, tests, and documentation.
- Task IDs are unique; dependencies are explicit and acyclic.
- The plan's `route` field is `"planning_only"`.

#### Pass criteria

- Plan is well-structured with exact file paths.
- The route completes with `status: "completed"`.
- `git diff --exit-code` is clean.
- No check setup or check execution occurs.
- No mutation-capable agent runs.

#### Failure indicators

- Plan uses directory scopes (`src/**`, `test/**`).
- Planner changes the route to `implementation`.
- `npm test` runs.
- Any mutation-capable agent runs.
- Any file changes.

---

## Results matrix

Record each scenario's actual outcome in a copy of this table.

| Route | status | Baseline checks | Final checks | Mutating agents | Expected files | Unexpected files | Git clean |
|---|---|---|---|---|---|---|---|
| `implementation` | | | | Tester, Builder, Documenter | `src/ledger.js`, `test/ledger.js`, `README.md` | | ✓ |
| `review_only` | | none | none | none | none | — | ✓ |
| `documentation_only` | | ✓ | ✓ | Documenter | `README.md` | | ✓ |
| `tests_only` | | ✓ | ✓ | Tester | `test/ledger.js` | | ✓ |
| `investigation_only` | | none | none | none | none | — | ✓ |
| `bug_fix` | | ✓ | ✓ | Tester, Builder, Documenter | `src/ledger.js`, `test/ledger.js`, `README.md` | | ✓ |
| `quick_implementation` | | ✓ | ✓ | Builder, Documenter | `src/ledger.js`, `README.md` | | ✓ |
| `planning_only` | | none | none | none | none | — | ✓ |

Fill in `status` (completed / failed / cancelled), whether baseline and final
checks ran (✓ / none), which mutating agents actually ran, and any unexpected
files that appeared.

---

## Troubleshooting

### Check discovery finds nothing

If the fixture's `package.json` is not detected, verify Pi is running from the
fixture root (the directory containing `package.json`) and that `npm test`
runs in that directory.

### Worktree isolation complains about no Git HEAD

The fixture setup creates an initial commit. If using an older version of
piOrchestrator, set `worktreeIsolation: false` in settings.

### Baseline is red

Run `npm test` manually. The fixture's baseline tests must pass before
check setup. If they do not pass, re-copy the template — the fixture was
never intended to be mutated permanently.

### Agent times out

The fixture does not require network calls beyond the Pi provider. If an
agent is slow, increase `agentTimeoutMs` in settings. For especially large
models, reduce the thinking level.

### Route fails with "checks required" on read-only route

If the config has non-empty `checks` from a previous mutation run, reset it:

```json
{
  "checks": []
}
```

Read-only routes need no checks. If checks exist, the orchestrator may try to
run baseline verification.

### Memory approval appears and affects the outcome

Lessons may be proposed after a mutation route. To keep scenarios
comparable, always decline or skip memory candidates unless testing memory
promotion specifically. Declining memory candidates does not fail the
workflow.

### A scenario unexpectedly cancels

Check the `state.json` `termination` field. Common causes:

- A required human gate was dismissed with Escape instead of being answered.
- A retry limit was reached.
- The agent output was malformed and the correction attempt also failed.
