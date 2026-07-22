# Decouple `implementationChecks` + Builder Worktree Isolation

## #5: Decouple `implementationChecks` variable

### Current state (fragile)

In `src/orchestrator.ts`, a single `let implementationChecks: CheckResult[] | undefined` is declared at line ~175 (before the implementation loop) and mutated in three places:

1. **Implementation loop** (line ~217): `implementationChecks = await this.runCheckStep(...)` — stores check results after each builder attempt
2. **Review-fix loop** (line ~245): `implementationChecks = await this.runCheckStep(...requireGreen: true...)` — **overwrites** with review-fix check results
3. **Code reviewer payload** (line ~237): `{ reviewType: "code", request, plan, implementationChecks }` — passed as input
4. **Documenter payload** (line ~253): `{ request, plan, baseline, codeReview }` — not directly, but `implementationChecks` is used for `allGreen` checks

### Problem

After the implementation loop breaks (all green), `implementationChecks` holds the passing check results. Then the review-fix loop **overwrites** the same variable with review-fix results. If the review-fix loop runs checks again, the original "implementation passed" results are lost. A reader cannot tell at a glance which phase's data is in the variable.

### Fix

Replace the single variable with three separate variables, each scoped to its phase:

```typescript
// BEFORE (around line 175-260 in orchestrator.ts)
let implementationChecks: CheckResult[] | undefined;
let diagnosis: unknown;

// Implementation loop — uses implementationChecks
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  ...
  implementationChecks = await this.runCheckStep(...);
  if (allGreen(implementationChecks, config.checks.length)) break;
  ...
}
if (!implementationChecks || !allGreen(...)) throw ...;

// Code review — passes implementationChecks
codeReview = await this.runAgentStep("reviewer", "reviewing_code", ...,
  { reviewType: "code", request, plan, implementationChecks }, ...);

// Review-fix loop — overwrites implementationChecks
for (let fixes = 0; fixes <= config.limits.reviewRevisions; fixes++) {
  ...
  implementationChecks = await this.runCheckStep(...requireGreen: true...);
}

// Documenter — doesn't use implementationChecks directly, uses codeReview
const documentation = await this.runAgentStep("documenter", ...,
  { request, plan, baseline, codeReview }, ...);
```

```typescript
// AFTER
let diagnosis: unknown;

// Implementation loop — owns implAttemptChecks
const maxAttempts = Math.max(1, config.limits.implementationRetries + 1);
let implAttemptChecks: CheckResult[] | undefined;
for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  ...
  implAttemptChecks = await this.runCheckStep(...);
  if (allGreen(implAttemptChecks, config.checks.length)) break;
  ...
}
if (!implAttemptChecks || !allGreen(implAttemptChecks, config.checks.length)) throw ...;

// Freeze for downstream consumers
const finalImplChecks: CheckResult[] = implAttemptChecks;

// Code review — uses finalImplChecks
codeReview = await this.runAgentStep("reviewer", "reviewing_code", ...,
  { reviewType: "code", request, plan, implementationChecks: finalImplChecks }, ...);

// Review-fix loop — owns reviewFixChecks (doesn't touch finalImplChecks)
for (let fixes = 0; fixes <= config.limits.reviewRevisions; fixes++) {
  ...
  const reviewFixChecks = await this.runCheckStep(...requireGreen: true...);
  // reviewFixChecks is only used locally — no downstream consumer
}

// Documenter — unchanged, uses codeReview
const documentation = await this.runAgentStep("documenter", ...,
  { request, plan, baseline, codeReview }, ...);
```

### Specific edits in orchestrator.ts

| Line(s) | Current text | New text |
|---------|-------------|----------|
| ~175 | `let implementationChecks: CheckResult[] \| undefined;` | Remove this line |
| ~175 | `let diagnosis: unknown;` | Keep, move up if needed |
| ~210 | `implementationChecks = await this.runCheckStep(...)` | `const implAttemptChecks = await this.runCheckStep(...)` |
| ~210-220 | `if (allGreen(implementationChecks, ...)) break;` → `if (allGreen(implAttemptChecks, ...)) break;` | Same pattern for all uses in the loop |
| ~230 | `if (!implementationChecks \|\| !allGreen(implementationChecks, ...)) throw...` | `if (!implAttemptChecks \|\| !allGreen(implAttemptChecks, ...)) throw...` |
| New | (after implementation loop) | `const finalImplChecks: CheckResult[] = implAttemptChecks;` |
| ~237 | `{ reviewType: "code", request, plan, implementationChecks }` | `{ reviewType: "code", request, plan, implementationChecks: finalImplChecks }` |
| ~245 | `implementationChecks = await this.runCheckStep(...requireGreen: true...)` | `const reviewFixChecks = await this.runCheckStep(...requireGreen: true...)` |

### Verification

