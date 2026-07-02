---
id: FG-428
type: story
status: done
title: "campaign reconcile: recover a wedged campaign item from durable evidence (non-destructive operator recovery)"
created: 2026-07-01
closed: 2026-07-02
closed_commit: b7c8f2d
---

## Problem

Campaign outcome reconciliation permanently blocks a campaign item on the EARLIEST recorded authoritative reviewer verdict. When a `fail/authoritative` is on record, the item stays `outcome=blocked, blocker=scope` even after the finding was resolved, a later `pass/authoritative` re-review was recorded, the gate was human force-advanced (with rationale), and the work was merged, host-verified, and closed. This wedges the whole sequential campaign — downstream items stay held behind an item that is, in durable reality, shipped. The only current escape is abandoning the campaign, which discards legitimate campaign state.

Observed on campaign-922c83b7c577: FG-357 is merged (b12b764), host-verified (npm run test:all, exit 0, recorded), closed with that commit, and has a later `pass/authoritative` plus a recorded human force-advance after the stale `fail/authoritative` — yet the campaign cannot mark it shipped, so FG-376 and FG-422 remain held.

Separately, the done-audit's working-tree-dirty check is too broad: it counts host-local operational state (backlog/notes.md, .forge-scratch/, transient operator notes) against shipped work, poisoning the audit for work whose real artifact is the merged commit + ticket state.

## Goal

Provide a narrowly-scoped, non-destructive operator recovery command that re-derives a wedged campaign item's outcome from DURABLE evidence already recorded in Forge/git/backlog/host-verification, marks it shipped when that evidence holds, unholds downstream items whose only blocker was it, and lets the campaign resume — without discarding the campaign and without accepting operator-asserted evidence. Also tighten the done-audit boundary so host-local operational state does not block shipped work.

## Acceptance Criteria

- `forge campaign reconcile <campaign-id>` re-derives each blocked item's outcome from DURABLE, MACHINE-CHECKED evidence only:
  - ticket status is `done` (backlog record)
  - `closedCommit` is recorded on the ticket AND is present/reachable on the base branch (git)
  - host verification is recorded for that commit (host-verification record, exit 0)
  - a later `pass/authoritative` verdict OR a recorded human force-advance (gate override with rationale) exists AFTER the stale `fail/authoritative` on the item's run
- The command marks an item shipped ONLY if ALL of the above hold; otherwise it refuses and reports exactly which facts are missing. No partial or optimistic shipping.
- The command does NOT accept operator-provided evidence strings. It re-derives from existing records. There is no broad `mark-shipped --evidence "..."` manual escape hatch; if any per-item form is provided, it re-derives identically and refuses when the durable records do not support shipped.
- On success it unholds downstream items whose only blocker was the reconciled item, and the campaign can resume normally.
- Reconciliation writes an auditable record (which evidence was found, who ran it, when). It SUPERSEDES the stale history; it does not silently erase it.
- Done-audit boundary: the working-tree-dirty check must not count host-local operational state (e.g. backlog/notes.md, .forge-scratch/, untracked operator notes) against shipped work. Done-audit evaluates the relevant merge/closed commit + ticket state, not transient workspace files.

## Tests

- Negative (guard): each missing-evidence case — ticket not done / no closedCommit / commit not reachable on base / no host-verification / no later pass-or-override — causes reconcile to REFUSE with a clear reason and mutate no state.
- Positive: all durable evidence present -> item marked shipped, downstream unheld, resume proceeds.
- Audit-boundary: an item with all durable evidence but a dirty host-local working tree (backlog/notes.md modified, untracked scratch present) reconciles/audits clean.
- Spoofing guard: no operator-provided input can cause a shipped mark when the durable records do not support it.

## Non-Goals

- Not the durable AUTOMATIC reconciliation in the normal outcome path — that is FG-427. This is the on-demand operator recovery command. They may share the underlying evidence-derivation logic.
- No arbitrary manual override that bypasses evidence.

## Relations

- FG-427 (durable automatic reconciliation honoring force-advance / later authoritative pass).
- FG-423 (campaign outcome gating: shipped requires passing authoritative verdict AND done-audit).
- FG-370 (Campaign Runner). FG-419 (trust-gate write-path guard discipline). FG-380 (host-local operational state must not dirty audits).
