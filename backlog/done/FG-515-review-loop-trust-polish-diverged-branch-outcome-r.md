---
id: FG-515
type: story
status: done
title: "review-loop trust polish: diverged-branch outcome + run-note persistence on no-dispatch exits (FG-514 follow-ups F1/F2)"
created: 2026-07-10
closed: 2026-07-10
closed_commit: f135f95
---

Originally filed as a fail-safe follow-up from FG-514's test-engineer pass (findings F1/F2). SUPERSEDED BY EVENTS the same day: the FG-514 review-loop (run run-review-loop-fg-514-3a23bf) round-1 reviewer graded both items as in-scope for FG-514 — they guard the durable trust facts that ticket ships — and the round-1 fixer implemented both, with tests, in commit 391bb80 on PR #93:

1. Diverged branches (local commits the remote lacks AND remote commits the reviewer never saw) now resolve to a distinct diverged outcome that names both commit lists, advises pull/rebase (not push), and is never trusted.
2. The run-note writer creates runDir itself, so the note persists on every loop exit path including no-dispatch early returns (e.g. verification_failed before reviewer dispatch).

Acceptance (both shipped in PR #93, commit 391bb80; close on merge evidence):
- [x] diverged branches get a distinct outcome naming BOTH the local-only and remote-only commits, with pull/rebase (not push) as the next action; still never trusted
- [x] the run note persists on every loop exit path (writer creates runDir if missing), with tests
