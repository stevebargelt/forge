---
id: FG-275
type: story
status: done
title: "RACI policy Story 2: define routing-policy schema"
---

**Closed:** 2026-06-04.

**Epic:** #273. **PRD:** `docs/prds/raci-routing-policy.md`.

Add a typed schema for the DERIVED `routing-policy.yml`.

Acceptance:
- Schema (`src/raci/policy-schema.ts`, Zod) for the DERIVED `routing-policy.yml`: top-level `version` + `governance.accountable` (literal `human`) + `routes` (record keyed by route-symbol). Per route: `classification_hints?` (non-empty strings), `responsible` (symbol = dispatch target; no separate target/workflow field), `path` (enum), `command` (required iff `path: cli`), `consulted` / `required_followups` / `force_rules` (symbol lists), `informed` (normalized objects `{name, when?}`).
- `accountable` is a policy-HEADER invariant fixed to `human` — NOT a per-route field. `.strict()` rejects a per-route `accountable`.
- `informed` is normalized object form in the policy (`{name, when?}`), never the source's `name:when=cond` string. `none` is a RACI-SOURCE sentinel only — the policy uses empty arrays, and `none` inside an array is rejected.
- `path` is a controlled enum; symbol fields use the #274 symbol grammar (SHAPE only). Semantic resolution — do force_rules / responsible / consulted resolve to baseline IDs / installed agents — is deferred to #277/#278.
- Tests cover: valid minimal policy; header accountable invariant; missing/non-human accountable rejected; per-route accountable rejected; valid CLI route with command; CLI route missing command rejected; non-CLI route with command rejected; empty arrays valid; `none` rejected in arrays; classification_hints shape (non-empty strings, spaces allowed); informed normalized-object shape (bare string + empty `when` rejected); malformed symbols + route keys rejected; unknown path rejected; version must be 1.

Relations: #273.