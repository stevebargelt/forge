---
id: FG-564
type: story
status: active
title: Slice 5b — campaign-runner adoption of the durable continuation primitive (per-item, depends on FG-596)
created: 2026-07-14
---

### Slice 5b — campaign-runner adoption of the durable continuation primitive (per-item)

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` (Slice 5)
**Depends on:** **FG-596 (Slice 5a — launchable single-item drive, MUST land first)**, FG-552 (wait primitive), FG-562 (durable claim).
**Refined by:** FG-564 bounded architecture pass, 2026-07-19. **Split, per-item boundary, and open decisions locked by operator 2026-07-19 (see Locked decisions).**

## Architecture finding (why this was re-scoped)

FG-564 as originally written cannot be thin wiring — verified against the tree: `src/campaign/` has ZERO launch-primitive coupling, and the continuation RECORDER is unwired in every production path (FG-563 shipped only the consumer). The launch boundary + executor restructure is a prerequisite refactor, **split out as FG-596**. THIS ticket is the adoption slice on top of it — thin once FG-596 lands. The refactor is NOT hidden inside this ticket's plan.

## The load-bearing decision: per-ITEM launch granularity (APPROVED)

Adoption is thin iff the boundary is per-item. Rejected alternatives:
- **Outer campaign-start launch — REJECTED.** Terminal only when the whole campaign finishes; cannot gate an item→item advancement that already happened.
- **Per-wave launch — REJECTED.** A `runNext` wave is an N-container fan-out (`runNext.ts:269`) plus a publication reconciled in the next wave's prologue. FG-562 binds ONE `source_launch_id` per phase — it cannot express N concurrent launches, and per-wave would fracture the `CONVERGE_LIMIT` window and the shared `git_state` blocker lifetime (both span multiple waves within one item).

**Exactly ONE continuation claim per item boundary (advance-to-next-item).** Every within-item transition — waves, publication convergence (AD-5 / `CONVERGE_LIMIT`), gate handling, item finalization — stays ORDINARY SYNCHRONOUS inside the launched drive and MUST NOT take a claim.

## Contract corrections (binding, before implementation)

1. **Launch disposition ≠ item outcome.** A drive-item launch's terminal disposition describes the drive-item PROCESS (exited_ok / non-zero / owner_gone / unknown). The item outcome (shipped / parked / failed) MUST ALWAYS be derived from durable campaign/run/task/publication state AFTER the wake — never read off the launch disposition.
2. **Attempt-scoped phase.** `continuationId` stays stable as `campaignId+itemId`, but `currentPhase` carries an **item-attempt identity** (e.g. `drive:<itemId>#<attempt>`). Rearming binds a NEW `sourceLaunchId` AND an attempt-specific phase, so a delayed completion from a PRIOR retry cannot advance a NEW attempt.
3. **`nextAction` names the actual next item.** `{ kind:'drive_campaign_item', campaignId, itemId:<the NEXT itemId> }`, or `{ kind:'finalize_campaign', campaignId }` — never ambiguously reuse the completed item's id. Never an opaque shell string.
4. **Campaign-facing command.** Prefer `forge campaign continue` / `forge campaign recover` as the operator surface, reusing the shared consumer core internally (do NOT fork `continue.ts`).

## FG-562 determination: primitive needs NO extension (at per-item granularity)

`ConsumerKind` already includes `"campaign"` (`continuations.ts:44`); `continuationsInDispatch` is consumer-scoped (`:248`); `adoptOrClaimDispatch`/`runByDispatchKey`/`startRun` dispatchKey stamp are generic. A per-item advancement is one-launch → one-attempt-phase → one-nextAction, expressed natively. **No change to the FG-562/runs primitives.** NOTE: controller takeover (AC7/AC8) MAY require a persisted **campaign-controller generation / ownership record** — that is campaign-side persistence to be specified and persisted explicitly (below), NOT an FG-562 primitive change.

## Shared consumer core — extract, do not copy

The claim/adopt/observe control flow is consumer-kind AGNOSTIC and becomes ONE shared module both consumers call: the `waitOutcome` guard, BD-3 re-read + `deriveTerminalDisposition`, the already-advanced short-circuit, `observeLaunchStatus`, the `dispatchAndAdvance` claim→adopt-not-duplicate→record→markAdvanced sequence, the watchdog record-before-advance hook, `recoverInFlightDispatches`. **Seam:** `assertFullIdentity`'s reject of `consumerKind !== 'orchestrator'` (`continuation-consumer.ts:202-207`) splits into a generic full-identity assertion + a `consumerKind`-keyed `PhysicalDispatch`. **Two hardcodes to parameterize:** `recoverInFlightDispatches` `consumerKind:'orchestrator'` (`:483`); the orchestrator-only guard (`:202`). Campaign owns only its `PhysicalDispatch` (`kind:'drive_campaign_item'` → item-run/drive-item launch with `dispatch_key` + attempt identity stamped) and the `forge campaign continue/recover` surface.

