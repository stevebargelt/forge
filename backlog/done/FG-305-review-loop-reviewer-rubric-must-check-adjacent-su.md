---
id: FG-305
type: story
status: done
title: "review-loop: reviewer rubric must check adjacent surfaces (stale closeout text, all log_formats, activated paths)"
---

**Closed:** 2026-06-07.

**Type:** review-loop reviewer-prompt/rubric hardening (no loop-mechanic change). Follows #302 / the earlier two rubric passes.

**Problem:** the bounded review-loop works, but the Codex reviewer keeps missing adjacent-system regressions a human catches. Recent misses:
- #198: stale Done/backlog closeout text still read "Deferred — not urgent" after close.
- #200: humanizer fixed claude stream-json but missed codex-jsonl, even though the Codex reviewer path is now the active review-loop reviewer.
- Prior: stale comments/docs/fixtures and runtime/provider adjacent behavior.

**Goal:** teach the reviewer brief to check beyond literal ticket acceptance. Add rubric requirements:
1. Committed backlog/docs CLOSEOUT text — flag stale status language (Deferred / not urgent / TODO / future-tense plans) once a ticket is closed.
2. Adjacent runtime/provider FORMATS when a helper is applied generically — inspect ALL currently supported log_format values, not just the one named in the ticket.
3. Recent project context — if a recently activated path exists, include it in the regression matrix (e.g. the Codex reviewer path is now active → show/log/usage/runtime changes must consider codex-jsonl).
4. Comments, seed text, fixtures, ADR/backlog wording — flag stale claims.
5. Reviewer must NAME the concrete matrix it considered: affected runtime kinds, log formats, auth modes, CLI modes, docs/backlog surfaces (as applicable).
6. If an adjacent format/surface is not inspected, the reviewer must explicitly say why it is out of scope.

**Acceptance:**
- The reviewer task prompt includes this broader adjacent-surface rubric.
- A pure guard asserts the prompt names: stale closeout text, the supported log_format/runtime matrix, recently-activated paths, and comments/docs/fixtures.
- No loop-mechanic change. Codex stays the reviewer profile — this is prompt/rubric hardening only.