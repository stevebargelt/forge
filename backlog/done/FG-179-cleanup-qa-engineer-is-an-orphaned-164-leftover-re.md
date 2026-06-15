---
id: FG-179
type: story
status: done
title: "Cleanup: qa-engineer is an orphaned #164 leftover — remove seed + fix stale docs (pipeline verify is test-engineer now)"
---

**Closed:** 2026-06-03. Commit `ebf919d`.

**Leftover from #164** (closed), which moved the pipeline verify phase from `qa-engineer` to `test-engineer` and intended to "rework qa-engineer -> manual-qa (rename or deprecate)" + "update workflow definitions referencing qa-engineer." The workflows were updated (all three `feature*.yml` now use `agent: test-engineer` for verify), but the deprecation tail was left:

- `seeds/agents/qa-engineer/` seed dir still exists (no current workflow references it; confirmed via grep).
- `docs/quick-start.md:147` still says the pipeline verify phase is `qa-engineer` — stale, should read `test-engineer`.
- `docs/SCHEMA-CONTRACT.md:109` still documents a `qa-engineer` role.
- (Historical PRD drafts under `docs/prds/yaml-orchestrator-116/` also mention it — those are frozen design docs, leave as-is.)

**Why it matters:** orphaned seeds + stale docs are exactly the contract-vs-behavior drift this session keeps surfacing — a future session reading quick-start would think verify is qa-engineer, contradicting the workflows + the orchestrator template. Old pipeline runs in the DB show `qa-engineer` verify tasks writing 0 test files; that role is dead in the current pipeline.

**Fix:** remove the `qa-engineer` seed dir (or, if any value remains, fold it into `manual-qa` per #164's intent), update `quick-start.md:147` and `SCHEMA-CONTRACT.md:109` to `test-engineer`. Small, isolated, docs + seed only.