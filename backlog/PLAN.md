# Forge Working Plan

**Last revised:** 2026-08-05

This is a mutable statement of current operator intent. It is not an approval
boundary, ticket specification, execution record, or source of lifecycle
truth.

The DB-backed backlog is authoritative for ticket scope, acceptance criteria,
dependencies, and lifecycle state. Forge runtime state is authoritative for
what is running, blocked, or done. `backlog/notes.md` is a session handoff and
may lag this plan.

**Expected replacement:** the operator controls and running dispatcher in
FG-591. FG-496's DB-backed backlog and queue primitives are complete.

## Current objective

**FG-576 — provider-neutral interactive orchestrator launcher.** The operator-queue
program is closed: FG-496's primitives, FG-610's claim/lease/recovery, and FG-591's
operator controls and dispatcher have all shipped. FG-576 resolves Claude or Codex from
model policy and absorbs the policy-driven `forge claude` path plus the
provider-specific live-session capabilities from FG-554 and FG-448 — confirm that
absorption against those two tickets before scoping, rather than assuming it.

## Recently completed

- **FG-591** (`ecbe7d6f`, PR #218) — the operator work queue: a Kanban board over
  orthogonal durable fields, CLI and dashboard controls, and a long-lived
  capacity-limited dispatcher whose every selection records why it passed candidates
  over. Reviewed under FG-689's sharded discovery — 8 shards, 5 lenses.
- **FG-689** (`0cc6decb`, PR #220) — reviewer input is scoped to authored lens-to-path
  ownership and sharded when it still exceeds budget, with completeness owed per shard.
  Removed a placeholder a reviewer could author a clean pass on.

## Now

1. **FG-576 — provider-neutral interactive orchestrator launcher:** resolve Claude or
   Codex from model policy; confirm what FG-554 and FG-448 actually contribute before
   treating them as absorbed.

## Next

1. **FG-691 — the store clock is unfreezable**, so lease boundary assertions race. It
   has already produced one intermittent red on a required check; it is the most likely
   source of an unexplained CI failure until it lands.
2. **FG-688 — a terminally-failed ordered wave has no adopt-preserving re-drive.** Cost
   is proportional to how far a wave got, and it bit twice this session.
3. **FG-692 — FG-591 review residue** (rank no-op advancing queueVersion, WCAG AA
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
- **FG-686** — FG-685 residue: `fg352 (11)` no longer induces a failure at the `git
  commit` invocation.
- **FG-687** — FG-584 residue: `renewRunLock` reports success after a superseded write
  to an unlinked inode; the CAS protects the successor, only the return value lies.
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
- Retire this file when FG-591 provides the authoritative operator controls and
  running dispatcher that replace it.
