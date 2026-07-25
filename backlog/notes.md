**Last session ended 2026-07-25.**

**Where we left off:** FG-575 shipped end-to-end via a disposable-clone dispatch (merge `9a73105`, PR #160), closed with an acceptance-evidence grid in `03b56f3`. The last exchanges were the operator rejecting two of the three follow-ups this session filed — the thread to carry forward is ticket-filing discipline, not the code.

**Picked up next:**
1. **FG-559** — agents on a linked worktree have no working git (`.git` is a gitdir pointer outside the container mount). Still the hard blocker for the FG-345 worktree default-on flip. Note it did NOT block FG-575: worktree mode is opt-in (`isWorktreeModeEnabled()` returns `FORGE_WORKTREES === "1"`, `worktree-lifecycle.ts:42-43`), so the default bind-mount has a real `.git`. FG-559 has four undecided directions and needs a design pass, not a fix.
2. **FG-617** — filed this session. The root integration tier now REFUSES to run when the invoking checkout's `src/`, `package.json` or lockfile is dirty (the removed `commitSource(sourceRoot)` had been silently satisfying the builder precondition for all 16 fixture builds). Refusal only, never a write. Direction: route fixture builds through an isolated builder too.
3. **FG-356** — orphan worktree reaper, plus unlock-first removal: `removeWorktree` uses a SINGLE `--force`, which still fails on a locked worktree.
4. Then the **worktree default-on** flip under **FG-345** — not before FG-559.

**External state to remember:**
- **Another session is still working in this repo.** `docs/research/competitive/` now has 7 uncommitted/untracked files — one MORE than at session start (`forge-feature-opportunities.md` appeared mid-session). Not ours; excluded from every commit and left untouched. They also still block `forge review-loop`, which refuses a dirty tree.
- **The disposable-clone dispatch pattern is proven and reusable.** `git clone --no-hardlinks` from the checkout + `cp -R node_modules` (root and `dashboard/`) gives a fully working, expendable mount in seconds — no `npm ci`, native binding comes along on same-host/same-arch. It sidesteps the FG-612 self-host guard entirely (no path overlap, so no `FORGE_NO_WORKTREES=1` incantation needed) and is the right target whenever an agent must run code that touches git history. Extract the diff back via `git remote add <clone>` + cherry-pick.
- **Non-ticket thread:** `~/code/forge-stable` (worktree pinned to an older `main`) still exists from the prior session. Delete when no longer wanted.

**Decisions worth not relitigating:**
- **FG-619 was REJECTED, not deferred.** It proposed loosening the FG-575 git-state assertion's full-porcelain comparison after a false red. The false red was caused by the orchestrator filing tickets WHILE the suite was proving that same checkout unchanged — an invalid validation environment, not a defect. Loosening to "no new entry under a path the suite owns" is incoherent (an unexpected write is by definition in an unexpected path) and would trade a false red for a false green. It also would have amended FG-575's shipped AC by the back door. Rationale is preserved in the closed ticket body.
- **FG-618 was CLOSED on a false premise.** It claimed release-entry spawns pass the "ambient" `FORGE_HOME`. `src/test-setup.ts:6-7` already assigns a disposable temp home and `run-integration-tests.sh` hardcodes that import, so those spawns never reached the operator's real `~/.forge`. Only residual is that `buildHome` is finer-grained — a four-line tidy, not a ticket.
- **Both FG-575 tests must stay.** Test-engineer mutation M3b: with the original defect fully reinstated but the invoking tree CLEAN, the last-in-file git-state assertion PASSES — and a clean tree is every CI run. The `DIRTY invoking checkout is NEVER committed into` test is the only one of the pair that fires in CI. They are complementary; deleting the stand-in as "redundant" would remove the real coverage.
- **The ticket's "it REWRITES the branch" claim was unsubstantiated and is corrected in the closed body.** No `--amend`, `reset`, or force exists anywhere in that file. The provable defect was the unwanted commit.
- **Don't mutate the checkout while a proof about that checkout is running.** Cost one wasted 40s run and one bad ticket. Hold backlog writes in scratchpad until the run lands.

**Shipped (for reference):**
- **FG-575** — `release.integration.test.ts` builds every release from an isolated copy under a disposable workspace; never commits into the invoking repo; workspace root `realpathSync`'d so both `/var` vs `/private/var` assertions hold on macOS; stale scratch-invariant header replaced; 3 new tests + 1 guard test. Verified 36/36 on the macOS host AND in the live dirty checkout with the invoking repo byte-identical afterward. `9a73105`, PR #160.
- **FG-618** — closed, false premise (above).
- **FG-619** — rejected, invalid validation environment (above).
- **FG-617** — filed and still open (above).
