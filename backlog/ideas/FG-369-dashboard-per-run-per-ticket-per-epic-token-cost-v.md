---
id: FG-369
type: idea
status: active
title: "Dashboard: per-run / per-ticket / per-epic token + cost visibility (surface forge usage rollups)"
created: 2026-06-23
---

**Type:** idea (not yet scoped to a story).

**Motivation:** `forge usage show` already computes token + cache rollups from `model_calls` (grouped by role/workflow/project/model/alias, filterable by --run/--task/--project/--since, with a cache-weighted cost column). But it is CLI-only. Today, answering "how many tokens did FG-350 cost?" required manually enumerating all six FG-350 runs and summing their per-run `forge usage` tables by hand (2026-06-22 session). The dashboard should surface this directly.

**Idea:** a dashboard usage/cost panel that visualizes the `forge usage` rollups:
- Per RUN: token in/out/cache-read/cache-create, request count, cache hit% and reuse, and the weighted (cache-discounted) cost figure — broken down by role (engineer vs reds vs test-engineer vs docs), so you can see where a run's spend went.
- Per TICKET / per EPIC: aggregate across all runs tied to a ticket id or epic (the hard part today — a feature like FG-350 spans many runs: pipeline + quick-chain recovery + accuracy fixes). Requires associating runs with a ticket/epic (run title parsing today is fragile; a first-class run→ticket link would be better).
- A "wasted spend" signal: surface abandoned/failed runs and request-changes retry loops prominently — the FG-350 wedged-pipeline run alone was ~63% of the feature's cost and was abandoned. Making that visible would have flagged the FG-364 deadlock far sooner.

**Fits the control-plane visibility epic** alongside FG-348 (Run Map) / FG-349 (Sources) / FG-359 (RACI Workbench) — likely a new panel in the dashboard Control Plane area. The data layer (`model_calls`, the `forge usage` rollup logic in the usage command) already exists; this is primarily a query/API + panel, plus possibly a durable run→ticket association to make per-ticket aggregation reliable.

**Open questions for scoping:**
- How are runs associated to a ticket/epic? Parse run title (fragile) vs add a `ticketId` to run metadata at `forge new`/`forge invoke` time (cleaner; relates to FG-350 control-plane receipts).
- Cost in dollars vs weighted tokens — does the dashboard apply per-model pricing, or just show weighted tokens?
- Real-time (live run usage) vs post-hoc only.
