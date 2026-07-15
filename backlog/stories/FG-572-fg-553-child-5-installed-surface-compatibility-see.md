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

The atomic release closure (FG-569/FG-571) covers the executable + node_modules + interpreter + the
control-plane asset dirs it bundles (seeds/, scripts/, docker/). But forge also depends on artifacts INSTALLED
OUTSIDE that closure: `~/.forge` seeds / workflows / routing-policy (verified: **copies, not symlinks**),
installed hooks, scripts, project-local `.forge` command assets, and the **dashboard application surface**
(a separate workspace with its OWN node_modules, deliberately NOT bundled into the control-plane release). A
promotion that swaps the executable but leaves an OLDER installed surface — or leaves the dashboard
unavailable — can mis-run silently.

## FG-569 deferral — stable `forge dashboard` from a release (this child owns it)

FG-569 ships an honest CONTROL-PLANE closure: it bundles the small asset dirs supported control commands need
(seeds/, scripts/, docker/) and makes `forge dashboard` **fail immediately in release mode with a named
nonzero refusal** rather than reach a dashboard/ that is not in the closure. Making a **stable `forge
dashboard` actually available from a promoted release** (bundling or otherwise serving the dashboard workspace
+ its dependencies) is deferred here, to Child 5. **The machine-wide promotion campaign (FG-561) is NOT
complete while stable `forge dashboard` remains unavailable from a promoted release.**

## Scope

For each installed surface, decide and implement one of: promotion **re-installs** it, **version-pins** it,
or leaves it **explicitly out of the control path** — and define what happens when an installed copy is
**older** than the promoted runtime. Distinguish the **atomic closure** (moves as one unit with the release)
from these **externally-installed, version-compatible surfaces** (a compatibility policy, not atomic swap).
Includes lifting `forge dashboard` from its FG-569 release-mode refusal to a supported, stable surface.

## Acceptance (EXECUTED)

- An installed surface copy **older** than the promoted runtime produces a **named, actionable failure** —
  not a silent mis-run.
- For each surface (seeds/workflows/routing-policy, hooks, scripts, project `.forge`, dashboard): its
  promotion behavior (re-install / version-pin / out-of-path) is implemented and tested.
- `forge dashboard` is available and stable from a promoted release (its FG-569 release-mode refusal is
  lifted), OR its unavailability is an explicit, named, accepted product boundary — and FG-561 is not marked
  complete while it remains unavailable.
- No installed surface silently loads mutable host code that contradicts the promoted runtime.

## Not in scope
- The release/promotion machinery itself (FG-569/FG-571).
