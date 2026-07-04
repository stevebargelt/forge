**Last session ended 2026-07-04.** Long overnight autonomous run on the reliability/campaign backlog — shipped all four core priorities plus a post-merge review-fix pass, each through engineer → red-wide → fix → host `test:all` (green every merge) → docs → PR → merge.

**Where we left off:** All requested reliability/campaign work is merged and clean; main is in sync with origin. The last thread was a reviewer returning two findings on the merged work — both fixed and merged (PR #17). Nothing is mid-flight.

**Picked up next:**
1. **FG-455 piece 4** — the only ACs left open on FG-455 (which stays active): (a) OOM/SIGKILL/exit-137 classification (`defaultContainerAlive` never inspects `ExitCode`/`OOMKilled`); (b) Mode A — a detached `forge invoke` that finishes but leaves the run falsely `complete` with an empty `result.json` (reconcile only revisits `running` tasks, never backfills a `complete` task's empty result from the container's own `/task/result.json`). Both documented on the FG-455 ticket body.
2. **FG-450** — Dashboard "Forge Fleet in Motion" marquee stats band (last priority-5; FG-449 already done/superseded). Deliberately not started overnight — it's frontend + subjective "catchy" tone + needs browser-tools visual verification, better with a fresh context and your eye. Fully scoped in the ticket.
3. **FG-458** then **FG-457** — the two follow-ups filed this run (campaign reconcile cross-lane consistency; review-loop misclassification). FG-457 in particular is worth fixing before leaning on `forge review-loop` again (see below).

**External state to remember:**
- **campaign-922c83b7c577 preserved** — still `paused`, untouched by all this run's work (verified). Do NOT resume/reconcile/mutate.
- **Benign ops orphan left alone:** `retry_orphan` on `task-build-a1b968` (pending) under the abandoned FG-442 run `run-campaign-execution-lanes-fg-442-f7ca3f`. Harmless (never dispatches); `forge ops repair task-build-a1b968` clears it if you want tidy.
- **`forge review-loop` is currently unreliable (FG-457):** it reported `reviewer_failed` on a reviewer that actually returned a valid `fail` verdict with real findings (only recoverable from the task result.json). This run used direct `forge invoke red-wide` as the review vehicle instead. Prefer that until FG-457 is fixed.
- Host-local `notes/overnight-decisions-2026-07-03.md` (uncommitted, on disk) holds the full 12-decision journal for this run — kept out of source PRs (FG-380).

**Decisions worth not relitigating:**
- FG-455 left OPEN on purpose — pieces 2&3 (the scoped work) shipped; piece 4 (OOM + Mode A) is remaining scope, not a closeable-and-follow-up situation.
- FG-437 ticket text named a container (`forge-provision-<taskId>`) that does not exist — the real one is `forge-provision-<cacheKey>`; implementation targets the real name. Don't "fix" it back.
- Dashboard FG-450 not started (subjective/visual; last priority; fresh context better) — not a capability gap.
- Long invokes dispatched detached (`nohup … & disown` + separate PID observer), not the fanout pipeline — held all night with zero wrapper-kill losses; the pipeline's attached `forge next` is the exact failure FG-455 addresses.

**Shipped (for reference):**
- FG-455 pieces 2&3 (PR #13) — fanout-parent reconcile, `forge cancel --abandon-run`, new `forge recover` (inspect/--continue/--re-drive), retry/show fanout guards.
- FG-441 (PR #14, closed) — `campaign resume` reconciles a manually-driven `awaiting_gate` item from durable evidence.
- FG-437 (PR #15, closed) — reconcile recovers a task crashed mid dependency-provisioning + reaps the orphan provisioner.
- FG-434 (PR #16, closed) — `forge dependency-cache prune` for shared cache volumes/markers.
- Review fixes (PR #17) — `forge recover --re-drive` guarded to `fanout_wave_orphaned` only; corrected provisioner name in failure telemetry.
- Filed: FG-457 (review-loop misclassification), FG-458 (campaign reconcile cross-lane consistency).
