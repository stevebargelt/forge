---
id: FG-355
type: story
status: done
title: "Red snapshot semantics — single-primary (FG-345 child 5): reds mount the primary task's worktree read-only"
created: 2026-06-22
closed: 2026-07-13
closed_commit: 4762b1f
---

**Parent:** FG-345. **Single-primary path ONLY** — fan-out red timing is owned by FG-353.

## Invariant (unchanged, and the reason this ticket existed)

Reds must never review the mutable publish target. They must review a frozen snapshot of exactly the work
that is about to ship — not `run.projectDir`, which may be mid-merge from a concurrent or sequential neighbor.

## RESOLVED BY FG-425 (merged 4762b1f) — with SUPERSEDED MECHANICS

FG-425's serialized integration publisher satisfies this invariant, and satisfies it more strongly than this
ticket originally specified.

**Original mechanics (SUPERSEDED, do not implement):** "dispatchReds looks up the primary task's
`worktreePath` and passes it as `projectDir` to `runOneRed`." The primary's worktree holds the primary's
BRANCH tree — which is *nearly* what ships, but is not bound to the commit that actually publishes.

**What actually landed (STRONGER):** reds run INSIDE the publisher's `validate`, against the per-attempt
CANDIDATE integration worktree at the immutable `candidateSha` — and `publishedSha === candidateSha` is a
hard assertion that throws (`src/v2/integration-publisher.ts:491`). So the reds review, byte for byte, the
exact commit that publishes. On an AD-1 moved-base rebuild, `validate` re-runs and the reds see the REBUILT
candidate rather than a stale one. An authoritative red fail REFUSES publication outright — nothing reaches
the target.

## Acceptance — met, with evidence

- **Red container's `/project` is read-only:** `src/v2/runNext.ts:1303` — `projectMode: "ro"`. OS-enforced,
  not prompt-enforced.
- **Red's `/project` is the frozen candidate, not main HEAD:** reds are dispatched via `runRedsAgainst(dir)`
  where `dir` is the candidate worktree (`src/v2/runNext.ts:686-700`); single-primary gained an integration
  worktree it did not previously have.
- **Reds run BEFORE publication** (the correct generalization of the original "before the FG-352 merge").
- **Tested:** `src/v2/fg425-red-rejection.worktree.test.ts:255` asserts the red's mount carries the primary's
  work, and `:256` asserts the publish target is provably STILL AT `baseSha` while the red is deciding — i.e.
  a red-rejected candidate publishes nothing. `src/v2/fg353-dispatch.worktree.test.ts` additionally asserts
  the tree the red reviewed IS the commit that got published.

Scope note: like FG-425's publisher (and like this ticket's parent FG-345), this is worktree-mode-scoped.
Non-worktree runs bind-mount the shared project dir and are byte-for-byte unchanged.
