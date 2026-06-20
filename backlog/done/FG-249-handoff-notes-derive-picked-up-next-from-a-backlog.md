---
id: FG-249
type: story
status: done
title: "Handoff notes: derive 'Picked up next' from a backlog priority model instead of hand-listing (Fix B, gated)"
closed: 2026-06-20
---

**Follow-on to #248 (Fix A shipped in 5387cd8).** Fix A added reconciliation so /orient + /handoff catch stale ticket refs in the notes. This is the structural alternative discussed alongside it: stop hand-listing tickets in "Picked up next" at all — render them live from the backlog so they cannot drift ("derive, don't denormalize").

**Why it is gated, not done now:** the backlog has NO priority model today. The Active section is ordered by sticky number (filing order), not priority — the "Picked up next" prose is currently the only place priority ordering is expressed. So "render the list live" first requires INVENTING a priority signal (section position, a `priority:` field, or a tag) in a markdown format #174 already flags as fragile to parse/edit. And the notes' real value is the per-item next-move reasoning (e.g. "precondition for #242's verdict gate; re-measure before enforcing"), which `forge backlog list` can't produce — it returns titles only. So B necessarily becomes a HYBRID: derived ranked list + hand-written per-item reasoning + non-ticket threads, plus a cross-project notes-format migration and both skills co-evolving.

**Prerequisite (file/scope first):** a backlog priority model — a way to express + read ticket priority order independent of sticky number. Without it, B has nothing to derive from. Once it exists, the /orient + /handoff change to render-live is small.

**Decision (session 2026-06-02):** ship A (done), park B behind the priority-model prerequisite. A removes the status drift that was actually biting; B only removes ordering duplication. Revisit if drift persists despite A.

**Relation:** follow-on to #248; blocked-on a not-yet-filed backlog-priority-model ticket; touches #174 (fragile notes/backlog parser).