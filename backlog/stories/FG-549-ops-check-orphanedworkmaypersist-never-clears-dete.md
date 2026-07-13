---
id: FG-549
type: story
status: active
title: "ops check: orphaned_work_may_persist never clears — detectOrphanedWorkMayPersist ignores parent run status, so every historical failed task re-surfaces as a high-severity incident forever"
created: 2026-07-13
---

## Problem

`forge ops check` reports 12 high-severity `orphaned_work_may_persist` incidents on the forge project. All twelve are stale: their parent runs are long since `complete` or `abandoned`, the working tree is clean, and no work is actually stranded. They have re-surfaced on every `ops check` for weeks and will keep doing so forever. This is operator-visible noise on a HIGH-severity channel, which is the channel that must stay trustworthy — a permanently-red ops check trains the operator to ignore it, and the one real incident (a genuine `stuck_run`, FG-414's class) gets lost in the pile.

## Root cause

`detectOrphanedWorkMayPersist` (src/ops/detect.ts:247) selects every task with `status = 'failed'` for the project and **never filters on the parent run's status** — it JOINs `runs` (`JOIN runs r ON r.id = t.run_id`, detect.ts:252) but uses the join only for the `project_dir` scope, never for `r.status`.

The two sibling detectors in the same file already do this correctly:
- `detectRetryOrphan` — `AND r.status IN (${TERMINAL_RUN_STATES...})` (detect.ts:69)
- the inconsistent-state detector — same filter (detect.ts:105)

`TERMINAL_RUN_STATES = ["complete", "abandoned"]` is already defined at detect.ts:55 and documented as "a run here will never dispatch further work on its own."

Note the polarity differs between detectors and must not be copy-pasted blindly: for `retry_orphan`, a TERMINAL parent run is what MAKES it an incident (a pending task nothing will ever dispatch). For `orphaned_work_may_persist`, a terminal parent run is what makes it STALE (the run reached its terminal state regardless — the failed task was superseded, re-dispatched, recovered, or the run was abandoned on operator authority). The fix is not "add the same filter"; it is "add the inverse filter."

## Design question the fix must answer

A naive `AND r.status NOT IN ('complete','abandoned')` suppresses the noise, but it can also hide a genuinely-lost diff: a task that failed with persisted work under a run that later completed by another path. Decide, and state the reasoning in the code:

- **Option A — suppress on terminal parent run.** Simple, matches the sibling detectors' shape. Accepts that a lost diff under a completed run is not an ops incident (the run shipped; salvage is a git-archaeology question, not a live wedge).
- **Option B — downgrade rather than suppress.** Keep the incident but drop it to low severity / informational when the parent run is terminal, so the high-severity channel stays clean without discarding the pointer entirely.
- **Option C — suppress only when the evidence is non-probative.** Note that for a SHARED project-dir task (no dedicated worktree) the evidence line already says so in as many words: "may include unrelated uncommitted changes, evidence to inspect, not proof of task work." Such evidence cannot distinguish real stranded work from an unrelated dirty tree, so on a terminal run it carries no signal at all. A dedicated-worktree task's evidence IS probative and might be worth keeping.

Recommendation: A or C. B risks becoming a permanent low-severity pile with the same "never clears" property, just quieter.

## Precedent

FG-504 and FG-505 (both closed) fixed exactly this CLASS of bug for the `container_reap_failed` kind — incidents that never clear after the underlying condition is resolved. This is the same defect in a different detector; the resolution should be consistent with how those landed.

## Acceptance Criteria

- [ ] `orphaned_work_may_persist` incidents whose parent run is terminal (`complete` / `abandoned`) no longer surface as high-severity ops-check incidents
- [ ] The chosen policy (suppress / downgrade / evidence-conditional) is stated in a code comment with its reasoning, including the polarity difference vs `detectRetryOrphan`
- [ ] A live incident under an ACTIVE run still surfaces at high severity — the fix must not silence real stranded work (negative test: failed task + persisted-work evidence + active parent run → incident still raised)
- [ ] Regression test: failed task with persisted-work evidence under a `complete` run, and under an `abandoned` run → no high-severity incident
- [ ] `forge ops check` on the forge project returns a clean (or accurately-scoped) result — the current 12 stale incidents clear without any DB surgery

## Relations

- Same class as FG-504 / FG-505 (incidents that never clear after resolution), for a different detector.
- Sibling detectors with the correct run-status filter: FG-414 added `detectRetryOrphan`'s active-run/all-terminal-tasks coverage.
- Surfaced 2026-07-13 while orienting on FG-425; the 12 incidents are unrelated to FG-425 and do not block it.
