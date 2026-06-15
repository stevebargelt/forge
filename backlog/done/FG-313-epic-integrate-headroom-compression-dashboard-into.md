---
id: FG-313
type: epic
status: done
title: "[EPIC] Integrate headroom compression dashboard into forge dashboard"
---

**Closed:** 2026-06-15.


**Status:** Scoped into FG-321, FG-322, FG-323.

**Goal:** Surface compression metrics in the forge dashboard — show token savings, compression ratios, and per-task compression details.

**Context:** Forge tracks compression via `compression.verification` events (FG-317). Each event logs:
- Who compressed: agent vs orchestrator
- Original size, compressed size, compression ratio
- Compression method (SmartCrusher / CodeCompressor / Kompress-base)
- Fields compressed

The dashboard currently doesn't show any of this. Users can't see token savings or identify agents that aren't compressing.

**Approach:** Three-phase build-out:
1. **FG-321** — API endpoints: `/api/compression/summary`, `/timeseries`, `/by-role`, `/methods`
2. **FG-322** — UI panels: compression health card, timeseries chart, breakdown table, method distribution
3. **FG-323** — Per-task compression detail: inline badges + expandable detail in task timeline

**Implementation stories:**
- FG-321: Dashboard compression stats API endpoints (Phase 1)
- FG-322: Dashboard compression stats UI panels (Phase 2)
- FG-323: Per-task compression detail in timeline (Phase 3)

**Out of scope for this epic:**
- Linking to headroom's external dashboard (if it has one)
- Querying headroom's SQLite store directly (we read from forge's `events` table)
- Real-time compression streaming (we show post-run summaries)

**Related:** FG-314 (headroom integration parent epic), FG-317 (compression verification that logs the events)