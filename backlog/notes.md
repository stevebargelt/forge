**Last session ended 2026-07-25 (long autonomous run).**

**Where we left off:** Shipped FG-607 (FG-496 Slice B), then FG-612, FG-614, and FG-613 off the back of a
worktree-isolation incident. Four of the eight queued items landed; the queue was NOT finished.

**Picked up next (in this order — the operator set it):**
1. **FG-575** — release.integration.test.ts commits AND REWRITES history in whatever repo it runs in, plus
   `/private/var` vs `/var` assertions. Its body was EMPTY; it is now written up from first-hand evidence (it
   rewrote the FG-607 branch twice this session), including an AC requiring the test to assert the checkout's git
   state is unchanged.
2. **FG-559** — agents on a linked worktree have no working git. This is the blocker for item 4.
3. **FG-356** — orphan worktree reaper + unlock-first removal (`--force` is a SINGLE force; a locked worktree
   needs `git worktree unlock` or `-f -f`).
4. **worktree default-on** — FG-345's parent decision. Do NOT flip before FG-559.

**Operational state you must know:**
- **The FG-612 guard is LIVE.** Every dispatch against the forge repo refuses unless worktree mode is armed.
  Ambient env does NOT reach the tmux workload, so the override rides INSIDE the launched command:
  `forge launch run --require-control-toolchain -- env FORGE_NO_WORKTREES=1 forge invoke ...`
  Use `FORGE_NO_WORKTREES=1` until FG-559 lands; `FORGE_WORKTREES=1` walks straight into FG-559.
- **Do NOT run the ROOT integration tier in this checkout** until FG-575 is fixed — it commits and rewrites branch
  history (observed twice). Individual files are fine; the dashboard workspace tier is fine.
- **Another session works in this repo.** `docs/research/competitive/` held uncommitted work all session; it was
  excluded from every commit and backed up to the scratchpad. Leave it alone. It also blocked `forge review-loop`,
  which refuses a dirty tree — the manual reviewer chain was the documented fallback.
- `~/code/forge-stable` is a worktree pinned to an older main, built so another project could keep using a working
  `forge` while this checkout churned. Keep or delete at will.

**Open tickets filed this session:** FG-611 (forge continue cannot arm an orchestrator continuation — the
exactly-once machinery documented in CLAUDE.md has never been reachable from a plain pipeline drive), FG-615
(stale "strip closed: frontmatter" reopen instruction in SKILL.md + orchestrator-template + every rendered
CLAUDE.md), FG-616 (dashboard/src/queries.ts holds its own module-eval FORGE_HOME/DB_PATH snapshot — the latent
twin of the bug that broke the dashboard during FG-607).

**Deferred onto FG-608 (Slice C), with reasoning on that ticket:** stale blocker evidence surviving a re-import;
an evidence-key `reidentify` path (a `git remote add` changes the evidence key and FG-607's new refusal then fires
on every backlog command with no in-tool recovery — a CUTOVER PRECONDITION, not a follow-up); the two campaign
`existsSync('backlog')` probes; and agent containers having no DB, so db-mode tickets are invisible inside every
container including the shipping-reviewer red.

**Worth not relitigating:** FG-607's AC 1 was formally amended (its zero-DB-open cost target is not simultaneously
satisfiable with the cross-worktree correctness invariant). FG-612's AC was amended after an external review caught
a hedged verdict — "no task row" was a bad proxy, and `forge next` keeps a failed row on purpose so `forge show`
can explain the refusal.
