---
id: FG-240
type: story
status: done
title: "Docs drift — Crawl 5: prototype L2 changed-primitive grep; MEASURE noise before enforcement"
---

**Closed:** 2026-06-02. Commit `c96296e`.

Prototype a check that, for primitives changed in a diff, greps docs/ seeds/ learnings/ for stale mentions and surfaces them as findings — the highest-leverage drift detector (literally what was done by hand 5x this session). Self-maintains the "likely-affected doc paths" (no static surface->docs map to rot).

HIGH-SIGNAL primitives ONLY (no giant keyword list):
- command names: `forge notify milestone`, `forge model resolve`, `forge providers doctor`
- flags: --profile, --auth-profile, --notify-policy
- schema fields: activity:, runtime:, model-policy.yml, allowed_profiles
- event names: orchestrator.milestone, model.profile_resolved
- runtime names: codex-subscription, claude-bedrock

AVOID broad terms (model, test, run, auth, workflow) unless paired with a known namespace / nearby token.

MEASURE the false-positive rate first. Do NOT wire it as an enforcing gate until precision is proven — prototype + report noise, then decide.