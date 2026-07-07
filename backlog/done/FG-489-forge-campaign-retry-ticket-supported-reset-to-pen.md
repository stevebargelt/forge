---
id: FG-489
type: story
status: done
title: "forge campaign retry <ticket>: supported reset-to-pending for transiently-failed campaign items; recovery guidance stops saying hand-edit the DB (review F6)"
created: 2026-07-07
closed: 2026-07-07
closed_commit: 6e8f4d1
---

Source: independent engineering review 2026-07-06 (notes/forge-engineering-review-2026-07-06.md), finding F6 / backlog rec #8.

## Problem

A campaign item that fails for a transient reason (expired auth, container/infra crash, idle timeout — the most common real overnight interruptions) is permanently lost to the campaign:

- `driveRemainingItems` skips complete/failed items (`src/campaign/executor.ts` ~682-696) and nothing ever resets a failed item to pending.
- No `retry`/`reset` verb exists in `src/cli/commands/campaign.ts` (start/resume/escalate-lane/abandon/reconcile/approve/show/report/plan only).
- `forge campaign reconcile` cannot help — it requires passing ship evidence, and an item that never ran has none.
- `recoveryGuidanceMessage` (`src/cli/commands/campaign.ts` ~29) literally instructs the operator to hand-edit the DB.

Consequence: every overnight transient failure needs manual surgery; this is one of the main gaps between "campaign as default autonomous surface" and reality (review section 3, blocker #2).

## Goal

An operator (or orchestrator) can return a transiently-failed campaign item to `pending` through a supported CLI verb, and resume then re-dispatches it normally. Recovery guidance names the verb instead of manual DB edits.

## Scope decision (recorded at filing)

Ship the explicit verb only. The review's "and/or auto-reset transient blockers on resume" half is deliberately deferred: silent auto-retry of e.g. an auth failure while auth is still broken re-burns the item without operator signal; revisit alongside F9-style notifications once pause/failure events push.

## Acceptance criteria

- [ ] New verb `forge campaign retry <campaign-id> <ticket-id>` resets a `failed` item to `pending` (clearing per-attempt state so dispatch is clean), guarded: campaign must be paused (not running/terminal).
- [ ] Eligibility is classification-aware: transient shared-blocker kinds (auth / infrastructure / idle-timeout / container-gone) retry directly; a scope/verdict-failed item refuses with guidance (no silent retry over a red/verdict failure).
- [ ] After retry, `forge campaign resume` re-dispatches the item through the normal drive path and it can reach `shipped` (test may stub the drive).
- [ ] `recoveryGuidanceMessage` (and any other operator guidance for this shape) names the retry verb; no guidance instructs manual DB edits for transient failures.
- [ ] Tests: pause on an auth-classified failure → retry → resume → assert re-dispatch; retry refusal on a running campaign; retry refusal on a scope-blocked item.