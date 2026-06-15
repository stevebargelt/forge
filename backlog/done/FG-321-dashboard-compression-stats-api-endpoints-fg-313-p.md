---
id: FG-321
type: story
status: done
title: Dashboard compression stats API endpoints (FG-313 Phase 1)
---

**Closed:** 2026-06-15.


**Goal:** Add read-only HTTP API endpoints to the dashboard server for querying compression metrics from forge's SQLite store.

**Context:** Forge tracks compression via:
- `compression.verification` events in the `events` table (one per task when result > 20KB)
- Event payload carries `{ agent_compressed, orchestrator_compressed, fields_compressed, original_size_bytes, compressed_size_bytes, compression_ratio, method }`

Dashboard server (`dashboard/src/server.ts`) currently has no compression routes. We need:

1. **GET /api/compression/summary**
   - Query params: `?since=30d&projectDir=/path`
   - Returns aggregate stats: total tasks compressed, total bytes saved, average compression ratio, breakdown by who compressed (agent vs orchestrator)
   
2. **GET /api/compression/timeseries**
   - Query params: `?since=30d&projectDir=/path&interval=day`
   - Returns time-series data: `[{ date, tasks_compressed, bytes_saved, avg_compression_ratio }]`

3. **GET /api/compression/by-role**
   - Query params: `?since=30d&projectDir=/path&limit=50`
   - Returns per-agent-role breakdown: `[{ agent_role, tasks_compressed, bytes_saved, avg_ratio }]`

4. **GET /api/compression/methods**
   - Query params: `?since=30d&projectDir=/path`
   - Returns compression method distribution: `[{ method: "SmartCrusher" | "CodeCompressor" | "Kompress-base" | "none", count, bytes_saved }]`

**Implementation:**
- Add query functions to `dashboard/src/queries.ts`: `compressionSummary()`, `compressionTimeSeries()`, `compressionByRole()`, `compressionMethods()`
- Wire routes in `dashboard/src/server.ts` (GET handlers only, read-only DB)
- Tests in `dashboard/src/queries-compression.test.ts`

**Acceptance criteria:**
- All four endpoints return valid JSON
- `?projectDir` filter works (host-global when omitted)
- `?since` parses "7d", "30d", ISO dates
- Returns empty arrays / zero counts when no compression events exist
- Typecheck + tests pass

**Dependencies:** None (compression events are already logged by FG-317)

**Related:** FG-313 (parent epic), FG-317 (compression verification), FG-322 (UI phase)