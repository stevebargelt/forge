---
id: FG-452
type: story
status: active
title: Out-of-band code-touching lane lacks reconcile-time host-verification capture + ancestry matching (FG-443×FG-440 seam; wedges FG-422 in campaign-922)
created: 2026-07-03
---

## Problem

The out-of-band completion lane (`awaiting_gate` items delivered outside the feature pipeline) never received the FG-440 reconcile-time host-verification capture + ancestry-matching that the scope-blocked lane got. For a **code-touching** out-of-band item this is a dead end. Surfaced live: campaign-922c83b7c577 still shows FG-422 as `awaiting_gate` / "Human gate required" despite FG-422 being merged and closed. FG-422 is exactly out-of-band + code-touching merge.

Three coupled defects (findings from post-ship review):

1. **No capture in the out-of-band branch.** `reconcile.ts:111` runs `runAndRecordHostVerification` only in the `isScopeBlocked` branch; the out-of-band `else` branch (lines 147–153) collects + evaluates but never captures. A code-touching out-of-band item with no pre-existing *passing* host-verification row refuses forever.

2. **Exact-sha matching, not ancestry.** `reconcile-outofband-collect.ts:153` matches host-verification rows via `queryHostVerificationRows` → exact `commit_sha = closedCommit` (`host-verifications.ts:81`). The scope-blocked lane uses `queryHostVerificationRowsForGate` (unfiltered) + ancestry/base-reachability (`reconcile-collect.ts`). Coupled with #1: FG-440 records the tested current base HEAD, so even after capture the exact-sha query can never match. Fixing #1 without #2 still fails.

3. **Operator surface hides the real blocker.** `report.ts:156` `outOfBandCompletableAction` only emits text when *already eligible*; `scopeBlockedHostVerificationHint` (`report.ts:176`) bails unless `blockerKind === "scope"`. An out-of-band item still needing host verification gets neither and falls through to generic architect-gate text — the wrong operator action for FG-422.

## Scope

Bring the out-of-band **code-touching** sub-lane to parity with the scope-blocked lane. The `non_code_diff` sub-lane needs no host verification and must stay unchanged.

## Acceptance criteria

- **AC1 — capture in out-of-band lane.** For an out-of-band item whose closing commit touches code, `forge campaign reconcile` runs a real host-verification gate at current HEAD in `projectDir` (reusing `runAndRecordHostVerification`), gated the same as the scope-blocked `needsCapture`: only when closedCommit is reachable on base AND no covering *passing* row already exists. Infra error degrades only that item (no reconcile-loop crash).
- **AC2 — ancestry matching in out-of-band lane.** The out-of-band `host_verification` sub-lane matches rows by ancestry + base-reachability (closedCommit ancestor of testedSha AND testedSha on base), not exact `commit_sha = closedCommit`, so a row recorded at current base HEAD satisfies it. Passing-row model preserved (a failed row never wedges; a later green supersedes).
- **AC3 — negative: no coverage still refuses.** A host-verification row whose commit_sha is NOT an ancestor of the tested HEAD, or a tested HEAD not on base, does NOT satisfy the lane. Written as a negative test.
- **AC4 — non_code_diff unchanged.** A docs-only out-of-band item completes on lane evidence with no capture attempted.
- **AC5 — operator surface.** `forge campaign show` for an out-of-band-but-not-yet-verified code-touching item surfaces the host-verification / `forge campaign reconcile` action, not generic architect-gate text. Assert on the human CLI output, not just JSON.
- **AC6 — live repro.** The FG-422 shape reconciles to `shipped` — proven against campaign-922c83b7c577 (preserved evidence) or a faithful fixture mirroring it (out-of-band, code-touching, closedCommit reachable on base, no prior passing row).
- **AC7** — full host `npm run test:all` green.
