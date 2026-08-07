**Last session ended 2026-08-07.** Four tickets shipped; the operator-queue program is closed.

**Shipped this session:**

- **FG-685** (`ee303508`, PR #216) — the no-AI-attribution hook is materialized into every
  Forge-provisioned task clone at provisioning time, with `core.hooksPath` pinned
  workspace-relative so the guard survives the container mount. A symlink install was not
  viable: `$FORGE_HOME` is not mounted in the agent container, and a dangling `commit-msg`
  is git reporting no hook at all, with no diagnostic.
- **FG-584** (`00000e76`, PR #217) — plan-step `depends_on` is executable controller data:
  dependency-ready dispatch, per-group bases cut from the gated candidate, a mid-wave
  prerequisite gate, typed merge-conflict blocks, four-boundary crash convergence. Its
  AC14 dogfood is recorded on the ticket. A flaky wall-clock assertion it shipped was
  hardened separately in `5644c53e`.
- **FG-689** (`0cc6decb`, PR #220) — reviewer input scoped to authored lens-to-path
  ownership and sharded when it still exceeds budget, completeness owed PER SHARD.
- **FG-591** (`ecbe7d6f`, PR #218) — the operator work queue, board, CLI/dashboard controls
  and capacity-limited dispatcher.

**Picked up next: FG-576** — provider-neutral interactive orchestrator launcher. Before
scoping it, confirm what FG-554 and FG-448 actually contribute; `PLAN.md` says FG-576
absorbs them, and that claim has not been verified against those tickets.

**Read these before touching the review or the ordered build:**

1. **FG-691 is the most likely source of a mystery CI red.** `storeNowMs()` is the live
   SQLite clock plus a fixed offset and cannot be frozen, so any lease boundary assertion
   races. It failed `test` — a required check — once on PR #218 at `offset 19999` (1ms
   inside a 20000ms TTL) and passed on every later run. It is not fixed. If a required
   check goes red at a lease boundary, this is why; do not "fix" it by widening the
   assertion.
2. **A step that makes a breaking change must carry its migration in the SAME step.**
   FG-689's first build died at gate 2 because the schema change was one step and its
   fixture migration another. Under FG-584 every prerequisite boundary runs the full unit
   tier, so `depends_on` sequences work but does not license a step that is knowingly red
   until a later step repairs it. This is recorded as FG-689 D11 but is NOT yet in the
   tech-lead protocol.
3. **Do not ask a containerized agent for evidence only the host can produce.** This was
   made twice: FG-591's falsification needs agent credentials CI does not have, and
   FG-689's step 11 needed a real dispatch a build agent cannot make. Both are now
   operator-run on the FG-621 precedent, with output pasted into their tickets.

**Filed, all non-preempting:** FG-686 (fg352's induction moved off the commit call),
FG-687 (`renewRunLock` returns true on a superseded write), FG-688 (no adopt-preserving
re-drive for a terminally-failed ordered wave), FG-691 (the unfreezable store clock),
FG-692 (FG-591 review residue: rank no-op advances `queueVersion`, WCAG AA contrast,
origin pinning excludes a non-default loopback bind).

**External state:**

- **ntfy is still down** — every `forge notify milestone` records to the DB and fails its
  push. Unchanged for nine sessions.
- **A GitHub Actions outage** swallowed all workflow dispatch for roughly 15 hours
  mid-session. Recovery was partial: a PR needed two close/reopen cycles before its run
  fired, and the first reopen's run was cancelled by the concurrency group, leaving a
  stale `test-extended: fail` that was NOT a real failure. Read a red aggregate against
  its run id before believing it.
- **`~/code/fg584-dogfood` is deliberately retained.** FG-584's AC14 evidence cites base
  SHAs that exist only in that repository; deleting it makes that evidence unverifiable.
- The installed tech-lead seed was replaced with the merged FG-584 version
  (`19f4460c`); the prior `cb52e609` is backed up at
  `~/.forge/seed-backups/2026-08-06-pre-fg584/`.

**Decisions worth not relitigating:**

- **FG-584 AC4's exclusion clause reads against RAW captured-but-unintegrated worker
  output**, not against an already-integrated and gated prerequisite of another chain.
  The shared-candidate architecture necessarily admits the latter, and it is safe: the
  final publication contains that work, its gate passed, and the exact superset SHA is
  recorded. Strict closure-only workspaces would need a branch-per-chain model, which is
  not the Gas City design (operator decision, FG-584 D9).
- **FG-591's falsification is operator-run, not CI-skipped.** A skip-capable CI test is a
  false proof; `scripts/fg591-falsification-smoke.sh` fails closed on every missing
  prerequisite and has exactly one `exit 0`.
- **Arming autonomous dispatch and setting capacity stay CLI-only.** The dashboard is
  unauthenticated on localhost; FORGE-DEC-015 accepted that for gate and next, not for
  authorizing unattended container execution (FG-591 D2).
