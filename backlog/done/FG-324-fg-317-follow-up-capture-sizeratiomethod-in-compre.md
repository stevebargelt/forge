---
id: FG-324
type: story
status: done
title: "FG-317 follow-up: capture size/ratio/method in compression events"
---

**Closed:** 2026-06-15.


**Goal:** Enhance FG-317 compression verification to capture and log compression metrics (original size, compressed size, ratio, method) in the event payload.

**Context:** FG-317 logs `compression.verification` events when the orchestrator safety net compresses large results. Currently the event payload only includes:
```json
{ "agent_compressed": false, "orchestrator_compressed": true, "fields_compressed": ["notes"] }
```

The dashboard (FG-321/322/323) expects richer metrics:
```json
{
  "agent_compressed": false,
  "orchestrator_compressed": true, 
  "fields_compressed": ["notes"],
  "original_size_bytes": 51200,
  "compressed_size_bytes": 10851,
  "compression_ratio": 0.212,
  "method": "headroom"
}
```

Without these fields, dashboard queries return null for bytes_saved, avg_compression_ratio, and method distribution.

**Implementation:**
- Update `CompressionVerification` type in `src/v2/compression-verification.ts` to include optional size/ratio/method fields
- Capture these metrics in `maybeOrchestratorCompress()`:
  - `original_size_bytes`: `args.resultRawSize` (already available)
  - `compressed_size_bytes`: size after compression (need to measure)
  - `compression_ratio`: compressed / original
  - `method`: from `compressPrompt()` meta.method
- Update compression event payload in `src/v2/invoke.ts` to include full metrics
- Tests: extend `compression-verification.integration.test.ts` to verify metrics are logged

**Acceptance:**
- Compression events include all 7 fields (3 boolean/array + 4 numeric/string)
- Dashboard `/api/compression/summary` returns non-null aggregates
- Dashboard compression tab shows real metrics (bytes saved, avg ratio)
- Per-task detail shows original/compressed sizes
- Tests pass, typecheck clean

**Related:** FG-317 (compression safety net), FG-321 (dashboard API), FG-322 (dashboard UI), FG-323 (per-task detail)