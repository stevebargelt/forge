**Last session ended 2026-07-22.**

**Where we left off:** FG-582 (FG-572 Child 5e — installed git hooks follow a promotion) shipped, merged (`44a305a`, PR #153), and closed with an AC-evidence grid (all 8 AC met). No thread mid-flight.

**Picked up next:**
1. **FG-583** (FG-572 Child 5h — non-atomic host seed cp loop; an interrupted upgrade can expose a mixed-but-Zod-valid workflow set to a concurrent `forge next`). Depends on FG-577 (landed). **This is now the LAST open FG-572 child — closing it closes FG-572 → closes epic FG-561.**
2. **FG-604** (NEW, filed this session) — init hook repoint: close/​bound the `atomicRepoint` check-then-`renameSync` TOCTOU window (a foreign hook swapped in between the ownership recheck and the rename is overwritten). Operator-dispositioned as follow-up (theoretical race, no realistic exploit — an attacker who can write `.git/hooks` needs no race); FG-582 shipped with the other AC-5 protections in force. FG-604 may legitimately close won't-fix if the window is irreducible without disproportionate machinery.
3. **FG-599** (positive Q2 delivery-mode record) and **FG-600** (FG-565 follow-ups: `forge continuation` should not `ensureForgeDirs`; F21 should drive the real `forge cancel` CLI).

**External state to remember:**
- Writer clone `~/code/forge-agent-work`: FG-582 branch `feat/fg582-hooks-follow-promotion` was merged+deleted; clone is on `main` synced to origin. `git reset --hard origin/main` before next use to be safe.
- Control checkout `~/code/forge` is the LIVE npm-linked control plane, now at `44a305a` (fast-forwarded to include FG-582). Promotion NOT in force here, so writing agents ALWAYS use the standalone clone, never `main`. Read-only reviewers may mount `main` RO.

**FG-582 lessons worth not relitigating:**
- The `feature` pipeline (architect re-run + build reds + shipping-reviewer) MISSED the critical bug: the promoted-arm hook path is the release-tree-internal `$FORGE_HOME/current/scripts/git-hooks/commit-msg-no-ai-attribution`, NOT a root-level `current/commit-msg` (which no real release contains). The ORIGINAL architect flagged this as its #1 HIGH risk; it was lost when that architect artifact was rejected+re-run for a different (ownership-boundary) correction. **The `forge review-loop` red-wide caught it in round 1** — the loop earned its keep. Lesson: when rejecting/re-running an architect, explicitly carry forward its OTHER high risks, not just the one being corrected.
- **test-engineer container-wait bug (worth filing):** the verify-phase test-engineer ended its turn with "I'll continue when the completion notification arrives" — the orchestrator completion-driven wait pattern leaking into an AGENT inside a container, where no wake ever comes. It exited `end_turn` with an empty `result.json` → task failed. `forge retry` (no --force) recovered it cleanly on the second run. If this recurs, file it against the test-engineer seed (agents must run tests synchronously, never background-and-wait).
- Merge authorization: review-loop stopped `needs_fix_max_rounds` (round-2 TOCTOU) + local-only fixer commit; operator chose follow-up (FG-604) + merge on green CI. Pushed the round-1 fix (`226d954`), CI green on both required checks (`test` + `test-extended`), merged squash → `44a305a`.

**Shipped (for reference):**
- **FG-582** (`44a305a`, PR #153) — installed git hooks follow a promotion via `$FORGE_HOME/current`: resolvability-not-existence arm selection (dangling current → dev fallback), ownership-by-evidence stale repair (releases/* containment rejected), foreign-surface refusal with pre-mutate recheck, atomic idempotent repoint, `resolveHookSource` non-fatal in promoted arm; docs/concepts.md + quick-start.md reconciled. Disposable-FORGE_HOME RED-before-GREEN matrix incl. real git-commit execution. AC grid in the closed ticket.
- Follow-up filed: **FG-604** (atomicRepoint TOCTOU residual).
