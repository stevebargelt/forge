**Last session ended 2026-07-10 (operator-directed 4-item sequential reliability queue: COMPLETE, 4/4 landed; campaign-7a56519b2f3d abandoned as the closing act).**

**Where we left off:** Queue done end-to-end and all threads closed. Item 2 (FG-516) stopped the queue mid-session on review churn; the operator's intervention (treat the residuals as AC violations; fix the missing BOUNDARY, not sites; authorize the dedupe-scope machinery change) unblocked it, and items 3-4 converged normally. Every merge rode closeable + trusted tip + both required CI checks green — zero merge exceptions. Last user direction was the campaign abandon (done, terminal).

**Picked up next:**
1. Normal backlog order resumes. Strong candidates deliberately left out of the queue by the operator: FG-513 (reviewer profile rotation claude→codex between loop rounds + model_error resilience — needs image rebuild + live smoke, better done attended) and the merge-exception ledger (non-ticket thread: small, policy-adjacent, operator wants to shape it interactively).
2. FG-477 (lifecycle evaluator): body now records FG-512+FG-519 as shipped narrowing slices; the evaluator should ABSORB resolvePhasePrimary, not re-derive it. Slice 1 (the classifier) is the dispatch-ready next move.
3. New fail-safe follow-ups filed this session, none urgent: FG-517 (campaign-scoped milestone channel for the zero-runs pause corner), FG-518 (resume-probe + reattach-twin workflow-load-failure parks push stale gate context — both sites marked known-gap in the typed ParkContext).

**External state to remember:** `forge upgrade` release check flags the agent-dev-worker image as STALE (Dockerfile newer than built image) — rebuild via docker/build.sh next time an agent misbehaves on runtime deps, or fold into FG-513's rebuild. Ops-check baseline: 7 pre-existing orphaned_work_may_persist rows + FG-425 stuck run (unchanged) + one benign FG-516-session artifact (task-test-engineer-c96170 failed → recovered via forge retry — the FG-507 path's first live dogfood, it worked). Review-loop trails: ~/.forge/runs/run-review-loop-fg-51{4,6,2,9}-*/review-loop.md (FG-516 has SEVEN loop dirs — the churn record). Operator-visible notification behavior changed this session: unattended campaign parks and live ops check now push (docs/how-to-set-up-notifications.md documents both, incl. the FG-518 exception).

**Decisions worth not relitigating:**
- Campaign-7a56519b2f3d ABANDONED (operator call): its failed/campaign_system + awaiting_gate item states were cosmetic damage from the pre-FG-502 gap; underlying tickets shipped long ago. Terminal — never reconcile/retry/resume it; the reconcile/retry dogfood waits for a genuinely wedged campaign.
- FG-516 convergence lesson (operator-articulated, twice proven): when a review-loop keeps finding variants, the BOUNDARY is missing — close classes by construction (park.ts owns the only running→paused CAS; typed ParkContext for payload; import-level guard tests), never by per-site fixes or scan-pattern arms races. Eleven loops; only the two by-construction moves produced passes.
- Campaign-pause dedupe is GLOBAL-scoped (emitMilestone dedupeScope 'global', json_extract over events) — run-scoped dedupe violates AC across retries. The composed ParkContext arm deliberately does NOT persist blockerKind (awaiting_gate && !blockerKind is the out-of-band reconcile marker).
- FG-508 descoped to the CLI-pin fix and closed; FG-513 owns the resilience scope. FG-514 shipped remote-head EQUALITY trust — an offline review-loop is not-closeable BY DESIGN. FG-515 lesson: don't pre-file follow-ups a loop fixer might absorb. Done-ticket prose gets supersession NOTES appended, never rewrites (FG-250 precedent).

**Shipped (for reference):**
- FG-514 (PR #93 f135f95 + docs #94): reviewed-tip equality trust, remote_ahead/diverged outcomes, bounded fail-closed fetch. FG-515 closed same merge.
- FG-516 (PR #95 b1490bd): unattended-park + live-ops-check notifications — park.ts boundary, typed ParkContext (20 sites), global dedupe, ~2k lines of tests. FG-517/FG-518 filed as scoped deferrals.
- FG-512 (PR #96 a9fe0e2 + docs #97): total runner dispatch provenance (8 sites + retry re-mints); a step named "task" is retryable; legacy refusal legacy-only.
- FG-519 (PR #98 241cacf): canonical resolvePhasePrimary (latest COMPLETE) across deriveUpstream/ready-queue/fanout; healed-duplicate phases hand downstream real results.
- FG-508 closed (descoped); FG-513 filed. Campaign-7a56519b2f3d abandoned.
