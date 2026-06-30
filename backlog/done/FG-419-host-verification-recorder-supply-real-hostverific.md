---
id: FG-419
type: story
status: done
title: "Host-verification recorder: supply real host_verification evidence to done-audit (unblocks Shipping Reviewer authoritative promotion)"
created: 2026-06-30
closed: 2026-06-30
closed_commit: 3ee71d9
---

## Problem

The done-audit's `host_verification` check is always `unknown` for real items because nothing records host-side verification evidence. `collectDoneAuditInputFor` passes `hostVerified: null`, so `host_verification` can never be a definite `pass`. Two things are blocked on this by design:

1. A real done-audit `pass` (and therefore campaign `all_shipped`) is unreachable for real items — done-audit is truthful-but-conservative: missing required evidence → `unknown`, never `pass`.
2. The Shipping Reviewer cannot be promoted from advisory to authoritative. FG-418 wired it into the `feature` build phase as advisory precisely because a gating reviewer over an always-`unknown` host_verification would block all real work. The documented promotion gate is "a host-verification recorder exists to supply evidence."

## Goal

Build a mechanism that records host-side verification (e.g. the orchestrator's `npm run test:all` on the host, or an equivalent project-defined host gate) ran and passed for a given ticket/run, and feed that evidence into the done-audit input so `host_verification` can resolve to a definite `pass`/`fail` instead of always `unknown`.

## Acceptance Criteria

- A recorder writes host-verification evidence (at minimum: verified yes/no, what command/gate was run, when, against which run/ticket/commit) to a durable store the done-audit collector can read.
- `collectDoneAuditInputFor` reads real `hostVerified` evidence instead of hardcoding `null`.
- `host_verification` resolves to a definite `pass` (or `fail`) when evidence is present; absence still yields `unknown` (the conservative default is preserved — no silent `pass` on missing evidence).
- A done-audit `pass` is demonstrably reachable for a real item once evidence is recorded (integration test through the real collect→evaluate path).
- The evidence is tamper-evident enough to be trustworthy as a gate (records the actual command + result, not an operator assertion alone) — decide and document the trust model.
- Operator surface: the recorded host-verification status is visible (done-audit report / show).

## Non-Goals

- Do NOT promote the Shipping Reviewer to authoritative in this ticket — that is a separate follow-up that becomes possible once this lands (FG-418 documents the gate). This ticket only unblocks it.
- Do NOT change the done-audit aggregation rules beyond wiring real `hostVerified` into the existing `host_verification` check.
- Do NOT weaken the conservative default (missing evidence must still be `unknown`, never `pass`).

## Context

- done-audit collector: `src/done-audit/collect.ts` (`collectDoneAuditInputFor` — currently `hostVerified: null`).
- done-audit evaluator: `src/done-audit/done-audit.ts` (`host_verification` check; `container_verification` is informational and never satisfies host_verification).
- Reviewer/advisory adoption that this unblocks: FG-418 (and `docs/concepts.md` Shipping Reviewer section, which names this recorder as the promotion gate).
- Conservative-by-design rationale: FG-383.

Related: FG-383 (done-audit), FG-418 (advisory adoption + promotion gate), FG-372 (Shipping Reviewer epic), FG-384 (reviewer build/guardrail).

## Decision — trust/gate model (settled at architect gate)

Required-gate model, v1 deliberately narrow. Distinguish "recorded host command evidence" from "required host gate satisfied":

- The recorder may store evidence for ANY host verification command.
- done-audit treats `host_verification` as **pass** ONLY when matching evidence satisfies the **required host gate** for that project/run — not merely that some host command passed.
- v1 supports ONE required gate, defaulting to `npm run test:all` for Forge itself, with a clear config/metadata path for a project-defined equivalent.
- Matching evidence must still match ticketId + projectDir + ticket.closedCommit (architect's composite key).
- Missing required-gate evidence → `hostVerified: null` (unknown).
- Matching required-gate evidence with nonzero exit → `hostVerified: false` (fail).
- Extra passing commands (e.g. typecheck) may surface as SUPPORTING evidence but MUST NOT satisfy `host_verification` by themselves.

Store/trust/matching mechanics per the architect: `host_verifications` table in `forge.db` via `CREATE TABLE IF NOT EXISTS` in SCHEMA_SQL (additive, not an applyMigrations ALTER); glass-box trust (record actual command string + exit code, reject bare assertions, surface the command); any-fail-wins aggregation; `evaluateDoneAudit` stays pure. Projects can grow richer required-gate lists later; v1 ships one canonical required gate.

Docs must say: `host_verification` means the required host gate passed (not merely that some host command passed); the recorded command/result is surfaced for glass-box trust; richer required-gate lists are a later slice.
