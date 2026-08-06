# Decision: the operator queue's capacity ceiling is host-scoped and counted inside the claim transaction; dequeue is planning and never cancellation; and authorizing unattended dispatch stays CLI-only

**ID**: FORGE-DEC-033
**Date**: 2026-08-06
**Status**: Decided
**Decided by**: forge (FG-591)
**Supersedes**: N/A — CONSUMES FG-609's queue primitives and FG-610's claim/lease primitives as they shipped, and RESOLVES the two decisions FG-610 deliberately deferred
**Scope**: forge
**Elevated from**: N/A

---

## Context

FG-609 shipped the DB-backed operator queue (one canonical nullable stack rank, queue membership, readiness, derived projections, `queue_events`). FG-610 shipped the durable reservation primitives over it (`queue_claims`, `claimNextEligible`'s two-phase scan, fenced leases, expiry-only takeover, the `ScanReason` vocabulary, capacity counted inside the write transaction). Neither shipped an operator-facing surface, and FG-610 explicitly deferred two questions to whoever owned `max_active_runs`:

- **which counting scope the ceiling uses** — the claim row carries `project_key` and the scope is a required, defaultless caller argument, with both scopes already proven under concurrency;
- **whether a cancel path should stop work on dequeue** — releasing a live claim re-admits a ticket that a container may still be executing.

FG-591 is that owner. It also arrived with a production reproduction attached: after FG-584 closed, the interactive orchestrator wrote "Starting FG-591" and ended its turn. With the operator silent, no run, task, launch, continuation or claim was created, while the orchestrator heartbeat kept describing the session as live. A natural-language sentence is not durable intent, and session liveness is not progress.

So this ticket had to answer, together, what authorizes unattended execution, what bounds it, what stops it, and what is recorded when nothing happens.

---

## Problem

Turning a durable reservation primitive into an autonomous execution engine raises four questions that cannot be answered independently without creating the exact defect the primitive exists to prevent:

1. What does the capacity ceiling count, in what scope, and how is every *other* kind of Forge work on the host accounted for?
2. What ends a reservation, and in what order relative to stopping the work?
3. What authorizes an unattended, repo-writing container to start — and on which surfaces may that authority be exercised?
4. When nothing starts, what durable record explains it?

---

## Decisions

These are the ticket's binding decisions D1–D13, recorded as decided. D1–D11 are architecture; D12–D13 constrain how the required falsification is built.

### D1 — a dashboard mutation that shells the CLI violates neither FORGE-DEC-015 nor BD-7 ✅

The architecture pass treated a dashboard write as colliding with both. Verified against the records: **FORGE-DEC-015 CHOSE** "dashboard shells out to the forge CLI for mutations", so a CLI-shelling `POST` route is the *prescribed* path, not a breach of it. **BD-7** (invariant 21) is scoped to the FG-679 *serving and polling* paths and already records two pre-existing serving paths that shell out as named exceptions. Neither decision is re-cut here.

What remains binding: the dashboard process never writes the DB directly, and the FG-679 serving/polling guard is neither widened to cover the mutation routes nor narrowed to excuse them.

### D2 — capability split on an unauthenticated surface ✅

Planning writes — rank, enqueue, dequeue, reorder — ship as CLI-shelling `POST` routes behind an Origin / `Sec-Fetch-Site` check and a non-simple content type. **Arming or disarming autonomous dispatch, and setting `max_active_runs`, stay CLI-only.** DEC-015 accepted an unauthenticated localhost surface for gate and next; authorizing *unattended container execution* is a materially larger capability and is not covered by that acceptance. This is a scope choice, not a security re-cut, and it is enforced by a closed exported route table and verb set rather than by prose.

### D3 — the capacity ceiling is HOST-scoped, with a host-wide value and per-project dispatch ✅

The resource being protected is the host: one Docker daemon, one machine's CPU and memory, one shared auth profile and its rate limits, one tmux server, one `~/.forge/forge.db`. A project-scoped ceiling of 2 across three registered projects permits six concurrent container runs on one laptop — the overload a ceiling exists to prevent, and unreadable from any single board. The *value* is host-wide (one `dispatcher_policy` singleton) because two dispatchers holding different values while enforcing against one shared count means the effective ceiling is whichever ran last: an incoherence with no owner. Rank, membership, scan domain and dispatcher identity stay per-project.

**Where it is counted is the load-bearing half.** The ceiling MUST be counted inside `claimNextEligible`'s write transaction. SQLite cannot enforce a `COUNT`, so a ceiling checked in a dispatcher loop, or subtracted as read-phase headroom, is advisory: it over-admits with no constraint violation and no trace.

**The stated capacity policy** (the AC requires one, in one place):

> `max_active_runs` is a hard bound on **queue-owned** concurrent runs only, counted as live `queue_claims` rows inside `claimNextEligible`'s write transaction, in host scope. Operator-initiated runs (`forge new`, `forge invoke`), campaign items and review loops carry no claim row, are structurally invisible to that count, and are **reported beside the ceiling and never counted against it**.

The tempting alternative — derive a count of other live runs and subtract it as dispatcher-side headroom — is rejected, not overlooked. The subtraction would necessarily happen outside the transaction that admits, so it could not bound anything; and **presenting an uncounted number as though it bounded something reads as a guarantee while being a guess**, which is worse than not counting it. If host-total bounding is wanted later it belongs *inside* the claim primitive as a second counted set, never as a dispatcher-side subtraction.

The accepted cost is stated rather than dismissed: a host-scoped refusal is opaque from inside one project ("my queue is stalled and my board shows nothing running"). It is mitigated by naming the holder — the scan already reports `${usedSlots}/${capacity} live claims in ${capacityScope} scope`, and the live-claim read returns each holder's `projectKey`, so `forge queue dispatcher status` and the board's capacity context name **which other project holds the slots**.

### D4 — dequeue never releases a live claim; cancellation is a separate act with a fixed order ✅

An operator dequeue, unrank or defer records planning **intent** and never touches a live claim. Releasing a reservation while its container still executes re-admits the ticket to the scan, and a second dispatcher claims work that is already running — the duplicate execution the claim primitive exists to prevent.

The store already refuses the shortcut, which is why the shortcut is dangerous rather than merely wrong: `releaseClaim` is owner+generation fenced and additionally requires a live lease, so a dequeue path could not release someone else's claim even if it tried — it would silently return `null`, which *looks like success*.

Cancellation is `forge queue cancel <id>`, and the ordering is not symmetric: **stop the work first**, through the existing cancel seam, and only then let the claim's own **lease owner** retire the reservation. Where the owning dispatcher is dead, lease expiry plus takeover is the recovery path, and the successor discovers the prior launch through the retired predecessor's recorded launch identity rather than finding an empty slot.

FG-591 owns the release vocabulary this creates: `completed | failed | cancelled | launch_failed | superseded`, beside FG-610's existing takeover outcome. Each value describes the **reservation**, never the work — `launch_failed` means the reservation ended because no container was ever started, which is a different operational fact from `failed`, and conflating them makes a never-launched ticket look like a failed one on the board. `queue_claims.outcome` carries no `CHECK` (FG-585's convention, and SQLite cannot widen one on the additive-only path), so the closure is enforced by a closed exported set pinned by test.

