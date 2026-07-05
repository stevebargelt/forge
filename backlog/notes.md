**Last session ended 2026-07-05.**

**Where we left off:** Cleared the FG-459 → FG-461 → FG-460 reliability/campaign queue autonomously (all shipped, merged, closed), then did housekeeping: pruned merged remote branches and, on operator direction, **abandoned campaign-922c83b7c577** (no longer needed as evidence). `main` in sync with origin; nothing mid-flight. Two operator catches late in the session both resolved cleanly and are captured under Decisions.

**Picked up next:**
1. **FG-462** — review-loop must not route backlog close/move findings to the engineer fixer. Highest-leverage: it made EVERY review-loop this session unable to reach `closeable` (reviewer flags the ticket's own still-active backlog file → `fixer_out_of_scope`, poisoning every round). Fixing it makes the review-loop → auto-merge path clean.
2. **FG-463** — wrap each reconcileRun write + its audit events in a transaction so a mid-sequence SQLITE_BUSY can't leave a status change without its `task.reconciled` event. Finishes FG-459's story (its coarse never-throw catch left this atomicity gap; ~10-site refactor).
3. **FG-450** — Dashboard "Forge Fleet in Motion" marquee band — still deliberately reserved for your eye + fresh context (frontend + subjective "catchy" tone + browser-tools visual verification). Untouched across sessions by intent.
4. **FG-465** — small: `describeMissingReason` has no friendly CLI text for `lane_evidence_missing` / `run_evidence:<code>` (fall through to raw code).

**External state to remember:**
- **backlog/notes.md is uncommitted** (this handoff block). 0 commits ahead of origin, but the notes edit is not yet committed/pushed — operator was asked and hasn't said yes to pushing. Commit as a `chore(backlog)` if you want it durable on origin.

**Decisions worth not relitigating:**
- **campaign-922c83b7c577 is ABANDONED (terminal, irreversible)** — operator released it; its 3 tickets (FG-357/376/422) had all shipped independently so nothing was stranded. Its preserved-evidence memory + MEMORY.md pointer were deleted. Don't re-preserve it.
- **review-loop backgrounded via Bash `run_in_background` is unreliable here** — twice it came back `status: killed` (terminated by a signal; **killer UNIDENTIFIED and NOT time-bound** — do not re-assert "the harness" or "~7 min", both were over-claims that got retracted). Workaround that worked both times: launch DETACHED via `python3 -c "os.fork(); child os.setsid(); subprocess.Popen([...review-loop...])"` from a foreground Bash call → survives; poll log + pgrep (no completion notification). Detail in memory `project_review_loop_operational_quirks`; capture the signal source live if it recurs.
- **FG-461's no-OOM-confirmation model:** attached-exit leaves `oomKilled` UNSET (unknown) — only reconcile, which reads Docker's real `OOMKilled` via `docker inspect`, may assert confirmed OOM. Message stays "exit 137 — possibly OOM or an external kill". (This was the operator catch that reopened+re-closed FG-461 via PR #28.)
- **FG-460's no-runId asymmetry is by design:** resume's `item.runId` guard excludes no-runId items (they re-park); reconcile handles them via the FG-443 pure path. Documented + tested, not a bug.
- **Merged 4 PRs under the session directive's "findings resolved under policy" branch** (not review-loop `closeable`, which FG-462 blocked): all code/AC findings resolved + `test:all` green each time.
- **1 benign ops incident persists** — `orphaned_work_may_persist` on `task-engineer-67e458` (FG-455 fixer orphan; work merged, evidence is just the untracked `notes/`). `investigate`-type, not repairable, no dismiss verb. Harmless. `notes/` stays uncommitted (host-local, FG-380).

**Shipped (for reference):**
- FG-459 (PR #25) — reconcileRun honors its never-throw invariant on every DB-write pass; injectable ReconcileWriters seam.
- FG-461 (PR #26 + accuracy fix #28) — attached-exit oom_killed/container_crash/idle_timeout record OrphanEvidence → show/status/ops render a recovery line; #28 removed the fabricated-OOM over-claim.
- FG-460 (PR #27) — campaign resume + reconcile share one out-of-band composition; resume ships docs-only items reconcile ships, still refuses unverified code.
- Filed this session: FG-462, FG-463, FG-464 (ntfy text), FG-465.
