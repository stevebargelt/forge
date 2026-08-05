# Decision: `awaiting_recovery` — a non-terminal task status for a publication whose window was lost after the ref advance landed

**ID**: FORGE-DEC-027
**Date**: 2026-07-13
**Status**: Decided
**Decided by**: Steve (forge build, FG-425 AC5)
**Supersedes**: N/A
**Scope**: forge

---

## Context

`tasks.status` is forge's state machine. Its values (`pending | running | awaiting_gate | awaiting_red | complete | failed | blocked_by_red`) are read by the ready queue, the gate verbs, retry, reconcile, the campaign executor, the FG-530 harness, and every operator surface. Adding one is a schema change and needs a decision record — which is what this is.

FG-425's integration publisher (FORGE-DEC-026) publishes a validated candidate through a short mutex window: CAS against the recorded base, ref update, then — for a local target — synchronize the checked-out index and working tree. The mutex is a **renewable durable lease**, so it can lapse. `MutexLostMidPublishError` is reachable in production: any deschedule longer than the lease TTL (laptop suspend, SIGSTOP, container pause, swap thrash, a long IO/GC stall) opens the window between two operations.

That produces a state with no honest answer in the old vocabulary. The publisher advanced the ref — **the candidate is on the target** — and then lost the window before it could settle what that means. Its attempt row is still `publishing`, the one non-terminal attempt state in which the target may already carry the candidate.

The old code returned a **terminal `refused`** here. `runNext` mapped it to `publication_refused` and marked the task `failed`. A later AD-5 sweep then converged the same attempt to `published`, and nothing reconciled the task. Two durable records contradicted each other — and the failed one advised **retrying work that had already landed on the target**. `failed` is not merely imprecise for this state; it is the single most dangerous thing forge could say about it, because the operator's natural response to it duplicates a publication.

---

## Problem

A publication that lost its window after the ref advance has **no terminal truth yet**. Forge needs a way to say "this is not settled, and I will not guess" — durably, visibly, and without inviting a retry — until AD-5 convergence determines what actually happened.

---

## Options Considered

### Option A: Keep it in `failed` with a special failure kind

Reuse the terminal status and distinguish the case by `failure_kind`.

**Pros**: no schema change; every existing consumer keeps working unmodified.

**Cons**: `failed` is **terminal**, and its whole operator contract is "this did not happen, fix it and retry." Every surface that reads a terminal status — retry advice, campaign blocker classification, `forge show`'s next-command line — would have to special-case one failure kind to *suppress* the advice the status itself implies. The first surface to miss the special case tells an operator to retry a publication that already landed. The status is the load-bearing signal; a payload field cannot outvote it.

### Option B: Block in-run until the window frees

Do not return at all — wait for convergence, however long it takes.

**Pros**: the task only ever lands on a settled truth; no new status.

**Cons**: unbounded. The publisher already waits a bounded lease interval (`2 × MUTEX_TTL`) and converges in the overwhelmingly common case. Waiting past that means blocking a forge process indefinitely on a window a crashed holder may never release, which trades a truthful record for a hang.

### Option C: A distinct NON-TERMINAL status — `awaiting_recovery` ✅

Name the state. The task parks, no terminal claim is written, and forge's own next wave converges it.

