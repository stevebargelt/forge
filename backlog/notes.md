**Last session ended 2026-07-12.**

**Where we left off:** Short session: oriented, then codified operator feedback as orchestrator policy — waits go through ScheduleWakeup, never bash `sleep N` (tmux/`forge launch run` owns the work, ScheduleWakeup owns the reminder, every Bash call short + synchronous, `tmux capture-pane` fallback-only). Landed in seeds/orchestrator-template.md + rendered CLAUDE.md:504 (commit bbe44ca, pushed to origin/main) and saved as persistent memory. The prior session's three next moves were NOT started — they carry forward below.

**Picked up next:**
1. FG-542 — PR #111 already merged the `forge claude` background-task invariant (`380c79c` -> merge `931d6e3`, both CI checks green) before this ticket existed. Run an honest post-merge audit + AC walk; do not claim review-loop authorized the merge. Correct through a new PR if findings remain, otherwise close retrospectively with `931d6e3`.
2. FG-539 — confirmed review-loop range-inference defect: the matcher requires literal `#FG-xxx`, while Forge commit subjects use `(FG-xxx)`. Production `resolveCommitRange("FG-536")` returns none despite matching commits. Implementation-ready.
3. FG-540 — confirmed Codex adapter gap from run-review-loop-fg-536-eaa5be / task-red-wide-0dc174: exit 0 + `turn.completed` + a valid terminal pass JSON, but empty result.json produced `result_missing` and `reviewer_failed`. Distinct from FG-513; recover exact schema-valid terminal JSON rather than blanket-retry structural failures. Implementation-ready.
4. FG-541 — design-only publication/CI handoff decision. CORRECTION: the six "CI unavailable" SHAs were NOT just-pushed registration races; all were review-loop-created fixer commits still local-only. Decide push authority or an honest no-push handoff before implementation. Do not add a registration delay.
5. Non-ticket thread — restart the dashboard (server process still predates FG-521's server-side change; kill by exact PID, restart, browser-tools verify).
6. Non-ticket thread — rebuild the agent image before the next dispatch: `forge upgrade` release check flags agent-dev-worker:latest STALE (build input newer than image) → `docker/build.sh` or `forge upgrade --rebuild-image`.
7. Housekeeping: delete local branches chore/fg533-close, chore/fg535-close, chore/fg536-close (all in origin/main) once local `main` is checkout-able — the locked codex worktree (/private/tmp/forge-codex-fg537, FG-537/FG-538 research) still holds `main`.

**External state to remember:**
- The background-task safeguard is now committed and pushed on `origin/chore/fg536-close` at 380c79c: every `forge claude` child receives `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, including Bedrock launches and hostile inherited values. It is not yet on origin/main; preserve and ship it through the normal trust gates.
- `forge ops check` shows 13 standing incidents for this project: 1 stuck_run (run-fg-425-e1dd27 — active run, all 6 tasks terminal; repair is autonomy=ask) + 12 orphaned_work_may_persist across old runs (FG-455…review-loop-fg-531 era). Historical residue, manual-only investigate — worth one triage pass someday, nothing urgent.
- CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 armed; `forge launch run [--name] -- <cmd...>` is the mandatory owner for long forge commands, and NOW ALSO: no bash sleep waits — ScheduleWakeup for the delay, short synchronous checks on wake (CLAUDE.md:504).
- ~/.forge/launches/ holds the FG-535/536 kill-smoke evidence records (deliberately kept); ~/.forge/sigterm-probe/ unchanged.

**Decisions worth not relitigating:**
- Wait pattern is policy now: never `sleep N && tmux capture-pane` (attached-process exposure = the FG-535 class, reintroduced on the wait side). ScheduleWakeup owns delays. In the seed + rendered block; new sessions get it automatically.
- FG-535 attribution CLOSED by operator direction: si_pid capture + plain-iTerm kill are operationally sufficient; the Supacode A/B matrix stays optional trigger-characterization only.
- FG-536 does NOT claim user-away/lock/display-off as kill trigger — sender proven, trigger unestablished (correlate only).
- FORGE-DEC-024/FG-479 unreversed: reconcile never inlines finalizePrimary. FG-523's validation contract is a pipeline implementer-step gate, NOT an invoke gate (FORGE-DEC-025: parity, not a contract).
- `forge launch` status vocabulary stays strictly evidence-bounded — exit 143 alone is never attribution; don't "simplify" it.
- The reconcile idle-bound logEvent stays ALLOWLISTED (not probed) in fg530-probe-inertness — append-only evidence, no paired status write.

**Shipped (for reference):** bbe44ca docs(orchestrator): ScheduleWakeup-not-sleep wait rule (seed + CLAUDE.md re-render) — pushed to origin/main together with a397d1f (prior session's handoff notes, which had stranded on chore/fg536-close). Prior session's queue for context: FG-531 (PR #107) · FG-533 (PR #108) · FG-535 (PR #109) · FG-536 (PR #110), all merged + closed.
