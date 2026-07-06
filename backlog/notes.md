**Last session: autonomous batch (2026-07-06) — FG-456/429/426/424/425/414/377/360/340.** 7 shipped, 2 deferred with captured specs, 1 follow-up filed.

**Shipped & closed (7):**
- FG-429 (#44) — orchestrator seed: resolve route from policy, don't ask operator to adjudicate a policy-decisive route (+ decisive/ambiguous examples). Orchestrator-direct.
- FG-426 (#45) — campaign policy: `integration_failed` classifies as item-scoped `scope`, not the `campaign_system` default. Ran INSIDE the campaign.
- FG-424 (#46) — integration gate distinguishes infra/platform failures (timeout/signal-kill) from real test failures: new `integration_gate_timeout` (retryable) / `integration_gate_crashed` (non-retryable, SHARED infrastructure) kinds, structural process-evidence only (no content-matching), fail-closed. Full pipeline INSIDE the campaign; post-merge I fixed a build-red finding (show.ts next-command guidance) + dispositioned an over-strict review-loop finding (documented false-negative bound).
- FG-414 (#47) — ops check detects stuck active-run/all-terminal-tasks orphans + `ops repair` for them; projects-show/dashboard in-flight count reconciled. Direct exec (review-loop caught+fixed a real liveness-coercion bug).
- FG-377 (#48) — persistence-check bounded settle/retry window (macOS mount-sync false-positive). Direct exec.
- FG-360 (#49) — `forge backlog retitle` verb + edit no longer re-slugs/orphans the file. Direct exec (removed a fixer over-correction that violated the no-move AC).
- FG-340 (#50) — test-engineer seed reworded so it writes durable test files and does NOT git commit (commit is orchestrator closeout). Direct exec (documentation-maintainer). NOTE: run `forge upgrade` (or install-seeds) to propagate the reworded seed into ~/.forge/agents/ so future test-engineer invokes pick it up.

**Deferred (open, with captured analysis — NOT started/partial):**
- FG-456 (autonomous mode) — architecture pass returned INFERABLE with a full 5-slice decomposition (saved `notes/fg456-architecture-decomposition-2026-07-05.json`). Recommended: persisted `autonomous` attr on Campaign (not a new command), reusing the reserved `human_decision` BlockerKind. **Slice D (executor wiring) changes the autonomous-self-merge governance policy + is a self-modification/bootstrap hazard → warrants HUMAN PR review, not autonomous self-merge.** Deferred implementation to an attended session; the hard part (decomposition) is delivered.
- FG-425 (per-projectDir gate locking) — 2 architect rounds + reds produced a COMPLETE spec (saved `notes/fg425-architecture-spec-2026-07-06.json`): a projectDir-keyed HYBRID lock = in-process async mutex (for runNext's Promise.all wave concurrency + the campaign-executor no-run-lock path) + cross-process file lock, canonical projectDir key, held across merge→gate→finalize at all 4 runNext.ts sites, deterministic release. Deferred: data-integrity concurrency where a half-right lock is worse than none; needs a focused session with HOST STRESS-LOOP validation (100x+).

**Campaign vs direct (which ran where):** Campaign `campaign-e89beee993ec` (sequential, per-item lanes) shipped FG-426 (quick) + FG-424 (full_feature) INSIDE it. FG-429 was orchestrator-direct (no container lane). FG-425 was deferred by rejecting its architect gate — which WEDGED the sequential campaign (item stuck `awaiting_gate` over a failed run; resume re-park-looped and never advanced to independent items; required a manual process-kill). Recovery: killed the resume process tree, paused, then ran FG-414/377/360/340 via DIRECT execution (invoke → review-loop → PR → merge → close). Campaign then ABANDONED (all its work resolved).

**Backlog delta:**
- Closed (7): FG-429, FG-426, FG-424, FG-414, FG-377, FG-360, FG-340.
- Opened (1): **FG-475** — "Campaign wedges on an operator-deferred full_feature item" (met threshold: campaign-runner correctness + operator pain — a sequential campaign can't advance past a rejected/failed full_feature item; recovery is a manual kill). Durable evidence of the wedge; the campaign-runner limitation, not an FG-425 issue.
- Left open (2, deferred): FG-456, FG-425 (specs captured, above).

**Tests/reviews:** every implementation ticket went through the bounded review-loop (red-wide + fixer) or the full pipeline reds; host `npm run test:all` green per-item and a final aggregate run on main (de5631e). Review-loops caught real bugs (FG-414 liveness coercion; FG-424 next-command guidance) that were fixed before merge.

**Autonomous decisions:** all "would-have-asked" calls journaled in `notes/autonomous-session-2026-07-05d.md` (D1–D12: execution-surface decomposition, FG-429/FG-456 bypass rationale, gate dispositions incl. FG-424 architect advance + plan request-changes for fanout-safety + build force-advance, FG-425 defer, campaign bypass). Deferred review notes (below the filing threshold, NOT filed) are in that journal's "Deferred review notes" section (FG-426 campaign-runner-plan.md staleness — resolved by FG-424 docs phase; FG-414 dashboard `awaiting_human_input` dead code per FORGE-DEC-020).

**Blockers:** none active. FG-425 and FG-456 need attended sessions (concurrency stress-loop / governance-slice human review, respectively).

**Picked up next:**
1. **FG-475** (active) — fix the campaign-runner wedge (advance past a rejected/failed full_feature item; a `campaign skip` verb or resume auto-handling the terminal-failed run). Unblocks clean operator-deferral of campaign items.
2. **FG-425** (active) — implement the captured hybrid-lock spec (`notes/fg425-architecture-spec-2026-07-06.json`) WITH host stress-loop validation. Highest data-integrity value; needs focus.
3. **FG-456** (active) — implement autonomous mode per the captured decomposition (`notes/fg456-architecture-decomposition-2026-07-05.json`); slice D (executor wiring) gets HUMAN PR review, not autonomous self-merge.
4. Housekeeping: `forge upgrade` to propagate the FG-340 reworded test-engineer seed into ~/.forge.
