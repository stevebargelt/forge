---
id: FG-323
type: story
status: done
title: Per-task compression detail in timeline (FG-313 Phase 3)
---

**Closed:** 2026-06-15.


**Goal:** Show compression stats inline in the task timeline detail view.

**Context:** When you click a task in the dashboard, you see its full detail card with stdout/stderr logs, verdicts, gates. Currently there's no compression info. This phase adds it.

**What to add:**

In the task detail view (`/api/task/:id` → rendered by `client/renderers.js`), when a `compression.verification` event exists for the task:

1. **Compression badge** next to the task completion timestamp
   - "✓ Compressed: 120KB → 15KB (88%)" (when agent compressed)
   - "⚠ Orchestrator compressed: 45KB → 6KB (87%)" (when orchestrator had to compress because agent didn't)
   - Badge color: green for agent_compressed=true, amber for orchestrator_compressed=true

2. **Compression detail section** (expandable accordion under the task summary)
   - Method: SmartCrusher / CodeCompressor / Kompress-base / none
   - Fields compressed: `["notes", "stdout"]` (from event payload `fields_compressed`)
   - Original size: 120KB
   - Compressed size: 15KB
   - Compression ratio: 88%
   - CCR ID: `abc123` (if available from event payload — link to retrieval action in future iteration)

3. **No compression note** (when task result < 20KB)
   - Small grey text: "Result size: 3KB (below compression threshold)"

**Implementation:**
- Extend `taskDetail()` query in `dashboard/src/queries.ts` to join `compression.verification` events for the task
- Add rendering logic in `client/renderers.js`: `renderCompressionBadge()`, `renderCompressionDetail()`
- Wire into the existing task detail card renderer

**UI/UX notes:**
- Only show compression detail when the event exists (most tasks won't have one)
- Make the detail section collapsed by default; expand on click
- Link "Fields compressed" to the actual fields in the result.json view (if we add result.json preview in a future iteration)

**Acceptance criteria:**
- Compression badge appears for tasks with compression.verification events
- Badge correctly distinguishes agent vs orchestrator compression
- Detail section shows accurate metrics from the event payload
- No badge/section for tasks without compression events
- No badge/section for tasks with result < 20KB
- Dashboard still renders cleanly for old tasks (pre-FG-317) with no compression events

**Dependencies:** FG-321 (compression events must be queryable)

**Related:** FG-313 (parent epic), FG-317 (compression verification that logs the events)