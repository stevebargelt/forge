**Last session ended 2026-07-12.**

**Where we left off:** Short session: oriented, then codified operator feedback as orchestrator policy — waits go through ScheduleWakeup, never bash `sleep N` (tmux/`forge launch run` owns the work, ScheduleWakeup owns the reminder, every Bash call short + synchronous, `tmux capture-pane` fallback-only). Landed in seeds/orchestrator-template.md + rendered CLAUDE.md:504 (commit bbe44ca, pushed to origin/main) and saved as persistent memory. The prior session's three next moves were NOT started — they carry forward below.

**Picked up next:**
1. Non-ticket thread — file the three review-loop friction items observed in the FG-531..536 session (then fix the worst): (a) a just-pushed sha reads "CI unavailable" (check-runs not registered yet) so the loop takes local fallback instead of the FG-501 wait path — happened ~6 times; (b) `forge review-loop <ticket>` range inference said "no commits reference FG-5xx" despite ticket ids in every commit subject — `--since $(git merge-base origin/main HEAD)` worked every time; (c) one transient `reviewer_failed` consumed a whole loop run.
2. Non-ticket thread — restart the dashboard (server process still predates FG-521's server-side change; kill by exact PID, restart, browser-tools verify).
3. Non-ticket thread — rebuild the agent image before the next dispatch: `forge upgrade` release check flags agent-dev-worker:latest STALE (build input newer than image) → `docker/build.sh` or `forge upgrade --rebuild-image`.
4. Housekeeping: delete local branches chore/fg533-close, chore/fg535-close, chore/fg536-close (all in origin/main) once local `main` is checkout-able — the locked codex worktree (/private/tmp/forge-codex-fg537, FG-537/FG-538 research) still holds `main`.

**External state to remember:**
- ANOTHER SESSION IS EDITING THIS TREE: src/cli/commands/claude.ts + claude.test.ts went modified mid-session (tests for the committed buildClaudeChildEnv — looks like FG-158-adjacent work). Not this session's work; left untouched. Check `git status` before any stash/reset and don't clobber it.
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