## FG-425 constraints a continuation claim MUST preserve (settled)

A claim must PRESERVE these, not merely reuse the classifier (**F21**):
- The `awaiting_recovery` park stamps a deliberately **SHARED** `git_state` blocker while a publication is unresolved; cleared at the **centralized ship transition**. The fix was its LIFETIME, not its kind.
- A cancel is terminal and wins; recovery never resurrects a cancelled task — **but the operator must still be told when a cancelled task's candidate DID land.**
- Bounded resume convergence (`CONVERGE_LIMIT = 2`, `executor.ts:682`).
- A terminal refusal may NEVER stand over an attempt still recorded `publishing`.

## Locked decisions (operator, 2026-07-19)

- **D1 — Controller identity: instance-stable.** `campaign@<campaignId>@<controllerInstanceId>`. A replacement controller MUST NOT renew the dead controller's still-live lease; takeover occurs only AFTER lease expiry. **Campaign `running` status is NOT a singleton fence** — it does not distinguish two controller instances, and this slice adds NO general one-controller-per-project restriction. Exact-once safety comes from the continuation claim / lease / CAS + receipt adoption. **If takeover requires an additional campaign-controller generation or ownership CAS, it MUST be specified and persisted explicitly** (a persisted campaign-side record), not assumed from status.
- **D2 — `running`-campaign takeover is IN this slice.** Continuation recovery is incomplete if a dead controller leaves the campaign at `running` with manual SQL as the only path. The takeover entry point MUST **fail closed while the prior lease remains live**, then adopt the existing continuation/run AFTER expiry. It MUST NOT reset the campaign item or mint a replacement run blindly.
- **D3 — Dead drive-item process is IN scope (residual REJECTED).** The previously-proposed "documented residual" is rejected: it contradicts crash case C6 and would let the new launch boundary reproduce the overnight wedge. See AC-DEAD-DRIVE.
- **D4 — Campaign-facing command:** `forge campaign continue` / `recover`, shared core internally.

## Acceptance Criteria (adoption slice)

- **AC3 (record + claim, attempt-scoped):** the controller records one continuation per item — `continuationId` = deterministic `(campaignId, itemId)`; `currentPhase` = attempt-scoped (`drive:<itemId>#<attempt>`); `sourceLaunchId` = the item's drive-item launch; `nextAction` names the NEXT item explicitly (contract correction 3). On wake it re-reads the authoritative launch record (BD-3) and claims the advance EXACTLY ONCE via the FG-562 phase-bound CAS. Rearming a retry binds a new `sourceLaunchId` + new attempt phase so a stale prior-attempt completion cannot advance the new attempt.
- **AC4 (BD-3 + outcome-from-durable-state):** the advance rests ONLY on a classification the authoritative launch record supports (`readLaunch`/`deriveTerminalDisposition`, incl. reconciled `owner_gone`/`unknown` no-exit dispositions); a fabricated/stale disposition has ZERO effect (proven RED). **AND the item's shipped/parked/failed outcome is derived from durable campaign/run/task/publication state after the wake — never from the launch disposition** (contract correction 1).
- **AC5 (F17 adopt-not-duplicate):** before dispatching item N+1's physical work, `continuationsInDispatch({consumerKind:'campaign'})` + `runByDispatchKey` adopt an existing in-flight item-run rather than spawning a duplicate. A duplicate item-run is NEVER created.
- **AC6 (shared core, not a copy):** the claim/adopt/observe core is a single shared module consumed by BOTH orchestrator and campaign; `consumerKind` branches ONLY at the injected `PhysicalDispatch` and the `recoverInFlightDispatches` parameter; the orchestrator-only guard is generalized.
- **AC7 (controller identity — D1):** instance-stable owner `campaign@<campaignId>@<controllerInstanceId>`; a replacement controller cannot renew a live lease and takes over only by lease expiry; no status-based singleton fence, no one-controller-per-project rule. Any campaign-controller generation/ownership CAS needed for takeover is specified and PERSISTED explicitly. Proven: a fresh controller RED against renewing a still-live lease; GREEN adopting only after expiry.
- **AC8 (running-campaign takeover — D2):** a `forge campaign recover` (running-campaign) entry point recovers a campaign whose controller died — **fails closed while the prior lease is live**, then after expiry adopts in-flight continuations/runs and continues the item loop WITHOUT manual SQL and WITHOUT resetting the item or minting a replacement run. Retires the manual recovery at `concepts.md:910-943` (updated). Proven RED against a takeover that acts while the lease is live, and against a blind item-reset/replacement-run.
- **AC-DEAD-DRIVE (D3, replaces the residual):** when a drive-item launch becomes `owner_gone`, `unknown`, or otherwise terminal **while the campaign item is still nonterminal**, the controller re-reads task/run/item/campaign/publication state and safely does ONE of: **(a)** adopt/re-drive the existing item-run through the normal reconciliation authority WITHOUT creating a duplicate; or **(b)** durably park the campaign in a supported recoverable state with an operator command that needs NO manual SQL. **For the FG-425 publication window specifically:** reattach to the existing run and converge through AD-5 within `CONVERGE_LIMIT`; it may NOT reset the item to `pending` nor mint another item-run. This is C6-consistent.
- **AC9 (five-level falsification, PRODUCTION PATH):** for each crash point below, a RED-before-fix production-path test asserts the specific defect and goes GREEN only against **real `runNext` + real publisher + real durable rows**; a fixture-green suite does NOT satisfy this AC. Truthful convergence at ALL FIVE levels (task, run, campaign-item, campaign, publication), each DERIVED from durable state.

