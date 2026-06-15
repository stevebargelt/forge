---
id: FG-94
type: story
status: done
title: Retry button suppressed on tasks failed via gate-reject
---

**Closed:** 2026-05-09 overnight, on branch `phase-flow-71` (231 tests passing, +3 new).
- `src/dashboard/queries.ts`: `getTaskDetail` returns a derived `failureMode: 'rejected' | 'crashed_or_agent_error' | undefined` field. Rejected = task is failed AND has at least one gate row with `decision='reject'`. `crashed_or_agent_error` covers everything else (container crash, agent error, validation failure, watchdog kill). undefined for non-failed tasks.
- `src/dashboard/html.ts`: failed-task rendering branches on `failureMode === 'rejected'`. The retry section is suppressed on rejected. Banner copy clarifies — "Task was rejected at the gate. Retry would re-run the same agent..." vs the original crash banner.
- Detail render-key (#72) includes `failureMode` so the retry section flips correctly when a gate-reject lands.
- 3 new queries.test cases: rejected, crashed, undefined-on-non-failed.