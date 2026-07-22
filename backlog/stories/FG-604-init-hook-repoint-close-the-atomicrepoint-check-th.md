---
id: FG-604
type: story
status: active
title: "init hook repoint: close the atomicRepoint check-then-rename TOCTOU window (foreign hook swapped in between the ownership recheck and renameSync is overwritten)"
created: 2026-07-22
---

**Source:** FG-582 review-loop round 2 (red-wide), run `run-review-loop-fg-582-5e53a2`.

## Problem

`executeHookPlan` re-reads the target's owned-state (`readOwnedTargetState`/`ownedStateMatches`) immediately before mutating, then `atomicRepoint` (src/cli/commands/init.ts:~319) does symlink-to-temp + `renameSync` over the target. A foreign hook swapped into `.git/hooks/commit-msg` in the window BETWEEN the ownership recheck and the `renameSync` is atomically overwritten, violating the never-clobber-foreign invariant (FG-582 AC-5). The recheck narrows but does not eliminate the race — any check-then-rename has a window.

## Assessment (why FG-582 shipped without closing it)

Low realistic exploitability: an attacker able to write `.git/hooks` during the victim's own `forge init` can write a malicious hook directly and needs no race. Operator decision (2026-07-22): file follow-up + merge FG-582 rather than accrete containment machinery to chase a theoretical window. FG-582's other AC-5 protections (plan-time classification, pre-mutate recheck, atomic replace so the guard is never momentarily absent) remain in force.

## Goal / Acceptance Criteria

- Close or bound the check-to-rename window so a foreign entry appearing after the recheck is not overwritten (e.g. re-check as late as possible before rename, or an approach that fails closed on a late swap), WITHOUT introducing lock/identity machinery disproportionate to the threat.
- A regression test that simulates a foreign hook appearing after the recheck and asserts it is left untouched (skipped), on disposable FORGE_HOME + repo dirs.
- If analysis concludes the residual window is irreducible without disproportionate machinery, document that conclusion and close as won't-fix with the rationale (do not accrete).