# Forge Working Plan

**Last revised:** 2026-08-09

This is a mutable statement of current operator intent. It is not an approval
boundary, ticket specification, execution record, or source of lifecycle
truth.

The DB-backed backlog is authoritative for ticket scope, acceptance criteria,
dependencies, and lifecycle state. Forge runtime state is authoritative for
what is running, blocked, or done. `backlog/notes.md` is a session handoff and
may lag this plan.

**Expected replacement:** FG-591 has shipped, so the condition this file was
written to expire on is met. Whether the queue and board actually replace a
statement of operator sequencing intent is now a live operator decision, not a
pending dependency — see the retirement rule at the end.

## Current objective

**FG-253 — provider-neutral orientation and handoff adapters.** Promoted
2026-08-09 by operator decision, TEMPORARILY ahead of FG-688: a fresh Codex
dogfood found no installed orientation workflow at all, because the orientation
and handoff semantics exist only as Claude-shaped prose and nothing installs an
equivalent surface for any other provider. Getting a session oriented is
upstream of the recovery work, so the adapter ticket goes first; FG-688 keeps
its promotion and resumes as the objective once FG-253 ships.

## Recently completed

- **FG-576** (`04fbfeb9`, PR #223) — `forge orchestrator`, the provider-neutral interactive
  launcher: receipt store, launcher-owned liveness with a process-identity fence, resolution
  and capability matrix, the Forge-owned Codex instruction carrier, both adapters, and the
  `forge show`/dashboard surfaces. 15/15 acceptance criteria evidenced at the final
  candidate. Built as a 12-step ordered DAG, salvaged after a fanout failure, and reviewed
  over the whole range — 5 lenses, 9 shards, 5 findings, all settled.
- **FG-691** (`0d0ed85a`, PR #222) — an explicit instant on the paired lease predicates,
  defaulting to `storeNowMs()`. The boundary is assertable at exactly the expiry instant and
  that offset was added to both sweeps; `storeNowMs` itself is unchanged and no caller was
  migrated. Settled clean: 4 lenses, 0 findings.

## Now

1. **FG-253 — provider-neutral orientation and handoff adapters**, defined once over the
   Forge-owned CLI and state primitives and rendered per provider, with a CLI-only fallback
   where no provider surface applies.

## Next

1. **FG-688 — adopt-preserving re-drive for a terminally-failed ordered wave**, plus the
   inspector recommending a verb its own failure-kind guard rejects. One gap, two halves.
   Promoted 2026-08-07 on its third reproduction: FG-576's build wave lost one child to
   `result_missing`, which terminated the fanout parent `prerequisite_blocked` with EIGHT of
   nine children already completed and merged, and `forge recover --re-drive` would have
   discarded all of it — `recover.ts:498-508` says so in its own comment — so that work was
   salvaged by hand. The second half is the same surface lying about itself: the read-only
   inspector RECOMMENDS `--re-drive`, but `performReDrive` refuses unless the failure kind is
   `fanout_wave_orphaned`, which `prerequisite_blocked` is not. Displaced by FG-253 only for
   sequencing; nothing about it was descoped.
2. **FG-682 — a correction found after the docs stage has no supported amendment path.**
   No longer theoretical: FG-576 hit it and paid a documented tip-equality override, and
   re-running shipping refused `blocked_environment (candidate_not_checked_out)`. Scoped as
   a BOUNDED late amendment, never a general re-anchor: declared paths only, undeclared
   dirty files refused by name, the coordinator commits and advances, SHA-bound
   verification invalidated and CI required at the new candidate, plus a bounded delta
   check rather than full re-discovery. Adjacent to FG-688 — both are review/recovery
   control-plane gaps.
3. **FG-681 — the host integration tier is broadly red on darwin while CI is green** (~76
   tests across 13+ files; the dominant signature is a pre-container refusal, not assertion
   drift). Root-cause the shared harness from the smallest `fg381` and largest `fg628`
   reproductions; do not patch, skip or allowlist individual symptoms. Newly urgent: three
   of FG-576's five defects were darwin-only and invisible to CI and to the Linux agent
   containers, so the split is now costing real defects rather than only noise.
4. **FG-692 — FG-591 review residue** (rank no-op advancing queueVersion, WCAG AA contrast),
   now also carrying the FG-576 finding that dashboard orchestrator rows are mouse-only.

`Next` is deliberately short. Ordering here expresses current operator intent;
it does not override ticket dependencies or authorize scope expansion.

## Captured follow-ups that do not preempt `Now`

- **FG-652** — stage-record SHA in the crash-after-advance recovery window.
- **FG-656** — fanout model resolution can drift from the held seed
  generation.
- **FG-657** — reconcile and close the DB ticket for the already-shipped PR
  #191 implementation.
- **FG-658** — consolidate the evidence-validator false-negative family:
  narrowly normalized source annotations, exact semicolon-bearing test names,
  and candidate-baseline evidence separated from deliberate mutation output.
- **FG-545** — add a docs/research-only CI fast path while preserving
  exact-head required checks.
- **FG-661** — FG-648 review residue: the WCAG contrast test asserts the peak
  label twice and never an axis label, and a read that fails after a successful
  load leaves a frozen chart with no staleness signal.
- **FG-663** — runs lose their repository identity when a checkout is deleted,
  orphaning 8.4% of task history as "Unknown repository". The durable project
  identity is the key and the tag; `.forge/config.yml`'s git-tracked
  `project_key` already survives cloning and is the preferred source.
- **FG-667** — FG-664 residue: the probe's platform filter prunes a multi-arch
  prebuilds directory, permanently refusing a correct cache; plus a stale
  review-wiring comment.
- **FG-686** — FG-685 residue: `fg352 (11)` no longer induces a failure at the
  `git commit` invocation, because the `--no-verify` capture exemption made its
  hook-based device inert and the replacement wedge fails at `git add`.
- **FG-687** — FG-584 residue: `renewRunLock` reports success after a superseded
  write to an unlinked inode. The compare-and-set protects the successor; only the
  return value lies, and its sole caller discards it.

These remain real work. They move ahead only under the interruption policy
below, not because they are adjacent to recently completed review work.
FG-663 and FG-667 are explicitly non-preempting residue (operator instruction,
2026-08-03) unless one becomes a deterministic blocker under the policy below.
FG-664 was promoted out of this set on 2026-08-02 and has since shipped.

## Interruption policy

An item may move ahead of `Now` or `Next` only for:

- demonstrated operator-blocking behavior;
- failing required CI;
- credible data-loss, security, or wrong-publication risk;
- a deterministic defect blocking the current objective;
- a required test tier that does not execute.

A newly discovered hardening opportunity is recorded in the DB backlog but does
not automatically become the next task. Do not open speculative follow-up
tickets for limitations that fail loudly, already belong to a parent ticket,
or have no demonstrated impact.

## Execution rules

- Start implementation from current `main` in an isolated disposable clone or
  task workspace, never by editing the live checkout.
- Evidence-led review runs once: one discovery pass, at most one remediation
  batch, and one recheck. Remaining work becomes an explicit disposition and
  follow-up, not another internal convergence cycle.
- The docs stage commits its own declared paths (FG-655, shipped `c93e13af`), so
  required documentation no longer has to be committed before review. It still
  must be DECLARED: the coordinator commits exactly the paths the agent lists in
  `docs_updated`, an undeclared path is a named refusal rather than a silent
  sweep, and a `docs_updated` that is missing, non-array, or carrying a
  non-string member is a contract violation, never a claim that nothing changed.
- The review coordinator owns candidate movement for ANY commit during a review,
  not only a fixer's output. While FG-682 remains open there is no supported way
  to amend a documentation correction found after the docs stage: committing it
  by hand pins the candidate behind the branch tip and fails both `tip_equality`
  and `docs_closeout`. Reconcile durable docs BEFORE the review where possible,
  and if a correction is found late, surface it as an explicit override decision
  rather than an ad-hoc commit.
- Merge only when required CI is green at the actual PR head.
- Close shipped tickets with acceptance-criteria evidence from the merged
  candidate.
- A dirty or untracked operator file in the live checkout is not part of an
  implementation candidate unless the operator explicitly places it in scope.

## Maintenance rules

- Keep `Now` to one product objective and `Next` to roughly five items.
- Keep `Recently completed` to the latest one or two shipped items; Git and the
  DB backlog are the durable history.
- Update this file when operator sequencing changes; do not preserve stale
  priorities as if they were current.
- Link ticket IDs instead of copying full acceptance criteria.
- Do not duplicate live run state or record progress percentages here.
- Retirement is now an open operator decision, not a pending dependency. FG-591
  shipped the operator controls and running dispatcher this file was to be retired
  for, but those surfaces carry queue and dispatch state — not the sequencing
  rationale, interruption policy, and execution rules recorded here. Retire this
  file only by deciding where that prose lives, not merely because FG-591 landed.
