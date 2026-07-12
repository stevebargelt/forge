**Last session ended 2026-07-12.**

**Where we left off:** The operator's 4-item autonomous queue (FG-531 → FG-533 → FG-535 → FG-536) completed 4/4 under mandatory durable-tmux process ownership — all merged, closed with AC walks, docs reconciled. No thread is mid-flight; the session ended at a clean stop.

**Picked up next:**
1. Non-ticket thread — file the three review-loop friction items observed repeatedly this session (then fix the worst): (a) a just-pushed sha reads "CI unavailable" (check-runs not registered yet) so the loop takes local fallback instead of the FG-501 wait path — happened ~6 times; (b) `forge review-loop <ticket>` range inference said "no commits reference FG-5xx" for FG-533/535/536 despite ticket ids in every commit subject — `--since $(git merge-base origin/main HEAD)` worked every time; (c) one transient `reviewer_failed` (invalid/absent reviewer result) consumed a whole loop run.
2. Non-ticket thread — restart the dashboard (its server process still predates FG-521's server-side change; kill by exact PID, restart, browser-tools verify).
3. Housekeeping: delete local branches chore/fg533-close, chore/fg535-close, chore/fg536-close (all pushed into origin/main) once local `main` is checkout-able again — a locked codex worktree (/private/tmp/forge-codex-fg537, another session's FG-537/FG-538 research) currently holds `main`, which is why closes went via branches off origin/main.

**External state to remember:**
- CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1 is armed for orchestrator sessions; `forge launch run [--name] -- <cmd...>` is the mandatory owner for long forge commands (rule in the rendered orchestrator block). With FG-536 live via linked source, agent CONTAINERS also survive any host-side kill by construction.
- ~/.forge/launches/ holds this session's launch records including the FG-536 kill-smoke evidence (kill2 = SIGKILL of the CLI, kill3 = SIGTERM of its subtree — the FG-535 harness signature); tmux sessions freed, records deliberately kept. ~/.forge/sigterm-probe/ unchanged (sentinel binary, smoking-gun si_pid log, FG-531 fixer snapshot).
- The FG-536 smoke invokes left three complete one-off runs in the DB (run-fg-536-detached-exec-live-smoke-*, run-fg-536-cli-kill-*) — audit residue, nothing stuck.

**Decisions worth not relitigating:**
- FG-535 attribution is CLOSED by operator direction: si_pid capture (the harness itself) + the plain-iTerm kill are operationally sufficient; the Supacode A/B matrix was deliberately NOT run and stays optional trigger-characterization only.
- FG-536 does NOT claim user-away/lock/display-off as the kill trigger — sender proven, trigger unestablished (correlate only); the ticket text was corrected on operator instruction.
- FORGE-DEC-024/FG-479 stands unreversed: reconcile never inlines finalizePrimary; pipeline recovery is re-drive through the real finalize path. FG-523's validation contract is a pipeline implementer-step gate, NOT an invoke gate — reconcile's invoke-like completion is at exact live-path parity (docs + FORGE-DEC-025 now say precisely this).
- `forge launch` status vocabulary is strictly evidence-bounded on purpose (signaled/sender-unrecorded, owner_gone/cause-unrecorded, terminated_unattributed, unknown) — exit 143 alone is never attribution; don't "simplify" it back to "externally terminated".
- The reconcile idle-bound logEvent is ALLOWLISTED (not probed) in fg530-probe-inertness with a written reason — append-only evidence, no paired status write; don't convert it to a probe (the matrix can never reach it: fakes report no live containers).

**Shipped (for reference):** FG-531 (PR #107, awaiting_red sweep — closed early-session) · FG-533 (PR #108, pre-container sweep + ops read-surface, last FG-530 pin deleted) · FG-535 (PR #109, `forge launch` durable launcher + no-inference exit records + orchestrator guidance; FORGE-DEC-... n/a) · FG-536 (PR #110, docker-detached agent execution + reconcile idle bound + container-id start evidence; FORGE-DEC-025). Also: FG-530/FG-290 done-ticket status updates, notes refreshes, and the FG-536 cause-claim correction — all direct-to-main backlog commits.
