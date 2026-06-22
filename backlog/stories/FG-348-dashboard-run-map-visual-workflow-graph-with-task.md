---
id: FG-348
type: story
status: active
title: "Dashboard Run Map: visual workflow graph with task-level Explain panel"
epic: FG-291
created: 2026-06-22
---

## Problem

Forge runs are hard to reason about from text because workflow phases, fanout, reds, gates, model/runtime policy, project overrides, and host-global state interact. Humans should rarely need to run CLI commands; the primary human surface should be the dashboard, with the orchestrator using CLI/API plumbing as needed.

The current dashboard shows run/task outputs, but it does not give a visual map of the workflow shape or a clear answer to: why did Forge run this task this way?

## Goal

Add a dashboard Run Map that visualizes the workflow/execution graph and exposes control-plane provenance through a task/run Explain panel.

The graph should help a human understand where a run is in the workflow. The side panel should explain the control-plane decisions behind a selected task.

## MVP Scope

- Run detail page shows a visual graph of top-level workflow phases/tasks.
- Fanout phases are grouped and expandable.
- Red tasks are visually attached to the primary task they reviewed.
- Nodes show role, status, gate type, and a compact model/profile badge.
- Clicking a node opens a Why this task? panel.
- The panel shows workflow source, model resolution, runtime/auth, mount mode, gate, reds, upstream inputs, warnings, and available artifacts.
- Dashboard uses a shared explain query/API rather than duplicating ad hoc control-plane logic.
- CLI JSON explain may exist as an orchestrator/API surface, but human-readable CLI output is secondary.

## Non-Goals

- No graph editing.
- No routing/classification UI.
- No dry-run simulation for proposed runs.
- No replacement for forge show artifacts.
- No attempt to display every config layer directly on the graph canvas.

## Design Notes

Default view should show workflow/execution shape first and details second. Control-plane details belong in a side panel or overlay, not on every canvas node.

Useful layers:

1. Workflow layer: phases, dependencies, fanout, gates.
2. Execution layer: actual tasks, statuses, retries, children, reds.
3. Control-plane layer: workflow source, model/runtime/auth, constraints, route provenance.

Warnings should be prominent in the side panel, for example:

- Project workflow override is active.
- Task predates manifest.json; mount details are inferred.
- Model policy absent; legacy runtime alias resolution used.
- Fanout children were created from plan.steps.

## Acceptance Criteria

- A human can open a run in the dashboard and understand the workflow shape without running a CLI command.
- A human can click any task and see why Forge chose that role/model/runtime/gate.
- Fanout and reds are visually distinguishable.
- Legacy runs degrade gracefully with unknown or inferred labels.
- The same structured explain data is available to the orchestrator as JSON.
- The implementation is read-only from the dashboard query/API perspective; mutating actions remain separate.
