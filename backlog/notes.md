**Last session ended 2026-08-07.**

**Where we left off:** The operator directed the FG-685 → FG-584 → FG-591 sequence to run
autonomously end to end, then added FG-576 to the queue. FG-591's review turned out to be
impossible — all five lenses crashed `input_too_large` on its 1,170,885-character diff —
so FG-689 was filed and promoted ahead of it by operator decision, with its mechanism
corrected first (the original direction would have built the path inference the review
PRD explicitly refuses). All four shipped. The session was stopped deliberately for a
context reset, not because anything is stuck.

**Picked up next:**

1. **FG-691 — the store clock is unfreezable.** The `Now` item, promoted ahead of FG-576
   by the operator on 2026-08-07. `storeNowMs()` is the live SQLite clock plus a fixed
   offset, so any lease boundary assertion races. It already failed `test` — a REQUIRED
   check — once on PR #218 at `offset 19999` (1 ms inside a 20000 ms TTL) and passed on
   every later run. It is not fixed, and it is the most likely source of a CI red that
   looks inexplicable. Do not resolve it by widening the assertion; the boundary is the
   point.
2. **FG-576 — provider-neutral interactive orchestrator launcher.** Immediately behind
   FG-691. The absorption claim has now been CHECKED and it does not hold as written:
   FG-554 (policy-driven `forge claude` model resolution) and FG-448 (remote-control URL
   on the project card) are both **done**, not active. FG-576 cannot close them — they
   shipped independently — so its remaining scope is only what they did not deliver, and
   it is smaller than `PLAN.md` previously implied. Scope it against what FG-554 actually
   landed.
3. **FG-688 and FG-692.** FG-688 (no adopt-preserving re-drive for a terminally-failed
   ordered wave) cost two discarded runs on 2026-08-06 and its cost scales with how far a
   wave got. FG-692 is FG-591's fail-safe review residue.

**External state to remember:**

- **ntfy is still down** — ninth consecutive session. `forge notify milestone` records to
  the DB and the push fails `network: fetch failed`.
- **A GitHub Actions outage** swallowed ALL workflow dispatch for roughly 15 hours
  mid-session, with no error and no queued runs — enabled, active, zero runs. Recovery was
  partial: one PR needed two close/reopen cycles before its run fired, and the first
  reopen's run was cancelled by the concurrency group, leaving a stale `test-extended:
  fail` that was NOT a real failure. Check a red aggregate against its run id before
  believing it.
- **`~/code/fg584-dogfood` is deliberately retained.** FG-584's AC14 evidence cites base
  SHAs that exist only in that repository; deleting it makes that evidence unverifiable.
- **The installed tech-lead seed was replaced** with the merged FG-584 version
  (`19f4460c`) so its `depends_on` contract reaches planners; the prior `cb52e609` is
  backed up at `~/.forge/seed-backups/2026-08-06-pre-fg584/`.
- **Non-ticket thread:** the shard plan records `validated against: unvalidated` even
  though the host-side dogfood IS that validation. Recorded on FG-689's evidence; worth
  making the record self-consistent when someone next touches that code.

**Decisions worth not relitigating:**

- **FG-584 AC4's exclusion clause reads against RAW captured-but-unintegrated worker
  output**, not against an already-integrated and gated prerequisite of another chain. The
  shared-candidate architecture necessarily admits the latter and it is safe — the final
  publication contains that work, its gate passed, and the exact superset SHA is recorded.
  Closure-only workspaces would need a branch-per-chain model, which is not the Gas City
  design (operator, FG-584 D9).
- **A step that makes a BREAKING change must carry its migration in the SAME step.**
  FG-689's first build died at gate 2 on exactly this. Under FG-584 every prerequisite
  boundary runs the full unit tier, so `depends_on` sequences work but does not license a
  step that is knowingly red until a later one repairs it. Recorded as FG-689 D11 — but
  NOT yet in the tech-lead protocol, so planners will keep making it.
- **Never ask a containerized agent for evidence only the host can produce.** Made twice
  in one session: FG-591's falsification needs agent credentials CI has not got, and
  FG-689's step 11 needed a real dispatch a build agent cannot make. Both are now
  operator-run on the FG-621 precedent with output pasted into their tickets.
- **FG-591's falsification is operator-run, not CI-skipped.** A skip-capable CI test is a
  false proof; `scripts/fg591-falsification-smoke.sh` fails closed on every missing
  prerequisite and has exactly one `exit 0` (operator, FG-591 D15).
- **Arming autonomous dispatch and setting `max_active_runs` stay CLI-only.** The
  dashboard is unauthenticated on localhost; FORGE-DEC-015 accepted that for gate and
  next, not for authorizing unattended container execution (FG-591 D2).
- **Routing:** `implementation_quick` ALWAYS runs its test-engineer follow-up — no waiver
  on the strength of an engineer's self-validation. A test-only deliverable routes
  `testing_automation` instead, where test-engineer is responsible and there is no second
  follow-up (operator standing rule).

**Shipped (for reference):**

- **FG-685** (`ee303508`, PR #216) — the no-AI-attribution hook is materialized into every
  Forge-provisioned task clone, `core.hooksPath` pinned workspace-relative.
- **FG-584** (`00000e76`, PR #217) — plan-step `depends_on` as executable controller data;
  AC14 dogfood recorded. Its flaky wall-clock assertion was hardened in `5644c53e`.
- **FG-689** (`0cc6decb`, PR #220) — reviewer input scoped to authored lens-to-path
  ownership and sharded, completeness owed PER SHARD.
- **FG-591** (`ecbe7d6f`, PR #218) — the operator work queue, board, controls and
  capacity-limited dispatcher.
- Filed, all non-preempting: FG-686, FG-687, FG-688, FG-691, FG-692.
