**Last session ended 2026-07-06 (autonomous batch of 9 tickets + FG-475 review).**

**Where we left off:** After the autonomous batch, the user asked whether FG-475 (the campaign-runner wedge I filed) was ready to start. Reviewing my own evidence caught that the ticket claimed a "re-park loop / spinning" — my resume log has exactly ONE refusal line then a hang, so it's a HANG, not a loop. Tightened FG-475 accordingly (retitled, corrected wording to match evidence, added a root-cause code pointer + an OPEN fix-direction note). Session otherwise complete.

**Picked up next:**
1. **FG-475** (active, now tightened → ready to plan) — fix the campaign wedge: a full_feature item whose run is terminally FAILED (operator gate-reject) leaves the item `awaiting_gate` and `resume` hangs without advancing to independent items. One design decision to make at plan time (stated in the ticket): **resume auto-reconciles the terminal-failed run** (my lean — no new verb, mirrors the working advance-path reconcile) vs an explicit `forge campaign skip` verb. Root-cause pointer: `src/campaign/executor.ts` has no branch for a terminal-failed full_feature run.
2. **FG-425** (active, deferred w/ complete spec at `notes/fg425-architecture-spec-2026-07-06.json`) — implement the projectDir-keyed HYBRID lock (in-process async mutex for runNext's Promise.all wave + the campaign-executor no-run-lock path, PLUS a cross-process file lock; canonical key; span merge→gate→finalize at all 4 runNext.ts sites). MUST validate with a host stress-loop (100x+), not a single green run.
3. **FG-456** (active, deferred w/ decomposition at `notes/fg456-architecture-decomposition-2026-07-05.json`) — implement autonomous mode as a persisted `autonomous` attr on Campaign (not a new command), reusing the reserved `human_decision` BlockerKind. Slice D (executor wiring) changes the autonomous-self-merge governance policy + is a bootstrap hazard → gets HUMAN PR review, not autonomous self-merge.

**External state to remember:**
- Non-ticket housekeeping: run `forge upgrade` (or install-seeds) to propagate the FG-340 reworded test-engineer seed into `~/.forge/agents/` so future test-engineer invokes stop self-committing. The repo source is fixed; the installed copy is not yet refreshed.
- Campaign `campaign-e89beee993ec` was ABANDONED (terminal) after it shipped FG-426+FG-424 inside it and wedged on the deferred FG-425. Do not try to resume it.
- Full decision journal (D1–D12) + deferred review-notes live host-local at `notes/autonomous-session-2026-07-05d.md` (uncommitted per FG-380).

**Decisions worth not relitigating:**
- FG-425 implementation DEFERRED: data-integrity concurrency where a half-right lock is worse than none; 2 architect rounds surfaced it needs in-process+cross-process hybrid locking + stress-loop validation. Spec captured; not a product fork.
- FG-456 implementation DEFERRED: inferable design, but slice D changes the self-merge governance policy (an operator call) + bootstrap hazard → human-in-loop. Architecture delivered.
- Campaign-as-surface only partly worked: FG-426/424 ran inside it; FG-429 was orchestrator-direct (no container lane); FG-414/377/360/340 ran via DIRECT execution after the wedge. FG-475 filed for the wedge — don't re-derive it.
- FG-475's auto-reconcile-vs-skip-verb choice is intentionally left OPEN for the plan/architecture step (leaning auto-reconcile).

**Shipped (for reference):** FG-429 (#44, resolve-route-from-policy seed) · FG-426 (#45, integration_failed→scope) · FG-424 (#46, integration gate infra-vs-real classification) · FG-414 (#47, ops stuck_run + in-flight count) · FG-377 (#48, persistence-check settle window) · FG-360 (#49, backlog retitle + no-reslug) · FG-340 (#50, test-engineer seed no-commit). Filed: FG-475 (campaign wedge). Deferred: FG-425, FG-456.
