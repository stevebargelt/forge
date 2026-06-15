---
id: FG-207
type: story
status: done
title: "WALK-4 rich-notifications: run-transition notifications carry failure_kind + a forge show next-command"
---

**Closed:** 2026-05-30. Commit `26c75db`.

Observability WALK stage, §4 (docs/observability.md:379).

Enrich the CONTENT of forge's existing run/task notifications so the ping itself
answers "what failed and what do I do next" without opening a terminal.

Target format:
  Forge: task engineer failed: result_malformed.
  Run: feature login redesign
  Next: forge show task-engineer-abc123

  Forge: task manual-qa idle for 8m; timeout at 10m.
  Run: app redesign
  Next: forge show task-manual-qa-def456

Scope:
- notify/format.ts formatRunNotification / formatGateNotification should include
  failure_kind (from the task.failed event payload — Crawl) and a derived next
  command (reuse deriveNextCommandForTask/deriveNextCommandForRun from show.ts).
- Idle-warning notifications (idle for Xm; timeout at Ym) — optional stretch, ties
  to WALK-1 idle computation.
- Respect NO_NOTIFY (#198) and the real-runs-notify rule (test suite stays silent,
  real runs ping).

RELATIONSHIP: distinct from #203 (orchestrator-done ping for forge-on-forge work,
which has NO run transition at all). This ticket improves the content of pings
that already fire on run transitions; #203 is about a ping existing for direct
orchestrator work. Implement independently; share the formatting helper.

Acceptance:
- A failure notification names the failure_kind and a copy-pasteable forge show.
- Formatting is unit-tested per failure_kind.