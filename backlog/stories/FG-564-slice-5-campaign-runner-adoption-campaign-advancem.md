---
id: FG-564
type: story
status: active
title: "Slice 5 — campaign-runner adoption: campaign advancement consumes the same completion primitive and terminal vocabulary"
created: 2026-07-14
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 5)
**Depends on:** FG-552 (wait primitive), FG-562 (durable claim).

## Problem

**BD-10 ("one primitive, multiple consumers") is a GOAL, not a preserved property.** Verified against the
FG-425-merged tree: the launch module is imported by exactly one module — the launch CLI. **The campaign
executor has zero coupling to launch records.** So there is no shared primitive to preserve yet; this
slice creates the second consumer without creating a second mechanism.

The risk this slice exists to prevent: the orchestrator and the campaign runner growing **different event
transports or different interpretations of launch truth**.

## Scope

- Reuse the Slice 2 wait/subscription primitive. **Do not build a second watcher, a second terminal
  classifier, or a campaign-only event table** unless a documented storage boundary genuinely requires it
  (and then say so explicitly).
- Map completion into the existing durable campaign/item state and the Slice 3 claim semantics.
- Preserve campaign blocker and continue-policy behavior.

## FG-425 constraints a continuation claim MUST preserve

These are not incidental — they are settled publisher/campaign semantics, and a claim that ignores them
will fight the publisher (**F21** must assert the claim *preserves* them, not merely that "the same
classifier is used"):

- **The `awaiting_recovery` park stamps a deliberately SHARED `git_state` blocker** while a publication is
  unresolved. The publish target is shared across campaign items, so an unsettled window genuinely impairs
  the others. The blocker is cleared at the **centralized ship transition**. Do **not** "simplify" this
  into a non-shared park kind — the defect that was fixed was its **lifetime**, not its kind.
- **A cancel is terminal and wins.** Recovery never resurrects a cancelled task — **but the operator must
  still be told when a cancelled task's candidate DID land.**
- **Bounded resume convergence** (`CONVERGE_LIMIT = 2`, `src/campaign/executor.ts:670`). `forge campaign
  resume` converges a lost publication window through the AD-5 convergence authority before parking.
- **A terminal refusal may NEVER stand over an attempt still recorded `publishing`.**

## Acceptance Criteria

- **F21**: the campaign consumes launch completion through the **same** classifier and primitive as the
  orchestrator; existing campaign policy is preserved.
- The campaign runner has **no second event transport, no second terminal vocabulary, and no
  campaign-only completion table** (or a documented storage boundary justifying one).
- A continuation claim on a campaign item preserves each of the four FG-425 constraints above —
  demonstrated by test, not asserted.

## Falsification — PRODUCTION PATH, not fixtures

**Every new regression test must be observed RED against its pre-fix baseline** (campaign rule). A test that
cannot go red does not prove the defect was covered.

**"Demonstrated by test" is NOT satisfied by fixture or unit coverage here — and this is the single most
likely way this slice ships broken.** A campaign test built on simplified fixtures can go green while the
real `drive`/`resume` → task → run → campaign-item → campaign → publication path stays **wedged**. **That is
exactly the FG-425 failure pattern** — a green suite over fixtures while the production path could not
converge — and FG-425's own proof had to be rebuilt on the real path (`real runNext`, real publisher, real
durable rows) before it meant anything.

**Required:**

- A **production-path campaign regression**: real `runNext`, the real publisher, real durable rows. No
  simplified workflow fixtures standing in for the real contract (a fixture whose `inputs: []` does not match
  the real `feature.yml` has already hidden a P1 once).
- The regression drives a real **`campaign resume` / `drive`** cycle through a completion, and asserts
  **truthful convergence of ALL FIVE state levels**: **task**, **run**, **campaign item**, **campaign**, and
  **publication** state. A test that asserts only the item advanced, while the run or publication state is
  left inconsistent, is not evidence — it is the wedge.
- Red-before-fix evidence for each new test.
- Campaign ordering, gates, cancellation, recovery, and publication states do not introduce a continuation
  constraint that the primitive cannot express. If they do, that is a finding against FG-562, not a local
  workaround here.
- Duplicate/lost completion events against a campaign item are safe (BD-5).

## Not in scope

- Redesigning FG-425's integration publisher, lane, mutex, recovery, or worktrees. **The publisher
  architecture is SETTLED** — no PID probing, signalling, identity nonces, zombie classification, or
  reaping; validation stays inside the lane turn.
- Parallel campaign lanes (FG-396).

## Consumer enforcement of FG-562's BD-3 / F17 (binding — added 2026-07-19, operator decision A)

FG-562 ships the durable continuation-claim PRIMITIVE only: it validates canonical terminal vocabulary, phase
binding, CAS state, deterministic dispatch identity (`dispatch_key`), adoption lookup (`adoptOrClaimDispatch`),
leases, and durable receipts. It deliberately does NOT establish that a passed-in disposition matches the real
launch, and it does NOT prevent a second *physical* run. **This slice, as the consumer, MUST enforce the
end-to-end guarantees the primitive cannot** — these are binding acceptance criteria here (the primitive's
mechanism is delivered; consumer enforcement was left OPEN by FG-562 by design):

- **Authoritative evidence before observe/claim (BD-3):** immediately before calling
  `observeLaunchStatus` / claiming, this consumer MUST obtain the launch disposition from the canonical launch
  reader (`readLaunch` / `classifyExit`) and pass that exact observation in. It MUST NOT synthesize, cache
  stale, or otherwise fabricate a terminal disposition — a claim may only rest on a canonical classification
  the authoritative durable launch record supports (incl. the reconciled `owner_gone`/`unknown` dispositions
  with no exit record).
- **No caller-fabricated terminal disposition:** a regression must prove this consumer cannot advance a phase
  on a disposition the authoritative record does not support (observed RED against a fabricated/stale status).
- **Receipt-keyed production check-before-spawn / adopt (F17):** before dispatching physical work, this
  consumer MUST perform the deterministic `dispatch_key`-keyed lookup (`adoptOrClaimDispatch`) and ADOPT an
  existing dispatch rather than spawning a duplicate agent/run.
- **Crash recovery adopts the original physical run:** on controller restart, this consumer MUST use the
  restart-replay collector (`continuationsInDispatch`) + the receipt to adopt the original in-flight physical
  run, never spawn a second one (observed RED against a recovery path that re-dispatches).

A test that exercises the primitive in isolation does NOT satisfy these — the enforcement must be demonstrated
on this consumer's real production path.
