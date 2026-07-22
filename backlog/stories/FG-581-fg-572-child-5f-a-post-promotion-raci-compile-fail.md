---
id: FG-581
type: story
status: active
title: "FG-572 Child 5f: a post-promotion RACI compile failure only warns, leaving the previous runtime's routing-policy.yml silently authoritative"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`, at `12b13c2`.

## Problem

`routing-policy.yml` is a pure derivative — `src/raci/host-policy.ts:4-5` states "humans must never
hand-maintain it." It is NEVER installed; it is COMPUTED from the installed operator-authored RACI by
`compilePolicyFile` (`host-policy.ts:26`) at `upgrade.ts:174`.

The real cross-promotion coupling is **the compiler**: a promoted runtime whose `src/raci/compile.ts` has
moved may reject an operator's older hand-edited RACI. `compilePolicyFile` returns `{ok:false}` rather than
throwing (`host-policy.ts:33-36`, by design), and `upgrade.ts:177` **warns and continues** — leaving in
place a `routing-policy.yml` that the PREVIOUS runtime compiled, now consumed by the new one.

That is a genuine silent mis-run across a promotion, and it is warn-not-fail today. Routing policy decides
which agent does what: a stale compiled policy silently routing under a new runtime is exactly the
"no installed surface silently loads mutable host code that contradicts the promoted runtime" AC of the
FG-572 parent. Verified RED at `12b13c2`: the compile failure warns; the stale policy stays authoritative.

## Goal

After a promotion, if the promoted runtime cannot compile the installed operator-authored RACI, the previous
runtime's `routing-policy.yml` must not remain silently authoritative. `upgrade.ts:176-179` escalates the
post-promotion compile failure from a warning to a **named, actionable refusal** that identifies the rejected
RACI construct, and the stale compiled policy does not stay silently in force. Successful-upgrade behavior is
preserved unchanged.

## Scope

`upgrade.ts:176-179` escalates a post-promotion compile failure from warn to a **named refusal**, so a stale
`routing-policy.yml` compiled by the previous runtime cannot stay silently authoritative.

Fail-closed direction matters: refusing to leave a stale authoritative policy is safer than continuing with
one. Decide the smallest safe invalidation or quarantine behavior for the stale policy rather than leaving it
silently readable. Do not redesign RACI, routing, promotion, or installed-surface ownership.

## Acceptance Criteria

- A post-promotion compile failure produces a named, actionable refusal; the previous runtime's
  `routing-policy.yml` does not remain silently authoritative. Observed RED against current code before the
  fix (disposable FORGE_HOME).
- The operator is told exactly which RACI construct the new compiler rejected.
- Coverage spans the production upgrade path, stale-policy non-consumption, human output, JSON (if
  applicable), exit status, and repair guidance.
- Successful-upgrade behavior is preserved.
- Tests use a **disposable FORGE_HOME**.
