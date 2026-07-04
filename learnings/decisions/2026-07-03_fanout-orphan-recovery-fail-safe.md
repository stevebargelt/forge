# Decision: Fail-safe recovery for lost containers — adopt vs. re-drive, gated behind an explicit operator command

**ID**: FORGE-DEC-024
**Date**: 2026-07-03
**Status**: Decided
**Decided by**: Steve (forge build, FG-455 p2/p3)
**Supersedes**: N/A
**Scope**: forge

---

## Context

FG-455 p1 taught reconcile to stop discarding a lost container's work: if the worktree has changed files but no parseable result, the task fails as `orphaned_work_may_persist` instead of silently completing or silently re-orphaning. That closed the "discard real work" gap for a single task, but left two harder cases open:

1. A **fanout parent** never gets its own container (`dispatchFanoutStep` only spawns children), so the per-task container-liveness loop in `reconcile.ts` always skips it. If the process that would have finalized the wave dies mid-run, the parent is stuck `running` forever — no dashboard state, no `forge next` progress, no way out except manual DB surgery.
2. Once a task (or a fanout parent) is sitting on recoverable evidence — a valid `result.json`, a stdout-inferred result, or just a changed-files diff — forge had no *safe* way to let an operator say "yes, adopt that and move on" without either editing the database by hand or triggering a blind `forge retry` that could stomp the very work it was supposed to recover.

---

## Problem

**How does forge let an operator recover from a lost container without either (a) discarding real work, or (b) silently completing a task on evidence that might belong to someone else's diff?**

---

## Options Considered

### Option A: Auto-recover in reconcile, no operator step

Have reconcile itself decide to adopt persisted work and mark tasks complete, the same way it already resolves fanout parents to complete/failed.

**Pros**: zero new commands; recovery "just happens" on the next `forge next`/`forge status`.

