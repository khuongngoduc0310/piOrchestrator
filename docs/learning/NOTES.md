# Notes

## Teaching preferences

- Teaching workspace lives at `docs/learning/` (user's explicit choice over repo root).
- Lessons are browser HTML (Tufte-style, print-friendly), opened in the browser via `Start-Process`.
- Quizzes: immediate, automatic feedback; answer options equal in length (no formatting clues).
- Lessons must be short and completable in one sitting; each gives one tangible win.
- Every lesson recommends a primary source to read.
- User is the author and has deep hands-on familiarity with specific surfaces (requirements command, dashboard, Mission Control) but wants the whole-system mental model — lessons should connect their existing islands into one coherent map.

## Course roadmap (mission order)

1. High-level map (0001)
2. Phases & route templates
3. Safety model (permissions, workspace guard, fail-closed validation, worktree isolation)
4. The two UIs (Mission Control TUI overlay + React dashboard)
5. Persistence & resume (checkpoints, immutable artifacts, /orchestrator-resume)
6. Requirements interview (/requirements, question hub, dashboard race, handoff)

## Working notes

- Lesson/asset links inside HTML use repo-relative paths (e.g. `../../README.md`) so they are clickable from `docs/learning/`.
- Teaching artifacts are untracked in git; user may want to gitignore them later — ask before committing anything.
