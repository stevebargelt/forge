# Decision: Post-review pipeline phases base on the reviewed candidate, and publication refuses a stale-based later phase

**ID**: FORGE-DEC-036
**Date**: 2026-09-09
**Status**: Decided
**Decided by**: Steve (forge build, FG-791)
**Supersedes**: N/A
**Scope**: forge

---

## Context

The `feature` pipeline runs `build` → `verify` → `docs`. Once the build fan-out is integrated, the [evidence-led review](../../docs/concepts.md#review-coordinator) fixes findings on the run's clone branch and advances the review's candidate to the post-fix tip. The build `review_disposition` gate then settles, and the pipeline's later phases (`verify`, `docs`) run.

**The defect (observed live, three runs, 2026-09-08/09).** A later phase derived its worktree from the *build task's recorded integration head* — the pre-review commit — not from the run's CURRENT candidate, the reviewed tip on the clone branch. On `run-fg-784-remote-board-cloudflare-access`, the build fan-out integrated at `787c9ee5`; the review fixed RF-1/2/3/5 in fix batch `51199eb6` plus a docs cycle `dfbddd2a` on the clone branch; the build gate advanced; the verify phase then ran in a worktree branched from `787c9ee5` (its safety-commit `75a8fd72`'s parent is `787c9ee5`; neither fix commit is an ancestor). The test-engineer authored a test against PRE-fix semantics — a dotted Access team the RF-5 fix now refuses — it passed in its container against the stale head, and publication (`fc881287`) merged it onto the reviewed branch, where it failed deterministically on the host and in CI. `run-fg-783` hit the same mechanic; `run-fg-782`/`785` were harmless only by luck.

This undermines candidate-bound evidence — the whole point of a review. A post-review phase can verify STALE code and publish a stale artifact onto the reviewed candidate, silently overwriting or contradicting the fix the review shipped.

---

## Problem

After the `review_disposition` gate settles, from what commit must a later pipeline phase (verify, docs) cut its worktree — and what stops it from publishing an artifact built on the wrong one?

Two sub-questions the fix must answer without a race and without breaking legacy runs:

1. What is the authoritative definition of "the run's current candidate" after a review, and how does the next phase read it without racing a concurrent orchestrator commit?
2. What happens when NO review exists (legacy verdict-mode workflows)? The base must degrade to today's behavior, never refuse.

---

## Options Considered

### Option A: Snapshot the candidate into a run/settlement-time column and read that

Write a durable "current candidate" column at review settlement; later phases read the column.

**Pros**:
- Explicit single field to read.

**Cons**:
- A new writer on the settlement path, a new column on the shared host DB, and a new state machine to keep true across crash/resume.
- Duplicates a fact the review ledger already holds (`reviews.candidate_sha` on the settled review).

---

### Option B: Two-source resolver keyed off the settled review ledger, frozen by lifecycle ordering ✅

A single read authority — `latestSettledReviewCandidateForRun(runId)` — returns the candidate_sha of the most-recently-settled evidence-led review for the run, else `undefined`. The base resolver prefers it, then falls back to the existing publication receipt, then HEAD. No new column, no new writer, no lock.

**Pros**:
- Reuses the ledger's existing `candidate_sha` — the review coordinator already advances it; nothing new writes candidate state.
- The freeze is a *lifecycle transition*, not a lock: only a SETTLED review is ever read, and no code path advances a candidate after settlement, so a value read at resolution time cannot be moved out from under the reader by a concurrent commit.
- Legacy runs degrade for free: a `legacy_verdict` / `legacy_review_loop` run has no settled evidence-led review, so the helper returns `undefined` and the resolver falls straight through to today's publication-receipt base — no new base source, no reachable new refusal path.

**Cons**:
- The reviewed tip is a valid base though it carries no `publication_attempts` receipt of its own (see the AD-6 note below); the resolver has to treat "reviewed candidate" and "published receipt" as two distinct authorities rather than one.

---

## Decision

**Chose**: Option B — a two-source read resolver keyed off the settled review ledger, plus a distinct publication preflight.

Three pieces:

1. **One base authority.** `src/store/reviews.ts` adds `latestSettledReviewCandidateForRun(runId)` — the candidate_sha of the most-recently-settled (`settled_at DESC, id DESC`) `state='settled'`, `review_mode='evidence_led'`, non-null-`candidate_sha` review, else `undefined`. `resolveTaskBaseSha` in `src/v2/runNext.ts` calls it FIRST; only on `undefined` does it fall back to `latestPublishedShaForRun`, then HEAD — byte-for-byte the pre-FG-791 behavior. This is the ONE authority both sequential dispatch and the fanout wave-base resolution call, so ordered/unordered waves and request-changes re-runs all resolve identically. Every resolution emits `phase.base_resolved{runId, taskId, baseSha, source}` where `source` ∈ `reviewed_candidate | publication_receipt | head`, so the phase record names the base sha AND why it was chosen (AC1).

2. **A distinct publication preflight (AC3).** `publishIntegration` in `src/v2/integration-publisher.ts`, immediately after the `already_published` idempotency check and BEFORE any lane/worktree/mutex/ref work, looks up the publishing task's recorded `baseSha` and the run's current candidate (`latestSettledReviewCandidateForRun`, else `latestPublishedShaForRun`). If a current candidate exists and the phase base is NOT an ancestor of it (via `isAncestor` from `publication-target.ts`), it REFUSES: marks the attempt `failed`, emits `publication.refused{reason:'stale_base_not_ancestor'}`, and returns `{kind:'refused'}` with the message from `describeStaleBaseRefusal` (`src/v2/project-identity.ts`), which names the phase base, the current candidate, and the remedy. Nothing is merged; the target ref is byte-for-byte unchanged.

3. **The docs and schema** name the rule and the new event.

---

## Consequences

**Positive**:
- Post-review phases test the code the review shipped, not code it replaced. The FG-784 class of failure — a stale artifact merged onto the reviewed branch — cannot recur silently: it is either repointed at the reviewed candidate (piece 1) or refused at publication (piece 2).
- Legacy verdict-mode runs are unchanged: no settled evidence-led review means no new base source and no reachable new refusal path.

**Negative / Trade-offs**:
- No `publication_attempts` receipt is written at review settlement (see AD-6). The two-source resolver is the cost of that choice: "the reviewed candidate" and "the last published sha" are two authorities the resolver and the preflight both consult, rather than one unified receipt.

**Risks**:
- The freeze rests on the invariant that nothing advances a candidate after settlement. The AC2 regression test (`src/v2/fg791-reviewed-candidate-base.worktree.test.ts`) asserts the settled review's candidate_sha is stable through verify dispatch to hold that invariant against future change.

---

## Implementation Notes

**Why the settlement lifecycle gate is the freeze point rather than a lock.** The resolver and the preflight read only a SETTLED review. Settlement is a one-way lifecycle transition, and no path calls `advanceCandidate` after it — so a candidate read at base-resolution or publication time cannot be moved by a concurrent orchestrator commit. A lock would guard a mutation that does not happen; the lifecycle ordering is what makes it safe to read without one.

**AC3 is a DISTINCT invariant from the fast-forward proof — neither subsumes the other.** The existing fast-forward ancestry proof + CAS in `publication-target.ts` asks "is the target still where this candidate was built on?" and guards ref ancestry inside the CAS window. The AC3 preflight asks "was this candidate even built on the code the review shipped?" and fires BEFORE the window. The FG-784 incident PASSED the fast-forward proof — the pre-review head WAS an ancestor of the target it merged onto — and still had to be refused. The FF/CAS proof is untouched; the new guard is layered on top of it.

**AD-6 reconciliation note.** AD-6 (a published task's `published_sha == candidate_sha`) is preserved even though the reviewed tip carries no `publication_attempts` receipt of its own. The reviewed candidate is a legitimate base though nothing published it through the integration publisher — the review coordinator advanced it on the clone branch, not the publisher. The resolver therefore treats the reviewed candidate as an authority ALONGSIDE, not derived from, the publication receipt: a later phase can base on a sha that has no receipt, and that is correct.

**What was deliberately NOT done.** No lock, no settlement-time snapshot column, no `publication_attempts` receipt written at settlement, and no change to the review lifecycle, the `candidate_sha` writer (`advanceCandidate`), the `review_disposition` gate, or the fast-forward proof. The contained two-source resolver is the chosen design.

---

## Revisit Conditions

- If a future path advances a candidate AFTER settlement, the lifecycle-ordering freeze no longer holds and this design needs a lock or a settlement-time snapshot instead.
- If review settlement starts writing a `publication_attempts` receipt for the reviewed tip, the two-source resolver collapses to a single publication-receipt authority and the `latestSettledReviewCandidateForRun` branch can retire.
