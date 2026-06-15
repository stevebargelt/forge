---
id: FG-293
type: story
status: active
title: Explore export of forge workflows to n8n format
---

**Spike / exploration.** Evaluate exporting forge workflows (and/or completed run DAGs) to n8n's workflow JSON format. Decide whether it's worth building, and if so, which direction.

**Why:** n8n's value is its visual canvas + connector catalog. A read-only export could give a familiar graph view and an interop seam without adopting n8n as a runtime.

**Format notes (n8n):** JSON with `nodes[]` (each: `name`, `type`, `typeVersion`, `position [x,y]`, `parameters{}`, optional `credentials{}`) and `connections{}` (adjacency keyed by source node name → `{ main: [[ { node, type, index } ]] }`), rooted at a trigger node. Execution is item-based: data flows along edges via expressions; branching is explicit IF/Switch/Merge nodes.

**Impedance mismatch to resolve in the spike (why this is explore, not just build):**
- Edge-passed data vs blackboard — n8n threads payloads node→node; forge uses SQLite as the blackboard (tasks read prior result.json + shared state, not edge payloads). Deepest mismatch.
- Arbitrary DAG vs phased pipeline + structured red fan-out + gates — n8n has no first-class gate (auto/human) or red verdict aggregation; those would become untyped node convention, which fights forge's Zod-validated schema.
- Node weight — a forge node is an agent role in a container under RACI routing; an n8n node is a typed integration call.

**Options ranked by fit (from session discussion):**
1. Interop at the boundary (forge triggered by / emitting to n8n webhooks) — best fit, but that's a different ticket than *export*.
2. Export forge run DAG → n8n JSON purely for visualization in n8n's canvas. The actual scope of THIS ticket. Earns its keep only if n8n's canvas is wanted over the existing dashboard.
3. n8n as forge's authoring/runtime format — poor fit; out of scope, do not pursue without a forcing reason.

**Deliverable of the spike:** a go/no-go on option 2 with a sketch of the node/connection mapping (forge phase/task → n8n node; dependency edges → connections; gates/reds → ??? — the open question) and an honest read on whether the lossy mapping is useful enough to maintain.

Relations: forge workflow model (`seeds/workflows/`, `src/v2/loader.ts`), #253 (provider adapter surfaces), dashboard run views.