# Forge Working Plan

**Last revised:** 2026-08-07

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

**FG-576 — provider-neutral interactive orchestrator launcher.** FG-691 shipped
2026-08-07, so the temporary promotion ahead of this item is spent.

FG-576 is smaller than this file previously implied. The absorption claim has been
checked: FG-554 (policy-driven `forge claude` model resolution) and FG-448
(remote-control URL on the project card) are both **done**, not active. FG-576
cannot absorb or close them — they shipped independently. Scope it against what
FG-554 actually delivered.

## Recently completed

- **FG-691** (`0d0ed85a`, PR #222) — an explicit instant on the paired lease predicates,
  defaulting to `storeNowMs()`. The boundary is now assertable at exactly the expiry
  instant, and the exact-expiry offset was added to both sweeps. `storeNowMs` itself is
  unchanged and no caller was migrated. Settled clean under evidence-led review
  `review-42fc831bfdf7` — 4 lenses, 4 shards, 0 findings.
- **FG-591** (`ecbe7d6f`, PR #218) — the operator work queue: a Kanban board over
  orthogonal durable fields, CLI and dashboard controls, and a long-lived
  capacity-limited dispatcher whose every selection records why it passed candidates
  over. Reviewed under FG-689's sharded discovery — 8 shards, 5 lenses.

## Now

1. **FG-576 — provider-neutral interactive orchestrator launcher:** resolve Claude or
   Codex from model policy. FG-554 and FG-448 are already shipped, so the remaining
   scope is only what they did not deliver.

## Next

1. **FG-688 — a terminally-failed ordered wave has no adopt-preserving re-drive.** Cost
   is proportional to how far a wave got, and it bit twice on 2026-08-06.
2. **FG-692 — FG-591 review residue** (rank no-op advancing queueVersion, WCAG AA
   contrast, origin pinning excluding a non-default loopback bind).

`Next` is deliberately short. Ordering here expresses current operator intent;
it does not override ticket dependencies or authorize scope expansion.

## Captured follow-ups that do not preempt `Now`

- **FG-652** — stage-record SHA in the crash-after-advance recovery window.
- **FG-682** — a documentation correction discovered AFTER the docs stage has
  completed has no supported amendment path. Adjacent to FG-655 but distinct:
  FG-655 is a stage that produced edits and could not commit them; this is a
  correction that arrives once no stage remains to carry it. Scoped as a bounded
  late-docs amendment (declared documentation paths only; code/tests/config and
  undeclared dirty files refused by name; the COORDINATOR commits and advances
  the candidate; SHA-bound verification invalidated and CI required at the new
  candidate; docs closeout plus a bounded delta check, never full re-discovery).
  FG-678's two overrides are its demonstrated impact.
- **FG-681** — roughly 76 integration tests across at least 13 files fail on the
  Darwin host and pass in CI at the same commits. The dominant signature is a
  pre-container refusal, not assertion drift. Root-cause the shared harness or
  runtime input from the smallest `fg381` and largest `fg628` reproductions;
  do not patch, skip, or allowlist individual symptoms. FG-676 may explain only
  the five campaign cases and is no longer the leading general hypothesis.
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
