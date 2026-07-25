---
id: FG-615
type: story
status: done
title: "docs drift: 'strip the stale closed:/closed_commit: frontmatter' reopen instruction is wrong since FG-409 (moveTicket already strips it) — in SKILL.md, orchestrator-template.md, and every rendered CLAUDE.md"
created: 2026-07-25
closed: 2026-07-25
closed_commit: 58b6b68
---

## The drift

Three places tell the operator that reopening a ticket leaves stale frontmatter behind that must be hand-stripped:

- `seeds/skills/forge-backlog/SKILL.md:69`
- `seeds/orchestrator-template.md:370` — the SOURCE
- `CLAUDE.md:460` in this repo, and the same rendered block in **every project forge has init'd**

All three say: "reopen a ticket: `forge backlog move <id> story`, then strip the stale `closed:`/`closed_commit:`
frontmatter the move leaves behind."

**That is wrong.** `moveTicket` destructures `closed` / `closedCommit` out itself in BOTH modes —
`src/backlog/structured.ts:457` (markdown) and `:727` (db) — so there is nothing left to strip. The instruction
sends an operator to hand-edit a ticket file that is already correct, which is worse than silence: it invites a
manual edit to the one surface the `forge backlog` CLI exists to keep people out of.

Pre-existing drift dating from FG-409; found by the documentation-maintainer during FG-607's docs phase and
deliberately left out of that pass to keep it scoped.

## Scope

- Fix `seeds/skills/forge-backlog/SKILL.md`.
- Fix `seeds/orchestrator-template.md` — this is the ORCHESTRATOR-POLICY surface, so the edit goes in the SEED and
  is then re-rendered with **`forge-dev upgrade`** (not `forge upgrade`, which resolves the template from the
  executing forge and would install a release's copy instead — FG-577). Editing `CLAUDE.md:460` in place is wrong:
  it sits inside the `<!-- forge:orchestrator-start/end -->` block and the next render overwrites it.
- Verify the rendered `CLAUDE.md` in this repo picks up the corrected text after re-render.
- Other projects pick it up on their next `forge upgrade`; no cross-project sweep needed.

## Also found in the same pass (fold in only if cheap — otherwise split)

`learnings/README.md:24-45` — the decisions index table stops at FORGE-DEC-025, but FORGE-DEC-026
(`learnings/decisions/serialized-integration-publisher.md`) and FORGE-DEC-027
(`learnings/decisions/2026-07-13_awaiting-recovery-task-status.md`) exist as files with no index row.

## Acceptance Criteria

- No surface tells an operator to strip `closed:` / `closed_commit:` after a move; the corrected text describes
  what `moveTicket` actually does.
- The fix is made in the SEED and the rendered `CLAUDE.md` is regenerated via `forge-dev upgrade`, not hand-edited.
- The `learnings/README.md` index lists FORGE-DEC-026 and FORGE-DEC-027 (or that is split into its own ticket).

---

## Acceptance Evidence

| AC | Evidence | Verdict |
|---|---|---|
| Fix `seeds/skills/forge-backlog/SKILL.md` | Reopen bullet now reads "the move clears the `closed:`/`closed_commit:` frontmatter itself, so there is nothing to hand-strip" — commit `58b6b68` | met |
| Fix `seeds/orchestrator-template.md` (the SOURCE) | Closing-gate step 4 corrected in the seed, not in the rendered block — commit `58b6b68` | met |
| Re-render with `forge-dev upgrade`, not `forge upgrade` | Ran `./bin/forge-dev upgrade` from the dev checkout (`forge-dev` is not on PATH; it is `bin/forge-dev` per `package.json` bin) | met |
| Verify the rendered `CLAUDE.md` picks up the corrected text | `grep -n "strip the stale" CLAUDE.md` returns nothing; `CLAUDE.md:460` now carries the corrected sentence | met |

Premise verified before editing rather than taken from the ticket: `moveTicket` destructures
`closed`/`closedCommit` out in BOTH modes — `src/backlog/structured.ts:457` (markdown) and `:727` (db).
