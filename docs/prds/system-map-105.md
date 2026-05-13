# System Map (#105) — implement the new graph view per the designs

## What this run is

Build the new task-graph view for the forge dashboard, called **System Map**. Replaces the existing cytoscape+dagre "Graph View" modal. The designs are finalized: see `/design/designs/system-map.png`, `/design/designs/system-map-fanout.png`, `/design/designs/system-map-reds-detail.png`, and the implementer note `/design/designs/system-map-implementer-note.png` (host mirror: `~/code/forge-design/designs/...`).

The implementer note is load-bearing: **the three frames are the same view rendered at different run states.** Build one component, not three.

## Why this matters

The existing graph view shows a sanitized, pill-row-flavored projection of a run — fanout dots, phase boxes, no retries, no reds. The human can't see what actually happened. The System Map renders every task in the run (including retry chains and every red review task) as peer nodes in one canvas, with the human free to drag nodes around to organize the layout to their mental model.

This was tracked as #105 in the backlog. Two ancestors closed during this design conversation: #102 (minimap) and #101 (side panel) are not in the new designs and not in scope.

## Run state at start (relevant to scope)

- The data layer ingredients exist: `src/store/tasks.ts`, `src/store/verdicts.ts`, `src/dashboard/queries.ts` already expose every task in a run including reds and retries. Tasks carry `parentId`, `phase`, `agentRole`, `status`. Reds are tasks whose `agentRole` starts with `red-`. Retries are tasks whose `parentId` points to another task in the same phase with the same agentRole and `status: 'failed'`.
- The existing graph view lives in `src/dashboard/graphView.ts` + `src/dashboard/html.ts` (the modal markup + the cytoscape initialization). It's been the home for a lot of #100 / #103 / #110 dashboard work; lots of code paths feed into it.
- #113 just landed: discipline reds (red-frontend / red-backend / red-security) now gate the parent like wide/narrow do. Verdicts carry `authority: 'authoritative'` for new runs and `'specialist'` for legacy. The System Map renders all reds with identical visual treatment regardless — see the reds-detail frame.
- Tests are at 346/346. Typecheck green. Branch is `reds-authoritative-113`; the System Map work needs its own branch.

## What's in scope (acceptance)

A working System Map view in the dashboard that:

1. **Renders every task in the run** — including reds (always visible as peer nodes), retry chains (failed task + its retry task both visible, edge between them), and fanout sub-tasks. No collapse modes, no hidden tasks.
2. **Uses ELK for initial layout** (via `cytoscape-elk` or equivalent) instead of dagre. ELK handles heavy fanouts and same-rank constraints far better — see the `system-map-fanout.png` design for the canonical complex case (8-way fanout, two retried investigates, awaiting-red on one, all flowing into one synthesize node).
3. **One view, three states** — the same component renders correctly for all three design frames:
   - `system-map.png` — linear run with a single retry + a blocked-by-red downstream task
   - `system-map-fanout.png` — heavy fanout with retries and awaiting-red
   - `system-map-reds-detail.png` — a parent task with 5 reds attached, all visible as peers
4. **Nodes match the design language** — status-colored borders + icons + meta line (`phase · role · elapsed`), inline progress bar on running nodes, "blocked by red" treatment when applicable, dim/pending downstream. The component library PNG and the reds-detail frame are the canonical references for red node treatment; render every red identically regardless of role kind (wide / narrow / discipline) since #113 made them all gating-equivalent.
5. **Edges are status-colored** based on the source-task status (green=complete, cyan=running, red=failed, dim=pending). Retries have an edge from the failed task to the retry. Reds have an edge from the parent to each red. No special edge "kind" labels — the design uses color and target-node-kind to convey the relationship.
6. **Draggable nodes, drag-stable while viewing.** When the human drags a node, it stays where they put it for the duration of the dashboard session viewing this run. No DB persistence; an in-memory map of `{ taskId → {x, y} }` keyed by run id is fine. Reset-layout button (in the design) clears the overrides and re-runs ELK.
7. **The header matches the design** — title "SYSTEM MAP", run id, workflow name, phase count + characteristic chip (e.g. "fanout retry"), run status pill, filter chips (all / running / awaiting / failed / blocked / complete), reset-layout button, close X.
8. **Filter chips dim non-matching nodes** rather than hide them. Edges to/from dimmed nodes also dim. Topology stays visible; just the focus changes.

## What's out of scope

