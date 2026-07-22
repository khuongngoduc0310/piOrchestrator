# Human-in-the-Loop: Plan Review, Approval, and Mutation Gating

## Context

The user wants to be involved in the orchestrator workflow as a human reviewer:
1. **Review the plan** — see the implementation plan and approve/reject it
2. **Review plan changes** — when the planner revises, review the updated plan
3. **Be asked before meaningful changes** — confirm before the tester creates tests and the builder modifies code
4. **Get suggestions** — the system should recommend what the user should be involved in

Currently the plan review is fully automated: the AI `reviewer` agent reviews and approves/rejects plans using `parseReviewOutput`. The user has no chance to interject. The builder and tester run autonomously once the workflow starts.

## Approach

Add a `humanInTheLoop` configuration section to `OrchestratorConfig` with per-touchpoint toggles. When enabled, the orchestrator pauses at the relevant stage, presents the plan/decision to the user via `ctx.ui` primitives, and waits for their input before proceeding.

The existing AI reviewer is **not removed** — it still validates structured output. But the **decision to proceed** (approve/reject) is handed to the user for the touchpoints they enable.

### Touchpoints offered

| Touchpoint | Config key | What happens | Recommended? |
|---|---|---|---|
| **Plan approval** | `planApproval` | After planner creates plan, show full plan to user → approve, request changes (with text feedback), or cancel | ★ Highly recommended |
| **Plan revision approval** | `planRevisionApproval` | After planner revises, show changes/revised plan → approve, request changes, or cancel | ★ Highly recommended |
| **Before test creation** | `confirmBeforeTests` | Before tester runs, ask user to confirm | ☆ Useful for large projects |
| **Before implementation** | `confirmBeforeImplementation` | Before builder runs, ask user to confirm | ☆ Useful for large projects |
| **Before code mutation** (combined) | `confirmBeforeMutation` | Single toggle for both tester + builder confirmation | ★ Recommended |

### How suggestions work

When a user first configures human-in-the-loop (or enables it), the orchestrator inspects the workflow and suggests which touchpoints to enable based on project characteristics. The suggestion is shown as a `ctx.ui.select` prompt:

> "You can be involved in these workflow stages. Which would you like to review?"
>
> ☑ Plan approval (Recommended — ensures the plan matches your intent)
> ☑ Plan revision approval (Recommended — stay aligned as the plan evolves)
> ☐ Confirm before implementation (Optional — asked before code is written)
> ☐ Confirm before test creation (Optional — asked before tests are created)

Default recommendations are pre-selected.

## Files to modify

1. **`src/types.ts`** — Add `HumanTouchpoints` interface and add it to `OrchestratorConfig`
2. **`src/config.ts`** — Add default `humanInTheLoop` config, merge defaults
3. **`src/orchestrator.ts`** — Insert human review checkpoints into the workflow
4. **`src/orchestrator.test.ts`** — Add/update tests for human-in-the-loop behavior

## Reuse

- `ctx.ui.select()` / `ctx.ui.confirm()` / `ctx.ui.editor()` / `ctx.ui.input()` — already used in `check-setup.ts` for user interaction; follows the same pattern
- `parseReviewOutput` — still used by the AI reviewer for structural validation; the human decision replaces the AI's `decision` field
- `parsePlannerOutput` — still validates the planner's output; unchanged
- `allGreen()` / `runCheckStep()` — unchanged

## Detailed design

### 1. `types.ts` — New types

```typescript
export interface HumanTouchpoints {
  planApproval: boolean;
  planRevisionApproval: boolean;
  confirmBeforeMutation: boolean;
}
```

Add to `OrchestratorConfig`:
```typescript
export interface OrchestratorConfig {
  // ...existing fields...
  humanInTheLoop: HumanTouchpoints;
}
```

### 2. `config.ts` — Default values

```typescript
humanInTheLoop: {
  planApproval: false,
  planRevisionApproval: false,
  confirmBeforeMutation: false
}
```

