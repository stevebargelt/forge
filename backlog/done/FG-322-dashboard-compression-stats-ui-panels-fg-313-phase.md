---
id: FG-322
type: story
status: done
title: Dashboard compression stats UI panels (FG-313 Phase 2)
---

**Closed:** 2026-06-15.


**Goal:** Add compression stats visualization to the forge dashboard web UI.

**Context:** Phase 1 (FG-321) adds API endpoints. This phase surfaces them in the UI. The dashboard is a single-page app (no build step) — client JS (`client/main.js`, `client/renderers.js`) fetches from API endpoints and renders cards.

**What to add:**

1. **Compression health panel** (new top-level card in the main feed)
   - "Tokens saved (last 30d): 2.4M (~$12 avoided at $0.005/1K)"
   - "Average compression ratio: 82%"
   - "Tasks compressed: 347 / 520 total (67%)"
   - "Agents not compressing: [red-narrow, manual-qa]" (when orchestrator_compressed=true for >50% of their tasks)
   - Fetches from `/api/compression/summary`

2. **Compression timeseries chart** (under the health panel, or in a "Compression" nav tab)
   - Line chart: bytes saved over time (last 30 days, grouped by day)
   - Fetches from `/api/compression/timeseries`
   - Use a lightweight inline SVG renderer (no chart library dependency) OR link to an external chart tool

3. **Compression breakdown table** (below the chart)
   - Rows: agent role, tasks compressed, bytes saved, avg ratio
   - Sortable by bytes saved (default) or ratio
   - Fetches from `/api/compression/by-role`

4. **Compression method distribution** (pie chart or bar chart)
   - Shows SmartCrusher / CodeCompressor / Kompress-base split
   - Fetches from `/api/compression/methods`

**Implementation:**
- Add client-side rendering functions in `client/renderers.js`: `renderCompressionHealth()`, `renderCompressionTimeseries()`, `renderCompressionBreakdown()`, `renderCompressionMethods()`
- Wire into `client/main.js` poll loop (or add a "Compression" nav tab that lazy-loads these on click)
- Server-side HTML shell (`dashboard/src/shell.ts`) needs no changes (it already serves the client JS)

**UI/UX notes:**
- Default to last 30 days; add a "since" dropdown (7d / 30d / 90d / all)
- Respect the existing `?projectDir` filter (when project-scoped, show only that project's compression stats)
- If no compression events exist yet, show a gentle empty state: "No compression data yet. Agents will report compression stats as they run."

**Acceptance criteria:**
- Compression health panel renders in the main feed
- Charts/tables render correctly when data is present
- Empty state renders when no compression events exist
- Project filter works (respects `?projectDir` query param)
- No build errors; dashboard still starts with `forge dashboard start`
  > *(SUPERSEDED IN PART by FG-571, 2026-07-16: stable `forge` refuses `dashboard` in release mode — the
  > dashboard is a separate workspace, not bundled into a release, deferred to FG-572. The equivalent check
  > today is `./bin/forge-dev dashboard start`. This ticket's compression-stats work is unaffected.)*

**Dependencies:** FG-321 (API endpoints must exist first)

**Related:** FG-313 (parent epic), FG-323 (per-task detail phase)