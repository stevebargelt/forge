---
id: FG-358
type: story
status: done
title: "Linux worktree support (FG-345 follow-up): node_modules provisioning without the macOS shadow volume"
created: 2026-06-22
closed: 2026-07-02
---

**Parent:** FG-345. **FOLLOW-UP — first cut is macOS-only (FG-351 hard-fails Linux).** **Depends on:** FG-351.

On macOS the DEC-019 shadow volume (spawn.ts:247-259, darwin-gated) gives each rw container a clean anonymous node_modules volume, so worktree agents install fresh cleanly. On Linux the shadow volume is NOT applied; today's containers inherit host node_modules via the shared bind-mount. With worktrees on Linux, node_modules (gitignored) is simply ABSENT from the checkout — agents that need it either fail or pay minutes of reinstall per container.

## Scope
- Define a Linux node_modules provisioning policy for worktree mode: configurable symlink-from-main, a Linux shadow-volume equivalent, or a require-reinstall policy. Pick one with rationale.
- Remove the FG-351 Linux hard-fail once the chosen policy is in place and validated.

## Acceptance
- A Linux host runs a worktree rw agent with node_modules available (per the chosen policy) without per-container multi-minute reinstall regressions (or with an explicit, documented reinstall cost).
- forge-test green on Linux for the worktree path.

Refs: spawn.ts:247-259 (DEC-019), FG-351 (platform gate this lifts).
