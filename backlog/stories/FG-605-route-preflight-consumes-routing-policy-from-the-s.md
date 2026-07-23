---
id: FG-605
type: story
status: active
title: route preflight consumes routing policy from the seed generation (not flat routing-policy.yml)
created: 2026-07-23
---

## Problem
`forge new` / `forge invoke` run a RACI route-preflight (raci/project.ts resolvePolicyPath → route-preflight.ts) that resolves the HOST routing policy from the flat ~/.forge/routing-policy.yml. After FG-583 (host seeds published as one atomic generation, no flat dispatch fallback), the routing-policy.yml is ALSO published inside the generation. On a fresh/interrupted (no-complete-generation) host the route preflight can therefore validate an operator-selected route against a flat policy set that never shipped with the workflow/runtime generation — a dispatch-ADJACENT gap.

## Why this is a follow-up, not part of FG-583
FG-583's core invariant — every consuming DISPATCH observes one complete seed generation — is delivered by the loader's single-refusal point; the actual dispatch already refuses on a no/incomplete generation. The route PREFLIGHT is dispatch-adjacent (route-key validation), not the seed-surface dispatch itself. An in-ticket attempt to make resolvePolicyPath consume from the generation regressed the existing `routingGovernance` route-matrix behavior; it was reverted to baseline to keep FG-583 scoped to its own invariant. This is a standalone improvement, NOT a child of FG-572/FG-561 and NOT a prerequisite for the durable-orchestration foundation.

## Goal
Make the route preflight consume the routing policy from the anchored seed generation (project override still wins), inheriting the same named no-complete-generation refusal rather than reading the flat file — WITHOUT regressing `routingGovernance` / the host-default route matrix. Add a regression test that a no-generation host refuses the preflight AND that the host-default governance matrix still resolves correctly when a generation is present.

## Acceptance Criteria
- resolvePolicyPath (raci/project.ts) resolves host policy from the held seed generation when one is anchored; project override always wins.
- A no-generation host fails the route preflight closed (named state) rather than reading flat routing-policy.yml.
- routingGovernance / host-default route-matrix tests still pass (the regression that caused the revert must not recur).
- Covers both the with-generation governance path and the no-generation refusal path.