### Crash-window / falsification matrix
- **C1** — controller dies AFTER launching drive-item N, BEFORE observing terminal → today: stuck `running`, manual SQL. Post-fix: `recover` (after lease expiry) observes durable state + advances.
- **C2** — dies AFTER observing terminal, BEFORE claiming advance → no claim; N+1 never dispatched. Post-fix: fresh controller claims once; assert exactly one N+1 run.
- **C3** — dies AFTER claim (`dispatching`, dispatch_key set), BEFORE N+1 run created → `runByDispatchKey` empty → dispatch now; exactly one N+1 run, no duplicate.
- **C4** — dies AFTER N+1 run created (dispatchKey stamped), BEFORE record/markAdvanced → naive resume duplicates. Post-fix: `runByDispatchKey` FOUND → adopt; one run at all five levels.
- **C5** — completion delivered twice OR lost-then-watchdog-recovered → exactly one advance; lost-signal audit row ONLY on watchdog recovery, none on duplicate delivery (F18/BD-5). Attempt-scoped phase (correction 2) blocks a stale prior-attempt completion from advancing a new attempt.
- **C6** — drive-item launch dies mid-publication window (`owner_gone`) after ref advanced, item nonterminal → AC-DEAD-DRIVE path: reattach to the existing run, converge via AD-5 within `CONVERGE_LIMIT`, preserve all four FG-425 invariants (shared `git_state` blocker cleared at centralized ship in the re-driven launched drive; no refusal over a still-`publishing` attempt); NEVER reset item to `pending` or mint another run. Proves the claim PRESERVES the invariants and the boundary is NOT wedge-prone.

## Explicitly NOT in scope

- Everything in FG-596 (launch boundary + executor restructure).
- Redesigning FG-425's publisher/lane/mutex/recovery/worktrees; no PID probing, signalling, identity nonces, zombie classification, reaping.
- Extending the FG-562 primitive (unnecessary at per-item granularity — but a campaign-controller generation/ownership record MAY be added campaign-side per D1).
- Parallel campaign lanes (FG-396).

## Binding AC — lease-gated adopt→physical-drive conversion (from FG-596, 2026-07-20)

FG-596 ships the atomic reservation such that a drive-item reservation returns `created | adopted | lost`, and FG-596 **physically drives ONLY a `created` reservation** — an `adopted` reservation is linked but never re-driven by FG-596 (it returns a recovery-needed/already-owned outcome identifying the keyed run, dispatches no physical work, mutates no run/task/publication state, and infers no owner liveness). Converting an `adopted` reservation into a physical re-drive is **this ticket's job and is gated on the campaign continuation lease:**

- **AC-ADOPT-DRIVE (binding):** ONLY the controller holding the campaign continuation lease (AC7 instance-stable identity) may convert an `adopted` reservation into a physical re-drive (runNext / invoke). A controller without the live lease MUST NOT re-drive an adopted run — takeover occurs only AFTER lease expiry (AC8). Proven RED against a non-lease-holder (or a second concurrent controller) converting an adopted reservation into physical drive while the lease is live; GREEN only after expiry. This is what fences "two live processes physically driving the same keyed run" — FG-596 guarantees one run + adoptability; FG-564's lease guarantees one live driver.
