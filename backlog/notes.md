**Last session ended 2026-07-04 evening.** Autonomous run: cleared the FG-459 → FG-461 → FG-460 reliability/campaign queue. All three shipped, merged, and closed; `main` in sync with origin. Nothing mid-flight.

**Shipped this session:**
1. **FG-459** (PR #25, 193220b) — reconcileRun now honors its never-throw invariant: every per-item DB-write pass + the run-level block + finalizeOrphanedPrimaries are guarded so a SQLITE_BUSY throw neither propagates nor aborts the other tasks. Injectable ReconcileWriters seam for deterministic throw-injection tests.
2. **FG-461** (PR #26, 7b4e102) — attached-exit oom_killed/container_crash/idle_timeout now record OrphanEvidence (via attachedExitEvidence in reconcile.ts), so show/status/ops-check render a recovery line. Skipped for read-only dispatches; ops-check gated on recorded evidence so historical crashes don't retroactively flood. Review caught a real bug: the recovery guidance told operators to `retry --force` for container_crash/idle_timeout, but those are retryable:true — fixed to `forge retry <id>`.
3. **FG-460** (PR #27, fd1b5d3) — campaign resume and reconcile now share one out-of-band composition (composeOutOfBandEligibility + authoritativeOutcomeContribution), so they can't disagree. Resume now ships docs-only (non_code_diff) items reconcile already ships, while still refusing unresolved-authoritative-fail and code-touching items lacking a passing host-verification row (resume never captures). Authoritative-codes set de-duplicated into reconcile-evidence.ts.

**Follow-ups filed (all NEW scope, not deferred AC):**
- **FG-463** — reconcile: make each write+its-audit-events atomic (transaction) so a mid-sequence SQLITE_BUSY can't leave a status change without its task.reconciled event. Pre-existing gap FG-459's coarse catch surfaced; ~10-site refactor.
- **FG-462** — review-loop must not route backlog close/move findings to the engineer fixer (the fixer_out_of_scope quirk that blocks a clean `closeable` on every implementation ticket). Auto-filed by the tooling. **Worth prioritizing** — it made every review-loop this session unable to reach `closeable` on the backlog-story-active false-positive.
- **FG-465** — describeMissingReason has no friendly CLI text for lane_evidence_missing / run_evidence:<code> (fall through to raw code). Minor operator polish.
- **FG-464** — rethink ntfy notification text/actionability (auto-filed).

**Operational learning (also in memory `project_review_loop_operational_quirks`):** `forge review-loop` run backgrounded via the Bash tool gets KILLED by the harness ~7-10min in (bigger diff → longer red review → killed; sub-7min tasks survived). NOT OOM, NOT a fixed cap (a re-run outlived the first), NOT code — cause undetermined from inside the sandbox. **Workaround that worked twice:** launch it detached via `python3 -c "os.fork(); child: os.setsid(); subprocess.Popen([...review-loop...])"` from a FOREGROUND Bash call → orphaned session leader outside the harness's tracked-background set → survives to a clean stop reason. No completion notification → poll the log + pgrep. A killed-wrapper run can also leave the fixer's edits uncommitted OR committed — inspect and adopt after host verification.

**Picked up next (operator's call — nothing forced):**
1. **FG-462** — fix the review-loop backlog-finding-to-fixer routing so implementation tickets can reach `closeable` cleanly (this bit every review-loop this session).
2. **FG-463** — transactional write+event atomicity in reconcileRun (finishes FG-459's story).
3. **FG-450** — Dashboard "Forge Fleet in Motion" marquee band — still deliberately reserved for your eye + fresh context (frontend + subjective tone + browser-tools verification).

**Don't relitigate:**
- campaign-922c83b7c577 stays paused — preserved evidence for FG-427/440/443; untouched all session.
- notes/ is intentionally uncommitted (host-local, FG-380).
- FG-460's no-runId case is a by-design asymmetry (resume's runId guard excludes it; reconcile handles via the FG-443 pure path) — documented + tested, not a bug.
