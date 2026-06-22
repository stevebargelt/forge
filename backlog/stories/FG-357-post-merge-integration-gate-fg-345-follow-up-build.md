---
id: FG-357
type: story
status: active
title: "Post-merge integration gate (FG-345 follow-up): build+test the MERGED result to catch semantic cross-file breakage"
created: 2026-06-22
---

**Parent:** FG-345. **FOLLOW-UP — explicitly excluded from the first cut.** **Depends on:** FG-352 + FG-353 (a merged result must exist to gate).

The highest-value safety property, and the one worktrees alone do NOT provide. Worktrees convert same-file TEXTUAL races into detectable conflicts, but semantic cross-file breakage merges CLEAN: agent A changes a signature in `foo.ts`, agent B (own worktree) calls the old signature in `bar.ts` → `git merge` succeeds with zero conflict → broken code merged with no signal. Only building+testing the MERGED result catches this.

## Scope
- After a successful merge to HEAD (sequential FG-352) or integration-branch merge (fan-out FG-353), run the project's build+test (`forge-test` semantics) against the MERGED tree before the step is final.
- Failure → a new terminal outcome (e.g. `integration_failed`) distinct from `merge_conflict`; surface the build/test output; retain state for inspection.
- Decide where it runs (host vs container) and how it reuses the project's existing test entrypoint.

## Why separate
Folding this into FG-352/FG-353 doubles their failure surface and makes the first cut unshippable. The first cut (silent races → detectable conflicts) is already a strict improvement; this gate is the second, larger increment.

## Acceptance
- A clean merge whose merged result fails build/test is caught and surfaced, not completed green.
- A semantic cross-file break (clean merge, broken integration) is detected. forge-test green.

Refs: FG-352, FG-353, FG-345 hard-constraint #1.
