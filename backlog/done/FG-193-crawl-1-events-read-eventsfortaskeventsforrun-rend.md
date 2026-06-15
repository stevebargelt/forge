---
id: FG-193
type: story
status: done
title: "Crawl 1 — events-read: eventsForTask/eventsForRun + render timelines in forge show"
---

**Closed:** 2026-05-29.

Crawl milestone, step 1 of 5 (see docs/observability.md, Crawl section). The keystone — do this first; the rest of Crawl is worthless until it lands.

**The problem this fixes:** forge's events table is WRITE-ONLY. logEvent is the only accessor in src/store/events.ts; nothing — not forge show, status, watch, or the dashboard — ever reads it back (verified: zero `FROM events` queries in src/). Forge faithfully records ~12 event types from a dozen call sites into a table no command can display.

**Scope (deliberately minimal — no schema, no new emissions):**
- Add read accessors to src/store/events.ts: eventsForTask(taskId) and eventsForRun(runId).
- Render timelines in src/cli/commands/show.ts: for a task, its lifecycle events (+ relevant run-level + verdict events) in timestamp order; for a run, run lifecycle + task events as one ordered timeline.
- Add --json output (orchestrator-consumable).

**Acceptance:**
- forge show <task-id> displays an event timeline from existing data.
- forge show <run-id> displays a run timeline (NOTE: show currently only accepts task ids — this also requires the run-id branch; coordinate with Crawl 4 which grows the run-id detail view. Minimal here = timeline; rich diagnostics come in Crawl 4).
- No schema change. No new event emissions.

Foundation for Crawl 2 (backfill — the new events need a surface to appear on) and Crawl 4 (detail view). Blocks both.