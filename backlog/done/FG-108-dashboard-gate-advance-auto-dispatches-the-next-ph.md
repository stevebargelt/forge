---
id: FG-108
type: story
status: done
title: "Dashboard: gate-advance auto-dispatches the next phase"
---

**Closed:** 2026-05-12 on branch `auto-dispatch-108` → merged to main. Test suite at 333/333 (+5 server tests). Shipped:
- `src/dashboard/server.ts`: `handleGate` chains into `forge next` after a successful `advance`. Skips the chain on reject/request-changes and on already-complete runs. Auth errors from the chained dispatch route to 400; other dispatch errors to 500 with a clear "Advanced X but dispatch failed" prefix. Response gains optional `dispatched: true` + `dispatchSummary` so the dashboard toast can confirm both halves happened.
- `src/dashboard/server.test.ts`: 5 new tests covering happy chain, reject doesn't chain, complete-run doesn't chain, dispatch failure → 500, dispatch auth error → 400.
- CLI behavior unchanged (`forge gate` still prints "Next: forge next ..." and exits). The chain is dashboard-only convenience, preserving CLI composability.