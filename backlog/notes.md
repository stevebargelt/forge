**Last session ended 2026-07-25.**

**Where we left off:** A long autonomous run against an operator-set queue of eight items; four landed. The last exchange was an external review finding that FG-612's closure overclaimed an AC ("no task row" while `forge next` deliberately creates one) — reopened, AC amended explicitly, re-closed. The queue stopped at FG-575, which was next and is now fully specified.

**Picked up next:**
1. **FG-575** — the highest-leverage unblock: `release.integration.test.ts` commits AND REWRITES branch history in whatever repo it runs in. Its body was empty; it now carries first-hand evidence (it rewrote the FG-607 branch twice), the `/private/var` vs `/var` half, and an AC requiring the test to assert the checkout's git state is unchanged. Until this lands, **the root integration tier is unsafe to run in this checkout** — individual files and the dashboard workspace tier are fine.
2. **FG-559** — agents on a linked worktree have no working git (`.git` is a gitdir pointer outside the container mount). This is the hard blocker for item 4, and it is why `FORGE_NO_WORKTREES=1` is currently the right override rather than `FORGE_WORKTREES=1`.
3. **FG-356** — orphan worktree reaper, plus unlock-first removal: `removeWorktree` uses a SINGLE `--force`, which still fails on a locked worktree (needs `git worktree unlock` or `-f -f`).
4. Then the **worktree default-on** flip under **FG-345**. Do not flip before FG-559 — agents would lose git entirely.

**External state to remember:**
- **The FG-612 guard is LIVE and will refuse your dispatches.** Ambient env does not reach the tmux workload, so the override must ride inside the launched command: `forge launch run --require-control-toolchain -- env FORGE_NO_WORKTREES=1 forge invoke ...`
- **Another session is working in this repo.** `docs/research/competitive/` has ~6 uncommitted/untracked files that are not ours — excluded from every commit this session and backed up to the session scratchpad. Leave them alone. They also block `forge review-loop`, which refuses a dirty tree; the manual reviewer chain is the documented fallback.
- `~/code/forge-stable` is a worktree pinned to an older `main`, built so a concurrent project could keep using a working `forge` while this checkout churned. Delete when no longer wanted.
- Non-ticket thread: the tmux server was killed and restarted mid-session to unbrick launches, which took down a port-8028 preview dashboard; it was restored. Port 8024 was never affected.

**Decisions worth not relitigating:**
- **FG-607 AC 1 was formally amended.** Its "zero DB open / zero git subprocess" cost target is not simultaneously satisfiable with AC 2 (two linked worktrees resolve the same storage mode); telling "never imported" from "imported but this branch predates the key commit" needs information only the DB has. Correctness won; the cost promise is now "no per-call regression, memoized per process".
- **FG-612 AC was amended, and `forge next` keeps its task row on purpose.** `insertTask` precedes the guard inside `dispatchStep`, and `failTask` then records the refusal on that row so `forge show` explains why the run did not advance. Refusing pre-insert would leave no row to carry the reason. Standing rule adopted: if an AC's literal wording is unmet, amend it explicitly BEFORE closing or leave the ticket open — never hedge inside a verdict column.
- **Four FG-607 review findings were deferred onto FG-608**, with reasoning on that ticket: stale blocker evidence surviving a re-import (the append-only-import boundary FG-606 settled); the two campaign `existsSync('backlog')` probes (seam-bypassing readers FG-608 owns); agent containers having no DB, so db-mode tickets are invisible inside every container including the shipping-reviewer red; and an evidence-key `reidentify` path — reclassified as a **cutover precondition**, because a plain `git remote add` changes the evidence key and FG-607's new refusal then fires on every backlog command with no in-tool recovery.
- **FG-613 was not a platform bug.** Those 10 tests failed only in aggregate, from contention over the shared tmux server; FG-614's per-test socket isolation fixed them (127/127 on the macOS host, versus 10 failures at `origin/main` on the same host). No darwin skip was added.
- Build-phase reds currently review by **reading, not executing** — host macOS `node_modules` inside a Linux container blocks test runs. FG-376 solved this for worktrees only, which is a further argument for the default-on item.

**Shipped (for reference):**
- **FG-607** — FG-496 Slice B: dual-mode `structured.ts` seam, DB-backed CRUD, per-project storage mode keyed by `project_key`, `forge backlog mode`, store banner. `a59ba14`, PR #157. Five fixer rounds; eleven findings.
- **FG-612** — forge-on-forge dispatch guard across all five container entry points, overlap detected in either direction, symlink-canonicalized. `066aab2`, PR #158.
- **FG-614** — launches enter their recorded cwd; named diagnosis with the remedy's cost; never auto-kills the server; per-test tmux sockets. `d92a063`, PR #159.
- **FG-613** — closed on FG-614's evidence.
- Filed and still open: **FG-611** (`forge continue` cannot arm an orchestrator continuation — the exactly-once machinery CLAUDE.md documents has never been reachable from a plain pipeline drive), **FG-615** (stale "strip `closed:` frontmatter" reopen instruction in SKILL.md, the orchestrator template, and every rendered CLAUDE.md), **FG-616** (`dashboard/src/queries.ts` holds its own module-eval `FORGE_HOME`/`DB_PATH` snapshot — the latent twin of the bug that broke the dashboard during FG-607).
