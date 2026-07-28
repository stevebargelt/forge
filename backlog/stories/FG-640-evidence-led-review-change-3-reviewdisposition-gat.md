---
id: FG-640
type: story
status: active
title: "Evidence-led review Change 3: review_disposition gate and feature-workflow migration"
created: 2026-07-28
---

## Problem

Change 3 of `docs/prds/evidence-led-review-lifecycle.md`. With the coordinator proven through
explicit `forge review` (FG-639), authority moves: gate on settled ledger state, migrate the
`feature` workflow off its six authoritative build reds, and retire the interim Change 0 operating
policy and the review-loop default.

## Scope

- **`review_disposition` gate derived from ledger state.** Blocks when: any lens selected by the
  confirmed contract lacks a schema-valid, reviewer-authored discovery outcome for the confirmed
  candidate; any finding is `untriaged`; any finding is `architecture_question`; any
  `rejected_premise` lacks candidate-bound disproving evidence; any `fix_now` finding lacks
  `resolved` recheck evidence at the current sha; any `fix_now` resolution lacks the evidence its
  original reachability requires; deterministic verification is absent or red; shipping review
  reports an unmet/unproven AC; reviewed-tip trust is not equality with the fetched remote head.
  Does NOT block on: a raw advisory red `fail` whose findings are dispositioned; settled
  `accepted_risk`/`deferred`/`rejected_premise`/`duplicate`; historical verdicts against superseded
  SHAs. An absent lens clears only by retrying it, amending the contract through its approving
  authority, or an authorized risk acceptance naming the missing evidence. Evidence-led workflows use
  `awaiting_gate` with the explicit gate kind — no new task status. `--force` is not the ordinary
  settlement path.
- **`feature` migration:** the six authoritative build reds become `authority: specialist` /
  `gate_on_verdict: false` under `review_mode: evidence_led`; risk-targeted lens selection from the
  plan-gate-approved contract (not all discipline reds per feature); explicit cutover, not implicit
  command behavior; exactly one `review_mode` per run; authority models never combined within one
  run; legacy workflows keep `verdict`/`blocked_by_red` until migrated; keep the coexistence window
  short.
- **Shipping reviewer formalized** to the six enumerated duties (AC→evidence mapping, verification
  presence, ledger settlement, identity continuity, contract coverage, ticket-required
  docs/closeout gaps); free-form late findings become ledger findings with normal disposition and no
  special authority from lateness.
- **Skills/seeds updated:** orchestrator seed + rendered block (the interim Change 0 policy text is
  REPLACED by the evidence-led default — Change 0 was explicitly temporary until this ships;
  seed/render parity maintained), red seeds, fixer, review skills. `forge review-loop` emits a
  deprecation note naming `forge review`, retains its old `--max-rounds` semantics until removal, and
  stops being the documented default.
- **FG-541 evidence mapping (REQUIRED — operator amendment 2026-07-28).** Map each FG-541
  requirement to the mechanism in this lifecycle that satisfies it, each with durable evidence (the
  enforcing code/test/gate condition, cited):

  | FG-541 requirement | Satisfying mechanism (cite code/test when shipped) |
  |---|---|
  | Local-only fixer commits | FixBatch fixer output confined to the task workspace/branch; publication only through Forge's publication path |
  | No silent publication of unrelated work | Fixer scope guard + candidate/gate/receipt/publication identity continuity (shipping check 6) |
  | Exact-head CI | Deterministic verification bound to the exact candidate sha (covering-evidence semantics; pending/absent never covers) |
  | Trusted-tip equality | Shipping check 5 and the gate condition: reviewed sha equals the fetched remote head |

  FG-541 is annotated folded-into/blocked-on THIS ticket now (annotation applied at filing). It may
  be marked superseded ONLY once this mapping is durable — every row citing a shipped, enforcing
  mechanism with evidence — not merely because this ticket was filed.

## Acceptance criteria

PRD scenarios as tests: #16 (`feature` selects only declared risk lenses), #17 (shipping review
cannot pass with an unmet/unproven AC even when the ledger has no open findings), #18 (clean ledger +
green deterministic verification + trusted-tip equality advances without `--force`), #21 (one
crashed selected lens keeps the gate blocked — no reviewer-authored outcome exists for it), #22
(reviewer-authored `inconclusive` counts as completed discovery but must be dispositioned; a
synthesized inconclusive does not count), #23 (implementation drift beyond approved lenses requires
contract confirmation/amendment, never path-guessing), #27 (coordinator may add a lens with recorded
evidence; cannot remove one or change the threat model without the original approving authority).

Plus: the FG-541 evidence-mapping table complete with citations to shipped mechanisms; the interim
Change 0 policy text replaced by the evidence-led default in the orchestrator seed + rendered block
with parity verified; migration-safety bullets hold (one `review_mode` per run; no combined
authority in one run).

## Non-goals

Removing legacy verdict history; rewriting every workflow in this release; reviewer performance
scoring; a learned or file-path risk classifier.

## Dependencies

Blocked on FG-639. Gates the supersession of FG-541 (annotated folded-into/blocked-on now; closed
only when the evidence mapping is durable).
