---
id: FG-581
type: story
status: done
title: "FG-572 Child 5f: a post-promotion RACI compile failure only warns, leaving the previous runtime's routing-policy.yml silently authoritative"
created: 2026-07-17
closed: 2026-07-22
closed_commit: dcc19ec
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

## Acceptance Evidence

Shipped in squash-merge `dcc19ec` (PR #152). Tests in `src/cli/commands/upgrade.integration.test.ts` drive the real `runUpgrade` path under the suite's disposable `FORGE_HOME`.

| AC | Evidence | Verdict |
|----|----------|---------|
| Post-promotion compile failure produces a named, actionable refusal; the previous runtime's `routing-policy.yml` does not remain silently authoritative — observed RED before the fix | `upgrade.ts` compile-failure branch (the `{ok:false}` else at ~line 614) sets `routingPolicy='failed'` and neutralizes the stale policy (quarantine → unlink fallback → loud "still authoritative" if both fail); test `FG-581 (RED): a failed post-promotion compile does NOT leave the previous routing-policy.yml authoritative — it is quarantined` (:522) asserts on-disk non-consumption and fails against pre-fix code; `FG-581 (downstream fail-closed)` (:797) proves a consumer that used to route from the stale policy now fails closed (`policy_not_found`) | met |
| The operator is told exactly which RACI construct the new compiler rejected | Compiler's verbatim `res.error` threaded into the human warning, the `--json` `UpgradeResult.routingPolicyError` field, and the repair guidance; test `FG-581: the refusal NAMES the rejected RACI construct … on the human warning AND --json` (:547) and `FG-581 (AC c): the REAL --json serialization path emits … routingPolicyError verbatim` (:757) | met |
| Coverage spans production upgrade path, stale-policy non-consumption, human output, JSON, exit status, repair guidance | Real `runUpgrade` path throughout; non-consumption (:522, :797); human output + exit 1 + INCOMPLETE (:547); real `--json` serialization parse (:757); repair guidance (:575); fail-closed rename-failure fallback (:655) and double-failure (:694); promoted-**release**-mode acceptance (:862) | met |
| Successful-upgrade behavior is preserved | `FG-581 (success preserved): a VALID host RACI still recompiles routing-policy.yml cleanly — exit 0, ok:true, no new friction` (:635); `FG-581 (dry-run)` (:610) proves a compile-failure forecast mutates no disk | met |
| Tests use a disposable FORGE_HOME | Whole suite uses the disposable `FORGE_HOME` from `src/test-setup.ts`; the configurable-`FORGE_HOME` (:575) and release-mode (:862) tests additionally assert `FORGE_HOME` is not the default `~/.forge` and that closeout/repair paths resolve under it | met |

Required CI green at merge (`test` + `test-extended`). Deferred (test-completeness / broader-scope, non-blocking): FG-603 (release-mode `--json`/construct assertions — mode-agnostic, already proven in dev mode), FG-601 (terminal-escape hardening), FG-602 (startRun route-receipt gap).
