---
id: FG-587
type: story
status: done
title: closed-ticket PRD checklists still say reinstall via install-seeds.sh overwrites authored seeds — a silent no-op since FG-578
created: 2026-07-17
closed: 2026-07-17
closed_commit: d9dacbb
---

**Surfaced by:** FG-578's docs reconciliation, 2026-07-17 (run
`run-fg-578-docs-force-retains-operator-authored-seeds-f7b52e`). The maintainer deferred these deliberately
and listed them precisely rather than silently skipping — this ticket captures that handoff.

## The drift

FG-578 made `agents/`, `constraints/`, and `forge-raci.md` **create-only** under `FORCE=1` — installed when
absent, retained when present. Several **closed-ticket PRD implementation checklists** still instruct
"reinstall via `./scripts/install-seeds.sh` after editing" an agent/constraint/red seed. For an
already-installed authored seed that reinstall is now a **silent no-op** — the edit does not land.

Exact locations (verified):
- `docs/prds/reds-evidence-anchored-147.md:86` — reinstall after editing the red seeds (constraints)
- `docs/prds/reds-evidence-anchored-147.md:169` — "all 5 red seeds get the new section. Reinstall seeds."
- `docs/prds/build-fanout-discipline-139.md:79` — `install-seeds.sh` to copy into `~/.forge/agents/tech-lead/`
- `docs/prds/build-fanout-discipline-139.md:112` — reinstall after editing the tech-lead agent seed
- `docs/prds/build-fanout-discipline-139.md:172` — reinstall after editing `seeds/agents/tech-lead/CLAUDE.md`
- `docs/prds/build-fanout-discipline-139.md:194` — implementation-order "Reinstall seeds" step

## The actual question (why this is a ticket, not an auto-fix)

These are **historical build records for shipped tickets**, not living how-tos. The living guidance
(`how-to-upgrade.md`, `how-to-new-agent.md`, `work-laptop-setup.md`) is already correct as of FG-578. Two
defensible options:

1. **Add a one-line superseded note** at each PRD's affected step pointing at the FG-578 policy — preserves
   the historical record while stopping a reader from following a now-broken step. (Precedent: design records
   that predate a split carry a supersession banner at the TOP of the document.)
2. **Leave them** — they are closed-ticket archives; a reader editing seeds today consults the how-tos, not a
   shipped PRD's checklist.

Recommendation: option 1, a top-of-document banner on each of the two PRDs (not inline per-line edits), since
the checklists are numerous and a document-level banner is what a reader landing mid-file will and won't see.
This is durable-docs work → documentation-maintainer, not orchestrator-direct.

## Acceptance
- Each of the two PRDs either carries a superseded-by-FG-578 banner covering its `install-seeds.sh` reinstall
  steps, or a recorded decision to leave them as archives — not silently unaddressed.
- No living how-to still tells a reader that reinstalling overwrites an authored seed (FG-578's docs pass
  already handled these; this is a verification line).

## Additional instance (found 2026-07-17 by FG-578's whole-corpus premise grep)

- `docs/prds/cross-project-usability-138.md:92, :162, :182` — "reinstall via `./scripts/install-seeds.sh`" /
  "Reinstall seeds" steps after editing seeds, including an orchestrator-template rewrite. PRD 138 is **closed**
  (FG-138 done). For the authored categories (`agents`, `constraints`, `raci`) this reinstall is now a no-op —
  same class as the 147/139 checklists above. Fold into the same banner decision.

So the closed-PRD set carrying now-partially-no-op `install-seeds.sh` reinstall steps is:
`reds-evidence-anchored-147.md`, `build-fanout-discipline-139.md`, `cross-project-usability-138.md`.