---
id: FG-507
type: story
status: active
title: "recover/retry lifecycle gaps: recover recommends a retry that refuses status=running; retried ad-hoc invoke tasks are undispatchable"
created: 2026-07-09
---

Two operational gaps hit live during the FG-502 run (2026-07-09) while recovering a killed fixer invoke (task-engineer-68c1cd, container SIGTERM'd exit 143, empty result.json):

1. forge recover's recommendation contradicts retry's preflight. recover on a running task with a dead container printed 'next: forge retry task-engineer-68c1cd (... retryable without --force)', but forge retry (with and without --force) refuses: 'Task is in status running, not failed'. The undocumented missing step was forge cancel first. Either recover should recommend the cancel+retry sequence, or retry should accept a running task whose container is confirmed gone (same evidence recover itself uses).

2. A retried ad-hoc (invoke-attached) task is a dead end. After cancel, forge retry created a lineage-linked pending task (task-task-002525) and said 'Next: forge next <run-id>' — but forge next reported 'nothing ready to dispatch': the workflow ready-queue does not pick up ad-hoc run-attached tasks (they are not workflow steps). The pending row just strands (had to cancel it and dispatch a fresh forge invoke). Either forge next's ready queue should include retried ad-hoc tasks, or retry on an ad-hoc task should re-dispatch directly (invoke semantics), or at minimum retry should not point at forge next for them.

Evidence: run run-fg-502-review-loop-fixer-scope-guard-campaign-item-state-reviewed-tip-identity-f952cf, tasks task-engineer-68c1cd (cancelled), task-task-002525 (stranded pending, then cancelled), task-engineer-0a5934 (fresh invoke that completed the work).

Acceptance:
- [ ] recover's recommended command sequence works verbatim on a running task with a confirmed-gone container
- [ ] a retried ad-hoc invoke task is dispatchable (or retry refuses with an accurate next action instead of pointing at forge next)
- [ ] integration test covers the dead-container running task recover->(cancel->)retry->dispatch path end to end