**Cons**: reconcile already runs unattended, with no chance for a human to look at the diff first. Silently promising `complete` from an ambiguous shared-project-dir diff (no dedicated worktree — could contain unrelated uncommitted changes from the operator's own tree) is exactly the false-success failure mode piece 1 was written to avoid. Reconcile's existing bar is "recompute what a live wave would have done"; adopting arbitrary orphaned work is a bigger, riskier claim that deserves an explicit human decision, not an automatic one.

---

### Option B: One `forge recover <id>` command, read-only by default, explicit flags to mutate ✅

Add a dedicated command. Default (no flags) is pure inspection: recompute the same evidence reconcile would use (worktree vs. shared-dir source, changed files, valid-result / stdout-recoverable), and print a recommended next command — `--json` for the full structured surface. Two distinct, explicit mutating modes:

- `--continue`: adopt the single task's persisted work (precedence: valid `result.json` > stdout-inferred > raw diff) and mark it complete via a **new** store primitive, `markTaskRecovered` — a compare-and-set that only fires from `status = 'failed'`. This is deliberately a *different* transition than `markTaskComplete`, whose CAS blocks `failed → complete` outright (that guard exists to stop a completing container racing a `forge cancel` from resurrecting a task the operator just killed). An operator's explicit `--continue` is a different, gated decision, so it gets its own transition rather than loosening `markTaskComplete`'s guard for everyone.
- `--re-drive`: re-dispatch an orphaned fanout wave by minting one fresh pending primary task in the step's phase — the same shape `dispatchFanoutStep`'s existing-parent lookup already expects (the pattern `gate.ts`'s `request-changes` also uses). The old parent and children are left in place as an audit trail. This always re-runs the **full** wave; there's no partial-index resume for just the children that failed — that would need deeper `dispatchFanoutStep` surgery and was ruled out of scope.

Both mutating paths are fail-safe: they refuse with no writes when the task isn't in a recoverable state, when there's nothing to adopt, or when the only evidence source is the ambiguous shared project directory — that last case requires `--force` to acknowledge explicitly.

**Pros**: recovery is a first-class, auditable, human-gated operation. The read-only default means an operator can always look before touching anything. The refusal conditions are load-bearing safety, not friction — each one maps to a specific way recovery could otherwise silently do the wrong thing.

**Cons**: one more command surface to keep in sync with reconcile's own evidence-gathering logic (mitigated by `forge recover` recomputing evidence live from the same primitives reconcile uses, rather than trusting stale persisted evidence).

---

## Decision

**Chose**: Option B — `forge recover <id>`, read-only by default, `--continue` / `--re-drive` / `--force` as explicit, individually-gated mutations.

**Rationale**: The single unifying principle across FG-455 p1/p2/p3 is *prefer fail-safe refusal over false success — never silently discard persisted work, and never silently claim more certainty than the evidence supports.* A dedicated, explicit command is the only way to give an operator a real look at the evidence before any state changes, and per-refusal-reason gating (not-recoverable / nothing-to-adopt / ambiguous-source) makes each safety property independently testable and independently overridable.

The same principle forced two related retry-side closures once `forge recover` existed as the "correct" path:
- `forge retry` on a fanout **child** now refuses without `--force` (`FanoutChildRetryError`) — retrying a child directly mints a stray parentId-undefined primary in the same phase as the real parent, confusing `dispatchFanoutStep`'s existing-parent lookup. It points at `forge recover <parent> --re-drive`.
- `forge retry` on a fanout **parent** (`failure_kind: fanout_wave_orphaned`) is now a `retry-policy.ts` POLICY entry (`retryable: false`), refused the same way `gate_rejected`/`red_blocked` already are — a blind retry would mint a second, uncoordinated pending primary, bypassing `--re-drive`'s dupe-pending guard and audit trail.

Both guards exist so `forge recover --re-drive` stays the single coordinated path for re-driving a wave — without them, `forge retry` was a trapdoor that bypassed the exact coordination `forge recover` was built to provide.

---

## Consequences

**Positive**:
- An operator can always inspect (`forge recover <id>`, no flags) before deciding anything — nothing mutates on the read path.
- `markTaskRecovered`'s narrow CAS (`'failed'` only) means it can never clobber a task that legitimately completed or was already recovered through another path — safe by construction, not by convention.
- `forge show`'s recommended next command and `forge retry`'s refusal now agree with each other for every orphan-related `failure_kind` (`orphaned_work_may_persist`, `fanout_wave_orphaned`) — a red-wide review pass (eb146a4) closed the two spots where they'd drifted (`forge retry` was unguarded for a fanout parent; `forge show` still recommended it).

**Negative / Trade-offs**:
- `--re-drive` always re-runs the whole wave, including children that already completed — no partial-index resume. Acceptable for now; revisit if wave sizes or per-child cost make that wasteful.
- Two now-similar evidence-gathering code paths exist (`reconcile.ts` and `recover.ts`'s `gatherLiveEvidence`) since `forge recover` intentionally recomputes rather than trusts persisted evidence (the diff/stdout may look different by the time an operator runs `forge recover` than at reconcile time). Kept as read-only mirrors of reconcile's private helpers rather than a shared exported module, to avoid coupling reconcile's internals to a CLI command's needs.

**Risks**:
- `--continue --force` on a shared (non-worktree) project dir is an explicit operator override of a safety refusal — if the operator forces it against the wrong diff, forge cannot tell after the fact. Mitigated by the refusal message naming exactly what's ambiguous and why, and by `VERIFICATION_HINT` recommending host verification before adopting.

---

## Implementation Notes

- `src/cli/commands/recover.ts` — `performInspect` / `performContinue` / `performReDrive` / `performRecover`.
- `src/store/tasks.ts` — `markTaskRecovered` (CAS from `'failed'`), sibling to and deliberately distinct from `markTaskComplete`.
- `src/v2/retry.ts` — `FanoutChildRetryError` + `fanoutParentOf` (phase-equality + non-`red-` prefix discriminates a genuine fanout child from a red-reviewer child or a gate-reject child).
- `src/v2/retry-policy.ts` — `fanout_wave_orphaned` POLICY entry, `retryable: false`.
- `src/v2/reconcile.ts` — the fanout-parent-in-running pass (FG-455 p2) that produces `fanout_wave_orphaned` in the first place; runs after the per-task container-liveness loop so every child is already resolved.
- `src/cli/commands/show.ts` — `getFanoutWaveEvidenceFromEvents` / `fanoutWaveRecoveryMessage`; both the human and `--json` surfaces render from the same helpers so they can't diverge (this is the exact class of drift the eb146a4 review pass caught and fixed).

---

## Revisit Conditions

- If `--re-drive`'s full-wave re-run becomes expensive enough to matter (large fanouts, costly children), revisit partial-index resume — it needs `dispatchFanoutStep` to accept a starting index/child subset, which was explicitly out of scope here.
- If a second command needs the same live-evidence recomputation `recover.ts` currently mirrors from `reconcile.ts`, extract a shared module instead of maintaining two copies.

---

## Addendum (FG-455 p4, 2026-07-04): `oom_killed` + Mode A empty-result backfill

Two more piece-4 additions extend this decision's evidence-gathering path rather than changing its shape:

- **`oom_killed`**: reconcile now gathers a best-effort `docker inspect` exit-code/OOM probe (`containerExitInfo`, never throws) alongside the existing worktree/changed-files evidence, at the same point it discovers a container is gone with no recoverable result. A positive OOM/exit-137 reading is classified as the new `failure_kind: "oom_killed"` — a more specific cause than `orphaned` / `orphaned_work_may_persist`, and it takes precedence over both (even a dirty worktree), though a recoverable stdout result still outranks it (the task completes instead). It's wired through the same surfaces this decision established for `orphaned_work_may_persist`: `retry-policy.ts` (`retryable: false`, needs `--force`), `recover.ts`'s `CONTINUABLE_KINDS`, `show.ts`'s recovery message, and `ops/detect.ts`'s `forge ops check` (fires only when the worktree is dirty — a clean-worktree `oom_killed` has no persisted work at risk).
- **Mode A backfill**: a distinct gap from anything above — a detached `forge invoke` whose wrapper is killed can leave a task `complete` in the DB with an *empty* result, which the `running`-task reconcile loop never revisits (it's already `complete`). A new pass, scoped to `status = 'complete'` tasks with no result, backfills from the container's own `result.json` or FG-337 stdout synthesis. Status-preserving (never flips `complete` back to anything else) and idempotent (a task with a result is left alone) — deliberately narrower than the adopt/re-drive decision above, since there's no ambiguous state to arbitrate: the task already completed, only its result was lost.

See [docs/concepts.md](../../docs/concepts.md#orphaned-task-recovery) for the operator-facing description of both.