The consequence the board must render is created deliberately: an item can be simultaneously **not a queue member and In progress**. That is a first-class state (`executing_not_queued`), not a gap.

### D5 — disabling autonomous dispatch must not stop the dispatcher process ✅

Disable is a policy flag consulted **before claiming**. Stopping the process instead drops heartbeats, lets leases lapse, and lets a later takeover launch a duplicate — the same failure D4 guards. A disarmed dispatcher keeps renewing its lease, keeps heartbeating live claims, and keeps releasing them as their work reaches terminal. Capacity reduction behaves identically: lowering the ceiling below current usage changes no live row and prevents the next claim until usage falls below the limit. **Neither is ever a reaper.**

### D6 — scan evidence must persist when NO claim is made ✅

FG-610 persists scan evidence only on a grant, by design (an idle dispatcher must not become a continuous O(queue depth) writer on the machine-wide store). But the idle case is operationally the *most* important one, because it is exactly when an operator asks why nothing started. FG-591 therefore writes one `dispatcher_evaluations` row per evaluation pass **including the passes that granted nothing**, carrying a closed top-level reason (`granted | disabled | no_capacity | no_eligible_work | lost | incompatible_only`), the capacity scope/limit/usage/holders as enforced, and the per-candidate scan evidence in queue-claims' `ScanReason` vocabulary **verbatim** — never a second vocabulary.

A temporary scheduling incompatibility lives there and **nowhere else**. It must never reach `blocker_evidence`, which is durable, per-ticket, partly container-visible, and drives the Blocked projection: a scheduling wait written there would silently reinterpret that ticket's status for every agent container on the next snapshot publish, with no code change in the container path.

### D7 — stale readiness after a ticket edit is an operator-actionable board state ✅

Not something the dispatcher silently re-evaluates. An autonomous process authoring its own eligibility criteria is a different trust posture than this ticket asks for. Enqueue is itself the recheck (FG-609), so the operator-driven path already exists.

### D8 — lease TTL is 15 minutes with a 5-minute heartbeat, operator-tunable ✅

Matching the run-lock renewal cadence. This is a starting point chosen for consistency, not a derived constant; the derived constraint is FG-610's `MIN_LEASE_TTL_MS` floor (three heartbeat intervals plus the whole-database write-lock wait), enforced by named refusal rather than by comment. The TTL is a floor on how long a wrongly stalled item stays reserved-but-invisible.

### D9 — nothing restarts the dispatcher automatically after a host reboot ✅

