---
id: FG-248
type: story
status: done
title: "Handoff notes drift: /handoff + /orient never reconcile ticket refs against backlog Active/Done + git"
---

**Closed:** 2026-06-02. Commit `5387cd8`.

**Recurring process bug (observed across projects — LiveBig, and live in the forge session 2026-06-02).** The handoff notes block lists tickets under "Picked up next" that have already merged and dropped off the active list (e.g. LiveBig #24 `c51b9dd`, #26 `ca5540c`). Because forge uses the notes block as start-of-session operating context, the orchestrator re-scopes or duplicates already-shipped work. Same class of bug as the docs-drift arc (#236–242): present-but-wrong prose vs. ground truth — except here the stale artifact is the handoff itself.

**Root cause: the notes are a hand-maintained denormalized cache of state that is authoritative elsewhere (backlog Active/Done + git merge commits), and nothing reconciles the cache.**

Neither end of the session loop does the join:
- **/handoff (write side)** fetches `forge backlog list --status done | head -30` — so it KNOWS what merged — but its instruction is "draft 2-3 starting moves," not "cross-check each ticket against Done + git merges and drop the ones that landed." No reconciliation step. The `head -30` cap can also hide an older merge.
- **Close→notes are two separate manual acts.** `forge backlog close` moves a ticket but does NOT touch the notes' priority list (reproduced this session: #246 closed via CLI but stayed in "Picked up next" until a reviewer caught it). /handoff is supposed to re-sync — but from the author's memory, not a mechanical diff.
- **/handoff explicitly defers correctness to /orient** ("If the synthesis is wrong, they'll catch it in the next session's /orient") — but **/orient's only staleness check is structural** ("notes block missing a 'Picked up next' section"), never semantic. It prints the active list AND the notes' priorities side-by-side but never JOINS them. The intended safety net has no check wired; it offloads to the human's eyeballs, which is exactly the reconciliation that gets skipped.
- **"Picked up next" conflates two content kinds**: tickets (status authoritative elsewhere → should be derived/validated, not hand-copied) and non-ticket threads (e.g. "LiveBig live-game hardware verification, which isn't a ticket" → the notes genuinely OWN these). They share one prose blob, so the load-bearing non-ticket thread hides among stale ticket refs.

**Ground truth (skills verified 2026-06-02):** source copies at `scripts/claude-commands/{handoff,orient}.md` install to `.claude/commands/`. A fix edits the source.

---

**Fix direction A — reconciliation at both ends (cheap, additive, kills the symptom directly).** Both skills already hold the needed data.
- /orient: extract `#\d+` from "Picked up next", join against `forge backlog list --status active` + recent merge commits; flag mismatches under **Needs attention** ("notes list #24 as next, but merged `c51b9dd` and off active"). Turns the toothless structural check into a real one.
- /handoff: before writing a ticket into "Picked up next", verify it's still Active with no merge commit; route landed ones to "Shipped" instead.
- No format change, no migration. Catches the actual failure (stale ticket STATUS).

**Fix direction B — structural "derive, don't denormalize" (correct in principle, but costs more than it looks).** Make "Picked up next" carry only a live-rendered pointer to the prioritized backlog + the non-ticket threads/narrative.
- **Hidden cost: the backlog has NO priority model today.** The Active section is ordered by sticky number (filing order), not priority — the "Picked up next" prose is currently the ONLY place priority ordering is expressed. Deriving the list means INVENTING a priority signal (section position, a `priority:` field, or a tag) in a markdown format #174 already flags as fragile to parse/edit.
- **Can't fully eliminate the prose.** The notes' real value is the per-item *next-move reasoning* ("precondition for #242's verdict gate; precision path in <ADR>; re-measure after") — not derivable from `forge backlog list`, which gives titles only. So B becomes a HYBRID: derived list + hand-written reasoning + non-ticket threads. More moving parts, plus a seam between derived and hand-written content.
- **Format change → cross-project migration** of every project's notes block + both skills co-evolving.

**Recommendation:** A first (directly addresses the drift symptom, zero migration). Treat B as a separate, larger effort gated on a real backlog priority model — and note B's "derive" only removes ordering duplication, while A removes the status drift that's actually biting. They're not lesser/greater versions of the same fix; they address different parts. Decision pending (see session discussion).

**Relation:** symptom-sibling to the docs-drift arc (stale prose vs ground truth). Touches #174 (fragile notes/backlog parser) as a headwind for any structured-field approach.