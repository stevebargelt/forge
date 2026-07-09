**Last session ended 2026-07-09.**

**Where we left off:** The operator-ordered autonomous batch (FG-487, FG-492, FG-362, FG-365, FG-366 via campaign-7a56519b2f3d) plus three same-day operator review rounds on the new reap lifecycle (FG-503 → FG-504 → FG-505) are ALL shipped, merged, and closed — PRs #77-#86, main = ce30408, workspace clean, nothing in flight. The session ended immediately after FG-505's closeout.

**Picked up next:**
1. FG-502 — review-loop/campaign friction (ACTIVE, filed+evidence-updated this session). Highest-leverage platform fix: 8 fixer scope-guard whole-round reverts over in-diff docs, 2 stranded local fixer commits (one where the PASS verdict evaluated a never-pushed tip — correctness), 2 shipped items unrecoverable from failed/blocker=campaign_system. Until it lands, standing discipline: verify the loop-reviewed tip sha == PR head before every merge.
2. Campaign cleanup decision (non-ticket): campaign-7a56519b2f3d is effectively done but shows FG-487/FG-492 items as failed/campaign_system (cosmetic, FG-502 gap) — abandon it or leave it; do NOT re-dispatch.
3. Normal backlog order: FG-402/FG-395 (dashboard attention inbox / campaign view — both pair naturally with FG-487's new verification surfaces), FG-425 gate locking (pre-existing stuck run run-fg-425-e1dd27 still wants `forge ops repair` — operator call, unchanged), FG-496 DB-backed backlog.

**External state to remember:** Pre-existing ops-check orphan rows (FG-491/FG-501 evidence, tickets closed) still cleanable whenever convenient. Branch protection unchanged (test + test-extended required, enforce_admins off). Per-loop logs for every launch this session live in notes/ (fg487/fg492/fg36x/fg50x-*.log, campaign-7a56519b2f3d.log); decision journal at notes/autonomous-session-2026-07-09.md.

**Decisions worth not relitigating:**
- Reap lifecycle end-state (FG-492/503/504/505): retention keys on TASK OUTCOME not exit code; every reap uses `docker rm -f -v` (else the DEC-019 anonymous shadow volume leaks); sweep candidacy is DISK-TRUTH-driven (docker ps -a vs terminal task rows, never event enumeration); `container.reaped` resolution events clear `container_reap_failed` incidents (detector stays pure-DB); absence-heal closes the lost-write window; dry-run never claims completed actions; provisioner keeps --rm (FG-437).
- FG-487 events: pairing is per-invocation attemptId, never latest-unmatched-by-key; reconcile gate events are runId-nullable payload-keyed; no new lifecycle state tables — query-time derivation, stale-flagged not hidden.
- FG-366 = option 1 (consumer audit cleared: readers key on logFormat/kind, never .name).
- Build-fanout step independence includes TYPE independence — a step importing a sibling's new exports fails isolated typecheck; consolidate coupled contract+consumers into ONE step (request-changes'd twice, both times correctly).
- Red-security retention-window finding accepted + documented (pre-launch policy); dashboard staleness cutoffs hardcoded vs env timeouts journal-deferred (conservative-direction only, documented as hand-synced heuristic).
- Operational: engineer containers must never background validation then end_turn (one $15 death, salvaged from disk); after argv/exec-shape changes run the extended tier locally before pushing; containerized fixers can corrupt dashboard native modules (npm rebuild better-sqlite3); campaign reconcile ships out-of-band items on a two-pass pattern (first refuses lane_evidence_missing, second real-execs).

**Shipped (for reference):** FG-487 #77 (host-side verification visibility), FG-492 #78 (container causal evidence + retention), FG-362 #79 (docs/invariants.md), FG-365 #80 (model policy once per wave), FG-366 #81 (resolved runtime.name), #82 (stranded AC4 test + FG-502 filed), FG-503 #83+#84 (reap-failure events + disk-truth sweep), FG-504 #85 (resolution events + honest wording), FG-505 #86 (absence-heal + dry-run wording). Ten PRs, all loop-passed + CI-green at verified head shas.
