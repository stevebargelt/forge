**Last session ended 2026-08-05.**

**Where we left off:** FG-610 was run autonomously end to end on the operator's instruction to make the
calls and report decisions at the end rather than stop at gates. It shipped and closed. The session
closed with two record-precision corrections the operator asked for: the FG-610 run-failure record was
amended to say the workflow run CORRECTLY failed (verify's branch could not merge after the
history rewrite) and that **FG-635 does not apply**, because the run did not falsely complete and docs
was explicitly recorded unreachable rather than silently skipped.

**Picked up next:**

1. **FG-584 — feature build fanout flattens semantic dependencies.** The ticket's own text sequences it
   immediately after FG-610 and before FG-591. FG-610 demonstrated it live rather than merely arguing
   for it: the runner fanned both plan steps in parallel even though the plan declared step 2 sequenced
   after step 1, so the docs child correctly self-failed rather than document a schema that was not
   committed yet. The tech-lead's stated fallback ("merge step 2 into step 1 if the runner cannot honour
   the ordering") was NOT executable — the decomposition was already fixed by the time the runner
   flattened it. That is worth carrying into the fix: a plan-time fallback cannot rescue a runtime
   flattening.
2. **FG-685 — filed this session, cheap and high leverage.** The no-ai-attribution force constraint has
   no mechanical enforcement where agents actually commit: the commit-msg hook is a symlink present only
   in `~/code/forge/.git/hooks/`, and a forge-provisioned clone has none (verified directly), while every
   agent commit happens in a clone or a per-task worktree. It is not theoretical — it cost a history
   rewrite this session and that rewrite is what broke the pipeline tail.
3. **FG-591** is the consumer FG-610 was built for, but FG-584 is sequenced ahead of it. FG-591 also
   inherits two decisions FG-610 deliberately left to it: which counting scope the capacity ceiling uses,
   and whether a cancel path should stop work on dequeue.

**External state to remember:**

- **ntfy is still down** — 7th consecutive session. `forge notify milestone` records to the DB and the
  push fails `network: fetch failed`. Every milestone this session recorded but did not deliver.
- **The tmux server was killed** after verifying 98 sessions / ZERO live panes. The stale `forge-fg678`
  cwd warning that fired on every `forge launch run` for three sessions is gone; the next launch builds a
  fresh server from a valid cwd. FG-590 still owns any automatic recycle.
- **A seed generation was republished** (`forge upgrade`, 21 files) to clear an FG-654 `stale_protocol`
  refusal on the documentation-maintainer. Host-wide effect; nothing else was touched.
- **The live checkout still carries someone else's uncommitted work** — `docs/research/README.md` plus
  two untracked research files. Preserved untouched across this whole session. Leave them.
- **`forge-fg610` was content-verified (zero unique content, all files present in main) and removed**,
  worktrees detached first. ~172 MB reclaimed. The six other clones in `~/code` are not mine and were NOT
  audited.

**Decisions worth not relitigating:**

- **FG-610 E1 — the capacity ceiling scope was deliberately NOT decided.** The claim row carries
  `project_key` and the counting scope is a REQUIRED, defaultless caller argument; both scopes are proven
  under concurrency. The architect escalated it as a stop gate; the answer is that scope is the same
  class of thing as the capacity NUMBER, which was already bounded as caller-supplied because
  `max_active_runs` is FG-591's. Do not bake a default in FG-610.
- **FG-610 E2 — an operator dequeue / unrank / defer never releases a live claim.** Not a free policy
  choice: releasing one while a container still executes lets a second dispatcher claim the same ticket,
  which is the duplicate execution the slice exists to prevent. Cancellation needs a dispatcher and
  belongs to FG-591.
- **The plan's "no ADDITIVE_COLUMNS entry for a brand-new table" invariant is WRONG.** `fg608-migration-parity`
  strips a FRESH db of every ADD-COLUMN-restorable column and re-migrates, so it demands an entry for
  every restorable SCHEMA_SQL column regardless of `CREATE TABLE IF NOT EXISTS`. Removing the five
  entries fails it 3 of 4. Raised twice (build red, then review RF-1) and rejected both times on a
  replayed command. Do not "fix" it a third time.
- **The FG-610 run failing was CORRECT, and is not FG-635.** Verify had branched from the pre-squash
  integration commit `abe0e7bc`, so after the AI-attribution scrub its merge-base with the candidate fell
  back to `origin/main`, publication failed `merge_conflict`, and forge explicitly recorded docs
  unreachable. FG-635 is false completion; this run did not falsely complete.

**Operational lessons worth keeping:**

- **A `rejected_premise` must be RE-BOUND after a fix cycle moves the candidate.** RF-1's evidence was
  recorded at `0c227970`; the batch fix moved the candidate to `1a90bb6d` and the gate refused with
  `rejected_premise_unproven` until the same experiment was replayed and re-recorded at the new sha.
  Expect this on every review whose fix cycle moves the sha.
- **The evidence-led gate refuses an orchestrator rationale, by design.** Under `review_mode: evidence_led`
  the build gate would not advance on a written disposition — only a settled LEDGER clears it
  (`review_absent`). Open the review; do not reach for `--force`.
- **Every `forge backlog` verb defaults to CWD, not to the project you are working on.** Running
  `notes show` from a scratchpad dir returned `(no notes)`, which would have blanked the handoff had it
  been piped straight back into `notes replace`. Pass `--project` explicitly, and assert non-empty before
  writing.
- **A reviewer finding is a lead, not a verdict.** Two of eight build findings and one of six review
  findings were wrong or pedantic; each was rejected with a replayed command rather than obeyed.

**Shipped (for reference):**

- **FG-610** (`6b01d3c5`, PR #215) — FG-496 Slice E: durable queue claim / lease / recovery primitives
  and the canonical claim-next query. Closed with a 16-row acceptance grid (6 AC + 10 binding decisions).
  Evidence-led review `review-fb6f43c96193` settled 8/8; both required CI checks green at the final
  candidate; 81 host tests, a four-process cross-process race with falsification mutants each shown to
  fail, and 200-iteration stress loops.
- **FG-685** — filed (not shipped): no mechanical enforcement of no-ai-attribution where agents commit.
