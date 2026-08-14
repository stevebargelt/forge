# Decision: Serialized integration publisher — validate a candidate in an isolated worktree, publish the exact tested commit through a short CAS window

**ID**: FORGE-DEC-026
**Date**: 2026-07-13
**Status**: Decided
**Decided by**: Steve (forge build, FG-425)
**Supersedes**: the long-lock / gate-process-supervision design carried on `fix/fg425-project-gate-locking` (`ce22024`, pushed, deliberately unmerged)
**Scope**: forge

---

> **Amended by FG-524 (2026-08-14).** The force-advance bullet below ("`gateForced`... runs the publication step alone — no agent re-dispatch, no reds re-collected") described the only `gateForced` re-entry that existed at the time: a human overriding an already-rejected red. FG-524 added a second `gateForced` reason — a fanout parent held at `awaiting_gate` by a *per-child validation-contract* failure, whose reds have never run at all — and that re-entry DOES re-collect the reds, folding them into the same publication validation span exactly as the first pass does. `redsAlreadyRan` (a verdict exists vs. not) is what tells the two re-entry reasons apart; "no reds re-collected" now describes only the human-override case. See [Validation contract](../../docs/concepts.md#validation-contract).

## Context

FG-357 added a post-merge integration gate: after a run's task branch merged into the project's checked-out HEAD, forge ran the project's own `test:unit` suite against that tree and failed the run if it broke. The gate worked, but it was wired backwards.

**The defect.** Validation ran against the publish target *after* the merge had already landed on it. Four sites in `src/v2/runNext.ts`, all the same shape:

| site | merge | gate |
| --- | --- | --- |
| single-primary | `mergeWorktreeBranch` (:625) | `runIntegrationGate(args.projectDir)` (:637) |
| fanout re-entry | `mergeIntegrationBranchToHead` (:1417) | `runIntegrationGate(args.projectDir)` (:1440) |
| fanout, reds passed | `mergeIntegrationBranchToHead` (:1755) | `runIntegrationGate(args.projectDir)` (:1777) |
| fanout, no reds | `mergeIntegrationBranchToHead` (:1801) | `runIntegrationGate(args.projectDir)` (:1823) |

(The FG-425 brief named two of these. There are four; a publisher wired into only the two named ones would have left the defect live on two fanout paths.)

Two consequences followed from that ordering. First, the target sat in a **merged-but-unvalidated** state for the entire duration of a test-suite run — roughly ten minutes on this project — and if the gate then failed, the bad merge was already published; the gate could only report the damage, not prevent it. Second, forge's run locking is per-`runId` (`src/util/run-lock.ts`) and **never** per-`projectDir`, so two runs on the same project could interleave their merges and gates against a moving HEAD: run A merges, run B merges, A's gate now validates a tree containing B's work, and whichever of them "passes" says nothing about what is actually on the target.

The first attempt at a fix (see **Supersession**) accepted the merge-then-validate ordering and tried to make it safe by holding a long per-project lock across merge + gate. That in turn made the liveness of a gate process load-bearing — an orphaned gate process group could still be mutating the target — and so pulled in an entire process-supervision layer: PGID sidecars, PID-reuse detection, leader probes, reaping. That branch was abandoned.

---

## Problem

A run must never publish to a project's target ref a commit that was not validated *exactly as published*, and two runs on the same `projectDir` must not interleave merge/publish against a moving target — without making the correctness of a publication depend on forge's ability to determine whether some other OS process is really dead.

---

## Options Considered

### Option A: Long per-project lock around merge + gate

Keep merging into the target first, then hold a per-`projectDir` lock across both the merge and the full validation run so no second run can interleave.

**Pros**:
- Small diff against the existing call sites; the merge/gate code does not move.
- Genuinely does exclude a concurrent forge run.

**Cons**:
- The target is still merged-but-unvalidated for the whole gate window. A gate *failure* still leaves bad work published; exclusion does not fix inversion.
- The lock is held for ~10 minutes, which makes lock-holder death the dominant failure mode — and therefore makes process liveness load-bearing.
- That forces a supervision layer (PGID sidecars, PID-reuse detection, zombie-leader classification, pre-merge reaping) whose correctness rests on "is that process really dead?", a question with no reliable answer.
- Serializes *execution*, not just publication, blocking FG-396's parallel campaign lanes.

---

### Option B: Serialized integration publisher — validate a candidate, publish it via CAS ✅

Validate a candidate commit in a dedicated, per-attempt integration worktree that is **not** the publish target. Publish that exact recorded commit afterward through a short compare-and-swap window. The publication lock is held **only** across CAS + fast-forward (+ working-tree checkout update for a local target) and **never** across validation.

**Pros**:
- The target is never in a merged-but-unvalidated state: it moves from base to a fully-validated commit in one fast-forward, or it does not move at all.
- The exclusion window shrinks from a test-suite run to a ref update, so lock-holder death stops being the dominant failure mode.
- Process supervision becomes unnecessary — see **Why process supervision is gone**.
- Worker execution stays parallel; only integration and publication are ordered, which is exactly what FG-396 needs.

**Cons**:
- More moving parts: a FIFO lane, a durable attempt record, a per-attempt worktree, two target implementations.
- Single-primary gains an integration worktree it did not have before — more disk, more setup cost per run.
- A moved base costs a rebuild and a second full validation (bounded — AD-1).

---

## Decision

**Chose**: Option B — the serialized integration publisher.

**Rationale**: Option A tried to make an inverted ordering safe by excluding everyone else from it. But exclusion never repairs the inversion — even with a perfect lock, a gate failure still leaves an unvalidated merge on the target, because the merge happened first. And the price of a lock held for ten minutes is that you must then answer "did the holder die?", which is what dragged in the supervision layer. Option B removes the question instead of answering it: validation touches a throwaway tree, so the only thing that must be serialized is a ref update measured in milliseconds.

### The shape

The lane comes **first**, not last. It is what makes the candidate's base stable for the whole of validation, and an attempt that validated before taking its turn would be validating against a base another forge attempt is still free to move.

1. **Record the attempt and enqueue it on the project's FIFO lane.** The durable enqueue key is assigned here — at record time, before any contention — together with the `attemptId` everything downstream (worktree, branch, lane entry, recovery) is keyed on. This is also AD-5's publication intent: it is durable before anything is touched.
2. **Once the attempt owns the active lane turn**: capture the target's base SHA `B`; create the **fresh, per-attempt** integration worktree; merge the task branch(es) there, producing candidate commit `C`; and run the **COMPLETE validation set** — integration gate, then reds and any review gate — against **exactly `C`**, in that worktree. Never against the target.
3. **Still within that same lane turn**, enter the **short publication mutex window**: final target checks (AD-3), the compare-and-swap against `B`, the ancestry proof, the ref update / lease push, and — for a local target — the checked-out tree synchronization.
4. **A moved-base rebuild and its full revalidation remain within the SAME lane turn.** The attempt does not go back to the end of the queue to rebuild; it rebuilds on the new base and re-runs the whole validation set, bounded to one such rebuild (AD-1).
5. **Release the mutex when the publication window closes; release/complete the lane only once the attempt's publication disposition is durable.**

`{ baseSha, candidateSha, publishedSha, target }` is recorded durably per attempt throughout, and finalize/cleanup is idempotent.

The two spans are different sizes and they protect different things — see the next section. The lane turn spans candidate integration and the full validation set (minutes). The mutex window spans the target-mutating operations alone (milliseconds). **Do not describe the ref update as "the only serialized operation":** it is the only operation inside the *mutex*, but validation is serialized too — by the *lane*.

### The binding operator decisions (AD-1..AD-7)

These were recorded by the operator on 2026-07-13 and are binding on the implementation. They are settled; they are not to be reopened, softened, or "improved."

- **AD-1 — Bounded publication attempts.** Two full validations maximum: the initial attempt plus **one** rebuild after a moved base. A second moved-base result **parks** with a named `publish_base_churn` reason and **preserves evidence** (worktrees retained, no cleanup). No candidate batching.
- **AD-2 — One FIFO integration lane per canonical project identity.** Worker execution stays parallel; candidate integration, final validation, and publication are ordered. CAS is still required — the lane does not make it redundant, because the lane does not know about external writers.
- **AD-3 — A dirty local publish target is a named `dirty_publish_target` blocker,** refused **before** any mutation. Never automatically stash, reset, clean, or checkout over operator-owned dirty state.
- **AD-4 — Fresh, uniquely identified integration worktree per publication attempt.** Never pooled, never reused after a crash or a moved-base retry.
- **AD-5 — Crash between ref-advance and checkout-update has a defined recovery.** Publication intent is recorded durably **before** any target mutation; recovery derives from `{ baseSha, candidateSha, currentTargetSha }` and **never** from working-tree contents.
- **AD-6 — Validation evidence binds to the immutable `candidateSha`.** Publication uses that recorded SHA — never a mutable branch tip, never current worktree state.
- **AD-7 — No automatic gate-process reaping.** A crashed attempt is **abandoned**; any retry uses a **new** worktree.

---

## Why process supervision is gone

This is the load-bearing section. It is written down so the reasoning is not lost and the machinery not re-derived.

Gate-process supervision was only ever necessary **because the gate ran against the publish target**. An orphaned gate process group mattered for exactly one reason: it could still be mutating the thing that was about to be published. That is the entire dependency. Supervision was never independently valuable — it was a consequence of where validation ran.

Once validation runs in a throwaway integration worktree, a forge crash that orphans a gate process group is a **resource leak, not a correctness hazard**. The orphan churns inside a worktree whose candidate cannot reach the target without a fresh CAS at publish time; and by AD-6, publication uses the recorded immutable SHA regardless of what that worktree now contains. A stale candidate simply loses the CAS and is abandoned (AD-7). Nothing it can do to its own working tree can reach the target.

So this design deletes, and forbids reintroducing:

- long-held integration / gate locks
- gate PGID sidecars
- PID-reuse detection
- zombie-leader classification
- automatic orphan reaping before merge
- process identity nonces

Orphaned gate process groups are a cleanup/GC concern, owned by FG-356, and are **never** a correctness gate. **Do not reintroduce pre-merge reaping as a safety mechanism.** If you find yourself writing code to decide whether some other process is really dead, you have taken a wrong turn.

**State the dependency direction plainly, because it runs both ways: IF VALIDATION EVER MOVES BACK ONTO THE PUBLISH TARGET, SUPERVISION BECOMES NECESSARY AGAIN.** The supervision layer is not deleted because it was badly built. It is deleted because the thing it protected no longer exists. Move validation back onto the target and you rebuild every one of those six items — so do not move it back.

---

## The load-bearing layering — why the lane is *allowed* to be approximate

Read this before "hardening" anything.

**The lane provides ORDERING only** — FIFO fairness across Forge-owned publication attempts on one canonical project identity (AD-2). That is its whole job. Its *turn* spans candidate integration, the full validation set, and the publication window (including a moved-base rebuild); its *guarantee* is nothing more than "attempts get their turn in the order they were recorded."

**The mutex is a different span with a different job.** It is held only across the target-mutating operations — final AD-3 checks, CAS, ancestry proof, ref update/push, local checkout sync — and never across validation. Ordering authority and mutual-exclusion authority are separate mechanisms, and neither substitutes for the other.

**CORRECTNESS is provided independently, and redundantly, by four mechanisms that do not depend on the lane at all**:

1. the short publication mutex (only one attempt inside the CAS window at a time),
2. the CAS against the **recorded** `baseSha` (the target must still be where the attempt started),
3. the fast-forward **ancestry proof** (the candidate must descend from that base),
4. publication bound to the **recorded immutable `candidateSha`** (AD-6).

Therefore, trace what a *wrongly-skipped* lane entry actually causes. Skipping it admits a second attempt into the publication window. There it meets the mutex, and then it **loses the CAS** — the target is no longer at its recorded base — so it rebuilds (AD-1) or parks. The worst outcome of a mis-takeover is **degraded fairness, and at most a spurious `publish_base_churn` park**. It can **never** cause a wrong publication.

That is precisely why the lane is permitted to be approximate, and why no liveness classification is needed anywhere in it. Without this written down, a future maintainer will read the lane, notice it can theoretically skip a live-but-expired entry, conclude the lane must be "hardened," and reintroduce PID probes to prove the entry's owner is dead — which is the abandoned design that AD-7 deletes. The lane does not need to be right. It needs to be *fair*, and it is allowed to be imperfectly fair.

---

## Lease, not staleness-window

Lane ownership — for the holder **and** for every queued waiter — is a **renewable durable lease**: an owner-written expiry that the owner refreshes. Takeover is permitted only when the recorded expiry is genuinely in the past.

**Explicit negative model: `liveRunLockHolder` (`src/util/run-lock.ts:119-123`).** It applies a fixed staleness window and returns `null` — "no holder" — once a lock is older than `DEFAULT_STALE_MS` (1h) **even when the owning pid is alive**. That rule is fine for its own purpose, and exactly wrong here: a legitimately long-waiting queued run would be declared abandoned at the one-hour mark and evicted, admitting a **second concurrent publisher**. Waiting is not evidence of abandonment. Do not reach for `liveRunLockHolder` or any fixed-staleness rule for the lane.

**A second, independent trap: the gate is synchronous.** `runIntegrationGate` (`src/v2/integration-gate.ts`) is an `execFileSync` — it blocks the event loop for the whole validation run. No timer-driven heartbeat can fire while a holder validates, so a naive timer-renewed lease would let the **holder self-expire mid-gate** and be taken over by the next in line. Two consequences, both load-bearing:

- **Waiters renew inline on their own poll tick** (10–15s), never from a background timer.
- **The holder pre-extends its lease across the declared blocking gate span**, using the gate's *own* configurable timeout (`FORGE_INTEGRATION_GATE_TIMEOUT_MS` / its `DEFAULT_TIMEOUT_MS`) as the ceiling, plus margin. Read that value from `integration-gate.ts`; do **not** duplicate the literal, or raising the gate timeout will silently break the lease.

Lease timestamps are written and compared against one clock (the lane store's), never across independently-sourced process clocks. A lease is a durable timestamp its owner refreshes — that is not process supervision, and it does not become process supervision by being asked to.

---

## Remote publication requires BOTH an ancestry proof AND an explicit expected-SHA lease

Neither substitutes for the other, and the failure is not obvious, so it is recorded here.

`git push --force-with-lease=<ref>:<baseSha>` carries **force** semantics. The lease is a compare-and-swap on the *base*: it asserts "the remote ref is still at `baseSha`." It says **nothing** about the *shape* of the update. Once that CAS matches, force-with-lease will happily push a **non-fast-forward** candidate and discard target history.

So the remote target performs two independent, required checks, in this order:

1. **Ancestry proof** — prove `candidateSha` descends from the recorded `baseSha`, computed **before** any network mutation. This constrains the shape of the update.
2. **Explicit expected-SHA lease push** — `--force-with-lease=<ref>:<baseSha>`, the atomic stale-base guard. This constrains the base.

A naked lease push with no separate ancestry proof is insufficient and is a rejectable finding. **Never use the implicit lease form** (`--force-with-lease` with no expected value): it reads a local remote-tracking ref, which a concurrent `fetch` can poison, turning the guard into a rubber stamp.

---

## `publish_base_churn` is not a tuning knob

With a FIFO lane (AD-2), **Forge-owned attempts cannot move each other's base** — that is what the lane is for. So a `publish_base_churn` park means the target was moved by something *outside* forge: an operator pushing to the target mid-run, another tool, a stray script.

Repeated churn parks are therefore a signal about **external write traffic to the publish target**, not about forge-internal contention. **Do not respond by raising the AD-1 bound.** Raising it would trade a park (which preserves evidence and tells you the truth) for more rounds of losing a race against a writer forge does not control.

---

## Consequences

**Positive**:
- The publish target is never merged-but-unvalidated. It fast-forwards to a fully-validated commit or does not move.
- The exclusion window shrinks from ~10 minutes to a ref update.
- Six categories of process-supervision machinery are deleted rather than maintained.
- Single-primary gains a candidate integration worktree, and reds/review now run against the candidate on *every* path — the fanout path already did this; single-primary did not.
- Worker execution stays parallel, which unblocks FG-396's parallel campaign lanes.
- `{ baseSha, candidateSha, publishedSha, target }` is durably recorded per attempt and operator-visible, so "what actually got published, and what was it validated as?" is now an answerable question.

**Negative / Trade-offs**:
- A per-attempt integration worktree per publication attempt: more disk, more setup cost, more to leak.
- A moved base costs a full rebuild and a second validation (~10 min), bounded to one.
- Publication is now ordered per project, so two runs on one project queue at the publish step rather than racing. That is the point, but it is a latency cost.
- More surface area: lane, mutex, attempt store, two target implementations, per-attempt worktree identity.

**Risks**:
- **A maintainer "hardens" the lane** by adding PID probes to avoid mis-skipping an entry, reintroducing the abandoned design. Mitigation: the *load-bearing layering* section above, which shows the worst case of a mis-skip is a spurious park.
- **A maintainer moves validation back onto the target** for speed (skipping the worktree). Mitigation: stated explicitly above — supervision becomes necessary again, and the whole deleted layer comes back.
- **A leaked worktree is treated as a correctness precondition** and made to block or fail a publish. It is not: cleanup is best-effort and never gates a correct publication (AD-4). FG-356 reclaims them.

---

## Build-phase corrections (2026-07-13, after the build reds)

The first implementation moved the *gate* off the publish target but got the rest of the ordering and the failure modes wrong. These are the corrections, recorded because each one is a rule that will be re-broken if the reasoning is not written down.

- **Validation is ONE set, and publication is conditional on ALL of it.** The first cut ran the integration gate against the candidate but published *before* the reds. A red-rejected candidate had therefore already reached the target — which makes a red a notification, not a gate. The publisher now owns the whole validation set: it always runs the integration gate against the candidate itself (not overridable by a caller), then calls the caller's `alsoValidate` hook, which folds in the reds and any review gate. Nothing is published unless all of it passes.
- **…which is also what makes the AD-1 rebuild sound.** `validate` is called **once per candidate, inside the rebuild loop**. A moved-base rebuild therefore re-runs the *full* set — reds included — against the new `candidateSha`. Re-running only the gate would publish a rebuilt tree that no red ever looked at.
- **A red rejection is now UNPUBLISHED work, so `gate advance --force` must publish it.** Before FG-425, a non-fanout primary was merged before its reds ran, so force-advancing over a rejection only had to mark it complete. That merge was the defect. Now a force-advance re-enters dispatch (`gateForced`, the same mechanism fanout parents already used) and runs the publication step alone — no agent re-dispatch, no reds re-collected. Without that, the ordering fix would silently *drop* force-advanced work instead of shipping it. The integration gate still runs on re-entry: a human overriding a red is not a human overriding a broken build, and they did not ask to.
- **The lease must be renewed across EVERY span the owner can block in.** It was renewed across the lane wait and across validation, but not across the wait for the publication mutex — so a live holder blocked on the mutex could lapse and be taken over: the exact FIFO break the lease exists to prevent, one span later. Both mechanisms are needed and neither covers both cases: a **timer heartbeat** for async spans (reds are containers), and a **pre-extension** for the synchronous gate, inside which no timer can fire at all.
- **A takeover is a defined terminal state, not an invariant violation.** `laneTick` assumed its own entry was still active. A live owner whose lease lapsed gets marked `abandoned` by another process, and on its next tick could then neither become head nor exit — it dereferenced an undefined head (TypeError) or waited forever (production passes no `maxWaitMs`). It now returns `takenOver`, and the owner **parks with a named `lane_taken_over` reason**. Nothing is signalled, probed, or reaped — AD-7 is untouched; a takeover is still nothing but a durable timestamp being in the past.
- **AD-3 refuses BOTH shapes of operator-owned state.** `git read-tree -m -u` refuses to clobber an *untracked* file — and it refuses **after** the ref has advanced. The dirty pre-check ignored untracked files, so the target's ref could advance, the checkout then fail, and the target be left with its ref ahead of its index — which every later publication's AD-3 check reads as tracked dirt. One publication wedged the project permanently. The pre-check now computes the base→candidate diff against the target's untracked set and refuses the collision **before any mutation**, with a named blocker. Forge still never deletes, stashes, or checks out over an untracked file.
- **A checkout FAILURE after the ref advance is ROLLED BACK — but ONLY while mutex ownership is CURRENTLY PROVEN. A CRASH there is recovered.** These are different, and both must be defined. On failure, the ref advance is undone by CAS (`update-ref <ref> <base> <candidate>` only lands if the ref is still the candidate *we* just wrote), the publication is refused, and the target ends byte-for-byte where it started: nothing published, nothing staged, and **the next publication is not blocked**. On a crash there is no rollback, and AD-5 recovery re-runs the idempotent checkout instead. *A publication must never leave the target in a state that blocks the next publication* — that is the rule the rollback exists to keep.

  **The CAS is NOT what makes the rollback safe, and an earlier version of this ADR said it was.** That claim — that the rollback "deliberately does not renew the hold" because a CAS "is safe with or without the mutex" — was false, and it was the defect. A publisher whose lease lapsed may have been overtaken by a thief that already AD-5-recovered *index and worktree* onto the candidate. The lapsed publisher's CAS "undo" would then still succeed against the *ref* — leaving ref=base with the tree at the candidate: a dirty, divergent target that no later publication can pass AD-3 against. The CAS proves only that the ref is still our own write. It proves nothing about the tree.

  **The invariant, absolute: once a publisher discovers it no longer owns the mutex, it executes NO target-mutating command — not `update-ref`, not `read-tree`, not `checkout`, not `reset`, not cleanup, not even an undo of its own write.** The rollback is itself a target mutation, so it runs only under ownership renewed/pre-extended *for that rollback*, immediately before it. If ownership cannot be confirmed, the publisher touches nothing and preserves the durable publishing intent instead — the ref carries the candidate, the attempt still records `{baseSha, candidateSha, target}`, and the window's **current owner** converges it through AD-5 from those three facts. See the next two sections for what that convergence is and who is allowed to perform it.
- **AD-6 means `publishedSha` IS the recorded `candidateSha` — including on the way out.** It was being read *back* from the target after the CAS. An external writer landing between the CAS and the readback would turn a publication that **actually landed** into a `publish_base_churn` park claiming nothing was published. The CAS wrote exactly `candidateSha` or it failed; there is no third outcome, so the AC's proof (`publishedSha === candidateSha`) is an assertion, never a lookup. Same rule on the remote path: no confirming `ls-remote` after a successful push.
- **AD-5 recovery reads the RECORDED target ref, and RUNS BY ITSELF.** It was re-deriving the local target from the repo's current `HEAD`, discarding the branch recorded on the attempt — so an operator who checked out another branch after the crash would have recovery read the wrong ref, and a detached HEAD made it throw outright. It now parses the recorded target descriptor. And it is invoked automatically at the top of every `runNext` wave (`recoverUnfinishedPublications`), not left for a human to happen to type `forge publish recover`: **a defined recovery that nothing ever invokes is not a recovery, it is a manual procedure nobody knows to run.**

---

## Only AD-5 convergence may terminalize a `publishing` attempt

`publishing` is the one non-terminal attempt state in which **the target may already carry the candidate** — its ref advance has landed. Everything below follows from that single fact.

`laneTick` sweeps the lane: an entry whose lease has lapsed is marked `abandoned` so the next attempt can take its turn. It used to terminalize that entry's **attempt record** in the same sweep, and `publishing` was not excluded. A foreign lane poll therefore flipped a `publishing` attempt to `abandoned` — which hid it from `unfinishedPublications` (which selects `publishing` only) *and* from `recoverPublicationAttempt` (which refuses to rewrite a terminal record). The durable `{baseSha, candidateSha, target}` intent was stranded, and the target was left permanently divergent: ref at the candidate, tree at the base, with the next publication's AD-3 check reading the whole diff as operator dirt and blaming a human for it.

**The rule, and the reasoning that must not be re-derived: a lane lease lapsing means the OWNER is gone. It does NOT mean the owner's ref advance is gone.** Those are different facts about different things, and only the first is a timestamp in the past.

So the two are separated:

- **The LANE entry is still abandoned.** That is ordering, and losing a turn costs **fairness** only — the layering section above is what licenses this.
- **The ATTEMPT record is never touched by the lane.** Only the convergence path — AD-5 recovery, derived from `{baseSha, candidateSha, currentTargetSha}` — may terminalize a `publishing` attempt, because only it looks at the ref, which is the only thing that knows whether the candidate landed.

A takeover therefore parks the *displaced attempt's task* with `lane_taken_over` (nothing was published; the lane entry was lost before the window), while an attempt that reached `publishing` is settled by recovery and by nothing else.

---

## A lost publication window yields exactly ONE truthful disposition (AC5)

`MutexLostMidPublishError` is **reachable in production**. Any deschedule longer than the mutex lease TTL opens the window between two operations: laptop suspend, SIGSTOP, a container pause, swap thrash, a long IO or GC stall. Do not argue it away; it is a state the system must have a defined, truthful answer for.

**The contradiction this replaces.** A publisher that advanced the ref and then lost the window used to return a **terminal `refused`** while its attempt row remained `publishing`. `runNext` mapped that to `publication_refused` and failed the task. A later AD-5 sweep then converged the very same attempt to `published` — and nothing reconciled the already-failed task. The result was two durable records contradicting each other, and the *failed* one advised a **retry of work that had already landed on the target**.

**The invariant: a terminal refusal may NEVER stand over an attempt still recorded `publishing`.** A refusal says "nothing was published"; over a `publishing` attempt whose ref advance landed, that is the most dangerous available lie, because the operator's natural response to it duplicates published work.

So the publisher **converges instead of guessing**:

1. It takes the window **back** — a bounded **lease wait** (`2 × MUTEX_TTL`), and nothing more. Nothing is probed, signalled, nonced, classified, or reaped (AD-7 is untouched). The bound is honest rather than arbitrary: the mutex covers a CAS, a ref write and a checkout, so a **live** holder is out of it in seconds and a **dead** one is out of it in one lease TTL. Waiting past both bounds is the point at which "we should have had our turn by now" is true.
2. With the window held, it converges **its own attempt** through the same AD-5 path the sweep uses — derived from `{baseSha, candidateSha, currentTargetSha}`, never from working-tree contents — and reports the disposition **the ref proves**. (A settled record needs no window at all: whoever took the mutex may have swept it already, and a settled attempt is *reported*, never re-derived.)
3. If the window never comes free within that bound, it returns the **NON-TERMINAL `recovery_pending`** outcome, and the owning task parks in the **non-terminal `awaiting_recovery`** status. No terminal claim is written over an unsettled publication — forge says "I do not know yet", because that is the truth.

**Recovery is not left to a human noticing.** `reconcilePublicationRecoveries` runs at the top of **every** wave, immediately after the AD-5 sweep: the sweep converges the **publication** from the ref, then reconciliation moves the **task** onto whatever the publication converged to. A `published` attempt completes its task through the gate its step declares (a lost mutex is not a reason to skip a human gate); an attempt converged to a non-published disposition fails its task with the **converged** failure kind — never with a kind guessed back when the window was lost. `forge publish recover <attemptId>` does the same by hand.

That reconciliation also **REPAIRS a task recorded `failed` beside a `published` attempt**. It has to: the contradiction has more than one way in — a database written by a build predating this fix, and the crash window between the publisher returning and the `awaiting_recovery` status landing, after which reconcile lands the stranded `running` row as a terminal failure while the sweep converges its attempt to `published`. The rule is about the **contradiction**, not about how it arrived: a `published` attempt's task tells the truth, whatever it said before. A `failed` task with no published attempt is a real failure and is never touched.

**Do not read this section back onto the original implementation.** "An attempt interrupted inside the publication window is always converged by AD-5 recovery" became true only with the laneTick fix above — before it, a foreign lane poll could terminalize the `publishing` record and put the attempt permanently beyond recovery's reach.

The new task status this requires (`awaiting_recovery`) is its own schema change and has its own ADR — **FORGE-DEC-027** (`2026-07-13_awaiting-recovery-task-status.md`).

---

## Implementation Notes

- **Scope.** The publisher is **worktree-mode-scoped** (`isWorktreeModeEnabled()`, `FORGE_WORKTREES=1`, opt-in). Non-worktree runs bind-mount the shared project dir, do no merge, and run no integration gate; their behavior is unchanged — no lane, no publication lock, no gate. A negative test pins this so a later refactor cannot quietly route them into the lane.

  > *Superseded by FG-345 (2026-07-28): isolation is now default-on.* The scoping predicate is unchanged — the publisher is still `isWorktreeModeEnabled()`-scoped — but that predicate no longer means "opt-in". It resolves on by default on a darwin host, so the publisher path is the ordinary one and the bind-mount path described above is now the exception (`FORGE_NO_WORKTREES=1`, or a non-darwin host).
- **Canonical project identity is the key.** Both the FIFO lane and the publication mutex are keyed on a realpath-canonicalized `projectDir`, so symlink, trailing-slash, and relative spellings collapse to one identity. Two runs naming the same project differently must land in the same lane; runs on genuinely different projects must not.
- **Durable state lives under `FORGE_HOME`, never inside `projectDir`.** Writing bookkeeping into the target would register as target dirt and trip the AD-3 dirty check against itself, and would be swept into the very fast-forward being coordinated.
- **Lane writes take their write lock immediately (`BEGIN IMMEDIATE`)** — enqueue, lease renewal, takeover-marking, terminal transition. The lane is the highest-contention cross-process write path in the system, and a deferred txn that upgrades mid-flight is exactly FG-548's `SQLITE_BUSY` shape. This is a constraint on *how* the publisher writes; it does not absorb FG-548's broader fix.
- **Ordering authority and mutual-exclusion authority are separate.** The durable enqueue key answers "who goes next"; the short mutex answers "who is inside the window now." Do not collapse them. "Take a file lock and hope" is not FIFO — OS lock grants are unordered.
- **Do not route the publisher through the FG-353 helpers** (`integrationBranchName` / `createIntegrationWorktree`, `src/v2/worktree-lifecycle.ts:336-400`). They are keyed on `(runId, parentTaskId)` and are **prune-then-create** — they deliberately reuse the same path and force-delete a stale one. That is the reuse AD-4 forbids, and worse, it would make the AD-1 moved-base rebuild destroy the first attempt's tree, which is precisely the evidence AD-1 requires be preserved. Those helpers keep their current keying for the fan-out child-merge role and are left unmodified; the publisher gets its own **create-only**, per-attempt identity keyed on the `attemptId` minted when intent is recorded.
- **Finalize/cleanup is idempotent** and safe to re-run after a crash at any step. Worktree teardown is best-effort and is never a precondition for a correct publication — a leaked worktree must never fail a correct publish.

---

## Supersession

Branch **`fix/fg425-project-gate-locking` (`ce22024`)** is pushed and **deliberately unmerged**. Do not delete it, do not merge it, do not branch from it. It exists as the record of the abandoned design. This ADR supersedes it.

**Salvaged from it** (and only these three things):
- **`projectIntegrationLockKey`** — canonical project identity: realpath-canonicalized `projectDir` collapsing symlink / trailing-slash / relative spellings to one identity. This is the key both the FIFO lane and the publication lock are keyed on.
- **`describeWait`** — operator-visible contention: names the holding run, the project, elapsed wait, and next action. Reused for the lane queue and the short publication window.
- **The multi-process test harness** (`project-integration-lock.integration.test.ts`, `fg425-project-gate-lock.worktree.test.ts`) — it spawns *real* separate forge OS processes. Retargeted at CAS publication and FIFO ordering rather than long-lock exclusion.

**Discarded from it, and not to be revived**: `GateGroupRecord`, `leaderCommandOf` / `LeaderProbe`, `terminateProcessGroup`, `reapResidualGateGroup`, and the leader nonce in `integration-gate.ts`. These were the process-supervision layer. They exist only to answer "is that other process really dead?", a question this design no longer asks.

---

## Seams with other tickets

- **FG-356** owns eventual orphan worktree reclamation, via the worktree handle recorded on each publication attempt. Cleanup is never a correctness prerequisite for publication.
- **FG-548** (`SQLITE_BUSY` on deferred write txns under multi-process WAL) is why lane writes take their write lock immediately. FG-425 does not absorb its fix.
- **FG-396** (parallel campaign lanes) is unblocked by this: AD-2's lane orders *publication*, not execution.
- **FG-345** owns the broader worktree model; **FG-353** owns the fan-out child-merge integration worktree, whose helpers the publisher deliberately does not use.
- **FG-357** is the post-merge integration gate this redesigns.

---

## Revisit Conditions

- **If validation is ever moved back onto the publish target** — then process supervision becomes necessary again, and this ADR's central claim no longer holds. Revisit the whole design, not just the supervision question.
- If `publish_base_churn` parks become common *without* an external writer to the target, the FIFO lane is not actually ordering Forge-owned attempts — that is a lane bug, not a reason to raise the AD-1 bound.
- If a remote publication target gets a real production caller, revisit whether the ancestry proof + expected-SHA lease pair is still sufficient against that specific host's ref-update semantics.
- If publication latency from lane queueing becomes the dominant cost on a busy project, revisit candidate batching — which AD-1 explicitly excludes from v1, and which would need its own decision.
