---
id: FG-201
type: story
status: done
title: forge invoke --run <terminal-run> attaches a running task but leaves run status complete → live task hidden in dashboard
---

**Closed:** 2026-05-30. Commit `ad82297`.

Hit live (and confused the user) multiple times: when the orchestrator chains engineer -> test-engineer by attaching the second invoke to the first's run via `forge invoke --run <runId>`, the engineer phase has already marked that run `complete`. The test-engineer task IS created and its container IS running, but `forge invoke --run` attaches the task WITHOUT flipping run.status back to `active`. The dashboard and `forge status` list by run status, so the run shows `complete` and the live test-engineer task is invisible — looks like "nothing is running" when a container is actively churning.

Confirmed: run-197-task-manifest-f45aaa status=complete while forge-task-test-engineer-2e8523 was Up 7 minutes with task.started + container.started events under that run.

Fix: when `forge invoke --run <runId>` (or any path) creates a non-terminal task under a run whose status is terminal (complete/abandoned), reactivate the run — set status back to `active`. The run isn't complete if it has a running task. Sibling to #185/#186 (run-status lifecycle correctness: cancel made abandon authoritative; this makes attach reactivate).

Workaround until fixed: orchestrator should NOT attach a new invoke to an already-complete run; give each invoke its own run so it shows active.