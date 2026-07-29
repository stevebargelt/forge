---
id: FG-639
type: story
status: active
title: "Evidence-led review Change 2: staged review coordinator (forge review pilot)"
created: 2026-07-28
---

## Problem

Change 2 of `docs/prds/evidence-led-review-lifecycle.md`. With the FG-638 ledger durable, the staged
lifecycle needs a coordinator that drives verified-candidate → contract confirmation → discovery →
disposition stop → batch fix → docs → verification → exact recheck + bounded delta → shipping review
→ settled, from persisted state.

## Scope

Pilot through explicit `forge review` ONLY. The `feature` workflow is NOT migrated and no gate
authority changes (FG-640).

- Review-contract validation + persistence (`threat_model`, `protected_invariants`,
  `acceptance_refs`, `risk_lenses`, `non_goals`). The lens vocabulary is resolved directly by the
  coordinator; no generic conditional-workflow language.
- **Stage 1 — deterministic verification entry:** reuse the existing covering-evidence and
  host-readiness machinery. A non-runnable candidate stops `blocked_environment` — no reviewer or
  fixer dispatched, no cycle consumed. A failing verification stops deterministically and is NOT
  converted into a red finding.
- **Stage 2 — contract confirmation + discovery:** confirm the approved contract against the final
  implementation diff; persist `contract_confirmed_sha`. Widening asymmetry: the coordinator may ADD
  lenses with recorded diff evidence; removing a lens or changing
  `threat_model`/`protected_invariants`/`acceptance_refs`/`non_goals` returns to the original
  approving authority; unclassifiable drift returns to plan/architecture; no file-path classifier.
  Parallel read-only lens dispatch against ONE recorded sha. Discovery is complete only when EVERY
  selected lens has a schema-valid, reviewer-authored outcome (`pass`/`fail`/`inconclusive`);
  authored `inconclusive` normalizes to an untriaged `lens_inconclusive` finding; crash / timeout /
  OOM / missing / malformed / synthesized output is NOT completion (carries FG-628's fail-closed
  artifact invariant into the new model). The discovery prompt requires per finding: summary +
  evidence; severity + lens; source anchor; affected AC/invariant; reachability
  (`demonstrated`|`supported`|`speculative`); contract-challenge flag; remediation explicitly marked
  as advice. Anchor validation as today; invalid anchored findings stay visible as rejected evidence.
- **Stage 3 — normalization/deduplication:** dedup only when observations name the same anchored
  mechanism AND the same affected invariant; every source reviewer/verdict is preserved as
  provenance; correlated sources never become an "independent review count"; keep both when unsure
  (false separation is cheaper than a silent merge).
