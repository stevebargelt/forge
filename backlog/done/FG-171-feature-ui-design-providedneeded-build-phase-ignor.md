---
id: FG-171
type: story
status: done
title: feature-ui-design-{provided,needed} build phase ignores discipline tags — port feature.yml fanout
---

**Closed:** 2026-05-28. Commit `645a523`.

**Caught 2026-05-28** on wnba-led-scoreboard: a `feature-ui-design-provided` run dispatched a single generic `engineer` for the whole build wave. The tech-lead plan tagged each step's discipline (steps 1–4 backend, 5–6 frontend), but the build phase ignored the tags — they rode along as metadata and never routed to frontend-specialist / backend-specialist. CLAUDE.md says the pipeline is "engineer (specialist per step)"; that did not happen.

**Root cause (verified).** The fanout mechanism exists and `feature.yml` uses it — its `build` step has:

    fanout:
      from_upstream: { step: plan, array_key: steps, input_key: step }
      agent_map: { frontend: frontend-specialist, backend: backend-specialist, infosec: security-advisor }

with `agent: engineer` as the fallback for unmapped/general disciplines. The two UI variants were never migrated:
- `seeds/workflows/feature-ui-design-provided.yml` build step (~line 48): plain `agent: engineer`, no fanout.
- `seeds/workflows/feature-ui-design-needed.yml` build step (~line 85): same.

The irony: the UI workflows are exactly where frontend-specialist matters most, and they are the two that don't route to it.

**Fix.** Port feature.yml's build-phase `fanout` block + the per-step `workflow_additions` ("Implement your assigned plan-step (passed via inputs.step)…") into both UI variants. YAML-only, no code change — the FanoutDef schema + runtime are already proven by feature.yml. Reds stay per-parent (review the aggregate diff), same as feature.yml (#139).

**Verify.** Confirm the tech-lead seed emits a `discipline` field per plan step (feature.yml already relies on it). Then a UI feature with mixed steps should fan out: frontend steps → frontend-specialist, backend → backend-specialist, unmapped → engineer.