- `npx vitest run` — all existing tests pass (variable renames don't affect behavior)
- Manual code review: confirm `finalImplChecks` is never reassigned after the implementation loop

---

## #3: Builder worktree isolation

### Goal

When `worktreeIsolation: true` is set in config, the builder and its checks run inside a `git worktree` copy of the repository. This prevents builder mistakes from corrupting the main working tree and produces a clean diff of changes.

### Config

Add to `OrchestratorConfig.limits`:

```typescript
export interface OrchestratorConfig {
  // ...existing fields...
  limits: {
    // ...existing limits...
    worktreeIsolation: boolean;  // <-- new
  };
}
```

Default: `false`.

### New file: `src/worktree.ts`

Three exported async functions:

#### 1. `createWorktree(cwd: string, runId: string): Promise<string>`

- Validates that `cwd` is inside a git repository (checks `.git` directory exists)
- Creates worktree path: `.pi/orchestrator/worktrees/<runId>/`
- Ensures the parent dir exists: `mkdir -p .pi/orchestrator/worktrees/`
- Runs: `git worktree add --detach <worktreePath>` (detached HEAD, no branch)
- Returns the absolute worktree path
- Errors: throws if `cwd` is not a git repo, if `git worktree add` fails, or if the worktree already exists

```typescript
import { mkdir, realpath } from "node:fs/promises";
import { execSync } from "node:child_process";
import path from "node:path";

export async function createWorktree(cwd: string, runId: string): Promise<string> {
  const gitDir = path.join(cwd, ".git");
  await access(gitDir); // throws if not a git repo
  const worktreesDir = path.join(cwd, ".pi", "orchestrator", "worktrees");
  await mkdir(worktreesDir, { recursive: true });
  const worktreePath = path.join(worktreesDir, runId);
  execSync(`git worktree add --detach "${worktreePath}"`, { cwd, stdio: "pipe" });
  return realpath(worktreePath);
}
```

#### 2. `removeWorktree(worktreePath: string): Promise<void>`

- Runs: `git worktree remove <worktreePath>`
- Cleans up: `rm -rf <worktreePath>` as fallback if `git worktree remove` fails

#### 3. `syncWorktreeChanges(worktreePath: string, targetCwd: string): Promise<{ changedFiles: string[] }>`

- Runs in the worktree: `git diff --name-only HEAD` to list changed files
- For each changed file, copies it from worktree to target using `git diff ... | git apply`
- Returns `{ changedFiles: string[] }` — list of relative paths changed

### Changes to orchestrator.ts

#### Workflow lifecycle

In `runWorkflow()`, wrap the implementation phase:

```typescript
// Before implementation loop (~line 175)
let worktreePath: string | undefined;
try {
  if (config.limits.worktreeIsolation) {
    worktreePath = await createWorktree(cwd, runId);
    await store.saveJson("worktree-info.json", { path: worktreePath });
    ctx.ui.notify(`Builder working in isolated worktree: ${worktreePath}`, "info");
  }

  // Implementation loop — redirect cwd to worktree for builder/checks
  const builderCwd = worktreePath ?? cwd;
  // ...existing implementation loop, passing builderCwd instead of cwd...

  // After successful implementation, sync changes back
  if (worktreePath) {
    const sync = await syncWorktreeChanges(worktreePath, cwd);
    if (sync.changedFiles.length > 0) {
      // Log synced files to state
      this.state.message = `Synced ${sync.changedFiles.length} changed file(s) from worktree`;
    }
  }
} finally {
  if (worktreePath) {
    await removeWorktree(worktreePath).catch(err => {
      ctx.ui.notify(`Failed to remove worktree: ${messageOf(err)}`, "warning");
    });
  }
}
```

#### Agent cwd redirection

The `builderCwd` needs to be passed to agent session creation. Currently `cwd` flows through:

1. `runAgentStep` → `this.agents.run({ ..., cwd, ... })` → passed to `PiSdkAgentExecutor.run()`
2. In `agent-runner.ts`, `cwd` is used in `createSdkSession` → `new DefaultResourceLoader({ cwd, ... })`

For worktree isolation, I need to pass the worktree path as `cwd` for builder/check agent steps. The simplest approach: add an optional `overrideCwd` parameter to `runAgentStep` and `runCheckStep`.

```typescript
private async runAgentStep<T>(
  agent: AgentName,
  stage: Stage,
  label: string,
  payload: unknown,
  cwd: string,           // <-- becomes the effective cwd for this step
  ctx: ExtensionCommandContext,
  validate: (text: string) => T,
  qualifier: { attempt?: number; revision?: number } = {}
): Promise<T> {
  // ... uses cwd for agent execution ...
}
```

For checks, `runCheckStep` already accepts `cwd` per-call, so passing `builderCwd` is straightforward.

### Edge cases

| Scenario | Behavior |
|----------|----------|
| Not a git repo | `createWorktree` throws → workflow fails with clear error message |
| `worktreeIsolation: false` | No worktree is created; existing behavior unchanged |
| Builder produces no changes | `syncWorktreeChanges` returns empty list; workflow continues normally |
| `git worktree add` fails (e.g., dirty index) | Error propagates → workflow fails |
| Worktree removal fails in `finally` | Warning logged, workflow continues (OS cleanup later) |
| Multiple concurrent runs | Each run uses its own `runId`, so worktree paths are unique |
| Test environment (no real git) | `createWorktree` checks `.git` exists; tests mock the function |

### Files to modify

| File | Change |
|------|--------|
| `src/types.ts` | Add `worktreeIsolation: boolean` to `OrchestratorConfig.limits` |
| `src/config.ts` | Add `worktreeIsolation: false` to `DEFAULT_CONFIG.limits` |
| `src/validation.ts` | Add `worktreeIsolation` validation in `validateOrchestratorConfig` |
| `src/worktree.ts` (new) | `createWorktree`, `removeWorktree`, `syncWorktreeChanges` |
| `src/worktree.test.ts` (new) | Unit tests for worktree utilities |
| `src/orchestrator.ts` | Worktree lifecycle wrap around implementation phase; pass `builderCwd` to `runAgentStep` and `runCheckStep` |
| `src/orchestrator.test.ts` | Test: worktree isolation enabled → verify worktree created and removed |

### Verification

1. `npx vitest run` — all tests pass
2. Manual: Set `worktreeIsolation: true` → run workflow → verify `.pi/orchestrator/worktrees/<runId>/` exists during implementation and is removed after
3. Manual: Builder succeeds → verify changes appear in main working tree
4. Manual: Builder fails → verify main working tree has no builder changes
5. Unit: `createWorktree` throws on non-git directory
6. Unit: `removeWorktree` cleans up even on partial failure
