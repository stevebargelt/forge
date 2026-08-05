**Last session ended 2026-08-05.**

**Where we left off:** FG-610 (FG-496 Slice E) SHIPPED and closed — merge `6b01d3c5`, PR #215, with a
16-row acceptance grid (6 AC + 10 binding decisions). It was run autonomously end to end on the
operator's instruction to report decisions at the end rather than stop at gates.

**Picked up next:**

1. **FG-584 — feature build fanout flattens semantic dependencies.** Its own ticket text says it lands
   immediately after FG-610 and before FG-591, and FG-610 demonstrated it live: the runner fanned both
   plan steps in parallel despite the plan declaring step 2 SEQUENCED after step 1, so the docs child
   correctly self-failed rather than write docs from the plan. The tech-lead's stated fallback ("merge
   step 2 into step 1 if the runner cannot honour the ordering") was not executable, because the
   decomposition was already fixed by the time the runner flattened it.
2. **FG-685 — new, filed this session.** The no-ai-attribution force constraint has NO mechanical
   enforcement where agents actually commit. The commit-msg hook is a symlink present only in
   `~/code/forge/.git/hooks/`; a forge-provisioned clone has none, and every agent commit happens in a
   clone or a per-task worktree. Verified directly. It is cheap to fix and it cost real money this
   session (see below).
3. **FG-591** is the consumer FG-610 was built for, but FG-584 is sequenced ahead of it.

**Decisions worth not relitigating (all recorded as binding E1-E10 in the FG-610 ticket body):**

- **E1 — capacity ceiling scope was NOT decided here.** The claim row carries `project_key` and the
  counting scope is a REQUIRED, defaultless caller argument supporting both project-scoped and host-wide
  counts, with both proven under concurrency. The architect escalated this as a stop gate; the answer is
  that scope is the same class of thing as the capacity NUMBER, which the architect had already bounded
  as caller-supplied because `max_active_runs` is FG-591's. FG-591 picks the policy; the ledger shape is
  neutral.
- **E2 — an operator dequeue / unrank / defer never releases a live claim.** This turned out NOT to be a
  free policy choice: releasing a live claim while a container is still executing lets a second
  dispatcher claim the same ticket, which is the duplicate execution the slice exists to prevent.
  Cancellation needs a dispatcher and belongs to FG-591; the surviving claim record plus the durable
  launch identity are what make it buildable later.
- **The plan's "no ADDITIVE_COLUMNS entry" protected invariant was WRONG for a brand-new table.**
  `fg608-migration-parity` strips a FRESH db of every ADD-COLUMN-restorable column and re-migrates, so it
  demands an entry for every restorable SCHEMA_SQL column regardless of `CREATE TABLE IF NOT EXISTS`.
  Removing the five entries fails it 3 of 4. Raised twice (build red, then review RF-1) and rejected both
  times with a replayed command. Do not "fix" it again.

**Sharp edges hit this session:**

- **Scrubbing an AI-attribution trailer mid-run orphans pipeline task-branch lineage.** An agent commit
  landed with `Co-Authored-By: Claude Opus 5`; the only remedy was a history rewrite, and the squash
  orphaned the verify task's base (`abe0e7bc`), so publication failed `merge_conflict`, the docs phase
  never ran, and the run recorded `failed` even though the work shipped clean and CI was green. This is
  the concrete cost behind FG-685 — fix the hook coverage and the whole chain disappears.
- **A `rejected_premise` must be RE-BOUND after a fix cycle moves the candidate.** RF-1's evidence was
  recorded at `0c227970`; the batch fix moved the candidate to `1a90bb6d` and the gate then refused with
  `rejected_premise_unproven`. Re-running the same experiment at the new candidate and re-recording
  cleared it. Expect this on every review whose fix cycle moves the sha.
- **FG-654 `stale_protocol` fired on the docs stage** — the published seed generation carried an older
  documentation-maintainer protocol than the executing forge. `forge upgrade` republished (21 files) and
  the retry succeeded; the bound dispatch meant no second maintainer started.
- **The evidence-led gate refuses an orchestrator rationale, by design.** Under `review_mode:
  evidence_led` the build gate would not advance on a written disposition — only a settled LEDGER clears
  it (`review_absent`). Open the review; do not reach for `--force`.

**External state:**

- **ntfy is still down** — 7th consecutive session. Milestones record in the DB, nothing pushes.
- **The tmux server was killed this session** after verifying 98 sessions / ZERO live panes. The stale
  `forge-fg678` cwd warning that fired on every launch is gone; the next launch builds a fresh server.
- **The live checkout still carries someone else's uncommitted work** — `docs/research/README.md` plus
  two untracked research files. Untouched again this session. Leave them.
- **My disposable clone `forge-fg610` was content-verified (zero unique content, all files present in
  main) and removed**, worktrees detached first. ~172 MB reclaimed. The six other clones in `~/code` are
  not mine and were NOT audited.
