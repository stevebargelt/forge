---
id: FG-491
type: story
status: done
title: "persistence watchdog false positive: complete in-run fixer downgraded to failed with 'work not persisted' while the full diff exists on the host (3+ occurrences)"
created: 2026-07-07
closed: 2026-07-09
closed_commit: "1688025"
---

Queued by the 2026-07-07 overnight handoff (hit twice that night); third+ occurrence confirmed 2026-07-07 afternoon. Three more occurrences hit during the FG-497 chain on 2026-07-08. The persistence watchdog fails a genuinely-complete task with "work not persisted" when the work IS on the host project dir.

## Evidence (preserved task rows — do not mutate)

- task-engineer-7bc36b and task-engineer-889edb (2026-07-07 overnight, in-run fixers on shipped runs): result claimed complete; watchdog said nothing persisted; git showed the full diff. See notes/autonomous-decisions-2026-07-07.md.
- task-engineer-07fe60 (2026-07-07 ~17:20Z, run-fg-485-7bfcb2 round-2 fixer): result.json status=complete listing exact file:line changes; watchdog error: "work not persisted..."; host grep immediately afterwards found EVERY claimed change present (src/campaign/executor.ts:27,818,827 and the new test at fg485-resume-drives-live-gate.integration.test.ts:425). The suites then passed on the host.
- task-engineer-ca940b, task-engineer-f9c174, task-engineer-39697b (2026-07-08, FG-497 chain, run-fg-497-invoke-task-argv-e2big-193dc8): every engineer invoke was downgraded to failed/work-not-persisted while result.json was otherwise valid (status complete, tests_run populated) and the complete diff was on disk and later shipped in PR #71.

## Root cause (confirmed 2026-07-08, replaces the earlier hypotheses)

`result.files_modified` entries are commonly ANNOTATED strings, not raw paths — `src/v2/invoke.ts:153-162 — workflow_additions no longer embeds args.task...`, `scripts/pi-context-proof.sh:1-122 (rewritten: ...)`, `seeds/runtimes/pi-apikey.yml:24-25`. src/v2/persistence-check.ts joined the WHOLE claim string onto projectDir, so annotated entries always resolved to nonexistent paths; when every entry was annotated (the common case), the all-absent loss signature fired and the complete result was discarded (destroying tests_run evidence). The original mtime/settle-window and diff-baseline hypotheses were checked and are NOT the cause; the FG-377 settle-retry logic is unrelated and unchanged.

## Acceptance criteria

- [ ] Root cause identified with a reproducing test (not asserted from theory): the annotated-entry shapes above, with the real file present on host, reproduce the false positive against the old code.
- [ ] The six evidence tasks' claim shapes (path:line-range, path:line-range — prose, path (prose), comma line-specs) no longer classify as "work not persisted" when the referenced file exists on the host.
- [ ] A genuinely-unpersisted case (container-only write, /workspace absolute path, all-unparseable prose) still fails — the negative half stays.
- [ ] Watchdog message updated to state exactly what was checked (raw claims, normalized paths, missing paths, unparseable claims) so a false positive is diagnosable from the error alone.
