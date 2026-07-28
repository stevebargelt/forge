---
id: FG-541
type: story
status: active
title: Design review-loop fixer-commit publication and CI handoff policy
created: 2026-07-12
---

## Relationship to the evidence-led review lifecycle (2026-07-28)

The local-only fixer evidence below remains valid, but this ticket must not be
designed or implemented as an independent expansion of `review-loop` while
`docs/prds/evidence-led-review-lifecycle.md` is under confirmation.

That PRD makes the interim use of `review-loop --max-rounds 1` discovery-only:
it creates no fixer commit to publish. In the target lifecycle, immutable
FixBatch delivery, deterministic verification, trusted-tip equality, and
publication receipts own the relevant handoff and authority instead.

**DECIDED (operator, 2026-07-28): FOLDED INTO / BLOCKED ON FG-640.** The PRD is confirmed; Change 0 (interim policy) is active; the implementation decomposition is FG-638 → FG-639 → FG-640. FG-640 carries a REQUIRED evidence mapping for this ticket’s requirements — local-only fixer commits, no silent publication of unrelated work, exact-head CI, trusted-tip equality — each row citing the shipped enforcing mechanism. Do NOT design or implement FG-541 independently. Mark it superseded ONLY once that mapping is durable (every requirement mapped to a shipped mechanism with evidence), not merely because FG-640 was filed. Until then, only correctness, recovery, or evidence-preservation fixes to the legacy loop are in scope; no new push authority under FG-541.

## Problem

The 2026-07-12 handoff attributed six `review-loop: CI unavailable` fallbacks to a race where a just-pushed SHA had not registered GitHub checks. Investigation disproved that cause.

The six SHAs (`17087bd`, `afce93d`, `2e701f6`, `8a652ad`, `5bc8ae2`, `c77c9a4`) were all round-one fixer commits created by review-loop itself. At the next-round CI probe every review report identified its SHA as local-only and not reachable from `@{u}`. GitHub could not register checks for commits it had never received. Historical GitHub check records appeared only after the loop stopped and the branch was subsequently pushed.

The code exposes the mismatch: `src/cli/commands/review-loop.ts` runs fast verification, commits the fix, and returns without a push (`:850-867`), while the adjacent comment claims "the fixer's commit gets pushed and CI runs test:extended." The next round probes CI for local-only HEAD, reports generic `CI unavailable`, repeats local verification, delegates extended verification to CI that cannot yet exist, and can never become closeable until an operator pushes and starts another loop.

This is genuine throughput and operator-contract friction, but adding a CI-registration grace period would not fix it. Forge needs an explicit publication policy first.

## Goal

Decide and document who may publish review-loop-created fixer commits, then specify an implementation that gives the next round honest verification and closeability semantics without silently expanding network or branch authority.

## Acceptance Criteria

- [ ] Reconstruct the six-run evidence above and preserve the corrected conclusion: local-only fixer commits, not a check-registration race.
- [ ] Compare at least: automatic push to an existing tracking branch, an explicit `--push-fixes`/policy opt-in, and preserving no-push behavior with an intentional operator handoff.
- [ ] State the authority and safety contract for any push option: no force push, no branch creation by guess, no push from a detached HEAD, exact expected remote/tracking branch, clean-tree requirement, bounded failure behavior, and no closeable claim until fetched remote-head equality plus required CI are proven.
- [ ] Define behavior when the branch contains pre-existing local commits in addition to the review-loop fixer commit; Forge must not silently publish unrelated work.
- [ ] If no-push remains supported, define an explicit `local_only` verification outcome and next action. It must not be mislabeled as generic CI unavailability or claim extended coverage was delegated to CI.
- [ ] Determine whether the fixer's successful pre-commit fast verification can be reused in the immediately following round without rerunning the same commands, while still withholding full closeability until required CI covers the published exact head.
- [ ] Resolve the stale source comment that currently claims the fixer commit is pushed.
- [ ] Produce a written decision and a separately executable implementation scope. No production push behavior changes under this design ticket alone.

## Non-Goals

- Do not implement a blind registration delay; it cannot make CI exist for a local-only commit.
- Do not weaken exact-head CI, reviewed-tip equality, or closeability requirements.
- Do not grant review-loop force-push authority.
- Do not silently publish commits merely because review-loop created the newest one.
