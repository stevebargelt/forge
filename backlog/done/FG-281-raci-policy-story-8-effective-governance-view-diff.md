---
id: FG-281
type: story
status: done
title: "RACI policy Story 8: effective governance view / diff preview"
---

**Closed:** 2026-06-05.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Render a READ-ONLY effective-governance view and change-preview diff FROM the RACI source plus its generated policy — surfacing what the current RACI compiles to (and what a proposed edit would change), so the table a human reads can't silently lie about what the policy does.

Acceptance:
- The view is generated from RACI + compiled policy; it NEVER writes back to the RACI. Direction stays RACI -> policy, never policy -> RACI.
- Shows the effective routes a human reads as a governance table.
- Powers the diff the orchestrator-mediated channel (Story 6) shows before a human confirms.
- Tests cover render-from-source and a representative proposed-edit diff.

Relations: #273.