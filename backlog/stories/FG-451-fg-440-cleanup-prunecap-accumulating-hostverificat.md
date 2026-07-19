---
id: FG-451
type: story
status: deferred
title: "FG-440 cleanup: prune/cap accumulating host_verifications rows for chronically-failing items (per-row ancestry check grows O(rows) over reconciles) + rename stale reconcile.integration.test.ts:859 test title to match the passing-row model"
created: 2026-07-03
---

**Disposition (2026-07-19):** Deferred until accumulated `host_verifications` rows produce measurable reconciliation latency or storage impact. Low-value cleanup alone is not a reason to prioritize it.
