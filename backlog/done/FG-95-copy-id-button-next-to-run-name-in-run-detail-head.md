---
id: FG-95
type: story
status: done
title: Copy-id button next to run name in run-detail header
---

**Closed:** 2026-05-09 overnight, on branch `graph-view-85` (251 tests, no test deltas — pure UI).
- `src/dashboard/html.ts`: middle-pane run-detail header now renders `<run-id> [copy] [status-badge]`. Reuses the existing `copy` class + `copyText` helper. Mirrors the task-id copy pattern in `taskHeaderSection` (#78).
- Sidebar rows kept tooltip-only — too cramped for an inline button.