- **The old graph-view code goes away cleanly.** No feature flag, no side-by-side. The new System Map replaces it. Delete `graphView.ts`'s data-feed half if it's no longer used by the pill row (the pill row uses `phaseShape.ts`, which stays). Audit and delete the cytoscape+dagre setup in `html.ts`. Tests for the old layer can go too.
- **Pill row stays untouched.** The pill-row-bar above the canvas is a separate component (`JAKzj` in the .pen library). It continues to work via `phaseShape.ts`.
- **Minimap (#102) and side panel (#101) are CLOSED.** Not in the designs; do not build them.
- **No node detail panels in this view.** Clicking a node should *not* open an in-canvas detail; existing task-detail routes/screens handle that. The System Map is structural — it shows the shape of the run.
- **No edge-kind labels or annotations.** The "← blocks parent" text in the reds-detail frame is a designer annotation, not a runtime overlay; do not implement.
- **The `scenario: …` chip in each design header is a designer annotation, not a runtime feature.** Do not implement.
- **No collapse-to-summary toggle.** The pill row above is the summary; the System Map is always the real shape.
- **Drag positions don't survive page refresh or dashboard restart.** Just hold them in-memory keyed by run id while the user is viewing.

## Reading list for the architect

Design corpus is mounted read-only inside your container at `/design`. The host path is `~/code/forge-design` (informational; you read via `/design`). Forge project is mounted at `/project`.

- `/design/designs/system-map.png` — basic frame
- `/design/designs/system-map-fanout.png` — heavy-fanout case
- `/design/designs/system-map-reds-detail.png` — reds visible as peers; canvas shows 5 reds and the implementer reads `tasks[]` from the DB regardless, so any header-count discrepancy in the design is informational only
- `/design/designs/system-map-implementer-note.png` — top-of-file note: "ONE VIEW · MULTIPLE SCENARIOS — Build one component. Do not build three modals/screens."
- `/design/designs/component-library.png` — single-sheet export of every reusable component from the .pen file. Read **System Map Atoms** for the canonical System Map node / edge / arrowhead components. **A red deprecation banner sits below System Map Atoms; everything below that banner (the old "Graph Nodes" row) is dead reference for the cytoscape+dagre graph view this run is replacing — ignore it.** Use this PNG for visual fidelity decisions; use the frame PNGs for in-context layout decisions.
- `/design/dashboard.pen` — the .pen file itself is encrypted and not directly readable by agents. Treat the PNGs above as the contract; do not try to open the .pen.
- `/project/src/dashboard/graphView.ts` — the data-feed function being replaced; understand what shape it produces for the pill row vs the graph today
- `/project/src/dashboard/phaseShape.ts` — stays as the pill row's source of truth; do not break it
- `/project/src/dashboard/html.ts` — the cytoscape setup + modal markup
- `/project/src/dashboard/queries.ts` — task / verdict / run accessors used by the dashboard

## Architectural angles the architect should think about

- **Data layer separation.** A new pure function `buildTaskGraph(run, tasks, workflow, verdicts): TaskGraph` should be the single source of truth for the System Map. Same shape regardless of layout engine, edge style, or render target. The pill row's `phaseShape.ts` stays separate.
- **Edge generation.** Every edge falls out of two relationships in the data: `parentId` (red → its parent task; retry → the failed task it replaced) and phase order (last-phase-task → next-phase-task). The architect should think about whether fanout phases need synthetic per-step edges or if `parentId` already covers it.
- **Layout vs render.** ELK produces (x,y) for nodes given a graph + constraints. Cytoscape consumes (x,y) and renders. Manual drag overrides (x,y) for that node. Reset clears overrides. Worth thinking about where the override map lives and who owns it.
- **Reds-in-rank.** Per design, reds appear in the same horizontal rank as their parent task (fanned vertically to the right). ELK needs explicit same-rank or layout-direction constraints to achieve this; default layered layout would push reds one rank further right, displacing downstream tasks. This is the specific layout constraint that's hardest to get right and worth the architect's attention.
- **What happens to old graph-view tests.** A bunch of #100 / #103 / #110 work shipped tests against the dagre graph data layer. Some of those assertions will translate; some won't. The architect should think about whether tests for the new TaskGraph layer should be additive or whether old tests should be replaced.
- **Drag-stability during live updates.** The dashboard polls / refreshes the run state. When new tasks arrive (new fanout child, new red verdict), the System Map must re-render without resetting the human's drag positions. Worth flagging as a real constraint, not a polish item.

## Architect output reminder

Per the architect seed: produce systems-level assessment — risks, constraints, boundaries, prior art, open questions. NOT type names, function names, or file-by-file implementation guidance. The plan phase translates the architecture into a step-by-step plan; the build phase implements it.

## Notes

- The `feature-ui-design-provided` workflow is right for this run: designs exist, no ui-review phase needed, architecture → plan → build → verify.
- The architect must read the PNGs and the implementer note before producing the assessment. Without that, the "one view, multiple scenarios" rule will get violated by both architect and implementer.
- Reds on the build phase are now gating-authoritative (#113). Expect that any backend or frontend specialist concern raised during the build will block the gate; this is correct behavior, not a bug — exercise the force-advance-with-rationale flow if needed.
