---
id: FG-208
type: story
status: done
title: "WALK-5 dashboard-activity: add task timeline + live activity panel to the dashboard"
---

**Closed:** 2026-05-30. Commit `b93a6cb`.

Observability WALK stage, §1 dashboard surface (docs/observability.md:325, 403).

Bring the Crawl/WALK observability data into the web dashboard (the CLI surfaces
are WALK-1/#204; this is the browser surface).

Scope:
- Task detail view: render the lifecycle event TIMELINE (eventsForTask) — the same
  data forge show <task-id> now shows, in the dashboard.
- Live activity panel for running tasks: last-output age, idle countdown, container
  name, current status, last lifecycle event (reuse WALK-1 computation).
- Failure surfacing: show failure_kind on failed tasks; group a run's failures by
  kind (groupFailedByKind already exists in show.ts).

Verify with browser-tools (screenshot + inspect) per the standing UI-verification
rule — don't ask the user to eyeball it manually.

Depends on WALK-1 (#204) for activity computation. Lower priority than the CLI
surfaces — file last, do after the read model is proven on the CLI side.

Acceptance:
- Dashboard task detail shows the event timeline.
- Running tasks show a live idle countdown that updates.
- Verified via browser-tools screenshots.