---
id: FG-547
type: story
status: active
title: Eliminate duplicate push and pull-request CI by adopting an early draft-PR lifecycle
created: 2026-07-12
---

## Problem

`.github/workflows/ci.yml` currently triggers on every `push` to every branch and on every `pull_request` into `main`. Its concurrency group is keyed by `github.ref`, so the push ref and PR ref do not coalesce. Once a branch has a PR, every update runs two full pairs of the required `test` and `test-extended` jobs.

This was previously recorded as a cosmetic cost, but it is now material: `test-extended` takes minutes, review-loop waits on CI every round, and long Forge campaigns repeatedly update active PR branches.

The runs are related but not identical. For PR #112 at head `4d346ae`, push run `29197727143` tested the branch head, while pull-request run `29198153519` checked out `refs/pull/112/merge` (synthetic merge commit `82ed33c`). The PR run therefore adds base-integration evidence, but paying both full suites for every head update is not an acceptable default.

Forge's current operating sequence causes the duplication: review-loop relies on push-triggered branch CI through FG-501, while PRs may not be opened until review is finished. Simply deleting either trigger would break review-loop evidence reuse, direct-main validation, fork PRs, or base-integration coverage.

## Goal

Run one required CI pair per candidate revision while preserving review-loop exact-tip evidence, PR/base integration coverage, branch protection, fork support, and direct-`main` validation.

## Preferred Direction

Move the orchestration lifecycle to an early draft PR:

1. After the first candidate commit is pushed, the orchestrator creates or reuses a draft PR before starting review-loop.
2. CI runs on `pull_request` open/synchronize/reopen events for candidate branches.
3. `push` CI is restricted to `main` for direct/backlog-only pushes and post-merge validation.
4. Review-loop consumes the PR check runs associated with the exact reviewed head and records that the workflow executed the PR merge ref.

An alternative design is acceptable only if it proves the same one-pair, exact-tip, integration, and failure semantics without relying on timing-based cancellation or silently dropping required checks.

## Acceptance Criteria

- Updating a same-repository branch with an open PR creates exactly one `test` and one `test-extended` check for that candidate revision, not a push pair plus a PR pair.
- The candidate run validates the PR merge ref against the current base, and Forge records/surfaces both the reviewed head SHA and the tested merge-ref/merge SHA where GitHub exposes them. It must not falsely describe merge-ref execution as byte-for-byte execution of the head commit alone.
- Review-loop can wait for and reuse both required checks for its exact reviewed head under the new trigger lifecycle; no regression to 20-minute no-CI waits or routine local fallback is allowed.
- The orchestrator creates or requires a draft PR before starting a CI-dependent review-loop. If no PR exists, preflight fails quickly with an actionable instruction instead of polling for CI that cannot start.
- Subsequent fixer pushes update the existing draft PR and trigger one new required-check pair for the new head.
- Direct pushes to `main`, including authorized backlog-only pushes, still run one full required-check pair.
- Fork PRs still receive the required checks under a documented safe permissions model.
- Branch protection continues to require `test` and `test-extended`; successful jobs remain attached to the PR head in the form GitHub branch protection recognizes.
- A failed or cancelled required check cannot be masked by an older successful run, a run for another head, or trigger/event ambiguity.
- Opening, converting, closing, and reopening a draft PR cannot leave review-loop trusting stale checks.
- Tests cover trigger policy, no-PR preflight, exact-head pairing, PR merge-ref provenance, fixer-push synchronization, duplicate/older check runs, and failed/cancelled outcomes.
- CI/testing and autonomous-run documentation is updated to describe the one-pair lifecycle and early-draft-PR requirement.

## Non-Goals

- Weakening either required check or making `test-extended` optional.
- Treating concurrency cancellation as sufficient deduplication after both expensive runs have already started.
- Removing PR/base integration coverage merely because push checks are green.
- Folding docs/research-only test selection into this ticket; FG-545 owns that independent optimization.

## Evidence

- `.github/workflows/ci.yml`: unrestricted `push`, `pull_request` into `main`, and ref-keyed concurrency.
- PR #112 head `4d346ae`: push run `29197727143` and pull-request run `29198153519` both ran `test` + `test-extended`; the PR checkout log shows `refs/remotes/pull/112/merge` at synthetic merge `82ed33c`.
- `notes/autonomous-decisions-2026-07-07c.md` D8 recorded the double run as cosmetic before CI minutes became operationally material.
- FG-501 made review-loop wait for branch CI, establishing the dependency that a trigger change must preserve.

## Relations

- Related to FG-474, FG-495, and FG-501 (required CI, tiering, and review-loop reuse).
- Coordinate sequentially with FG-545 because both modify CI selection/wiring; do not implement them concurrently on separate branches.
- Related to FG-396/FG-544 because parallel lanes and research increase CI update volume.
