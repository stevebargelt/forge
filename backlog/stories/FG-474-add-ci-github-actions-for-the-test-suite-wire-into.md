---
id: FG-474
type: story
status: active
title: Add CI (GitHub Actions) for the test suite + wire into the merge gate as the required check; stop running the full host suite repeatedly (offload + visibility)
created: 2026-07-06
---

## Problem
Forge has NO CI (`.github/workflows` is empty). Deterministic verification currently runs on the host, repeatedly, and invisibly:
- The review-loop runs typecheck + `npm run test` (root suite) on the host as its pre-review verification.
- The orchestrator then runs `npm run test:all` (root + dashboard) on the host again before merge.
- Result: the ROOT host suite runs twice per ticket (~4 min each), and BOTH host runs are invisible in the dashboard (which only shows agent containers) — during those windows "it looks like nothing is happening" (operator-observed, 2026-07-06).
- Meanwhile the merge policy already gates auto-merge on "every required CI check green" — but with no CI that condition is vacuously true, so the designed gate does nothing.

## Goal
Move the deterministic test/typecheck gate to CI (GitHub Actions) so it runs once, off-host, and VISIBLY (as a PR check); remove the redundant repeated host runs; and make CI the real required check the existing merge policy already references.

## Acceptance Criteria
- A GitHub Actions workflow runs on PRs to `main` (and pushes to feature branches) and executes: `npm ci`, the better-sqlite3 native build, `npm run typecheck`, and `npm run test:all` (root + dashboard workspace).
- Node is pinned to the repo's `.nvmrc` (24) in CI so the better-sqlite3 NODE_MODULE_VERSION ABI mismatch (137 vs 131) seen locally cannot happen.
- The workflow is green on a known-good commit (validate on a throwaway PR) and red when a test fails (validate with a deliberately broken test).
- The merge gate is wired to the CI check: auto-merge requires the CI check green (this already exists in policy — confirm/tighten the operator-facing wording so "required CI check" points at this workflow), and branch protection on `main` requires it (or document why not).
- Orchestrator process updated (orchestrator-policy surface): once CI owns the suite, the orchestrator STOPS running `npm run test:all` locally before merge and instead gates on the PR's CI check. Document the new flow.

## Open questions / design choices (resolve during implementation)
- Should the review-loop keep running host verification at all? If CI owns correctness, the review-loop should arguably ONLY do the red-wide review and treat the PR's CI check as the test gate (removing the last invisible host-suite run). Decide: keep a fast local typecheck-only pre-check, or fully defer to CI.
- Dashboard visibility of CI status: surface the PR check status somewhere the operator sees it (dashboard project card / run view), so the "nothing is happening" gap is closed rather than moved to GitHub. Possibly a follow-up.
- Cost/latency: CI adds push→check latency vs instant local; acceptable given the offload + visibility win, but note it.

## Non-Goals
- Does not remove agent (engineer/test-engineer) in-container self-validation — that's the agent's job and runs in a different environment.
- Does not change what the tests assert; purely moves WHERE/HOW OFTEN they run and how the gate is wired.

## Why it meets the filing threshold
User-visible operator pain (invisible multi-minute host waits + repeated runs), and it activates a merge-gate condition the policy already references but nothing satisfies. Operator-requested (2026-07-06).

## Reference
Merge policy "required CI checks green" (orchestrator template / CLAUDE.md). `.nvmrc`=24. better-sqlite3 ABI issue observed this session (login-shell nvm default = v131 vs project v137). test scripts: package.json `test` (root), `test:all` (root + dashboard).


## Evidence addendum (2026-07-08 autonomous session — operator: "the review loop re-running tests when you just ran tests is a waste of time")

One night's quick-lane shipping (FG-485/488/489/490 + one reopen) ran the full host suite ~10 times (~8 min each). Breakdown per ticket: orchestrator pre-loop test:all + the review-loop's round-1 verification of the SAME commit + a post-merge run at main for the host_verifications row. Orchestrator process change (immediate): drop the pre-loop run — the loop's verification is the gate. Remaining structural need this ticket owns: (a) CI as the required merge check so local suites stop being the bottleneck; (b) review-loop consumes covering verification evidence (CI status or a host_verifications row at the same sha) instead of re-running; (c) the post-merge evidence run comes from CI/reconcile-capture rather than a manual host run.