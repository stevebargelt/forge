---
id: FG-539
type: story
status: done
title: review-loop commit-range inference misses standard Forge ticket IDs without a hash prefix
created: 2026-07-12
closed: 2026-07-12
closed_commit: 739b0b2
---

## Problem

`forge review-loop FG-533`, `FG-535`, and `FG-536` could not infer a commit range even though the relevant commit subjects named those ticket IDs. Operators had to supply `--since $(git merge-base origin/main HEAD)` manually.

This is a confirmed matcher defect, not a worktree or branch-topology failure. `resolveCommitRange` strips a leading hash from the CLI argument and then searches Git history for a mandatory hash-prefixed reference such as `#FG-536`. Forge's established commit convention uses `(FG-536)` without the hash. Against the current repository, production `resolveCommitRange("FG-536")` returns `mode: "none"`, while the equivalent Git search without the mandatory hash finds the implementation, fixer, documentation, and closeout commits.

Primary code: `src/v2/review-loop.ts:37-66`.

## Goal

Infer the precise ticket-related commit set from the ticket-reference forms Forge actually writes, without broadening the match to similarly-prefixed ticket IDs or unrelated history. Explicit `--since` remains authoritative.

## Acceptance Criteria

- [ ] Inference recognizes a structured ticket ID without a hash, including the established `(FG-536)` subject form.
- [ ] Inference continues to recognize hash-prefixed references such as `#FG-536` and the legacy numeric `#301` form.
- [ ] Boundary matching remains exact: `FG-536` does not match `FG-5360` or another ticket whose numeric suffix merely shares the prefix.
- [ ] A production-shaped regression fixture containing the FG-533/FG-535/FG-536 commit-subject convention returns `mode: "inferred"` with the expected SHAs.
- [ ] Non-contiguous matching commits continue to set `spansUnmatched` and review only the precise matching SHAs; unrelated commits inside the span are not added to the review diff.
- [ ] `--since <sha>` behavior and precedence are unchanged.
- [ ] CLI coverage proves `forge review-loop FG-xxx --dry-run` no longer emits `no commits reference FG-xxx` when standard Forge ticket references are present.

## Non-Goals

- Do not guess a range when no exact ticket reference exists.
- Do not silently replace explicit `--since`.
- Do not review every commit since the repository's root or an arbitrary fixed branch.