- **Stage 4 — disposition stop** (uses FG-638's CLI and authority rules).
- **Stage 5 — FixBatch (PRD Appendix A):** `fix_batches` + `fix_batch_results` tables; a batch is
  immutable at a revision (a changed disposition or candidate creates a NEW revision; a running task
  stays bound to its recorded revision); ONE fixer dispatched with the batch ID and a hash-verified
  materialized input bundle (payload verified against the persisted hash before container start);
  result ingestion validates schema + batch identity, requires exactly one result per expected
  finding ID, and rejects unknown/duplicate/omitted IDs; agents never write the host DB. Delivery is
  at-least-once; ingestion is idempotent. The existing scope guard remains; a scope-changing
  conflict returns to disposition.
- **Stage 6 — guaranteed docs reconciliation BEFORE final verification** (docs may change the
  candidate; recheck evidence must not bind to a pre-docs sha).
- **Stage 7 — final deterministic verification** at the final candidate.
- **Stage 8 — exact recheck + bounded remediation-delta review** by a NEW `review-rechecker` role
  (seed): receives every fix_now ID + original evidence, the fixer's per-finding evidence, the
  confirmed discovery sha and final candidate sha, the complete delta, the confirmed contract, and
  each finding's source-lens instructions. Two bounded jobs only — exact recheck of known IDs, and
  discovery over the post-discovery delta plus directly adjacent production paths; no repo resample.
  Per-ID result schema (`resolved` | `still_present` | `inconclusive` + evidence_kind + evidence);
  omission is a schema failure, never resolution. Resolution evidence proportional to original
  reachability: `demonstrated` ⇒ named regression test / replayed reproduction / equivalent
  deterministic proof; `supported` ⇒ anchored contradictory evidence + a relevant verification step;
  `speculative` ⇒ bounded inspection with its limitation explicit. The rechecker VERIFIES evidence
  (never repeats the fixer's claim); returns `inconclusive` to disposition rather than synthesizing
  closure or launching another panel. `new_findings` enter the ledger `untriaged` with no automatic
  fixer. No-op when discovery produced no fix_now findings AND the candidate has not changed; any
  post-discovery candidate change still receives the bounded delta review. “Named regression test”
  means a behavior/invariant-named test in the canonical subsystem suite — not a new RF/FG-named test
  file. Finding/ticket provenance belongs in the ledger, test name, or comment. A dedicated
  finding-/ticket-named file requires a recorded cross-layer capstone reason. FG-641 owns cleanup of
  the existing ticket-named suite; this ticket prevents new debt and does not absorb that cleanup.
- **Stage 9 — shipping review:** the seven checks (verification green at the current candidate;
  every AC `met`/`unmet`/`unproven` with cited evidence; every finding settled; every fix_now
  explicitly `resolved`; reviewed sha equals trusted remote head; candidate/gate/receipt/publication
  identity continuity; final diff plausibly covered by the confirmed contract). `unmet`/`unproven`
  blocks; free-form new findings return to disposition.
- `forge review start|continue`: `start` verifies, confirms, discovers, stops at disposition when
  findings exist; `continue` drives the ONE valid next transition from durable state and NEVER
  repeats discovery; an orchestrator crash resumes from the persisted stage and never repeats a
  completed stage solely because the process died.

## Acceptance criteria — PRD scenarios executed as tests

#1 (a finding absent from recheck output remains open), #2 (same anchored mechanism from two
reviewers ⇒ one finding, both sources preserved — moved here from FG-638 by operator amendment
2026-07-28), #3 (superficially similar findings with different affected invariants stay separate —
moved here), #4 (five fix_now findings ⇒ one fixer invocation), #5 (fixer resolves four, reports one
scope-changing ⇒ four proceed to recheck, fifth becomes architecture_question), #6 (recheck
still_present returns to disposition, no auto fixer), #7 (late speculative low recorded untriaged, no
blocking force from lateness), #8 (demonstrated data-loss path vs protected invariant returns to
disposition before shipping), #9 (reviewer crash ⇒ no synthesized pass or empty finding set), #10
(finding omitted from reviewer JSON ⇒ schema failure, not resolution — moved here), #11 (historical
fail against SHA A does not block settled SHA B with rechecks covering B), #14 (candidate change
after recheck invalidates candidate-bound resolution/shipping evidence), #15 (`forge review continue`
after a crash resumes the persisted next stage without repeating discovery), #19 (fixer retry
receives the same immutable FixBatch revision + verified payload hash; changed disposition ⇒ new
revision), #20 (fixer result omitting an expected finding ID or naming a foreign one refused at host
ingestion), #24 (fixer-introduced reachable defect caught by bounded delta review ⇒ new ledger
finding), #26 (demonstrated finding cannot be resolved solely by model re-inspection), #28 (rechecker
inconclusive returns to disposition, never synthesizes closure or a new discovery panel).

Plus: `blocked_environment` consumes no review cycle and dispatches nothing; a deterministic
verification failure never becomes a finding. Tests added as resolution evidence follow the
behavior-oriented placement rule above; acceptance evidence must not require one new test file per
finding or backlog ticket.

## Non-goals

Gate derivation, `feature` migration, red-seed authority changes, review-loop deprecation (FG-640).
No generic `messages` table or real-time agent inbox (Appendix A deliberate boundary).
Existing ticket-named test-suite consolidation remains FG-641.

## Dependencies

Blocked on FG-638 (tables, stable IDs, disposition CLI + authority rules). Blocks FG-640.
