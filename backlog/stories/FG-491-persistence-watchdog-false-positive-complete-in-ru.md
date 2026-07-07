---
id: FG-491
type: story
status: active
title: "persistence watchdog false positive: complete in-run fixer downgraded to failed with 'work not persisted' while the full diff exists on the host (3+ occurrences)"
created: 2026-07-07
---

Queued by the 2026-07-07 overnight handoff (hit twice that night); third+ occurrence confirmed 2026-07-07 afternoon. The persistence watchdog fails a genuinely-complete task with "work not persisted" when the work IS on the host project dir.

## Evidence (preserved task rows — do not mutate)

- task-engineer-7bc36b and task-engineer-889edb (2026-07-07 overnight, in-run fixers on shipped runs): result claimed complete; watchdog said nothing persisted; git showed the full diff. See notes/autonomous-decisions-2026-07-07.md.
- task-engineer-07fe60 (2026-07-07 ~17:20Z, run-fg-485-7bfcb2 round-2 fixer): result.json status=complete listing exact file:line changes; watchdog error: "work not persisted: result.json reports status=complete with 2 modified file(s), but none exist on the host project dir — the agent likely wrote to an ephemeral container path"; host `grep` immediately afterwards found EVERY claimed change present (src/campaign/executor.ts:27,818,827 and the new test at fg485-resume-drives-live-gate.integration.test.ts:425). The suites then passed on the host.

## Problem

The settle-window/at-least-one-file heuristic in the persistence check produces false "work not persisted" failures on shared-project-dir (non-worktree) dispatch. Consequence: a `complete` result is downgraded to `failed`, the orchestrator/campaign sees a failed fixer, and every recovery path (retry from scratch) would DISCARD or duplicate real work. Only manual on-disk verification catches it — which defeats unattended operation.

## Hypotheses to verify (do not assume)

- mtime/settle-window comparison: the checker may compare file mtimes against task start with a skewed clock base (container vs host), or the settle window closes before the final writes flush.
- The checker may diff against the wrong baseline in shared-dir mode when a PREVIOUS task in the same run already modified the same files (all three occurrences were in-run fixers editing files an earlier build task had already touched — the diff-vs-baseline may attribute the changes to the earlier task and see "no new changes").

## Acceptance criteria

- [ ] Root cause identified with a reproducing test (not asserted from theory): an in-run fixer that edits files a prior task already modified, completing successfully in shared-dir mode, is verified as persisted.
- [ ] The three evidence tasks' shape (complete result + host diff present) no longer classifies as "work not persisted".
- [ ] A genuinely-unpersisted case (container-only write) still fails — the negative half stays.
- [ ] Watchdog message updated to state exactly what was checked (paths, baseline, window) so a false positive is diagnosable from the error alone.