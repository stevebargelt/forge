---
id: FG-105
type: story
status: done
title: System Map view (replaces old graph view)
---

**Closed:** 2026-05-13. Shipped via the System Map run forge ran on itself + a manual renderer-fix pass against the design frames after red review caught gaps. Commit `5a44588` on `system-map-105`; merged to main as `6a1b6aa`.

**What landed:**
- `src/dashboard/systemMap.ts` — pure `buildTaskGraph(tasks, phaseShape)` emitting nodes with `_fanoutTotal` / `_fanoutComplete` for in-node progress bars, plus three arrow kinds (linear, retry, red). `computeElkLayers` assigns ELK layer hints.
- `src/dashboard/systemMap.test.ts` — 15 unit tests.
- `src/dashboard/html.ts` — modal shell with header/canvas/footer, ELK layout via cytoscape-elk@2.3.0, reds hand-placed vertically in their parent's column post-layout, HTML labels via cytoscape-node-html-label@1.2.1 (auto-registers on cytoscape's core extension API, not a window global), drag-stable per-run via module-level `Map<runId, Map<taskId, {x,y}>>`, filter chips (All / Running / Failed / Pending / Reds), retry arrows arc below the row via bezier control points.
- Old graph view deleted: `graphView.ts`, `graphView.test.ts`, the `buildGraphDataClient` mirror, `openGraphView` / `relayoutGraph` / `expandFanoutPhase` / `collapseFanoutPhase` from CLIENT_JS, the dagre + cytoscape-dagre CDN tags, and the old `.graph-modal-*` CSS.
- `SYSTEM_MAP_STATUS_COLORS` extends the old map with `complete` (was `done` — wrong key, made every complete task render as gray) and adds icon glyphs per TaskStatus.

**Renderer fixes after the agent build phase shipped (red review found these, hand-iterated against design):**
- `_fanoutTotal` / `_fanoutComplete` referenced but never populated by the data layer.
- cytoscape-elk URL was `@1.4.0` (404 — that version doesn't exist on unpkg).
- `done` status key didn't match TaskStatus `complete`.
- nodeHtmlLabel detection used a non-existent `window.cytoscapeNodeHtmlLabel` global.
- ELK partitioning collided reds with downstream phases; switched to ELK-on-main-flow + hand-placement-for-reds.

**Closes:** #102 minimap, #101 side panel (not in the new designs).
**Follow-ups filed:** #115 (smart-refresh task-state gap, hit during this run), #123 (a11y posture), #124 (drag-overrides Map LRU), #125 (implementer seeds + forge-test), #126 (replace Playwright MCP with shell CDP — hit Playwright wedge during renderer iteration), #127 (red→parent arrow semantics — magenta arrow reads as flow when it should read as side-channel).