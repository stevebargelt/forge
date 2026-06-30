---
id: FG-420
type: story
status: active
title: Promote Shipping Reviewer to authoritative in the default feature workflow
epic: FG-372
created: 2026-06-30
---

## Problem

The Shipping Reviewer runs in the default `feature` workflow's build phase but only as ADVISORY (`authority: specialist`, `gate_on_verdict: false`) — it warns, it never blocks. It was kept advisory deliberately because its prerequisites were not yet real: the Reviewer Context Packet was hollow, host-verification was always `unknown`, and git/push truth was unreliable. Those prerequisites are now real:

- **FG-418** — the Reviewer Context Packet carries real engineer evidence (changed files, commit, verification commands, deferred scope, engineer summary) at review time, including fanout child aggregation.
- **FG-419** — done-audit has real host-verification evidence via the recorder + required-gate model; a real `pass` is reachable and a failing/unknown gate is truthful.
- **FG-367** — git/push truth is conservative and visible (no-remote → `unknown`, not a false fail; no auto-push/PR; branch/worktree evidence surfaced).

So the reviewer can now safely be made authoritative without blocking all real work on an always-unknown signal.

## Goal

Decide and implement the NARROWEST safe promotion of the Shipping Reviewer from advisory to authoritative, so a real acceptance failure actually blocks the gate instead of merely warning.

## Acceptance Criteria

- Promote the Shipping Reviewer to authoritative in the narrowest safe scope — likely the `feature` workflow build phase ONLY (`authority: authoritative`, `gate_on_verdict: true`). Do not promote it across every workflow.
- `needs_fix` BLOCKS the gate (the FG-384 guardrail substantiation must carry the synthetic finding through the real red-ingestion path so the fail survives — not a mapper-only guarantee).
- `needs_human` becomes an explicit human-gate / block state, NOT a silent pass. The run must stop for an operator decision.
- `ship_with_named_deferrals` passes ONLY when every deferral is valid and linked (non-empty description AND followUpTicketId); otherwise it maps to `fail` and blocks.
- A failing or `unknown` done-audit still blocks a `ship` unless the agent records an explicit accepted exception (`doneAuditDisposition: accepted_exception: ...` or `covered_by_deferral`) — the FG-384 guardrail backstop, now operating over REAL host-verification evidence (FG-419).
- Integration tests through the REAL dispatch / red-ingestion path (not mapper-only): FG-384 already proved mapper-only tests miss production downgrades (runNext red ingestion can downgrade an unsubstantiated `fail` to non-blocking `inconclusive`). Cover: `needs_fix` → blocks (primary `blocked_by_red`); `needs_human` → explicit human-gate/block; invalid `ship_with_named_deferrals` → blocks; `ship` over fail/unknown done-audit with no accepted exception → blocks; `ship` with valid evidence + accepted exception → passes.
- The advisory→authoritative change is the ONLY behavior change; do not alter `mapShippingReviewerVerdict` semantics, the packet contract, done-audit aggregation, or the recorder.

## Non-Goals

- Do NOT promote across all workflows — one mutating feature workflow (build phase) first.
- Do NOT build a host-verification recorder or change done-audit (already shipped in FG-419).
- Do NOT change the reviewer's verdict vocabulary or the mapper logic — only the workflow authority/gate wiring + the `needs_human` block-state handling if not already present.
- Do NOT add auto-push/PR (FG-367 stays conservative).

## Context

- Advisory wiring + packet evidence: FG-418 (`seeds/workflows/feature.yml` build reds; `src/v2/reviewer-context-packet.ts`).
- Verdict mapping + guardrail substantiation: FG-384 (`mapShippingReviewerVerdict`, `runNext.ts` red ingestion ~line 691/888).
- Host-verification evidence: FG-419 (`src/done-audit/collect.ts`, `host_verifications`).
- Git/push truth: FG-367 (`src/done-audit/collect.ts` no-remote, `src/campaign/*`).
- Decide how `needs_human` surfaces as a block — confirm whether `inconclusive` currently halts or advances at a verdict gate, and make `needs_human` an explicit stop.

Related: FG-372 (epic), FG-384, FG-418, FG-419, FG-367.
