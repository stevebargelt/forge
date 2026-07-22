---
id: FG-582
type: story
status: active
title: "FG-572 Child 5e: installed git hooks are absolute symlinks into the dev checkout and do not follow a promotion (carries an unresolved T9 anchoring tension)"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561 · **UNBLOCKED — T9 anchoring settled: symlink-through-`$FORGE_HOME/current` (operator decision 2026-07-17); both blockers cleared. Ready to implement — see the Operator decision section below.**
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`, at `12b13c2`.

## Current state (VERIFIED on host at 12b13c2 — the arch pass could not see this from its mount)

`forge init` installs git hooks as **absolute symlinks** (`src/cli/commands/init.ts:196`, `executeHookPlan` →
`symlinkSync(plan.source, plan.target)`). Confirmed live in this repo:

    .git/hooks/commit-msg -> /Users/stevebargelt/code/forge/scripts/git-hooks/commit-msg-no-ai-attribution

That is an absolute path into the **dev checkout**. Under a promotion the hook keeps executing dev bytes
regardless of which release is current — the installed hook does not follow the promotion at all.

## The T9 tension — RESOLVED (operator chose symlink-through-`current`; see the Operator decision section below). Retained for history.

Two defensible directions pull opposite ways:

- **Symlink through `$FORGE_HOME/current`** — promotion re-points every hook atomically, for free.
- **Pin to the install-time release** — matches T9's "a process anchors at start" anchoring discipline.

The campaign has settled anchoring for **processes** but NOT for **installed pointers**, which is a distinct
case. A hook is not a running process; it is re-resolved at every invocation.

Architect's default if unanswered: **pin to `current`**, since a hook executing a superseded release's bytes
indefinitely is the worse failure. But this is explicitly flagged as the operator's call, and T9 itself
("whether an already-running process is affected by a mid-flight promotion") is an **open acceptance case, not
an established fact** (PRD ~line 379) — the design must test it, not assert it.

## Also in scope

Disambiguate `init.ts:185`'s `exists-other` between a **stale forge hook** (safe to re-point) and a **foreign
hook** (must never be clobbered — same operator-owned-surface principle as FG-578).

## Blocked on — CLEARED (both resolved; retained for history)

1. ~~The T9 anchoring decision for installed pointers (operator).~~ **RESOLVED 2026-07-17: symlink-through-`$FORGE_HOME/current`** (see Operator decision).
2. ~~FG-577 (5a) landing, so the install path resolves from the running runtime.~~ **LANDED (`b5add06`).**

## Acceptance (EXECUTED) — draft, finalize after the T9 call

- A promotion re-points (or deliberately does not re-point) hooks per the chosen policy, with a test observed
  RED against current absolute-dev-path behavior.
- A foreign hook is never clobbered; a stale forge hook is distinguished from it by evidence, not by name.
- Tests use **disposable FORGE_HOME + disposable install prefixes**; no test rewrites this repo's real
  `.git/hooks`.

## Stale docs this ticket owns (found 2026-07-17 during FG-577; NOT fixable until this ships)

FG-577's premise grep across `docs/**` surfaced two durable docs asserting the pre-split symlink mechanic.
Both were **deliberately left alone** — correcting them means documenting installed-symlink behavior that THIS
ticket owns and has not shipped, so fixing them now would document a protection that does not exist:

- **`docs/concepts.md:40`** — "Installed by `forge init` as symlinks into the local forge clone (so
  `forge upgrade` propagates template edits to all projects without per-project re-copy)."
- **`docs/quick-start.md:80`** — "slash commands are symlinks so template edits in the forge repo flow to
  every project on next session."

Under a promoted release these resolve into the **release tree**, not the clone, so template edits in the
checkout do not flow. Neither is caused by FG-577: `init.ts` already resolved module-relative
(`init.ts:222,283-311,650,786`) and FG-577 does not touch `init.ts` — the drift predates it and was simply
never visible before the stable/dev split made it matter.

**Whichever way the T9 anchoring decision goes, both lines must be reconciled in the same change.** They are
the operator-facing statement of exactly the behavior this ticket decides.

## Operator decision — 2026-07-17 (T9 anchoring: symlink-through-current)

**Installed git hooks symlink THROUGH `$FORGE_HOME/current`, not through a resolved release path.** Each hook
invocation therefore uses the **currently promoted release**; an already-running invocation remains anchored to
whatever it started under. Pin-at-install is rejected — it would leave hooks indefinitely stale after a
promotion. This resolves the T9 tension for INSTALLED POINTERS (distinct from the process-anchoring the
campaign settled earlier): a hook is re-resolved at every invocation, so pointing it at `current` is correct.

**Unblocked:** FG-577 (5a) has landed (`b5add06`), and the T9 decision is now made — both blockers cleared.

**Implementation (per this decision):**
- `forge init`'s hook install (`init.ts:196`, `executeHookPlan` → `symlinkSync`) targets
  `$FORGE_HOME/current/<hook>` instead of an absolute dev-checkout / resolved-release path, so promotion
  re-points every hook atomically.
- Disambiguate `init.ts:185`'s `exists-other`: a stale forge hook (safe to re-point) vs a foreign hook (never
  clobber) — same operator-owned-surface principle as FG-578.
- In a live dev checkout with no `current` pointer, preserve today's behavior (point at the checkout) — do not
  break the dev loop.
- Reconcile the two stale slash-command-symlink docs this ticket owns (`docs/concepts.md:40`,
  `docs/quick-start.md:80`) in the same change.
