---
id: FG-582
type: story
status: active
title: "FG-572 Child 5e: installed git hooks are absolute symlinks into the dev checkout and do not follow a promotion"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561 · **Status:** ready to implement — T9 anchoring settled (symlink-through-`$FORGE_HOME/current`, operator decision 2026-07-17); both blockers cleared (FG-577 landed `b5add06`).
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`, at `12b13c2`.

## Problem

`forge init` installs Forge-owned git hooks as **absolute symlinks into the dev checkout**
(`src/cli/commands/init.ts:196`, `executeHookPlan` → `symlinkSync(plan.source, plan.target)`). Verified live on
host at `12b13c2`:

    .git/hooks/commit-msg -> /Users/stevebargelt/code/forge/scripts/git-hooks/commit-msg-no-ai-attribution

Because the target is an absolute path into the checkout, the installed hook does **not follow a promotion**: it
keeps executing dev-checkout bytes regardless of which release is currently promoted. A promoted release and its
installed hooks silently diverge.

Two secondary defects travel with this:
- `init.ts:185`'s `exists-other` case does not distinguish a **stale Forge-owned hook** (safe to re-point) from a
  **foreign hook** (must never be clobbered) — the same operator-owned-surface principle as FG-578.
- Two durable docs assert the pre-split symlink mechanic and are now stale under a promoted release
  (`docs/concepts.md:40`, `docs/quick-start.md:80`). They describe behavior this ticket owns and were deliberately
  left untouched until it ships.

## Goal

Installed Forge-owned git hooks follow the promoted release: each new hook invocation resolves through
`$FORGE_HOME/current` and therefore runs the currently promoted release's bytes, while an already-running
invocation stays anchored to the bytes it started with. Installation is idempotent, never clobbers a
non-Forge-owned surface, and preserves today's dev-checkout behavior when there is no `current` pointer. The two
stale hook-path docs are reconciled in the same change.

## Settled design — symlink-through-`$FORGE_HOME/current` (operator decision 2026-07-17)

**Installed git hooks symlink THROUGH `$FORGE_HOME/current`, not through a resolved release path.** Each hook
invocation therefore uses the currently promoted release; an already-running invocation remains anchored to
whatever it started under. Pin-at-install was rejected — it would leave hooks indefinitely stale after a
promotion.

This resolves the T9 tension for **installed pointers**, which is a distinct case from the process-anchoring the
campaign settled earlier: a hook is not a running process, it is re-resolved at every invocation, so pointing it
at `current` is correct. (Historical rationale: the alternative, pinning to the install-time release, matched
T9's "a process anchors at start" discipline but left a hook executing a superseded release's bytes
indefinitely — the worse failure. The operator chose `current`.)

## Acceptance Criteria

1. **Promotion-following:** `forge init`'s hook install (`init.ts:196`, `executeHookPlan` → `symlinkSync`) targets
   `$FORGE_HOME/current/<hook>` instead of an absolute dev-checkout / resolved-release path, so a new hook
   invocation observes the currently promoted release. A test observes RED against the current
   absolute-dev-path behavior, then GREEN, and a test proves a promotion changes the target a new invocation
   resolves.
2. **In-flight anchoring:** an invocation already running remains anchored to the bytes it started with (not
   re-resolved mid-run).
3. **Dev-checkout fallback:** in a live development checkout with **no `current` pointer**, the existing
   development behavior is preserved (point at the checkout) — the dev loop is not broken.
4. **Stale-hook repair:** `init.ts:185`'s `exists-other` is disambiguated so a **provably Forge-owned** stale hook
   is re-pointed, distinguished from a foreign hook by **evidence, not by name**.
5. **Foreign-surface refusal:** a regular file, a foreign symlink, or a foreign hook is **never** overwritten.
6. **Idempotence:** installation is a no-op when the hook already points at the correct target.
7. **Docs reconciliation:** `docs/concepts.md:40` and `docs/quick-start.md:80` are corrected to describe the
   `$FORGE_HOME/current` mechanic in the same change.
8. **Test isolation:** tests use **disposable FORGE_HOME + disposable repository/install directories** and never
   touch this repo's real `.git/hooks` or any real user hooks. RED-before-GREEN coverage exists for: the current
   absolute-development-path behavior; a promotion changing the target a new invocation observes; stale
   Forge-owned hook repair; foreign-hook and foreign-symlink refusal; already-correct idempotence; and
   development behavior when no `current` pointer exists.

## Notes

- Closing FG-582 + FG-583 closes FG-572 → closes epic FG-561.
- The two stale docs are the operator-facing statement of exactly the behavior this ticket decides; they must be
  reconciled here, not deferred (they were only deferred originally because the protection did not yet exist).