The board and `dispatcher status` surface a stale or dead lease **loudly**, and the operator re-arms. A login agent is a host-install concern beyond this ticket. Correspondingly, a dead or stale lease **outranks** the last evaluation on every operator surface: an expired lease means nobody is looking at this queue, and reporting the last pass's reasonable-sounding outcome there is how a correct-looking board hides a dead controller.

### D10 — the compatibility predicate stays pure and I/O-free, and must be GIVEN the facts a real decision needs ✅

Pure, I/O-free, deterministic and total, honouring FG-610's stated predicate purity contract, and evaluated in the scan's unlocked READ phase only — caller code under the machine-wide write lock stalls every forge process on the host. It is hydrated with each active claim's repo/worktree lane and branch, its run's touched paths, the candidate's dependency and explicit ordering/exclusivity relations, duplicate-ticket execution, and durable resource locks. A predicate that cannot see those is deciding on incomplete inputs. It **refuses on ambiguity**: a bypass costs a cycle, a bad overlap costs a corrupted worktree. Bypassing a candidate never mutates its rank.

### D11 — a drag-reorder must not silently overwrite concurrent changes ✅

A reorder is submitted against the version the board loaded — the id of the project's most recent order-affecting queue event, a monotonic counter that already exists and needs no new column — and **refuses by name rather than clobbering** a queue that moved underneath it. `--expect-version` is optional on the CLI (omitting it preserves FG-609's behaviour) and **required** on the dashboard's rank/reorder routes, where the submitter is always a page that loaded state some time ago.

### D12 — a test that terminates a process kills ONLY a PID it spawned itself ✅

The falsification proving the dispatcher's liveness is independent of an interactive session's process tree is required, but it runs on a host with a live orchestrator session and shared infrastructure. It MUST spawn its own disposable process, record that exact pid, terminate it by that pid, and assert the pid it killed is the one it spawned. It MUST NOT use `pkill -f` / `pgrep -f` or any name/pattern/argv matching (FG-492: long-lived agent processes carry conversation text in argv and false-match unrelated role and ticket names). It MUST NOT use `tmux kill-session` or `tmux kill-server` — every `forge launch run` job shares ONE tmux server. A test that *could* terminate a session, container or launch it did not create is a defect regardless of whether it did so on the run that shipped it. The same rule binds any other code path in this ticket that terminates, signals or reaps a process.

### D13 — the lease boundary must be testable at a single pinned instant ✅

Found on the first build attempt. `storeNowMs()` returns the live SQLite clock plus a fixed test offset and cannot be frozen, so "now == expiry" holds only for the instant the offset is computed; two consecutive reads are microseconds apart against a still-advancing clock. The acquire path read `== expiry` and correctly denied takeover while the view path read `> expiry` a moment later and reported expired — both individually correct, which is why the comparison operators were never the problem.

The invariant is real and kept: **two dispatchers reading the same instant must not disagree about whether a holder is gone, and a lease expiring exactly now has not expired.** What was missing is a seam that can express it, so the lease reads accept an explicit `nowMs` and a caller (or a test) evaluates acquire and view against the same value. Explicitly rejected: loosening the assertion, comparing with a tolerance window, or asserting only the acquire path. A test that cannot pin the instant cannot prove the invariant.

---

## Consequences

**Gained**

- A ceiling that actually bounds admission, because it is counted where admission happens.
- An honest capacity report: what is counted, what is only reported, and no number that looks like a guarantee.
- A queue that can be re-planned freely — dequeue, unrank, defer, reorder — with no path from a planning mutation to a stopped or duplicated container.
- A durable answer to "why did nothing start", including for passes that granted nothing, with disarmed / no capacity / no eligible work / blocked / temporarily incompatible / dead dispatcher kept distinguishable.
- Unattended execution authority that lives on exactly one surface and records who armed it and when.

**Accepted costs**

- A host-scoped refusal is opaque from inside one project. Mitigated by naming the holding project on every capacity surface, not by changing the scope.
- Other Forge work is genuinely uncounted. An operator running four containers by hand can still overload the host; the queue simply does not pretend to bound that.
- Cancellation is two operator concepts (dequeue vs cancel) where one might have felt simpler. That is the point: the simpler version is the duplicate-execution defect.
- `queue_claims.outcome`'s closure rests on this ticket's discipline plus a test, not on a database constraint.

**Explicitly not decided here**

- No automatic dispatcher restart after reboot (D9), no dashboard route that arms dispatch or sets capacity (D2), no dispatcher-authored readiness re-evaluation (D7), no parallel Campaign Runner lanes, and no change to FG-370's Campaign Runner or FG-600's post-launch arming and continuation.

---

## References

- `docs/concepts.md` → **Queue dispatch**, **Operator queue**, **Queue claims**
- `docs/invariants.md` → invariant 23
- `docs/quick-start.md` § 14
- `docs/SCHEMA-CONTRACT.md` → **dispatcher tables**, **`GET /api/queue`**, **`POST /api/queue/*`**
- FORGE-DEC-015 (dashboard shells the CLI for mutations), FG-609, FG-610, FG-584, FG-492