**Pros**: the status says exactly what is true — *unsettled, recoverable, do not retry*. Terminal-status consumers are untouched (it is not terminal, so `failed`'s contract is never stretched to cover a case it contradicts). Retry, gate, and the advisor can refuse or redirect on the status itself rather than on a payload field.

**Cons**: a schema change, and one more status every consumer must handle. It also depends on a subsequent wave running to clear it (see **Consequences**).

---

## Decision

**Chose**: Option C — `awaiting_recovery`, a non-terminal task status (`src/types/index.ts`, `markTaskAwaitingRecovery` in `src/store/tasks.ts`).

**Rationale**: the state genuinely is not terminal, and the FG-425 invariant is absolute — *a terminal refusal may never stand over an attempt still recorded `publishing`*. Option A satisfies the letter of that invariant while breaking its spirit: it keeps writing a terminal row and hopes every reader notices the asterisk. The status is what surfaces, what retry checks, and what an operator reads first, so the status is where the truth has to live.

### What it means, and exactly when a task enters it

`awaiting_recovery` means: **this task's publication attempt advanced the target ref, then lost the publication window before its disposition could be settled — and the attempt is still recorded `publishing`, so no terminal claim about it may be made.**

The one entry path is `awaitPublicationRecovery` (`src/v2/runNext.ts`), reached only when `publishIntegration` returns the non-terminal `recovery_pending` outcome. The publisher returns that only after it has:

1. lost mutex ownership *after* its ref advance landed (`MutexLostMidPublishError` — and, per AC1, having mutated **nothing** further, because a publisher that has lost the window executes no target-mutating command, not even a rollback of its own write); then
2. tried to take the window **back** for a bounded lease wait (`2 × MUTEX_TTL`) in order to converge its own attempt through AD-5; and
3. still not gotten it.

If it *does* get the window back, it converges and reports the true disposition, and no task ever parks here. `awaiting_recovery` is the residue of the case where convergence could not be completed in-run.

The write is CAS'd like every other non-terminal landing (`WHERE status NOT IN ('complete','failed')`): a concurrent `forge cancel` or any terminal write wins, and the call reports that it did not land.

### Why it is non-terminal, and what makes it recoverable rather than a wedge

Two mechanisms clear it, and the first needs no human at all:

- **`reconcilePublicationRecoveries`** runs at the top of **every** wave (`src/v2/runNext.ts`), immediately after `recoverUnfinishedPublications`. The pair is: converge the **publication** from the ref (AD-5, derived from `{baseSha, candidateSha, currentTargetSha}` alone), then reconcile the **task** from the publication. A `published` attempt completes its task through the gate its step declares; an attempt converged to a non-published disposition fails its task with the **converged** failure kind, read off the record rather than guessed. An attempt still `publishing` — a live publisher owns it, or the window is busy — is left alone and the task stays recoverable: an unsettled publication is not a failure, and waiting is not a wedge, because the next wave sweeps again.
- **`forge publish recover <attemptId>`** runs the same idempotent convergence by hand — and then the **same `reconcilePublicationRecoveries`**, so it clears the status on its own rather than settling the attempt and leaving the task parked until someone happens to run `forge next` (a hand recovery that only converged the publication would leave a `published` attempt beside a task that disagrees with it: the very contradiction above, arriving by a different door). It takes the publication window or refuses, naming the holder; it reports the reconciled task's resulting status. The one thing it cannot do is reconcile a task whose run's workflow no longer resolves — the task's landing needs the gate its step declares — and it says so by name rather than failing a recovery that already converged the target.

The terminal verbs refuse the status by name rather than mishandling it: `forge retry` explains that the work may already be published and that a retry would publish it twice; `forge gate` explains that there is nothing to gate yet and that `--force` cannot settle it. `forge show`, `forge status` (`⧗`), and the advisor all surface it, and all three lead with **do not retry**.

### Why it is exempt from `checkNoPermanentWedge`

The FG-530 harness's wedge check (`src/v2/fg530-harness.ts`) requires every non-terminal task at fixpoint to have either an enabled transition or a named operator verb. `awaiting_recovery` is explicitly exempted.

**Why the exemption is sound**: the transition out of this state is **forge's own**, and it is enabled on every subsequent wave. `forge next <runId>` converges the attempt and reconciles the task — there is no human decision to wait on, no external event to arrive, no verb the operator must discover. It is not a wedge in the sense the check exists to catch: a task with no way forward.

**Be honest about what it depends on**: *a subsequent wave running*. A task parked in `awaiting_recovery` on a run nobody ever calls `forge next` on again stays there. That is a real bound, and it is why the state is loud on every operator surface (and why `forge publish recover` exists as the by-hand form). The exemption asserts the transition is **enabled**, not that something is guaranteed to fire it.

### The crash-safety argument, and the FG-530 write-surface allowlist entries

The FG-530 probe-inertness suite pins the set of writes forge performs outside a container's own result path; five entries were added for this status (`src/v2/fg530-probe-inertness.test.ts`) — three state writes and two append-only audit events against them. The claim behind all five, recorded here so a future reader can attack it:

> **Both new writes are re-derivable from the same durable pair every other publication write derives from: the `publication_attempts` row and the target REF. Neither invents state; both COPY state that already exists.**

Case by case:

- **`awaitPublicationRecovery` → `markTaskAwaitingRecovery`** (plus its `task.awaiting_recovery` audit event). A crash **before** this write leaves the task `running` with an attempt still `publishing` — reconcile's container-gone sweep lands that as a terminal failure, and `reconcilePublicationRecoveries` then **repairs** it on the next wave (it reconciles a `failed` task beside a `published` attempt precisely so this crash window cannot strand the contradiction AC5 exists to remove). A crash **after** it leaves the task in the state the next wave reconciles anyway. Neither side can produce a terminal claim that outlives the truth.
- **`reconcilePublicationRecoveries` → `reopenFailedTaskForRecovery`** (the `failed` → `awaiting_recovery` repair step; named and CAS'd on the source status by FG-676, replacing an earlier bare `setTaskStatus` call). It clears a terminal claim left standing over an attempt AD-5 recovery has since converged to `published`, so that `finalizePrimary`'s completion CAS — which refuses to overwrite a `failed` row *on purpose*, guarding a completing container against a concurrent cancel — can land it. The repair steps **through** `awaiting_recovery` rather than around it, so that guard is never relaxed. Idempotent and derived entirely from the durable attempt record: a crash on either side leaves the same record for the next wave to re-derive the same repair from. Since FG-676 the reopen only fires `WHERE status = 'failed'`, and `finalizePrimary`'s own CAS is checked (`landed`) before the sweep may log `task.publication_reconciled` — a human decision (`forge cancel`, a gate rejection) landing in the window between the reopen and the finalizer's write refuses both the write and the event, rather than resurrecting the decided row.
- **`reconcilePublicationRecoveries` → `failTaskIfNotTerminal`** (plus its `task.publication_reconciled` audit event; FG-676's CAS'd counterpart of the earlier unconditional `failTask` call). The terminal failure for a task whose attempt converged to a **non-published** disposition — the ref provably does not carry its candidate, so nothing of it was published. A crash before this write leaves the task non-terminal with the attempt already settled, and the next wave re-derives exactly this landing from that same settled record. The CAS refuses (no row write, no event) if a human's decision landed on the row between the sweep's read and this write — the same guard as the published arm above, so neither arm of the sweep can launder a decision made in its own read-to-settle window.

**Where to attack it.** The argument rests on the durable pair being sufficient to re-derive the task's state at any point, which in turn rests on the attempt record never being terminalized by anything except AD-5 convergence. That is exactly the invariant the `laneTick` fix established (FORGE-DEC-026, *Only AD-5 convergence may terminalize a `publishing` attempt*) — a lane sweep that terminalizes a `publishing` record strands the intent and the whole re-derivation collapses. If a future change lets any other path write a terminal attempt state, this crash-safety argument is void, and this status becomes a wedge rather than a park.

---

## Consequences

**Positive**:
- The AC5 invariant holds mechanically: no terminal task row can stand over an attempt still recorded `publishing`.
- No operator surface tells someone to retry work that is already on the target — the status itself carries the warning, so a surface that forgets to special-case it still cannot advise a duplicate publication.
- Recovery is forge's own and automatic; the by-hand verb exists but is not the design.

**Negative / Trade-offs**:
- One more status in `tasks.status` — every consumer that enumerates statuses must handle it, and the FG-530 wedge check needs a documented exemption.
- Clearing it depends on a subsequent wave running against that run.
- It is only reachable through one narrow window (a deschedule longer than the mutex lease, mid-publication), so it will be rare in practice and correspondingly under-exercised in the field — which makes its test coverage, not operator familiarity, the thing keeping it correct.

---

## Revisit Conditions

- **If any path other than AD-5 convergence is allowed to terminalize a `publishing` attempt**, the crash-safety argument above is void — revisit this ADR and FORGE-DEC-026 together, not just the status.
- If tasks are observed parking in `awaiting_recovery` and *staying* there, the assumption "a subsequent wave runs" is not holding in practice, and the exemption from `checkNoPermanentWedge` needs to be reconsidered — the fix would be a sweep that is not run-scoped, not a terminal status.
- If the publication mutex ever stops being a lease (or gains process supervision), the bounded lease wait that makes `recovery_pending` rare is no longer what it says it is — revisit AD-7 first.
