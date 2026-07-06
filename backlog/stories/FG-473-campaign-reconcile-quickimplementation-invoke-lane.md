---
id: FG-473
type: story
status: active
title: "campaign reconcile: quick_implementation (invoke-lane) code items can never complete — Fact-5 folding blocks 'no authoritative verdict at all', not just an unresolved fail"
created: 2026-07-06
---

## Problem (found live, campaign-2753b15667d7, 2026-07-06)
A `quick_implementation`-lane campaign item that delivers a **code** change can never be marked `complete` by `forge campaign reconcile` (or `resume`), even when the work is genuinely, fully shipped. Because the campaign completes items sequentially, an incompletable item 0 **wedges the whole campaign** — no later item can dispatch.

Reproduced with FG-472 (campaign-2753b15667d7 item 0, lane `quick_implementation`, run `run-fg-472-a64e47`):
- Ticket closed with `closedCommit` a727063 (merged PR #38), `closedCommit` reachable on base ✓.
- Real host-verification recorded: `forge record-host-verification --ticket FG-472 --gate "npm run test:all" --exit-code 0 --commit a727063` → lane evidence present ✓.
- `forge campaign reconcile` still **refuses**, now on ONLY: `run_evidence:no_authoritative_verdict_or_force_advance_event`.

## Root cause (code-verified)
- A `quick_implementation` lane dispatches an **invoke_chain** (engineer + test-engineer). It has **no reds**, so its run records **zero authoritative verdicts**. The invoke-lane finalize (`src/campaign/executor.ts:~590`) sets only `lifecycleStatus: awaiting_gate` — no verdict, no force-advance event.
- The out-of-band completion path folds in the run's Fact 5 for any item **with a runId** (`src/campaign/reconcile-outofband-evidence.ts:41-52`, FG-458/FG-460 → `authoritativeOutcomeContribution`). Invoke-lane items always have a runId.
- Fact 5 (`src/campaign/reconcile-evidence.ts:249-256`) requires an authoritative verdict OR a qualifying force-advance. A force-advance can only supersede an **existing** authoritative verdict on the same task (evaluator `:170-196`; test `reconcile-evidence.test.ts:351` — "standalone force-advance with ZERO authoritative verdicts → ineligible"). With zero verdicts, Fact 5 is **structurally unsatisfiable**.

Net: `authoritativeOutcomeContribution` over-blocks. Its stated intent (comment at reconcile-outofband-evidence.ts:41) is to prevent shipping over an **unresolved authoritative fail**. But it also blocks `no_authoritative_verdict_or_force_advance_event` — the **normal** state of an invoke lane that never had a reviewer — treating "no objection" as "unresolved".

## Doc/code tension
`docs/concepts.md:572` (FG-460) says an invoke-lane **code** item ships once its ticket is closed with a reachable `closedCommit` and lane evidence (host-verification) exists — Fact 5 is **not** mentioned there. The code additionally requires Fact 5 for any item with a runId. The doc and code disagree for exactly this case.

## Expected behavior
An out-of-band invoke-lane item whose run has **no authoritative verdict at all** (because its lane structurally has no reviewer) should be treated as **no objection** on the authoritative axis — contributing nothing — reserving the Fact-5 block for a genuine **unresolved authoritative fail** (`latest_authoritative_verdict_is_fail_with_no_later_pass_or_force_advance`). Ticket-closed + reachable commit + passing host-verification should then complete the item, matching concepts.md:572.

## Acceptance criteria
- `authoritativeOutcomeContribution` (out-of-band path) folds in an authoritative-fail block, but NOT `no_authoritative_verdict_or_force_advance_event`, when the item's run has zero authoritative verdicts on every task (invoke-lane shape).
- An invoke-lane (`quick_implementation`) item with: ticket closed + `closedCommit` reachable + a passing covering host-verification row, and NO authoritative verdict on its run, reconciles to `complete`.
- An invoke-lane item whose run DOES carry an unresolved authoritative fail is still refused (regression guard — the FG-458 protection is preserved).
- `docs/concepts.md` campaign section reconciled to the shipped rule (no doc/code disagreement for the invoke-lane code case).
- Negative + positive tests through the real reconcile out-of-band path (not just the pure evaluator).

## Evidence / references
- Live refusal: campaign-2753b15667d7, item FG-472, after host-verification recorded → `run_evidence:no_authoritative_verdict_or_force_advance_event` only.
- src/campaign/reconcile-outofband-evidence.ts:41-52; src/campaign/reconcile-evidence.ts:170-196, 249-256; src/campaign/executor.ts:~590; docs/concepts.md:572. Related lineage: FG-458, FG-460, FG-442; sibling reconcile-labeling work FG-431.

## Why it meets the filing threshold
Correctness gap in a campaign trust gate that BLOCKS legitimate campaign completion of shipped work (wedges the whole sequential campaign) — user-visible operator pain, and it blocks campaign-based closeability for the common quick-lane case. Found live, not hypothetical.
