---
id: FG-515
type: story
status: active
title: "review-loop trust polish: diverged-branch outcome + run-note persistence on no-dispatch exits (FG-514 follow-ups F1/F2)"
created: 2026-07-10
---

Two fail-safe findings from FG-514's test-engineer pass (run run-fg-514-reviewed-tip-equality-trust-f0ba1a), batched: neither can cause a wrong-ship (closeable is correctly withheld in every case) — both are operator-message/durability polish.

1. FG-514-F1 (low): a DIVERGED branch (local commits the remote lacks AND remote commits the reviewer never saw) collapses to local_only, because resolveReviewedTipTrust (src/cli/commands/review-loop.ts, resolveReviewedTipTrust) tests remoteRef..tip first and returns early. Closeable is correctly withheld and exit is 1 — the invariant holds — but the operator is told "Push the branch and re-run", which git rejects as non-fast-forward on a diverged branch, and the remote-only commits are never named. Fix: compute both ranges before branching; add a diverged outcome (or extend local_only with unreviewedCommits) whose next action is pull/rebase. A regression test pinning the current collapse exists: "FG-514 resolveReviewedTipTrust: a DIVERGED branch ... is never trusted" (src/cli/commands/review-loop.integration.test.ts) — update it to the new outcome when fixing.

2. FG-514-F2 (informational, pre-existing since the FG-487 era): the review-loop run note persists only if existsSync(runDir(runId)) — createInvokeRun creates the run ROW but the run DIR is only materialized by invoke()'s first task dispatch. A loop that returns before any dispatch (e.g. verification_failed on round 1) prints the note but persists nothing. FG-514 raised the stakes: the note now durably carries trust facts (REMOTE-AHEAD, unreviewed shas, fetch errors). Impact bounded — every closeable-true path has dispatched a reviewer — but the note writer should mkdir the run dir itself rather than silently skipping persistence.

Acceptance:
- [ ] diverged branches get a distinct outcome naming BOTH the local-only and remote-only commits, with pull/rebase (not push) as the next action; still never trusted
- [ ] the run note persists on every loop exit path (writer creates runDir if missing), with a test through a no-dispatch early-return path
