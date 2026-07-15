---
id: FG-572
type: story
status: active
title: "FG-553 Child 5: installed-surface compatibility (seeds/hooks/scripts/dashboard) across a promotion"
created: 2026-07-14
---

**Parent:** FG-553 · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` (Child 5)
**Depends on:** FG-571 (promotion exists to be compatible with).

## Problem

The atomic release closure (FG-569/FG-571) covers the executable + node_modules + interpreter. But forge also
depends on artifacts INSTALLED OUTSIDE that closure: `~/.forge` seeds / workflows / routing-policy (verified:
**copies, not symlinks**), installed hooks, scripts, project-local `.forge` command assets, and dashboard
assets. A promotion that swaps the executable but leaves an OLDER installed surface can mis-run silently.

## Scope

For each installed surface, decide and implement one of: promotion **re-installs** it, **version-pins** it,
or leaves it **explicitly out of the control path** — and define what happens when an installed copy is
**older** than the promoted runtime. Distinguish the **atomic closure** (moves as one unit with the release)
from these **externally-installed, version-compatible surfaces** (a compatibility policy, not atomic swap).

## Acceptance (EXECUTED)

- An installed surface copy **older** than the promoted runtime produces a **named, actionable failure** —
  not a silent mis-run.
- For each surface (seeds/workflows/routing-policy, hooks, scripts, project `.forge`, dashboard): its
  promotion behavior (re-install / version-pin / out-of-path) is implemented and tested.
- No installed surface silently loads mutable host code that contradicts the promoted runtime.

## Not in scope
- The release/promotion machinery itself (FG-569/FG-571).
