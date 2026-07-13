**Last session ended 2026-07-13 (handoff after the 2026-07-12 queue session).**

**Where we left off:** Operator-directed queue FG-539 → FG-540 → FG-425 → FG-527 ran to its stop condition: FG-539 and FG-540 shipped+closed, FG-425 PAUSED awaiting one operator decision, FG-527 deliberately NOT started (operator is assembling a fresh overnight queue separately — do not auto-start it).

**Picked up next:**
1. **FG-425 — resolve the paused decision, then finish.** Branch `fix/fg425-project-gate-locking` pushed at `ce22024` (11 commits, ticket open, NOT merged). The exclusion core is done and 4-loop-run reviewed; only crash-orphan reap identity is open. Recommended (awaiting operator yes): strictly fail-closed reaping — reap ONLY on affirmative identity match; ALL ambiguity (absent/zombie/unverifiable/mismatch) blocks with the actionable `kill -9 -<pgid>` error; delete the auto-enter-on-reuse branch. Small deletion + test flips, then one loop, merge, close. NOTE: docs/concepts.md was reconciled against the PRE-decision code (maintainer runs ec5a1c + 26addd) — re-check it after the decision. Merging FG-425 CLEARS the FG-396 integration-lock prerequisite (FG-410 already closed); until then it is NOT cleared.
2. **FG-548** (filed this session) — store deferred-write-txn SQLITE_BUSY under multi-process WAL (snapshot upgrade bypasses busy_timeout); surfaced by FG-425's cross-process harness, retry shim in that test cites it. Correctness + parallel-lanes-adjacent.
3. Non-ticket thread — at next queue assembly, file two tickets from this session's evidence: (a) review-loop disposition carry-forward (reviewers re-find operator-dispositioned findings; cost FG-540 ~3 loop runs); (b) dashboard in-flight blindness to host-side loop phases (CI-wait/verify have no run/task rows). Also relevant already-filed: FG-541 + FG-547 (the just-pushed-sha "CI unavailable → local fallback" fired ~8 times this session).

**External state to remember:**
- Branch `fg540-recover-schema-validation-evidence` on origin holds the reviewer-demanded stricter recover-time schema validation, deliberately UNMERGED (referenced from PR #113's disposition) — do not delete.
- Dashboard now runs tmux-owned (launch-dashboard-fstupk, port 8024). Agent image rebuilt; the release-check STALE flag is a known false positive (FG-543) — ignore it until fixed.
- ~/.forge/launches/ accumulated ~15 launch records this session (review-loops, docs runs) — historical evidence, no action.

**Decisions worth not relitigating:**
- FG-540 reviewer-schema-at-recovery = accepted parity, merged on operator authority; the record is PR #113's body. Don't re-litigate in future loops — this is also exhibit A for the disposition-carry-forward ticket.
- FORGE-DEC-024's two stale precedence lines: deliberate non-edit (ADRs amend by supersession); pending orchestrator supersession note, not a docs bug.
- FG-425 identity engineering stops at the supervision boundary — deeper orphan supervision belongs to the strategic-review §3.1 daemon, not this ticket.
- Process lessons: launch-record `running` = the wrapper, not the work (read run rows first); `forge backlog file` prints the assigned id — READ it (FG-544 body was briefly overwritten by assumption, restored from git); concurrent sessions/fixers edit the same tree — dedupe, never assume sole authorship of working-tree changes.

**Shipped (for reference):** FG-539 (PR #112 / `739b0b2`, range inference recognizes `(FG-xxx)` subjects) · FG-540 (PR #113 / `0a2ce3e`, Codex stream recovery — one shared extraction rule at 5 consumers, provenance event, E2E incident replay; 10 loop runs) · FG-542 (closed `931d6e3`, PR #111 baked CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 into forge claude) · FG-543 + FG-548 filed · chore: FG-544 restored intact after accidental overwrite.
