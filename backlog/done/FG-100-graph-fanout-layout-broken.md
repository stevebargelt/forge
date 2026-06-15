---
id: FG-100
type: story
status: done
title: "GRAPH: fanout layout broken"
---

**Closed:** 2026-05-11 on branch `graph-view-85` → merged to main as part of `ed7e8c5`. Three failure modes from the original capture (overlap, gap, edge-cut) resolved by shipping Hypothesis C — flat-node model, no cytoscape compound parents. Children of an expanded fanout phase are top-level peer nodes; dagre handles parallel ranks natively. Plus curved edges (`unbundled-bezier`) so the graph reads as flow not org-chart, plus failed children rendered as dead-ends (no outgoing edge to next phase) matching real workflow semantics. Original WIP (compound nodes + grid sub-layout) is gone.