### 3. `orchestrator.ts` — Workflow changes

#### Helper method: `promptHumanPlanReview`

Add a private method that:
1. Formats the plan JSON as a readable summary
2. Shows it via `ctx.ui` (using `editor` for viewing, or `select` for the decision)
3. Returns `{ approved: true }`, `{ approved: false, feedback: string }`, or `undefined` (cancelled)

#### Touchpoint 1: Plan approval (replaces AI reviewer decision)

In the plan review loop, when `humanInTheLoop.planApproval` is true:

```typescript
// After planner creates plan
if (config.humanInTheLoop.planApproval) {
  const humanDecision = await this.promptHumanPlanReview(plan, ctx);
  if (!humanDecision) throw new Error("Workflow cancelled by user");
  if (humanDecision.approved) {
    planApproved = true;
    break;
  }
  // humanDecision.feedback goes back to planner for revision
  plan = await this.runAgentStep("planner", "planning", "Revise implementation plan",
    { request, exploration, previousPlan: plan, humanFeedback: humanDecision.feedback },
    ...);
}
```

If `planRevisionApproval` is also enabled, the revised plan also goes through human review.

If `planApproval` is disabled, the existing AI reviewer handles the decision (unchanged).

#### Touchpoint 2: Before mutation confirmation

When `confirmBeforeMutation` is true, prompt the user before tester and builder steps:

```typescript
if (config.humanInTheLoop.confirmBeforeMutation) {
  const proceed = await ctx.ui.confirm(
    "Create test files?",
    "The tester will create test files and may modify the working tree. Continue?"
  );
  if (!proceed) throw new Error("Workflow cancelled by user");
}
```

#### Touchpoint 3: Plan revision approval

Same as plan approval, but also shows what changed from the previous plan (diff of task IDs, added/removed tasks).

### 4. `orchestrator.test.ts` — Tests

- **Human approves plan**: Mock `ctx.ui.select` to return "Approve" → verify workflow continues to baseline
- **Human rejects plan with feedback**: Mock select to return "Request changes", mock `ctx.ui.input` to return feedback → verify planner is called with `humanFeedback`
- **Human cancels**: Mock select to return "Cancel" → verify workflow fails with "cancelled by user"
- **Human confirms mutation**: Mock `ctx.ui.confirm` to return `true` → verify builder runs
- **Human denies mutation**: Mock `ctx.ui.confirm` to return `false` → verify workflow fails

Add a new helper that sets `humanInTheLoop` flags on the config.

## Steps

- [ ] **types.ts**: Add `HumanTouchpoints` interface; add to `OrchestratorConfig`
- [ ] **config.ts**: Add default `humanInTheLoop` values; merge defaults
- [ ] **orchestrator.ts**: Add `promptHumanPlanReview()` method
- [ ] **orchestrator.ts**: Modify plan review loop — insert human review before/with AI reviewer
- [ ] **orchestrator.ts**: Modify plan revision loop — insert human review for revisions
- [ ] **orchestrator.ts**: Add mutation confirmation before tester and builder steps
- [ ] **orchestrator.ts**: Add human-in-the-loop suggestion on first enable
- [ ] **orchestrator.test.ts**: Test human approves plan
- [ ] **orchestrator.test.ts**: Test human requests changes to plan
- [ ] **orchestrator.test.ts**: Test human cancels during plan review
- [ ] **orchestrator.test.ts**: Test human confirms/denies mutation
- [ ] **orchestrator.test.ts**: Test touchpoints disabled (existing behavior unchanged)
- [ ] **Run all tests**: Verify `npx vitest run` passes

## Verification

1. `npx vitest run` — all tests pass
2. Manual: Start a workflow with `humanInTheLoop.planApproval: true` → verify plan is shown and user can approve/reject
3. Manual: Enable `confirmBeforeMutation` → verify prompt appears before tester and builder
4. Manual: Disable all touchpoints → verify existing fully-automated behavior is unchanged
