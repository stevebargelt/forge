---
id: FG-196
type: story
status: done
title: "Crawl 4 — show-detail: grow forge show <run|task> into the diagnostic view"
---

**Closed:** 2026-05-30.

Crawl milestone, step 4 of 5 (docs/observability.md, Crawl §4). Depends on Crawl 1 (timeline read path) and Crawl 3 (failure_kind in payloads).

**Grow forge show — do NOT add forge inspect.** Forge already has status (overview) + show (detail); a third overlapping read command is user-facing sprawl before the read model is stable. Make forge show <run-id|task-id> the canonical detail/diagnostic command.

Task view adds (on top of Crawl 1's timeline): status + failure_kind, container name, elapsed time, last-output timestamp, idle timeout if known, last few stdout/stderr lines, result-file status (missing/empty/malformed/valid), artifact manifest (Crawl 5), suggested next command (e.g. failed+idle_timeout → forge retry <id>).

Run view: identity/workflow/project/status, current blockers, failed tasks grouped by failure_kind, awaiting-gate + blocked-by-red tasks, running tasks with last-output time, next suggested command. (This is where the run-id branch from Crawl 1 gets its rich rendering.)

**Acceptance:** forge show <task-id> on a failed task shows the full diagnostic block from the doc's example (lines ~227-248); forge show <run-id> summarizes blockers + failures by kind; --json for both.