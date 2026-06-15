---
id: FG-294
type: story
status: active
title: Explore export of forge run DAG to Excalidraw format
---

**Spike / exploration.** Export a forge run's task DAG (and/or a workflow definition) to Excalidraw's `.excalidraw` scene JSON for a sketchable, shareable diagram.

**Why this is a better-fit target than n8n (#293):** Excalidraw is purely presentational — a whiteboard scene, not an execution engine. So forge's gates, red fan-out, and phases map to *shapes and labels* with NO semantic loss; there's no blackboard-vs-edge-data or gate/verdict impedance mismatch to resolve. The only real work is layout.

**Format notes (Excalidraw):** JSON `{ type: "excalidraw", version, source, elements[], appState, files }`. Each element has `id`, `type` (`rectangle` / `diamond` / `text` / `arrow` / `ellipse`), `x`, `y`, `width`, `height`, `angle`, stroke/fill styling, and a `seed`. Arrows carry `points[]` plus `startBinding`/`endBinding` referencing element ids (with `focus`/`gap`) so connectors stay attached. Text can be a standalone element or bound to a container via `containerId` + the container's `boundElements`.

**Sketch of the mapping:**
- phase/task → rounded `rectangle` (or `diamond` for gate steps), labeled with role + status via bound text.
- dependency / next-phase edge → bound `arrow` between element ids.
- red children → smaller nodes fanned off the task they audit; verdict as label/color.
- color by status (complete / failed / running / reconcile_candidate) reusing the dashboard palette.
- layout: simple layered/topological left→right or top→down; assign x/y by phase depth.

**Open questions for the spike:**
- Layout quality — auto-layout a layered DAG well enough to be readable without manual nudging (acceptable since Excalidraw is editable after export).
- Static snapshot vs live — one-shot export of a finished run is the easy win; "live updating" is out of scope.
- Where it surfaces — a `forge export <run-id> --format excalidraw` CLI? a dashboard download button? (decide in spike).

**Deliverable:** go/no-go + a minimal proof export of one real run DAG opened in Excalidraw.

Relations: #293 (n8n export — sibling exploration, worse fit), forge workflow model (`seeds/workflows/`, `src/v2/loader.ts`), dashboard run views, reconcile_candidate status color (#290).