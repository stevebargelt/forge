---
id: FG-113
type: story
status: done
title: "Promote specialist reds to authoritative (gateOnVerdict: true)"
---

**Closed:** 2026-05-12. Specialist `additional[]` reds (red-frontend / red-backend / red-security) now inherit RedConfig.authority + gateOnVerdict like wide/narrow do. A fail blocks the gate via `blocked_by_red`; override is the existing `--force --rationale` path.

**Shape that shipped:** Path A from the planning conversation — minimal, reversible, no schema change.
- `src/spine/spawnRed.ts` — extracted `buildLaunchPlan(redConfig)` as a pure exported function. All reds in a RedConfig (wide / narrow / additional) get the same authority + countsTowardGate: true. Pre-#113, `additional` was hardcoded `specialist` / countsTowardGate: false.
- `src/types/index.ts` — RedConfig.additional doc comment rewritten to reflect new gating semantics.
- `src/workflows/feature.ts`, `feature-ui-design-needed.ts`, `feature-ui-design-provided.ts` — comments updated; no structural change (RedConfig was already `authority: "authoritative"` + `gateOnVerdict: true`).
- `seeds/agents/red-{frontend,backend,security}/CLAUDE.md` — reworded from "specialist red, informational" to "discipline red, fail blocks the gate." Tone matches red-wide/red-narrow.
- `src/spine/spawnRed.test.ts` — new file, 5 unit tests against `buildLaunchPlan` (inheritance for additional[], specialist-authority workflows still propagate specialist, empty/missing wide-narrow cases).
- `src/workflows/specialistSeeds.test.ts` — assertion flipped from "CLAUDE.md says `gateOnVerdict: false`" to "CLAUDE.md self-identifies as discipline red + says fail blocks the gate."

**Forward-only.** Legacy verdicts in the DB still carry `authority: 'specialist'`; the dashboard's #110 specialist-fail-rationale path remains intact for them. New runs write `authority: 'authoritative'` for discipline reds and trip the `blocked_by_red` + force-advance UI instead. The two paths coexist; no migration.

**What's still load-bearing:** the `RedAuthority` type's `specialist` value, `gate.ts`'s `aggregateVerdicts` specialist-fails branch, and the dashboard's `v.authority === 'specialist'` checks all remain — they handle legacy verdicts and leave room for future non-gating reds (e.g. triage). Cleanup of that branch is a Path B future task, not filed yet because it's only worth doing once legacy verdicts have aged out.

**Verification.** 346/346 tests passing (5 new), typecheck green. Real end-to-end verification needs a feature run where a discipline red fires — first occurrence will exercise the `blocked_by_red` + dashboard force-advance flow.

**Tests of note still asserting old behavior:** the four #110 tests in `gate.test.ts` (`gate=human advance with specialist fail requires rationale`, etc.) still pass because they manually insert verdicts with `authority: 'specialist'` — that path is still real for legacy data, just not how new specialists are recorded. Intentional.

### Active-cleanup pass 2026-05-12 — 8 stale entries closed
End-of-session sweep before a Claude upgrade. Each entry is genuinely dead or shipped:

- **#85 — Graph view as a separate screen.** Parent of all the GRAPH: work that followed. #98 / #100 / #101 / #102 / #103 / #105 all came out of this. The original parent is dead; its children carry the work.
- **#53 — prompt-author agent seed + ui-design template.** Shipped. `seeds/agents/prompt-author/CLAUDE.md` + `seeds/agents/prompt-author/templates/` exist. Validated empirically (note in the original entry confirmed this on 2026-05-07).
- **#45 — `forge auth status` warns on stale bedrock vars.** Functionally shipped by #97 — the dashboard auth-mode popover renders the bedrock token's expiry timestamp + remaining time + amber/red health dot when stale. The original framing (a CLI flag) was made redundant by the always-on indicator.
- **#39 — Audit the spawn → DB pipeline for missing fields.** Meta-task from 2026-05-08 that said "run an audit someday after #32/#38/#27 land." Never materialized into action. If a specific missing field comes up, file that directly; "do an audit" was perpetually-deferrable.
- **#49 — Design-reviewer red agent (future investigation).** Predicated on FORGE-DEC-014-killed assumptions about the in-container designer. Re-evaluate when host-led-Pencil generates evidence worth catching.
- **#50 — React Native code export from Pencil .pen files.** Dependent on the container-designer (#46) that FORGE-DEC-014 killed. Dead-parent → dead-child.
- **#51 + #51b — design-reviewer agent: visual diff implemented UI vs design artifact.** Same FORGE-DEC-014 problem: the artifact pair (`pngFiles` + `htmlFiles`) the agent was supposed to consume comes from the killed `#46` container-designer flow. Worth revisiting once the host-led-Pencil + prompt-author flow has produced a few real design corpora that could feed a different reviewer shape.
- **#52 — Browser DevTools error capture.** Tied to #51's Puppeteer-Core CLI scripts. Same FORGE-DEC-014 dependency. If a forge workflow ever needs "did the page render without errors" as a check, file fresh.

Active dropped from 36 → 28.