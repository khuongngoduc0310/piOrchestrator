# piOrchestrator Resources

## Knowledge

- [Repo README](../README.md)
  The project's own contract: workflow, lifecycle, routes, role tools, SDK execution, reliability policy, run artifacts, dashboard, memory, limitations. Use for: anything claimed about behavior — it is the primary, highest-trust source.
- [AGENTS.md](../AGENTS.md)
  Repository guide written for agent collaboration: architecture invariants, safety contracts, where each concern lives, test conventions. Use for: locating a concern in the code and understanding cross-cutting rules (e.g. check setup deferral, route templates, fail-closed persistence).
- [Archived design docs](../archive/plans/README.md)
  Design history of the larger features: HITL gates, check approval, settings wizard, persistent UI redesign, decoupling checks from the worktree. Use for: understanding *why* a design is the way it is, and the evolution behind the current shape.
- [Pi SDK extension types](../../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts)
  The `ExtensionAPI` / `ExtensionCommandContext` / `ExtensionUIContext` / `TerminalInputHandler` contracts the extension implements against. Use for: exactly what Pi offers an extension (commands, UI dialogs, terminal input, lifecycle events).
- [Source anchors](../src/index.ts, ../src/orchestrator.ts, ../src/orchestration/orchestrator-workflow.ts, ../src/orchestration/orchestrator-routes.ts)
  The extension entrypoint, the thin public facade, the workflow phase machine, and the fixed route templates. Use for: tracing any feature from command to completion.
- [Manual test scenarios](../manual-testing/requirements/README.md)
  Behavioral specs written as runnable-by-hand scenarios (happy path, cancellation, decision race, arrow-key navigation). Use for: seeing intended behavior described outside the code, and as a checklist when behavior changes.

## Wisdom (Communities)

- None yet. The user is the sole author and has not opted into any community; revisit if they want external design review (Pi's GitHub discussions would be the natural venue).
