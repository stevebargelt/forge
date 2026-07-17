---
id: FG-573
type: story
status: done
title: "docs: reconcile durable-orchestration-continuation PRD current-state map against landed Slice-1 children (R1/R2, store policy, exec entry)"
created: 2026-07-15
closed: 2026-07-16
closed_commit: 73f7f56
---

**Parent:** FG-552 (PRD) · **Epic:** FG-561 · **Type:** docs follow-up

## Problem

The accepted PRD `docs/prds/durable-orchestration-continuation.md` carries a "current-state" /
runtime-provenance map and BD tables that were written before any Slice-1 child landed. As each child ships,
that map goes stale, and successive reviews keep re-flagging the same lines from different tickets:

- **FG-569 review** — `:232` still says R1 and R2 are not recorded, contradicting the shipped exec entry +
  R1/R2 provenance.
- **FG-568 review** — `:97`, `:247`, `:626` still describe a destructive DROP on every open and an active
  FG-553/R1 gap, contradicting the shipped additive-only store policy + convergence contract.

These are out of scope for the individual code tickets (the PRD is a campaign-level artifact, not in any
child's reviewed range), which is why each child's fixer correctly refuses them. They need one dedicated
reconciliation pass.

## Scope

Reconcile the PRD's current-system map, runtime-provenance/BD-14 table, and BD-15 store-evolution rationale
against what has actually landed in Slice 1:

- **FG-567** — signal-fidelity contract (exec-form observer sees the real signal).
- **FG-568** — additive-only open path, schema-version stamp, quiesce-gated destructive convergence, dual-shape
  usage insertion across the overlap window (no destructive DROP on ordinary open).
- **FG-569** — `/bin/sh` exec entry (single process, execPath is the control runtime), inert immutable release
  closure + manifest, **R1 and R2 recorded**.

Keep **R3/R4 (FG-555)** and promotion/`current`/PATH (FG-571) explicitly out-of-scope / still-planned — do not
overstate. Route through the documentation-maintainer.

## Acceptance

- The PRD current-state map distinguishes landed R1/R2 from still-out-of-scope R3/R4, and reflects the
  additive-only store policy + exec entry as shipped.
- Lines `:97`, `:232`, `:247`, `:626` (and any adjacent stale current-state prose) no longer contradict the
  shipped code.
- A re-review of a subsequent Slice-1 child no longer re-flags PRD current-state staleness for already-landed
  children.
