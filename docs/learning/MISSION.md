# Mission: Own the piOrchestrator codebase

## Why

The agent built most of piOrchestrator with me. I want to genuinely understand its design so I can explain it to others and drive future changes with confidence, instead of relying on the agent's summaries.

## Success looks like

- Explain how the whole system fits together in a 10-minute walkthrough, without notes.
- Trace any feature request or bug report to the exact files and state transitions that implement it.
- Review and steer design changes (new routes, safety changes, UI changes) on first principles instead of asking the agent to decide.
- Modify core orchestration code and predict the blast radius before running tests.

## Constraints

- Browser HTML lessons with quizzes; each short and completable in one sitting.
- Every lesson recommends a primary source to read (the repo's own docs and code are the highest-trust resources).
- Course order: high-level map → phases & route templates → safety model → the two UIs → persistence & resume → requirements interview.
- Teaching workspace lives at `docs/learning/` inside the repo; all artifacts are untracked teaching files.

## Out of scope

- Pi SDK/core internals beyond what the extension touches.
- React implementation details of the dashboard (until the UIs lesson).
- Agent model tuning and the internals of `prompts/*.md` (until asked).
