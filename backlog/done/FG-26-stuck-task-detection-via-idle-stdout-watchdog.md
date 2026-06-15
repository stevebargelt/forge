---
id: FG-26
type: story
status: done
title: Stuck-task detection via idle-stdout watchdog
---

**Closed:** 2026-05-06, commit `aca548e`
Added `startIdleWatchdog`. Container killed if no stdout for 5 min (configurable via `FORGE_AGENT_IDLE_TIMEOUT_MS`). Five unit tests.