---
id: FG-211
type: story
status: done
title: "RUN-3 ops-dashboard: dashboard operations summary views (success rate, failure-kind mix, durations)"
---

**Closed:** 2026-05-30. Commit `9554c86`.

Observability RUN stage §3 dashboard surface (docs/observability.md). Bring RUN-2 metrics into the web dashboard as an operations summary view (sibling to the existing usage view).
- Run success rate, failure-kind mix, median durations by workflow/phase, cancel/retry/red-block counts.
- Reuse the dashboard's read-only query layer (dashboard/src/queries.ts); inline aggregation to keep it self-contained.
- New nav tab or section alongside activity/projects/usage. Verify with browser-tools (screenshot + inspect).
Depends on RUN-2 (#metrics) for the aggregation shape. Lower priority than the CLI surfaces.