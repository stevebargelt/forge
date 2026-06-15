---
id: FG-103
type: story
status: done
title: "GRAPH: top-bar run-status pill"
---

**Closed:** 2026-05-12 on branch `graph-status-pill-103` → merged to main. Suite at 338/338 (no test deltas — single-span chrome addition).
- `src/dashboard/html.ts`: graph-modal-header gains a `.badge.status-<run.status>` span between the title and the close button. Reuses `rowDisplayStatus()` so `active` renders as "running" consistent with the sidebar run-row badge. Migrated `margin-left:auto` from `.graph-modal-close` to the new badge so both stay flush-right.
**Live-verified** in the dashboard against a complete run; green-dot "complete" badge renders cleanly.