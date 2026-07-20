---
id: FG-564
type: story
status: done
title: Slice 5b — campaign-runner adoption of the durable continuation primitive (per-item, depends on FG-596)
created: 2026-07-14
closed: 2026-07-20
closed_commit: 1a43bd0
---

### Slice 5b — campaign-runner adoption of the durable continuation primitive (per-item)

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` (Slice 5)
**Depends on:** **FG-596 (Slice 5a — SHIPPED `02e3b70`, closed `e79b68b`)**, FG-552 (wait primitive), FG-562 (durable claim), **FG-563 (shared production consumer, SHIPPED `9a3235d`)**.
**Refined by:** FG-564 bounded architecture pass, 2026-07-19; post-FG-596 correctness refresh, 2026-07-20. **Split, per-item boundary, and locked decisions were approved by the operator (see Locked decisions).**

## Architecture finding (why this was re-scoped)

The original architecture pass found that `src/campaign/` had no launch-primitive coupling and split the launch boundary + executor restructure into FG-596. **That prerequisite is now shipped.** The production controller launches one `forge campaign drive-item` process per item through `launchDriveItemUnderForge`; every run-producing lane goes through the atomic `reserveCampaignDriveDispatch`, keyed by persisted `campaign_items.attempt_generation`; and an `adopted` reservation is linked but deliberately not physically driven.

This ticket adds the first production campaign continuation RECORDER and the controller-side adoption/recovery protocol on that shipped boundary. It no longer owns the executor restructure, but it is **not merely thin wiring**: durable launch linkage, campaign-controller leasing, running-campaign takeover, and lease-gated recovery are novel production responsibilities.

## The load-bearing decision: per-ITEM launch granularity (APPROVED)

The approved boundary is per-item. Rejected alternatives:
- **Outer campaign-start launch — REJECTED.** Terminal only when the whole campaign finishes; cannot gate an item→item advancement that already happened.
- **Per-wave launch — REJECTED.** A `runNext` wave is an N-container fan-out (`runNext.ts:269`) plus a publication reconciled in the next wave's prologue. FG-562 binds ONE `source_launch_id` per phase — it cannot express N concurrent launches, and per-wave would fracture the `CONVERGE_LIMIT` window and the shared `git_state` blocker lifetime (both span multiple waves within one item).

**Exactly ONE continuation claim per item boundary (advance-to-next-item).** Every within-item transition — waves, publication convergence (AD-5 / `CONVERGE_LIMIT`), gate handling, item finalization — stays ORDINARY SYNCHRONOUS inside the launched drive and MUST NOT take a claim.

## Contract corrections (binding, before implementation)

1. **Launch disposition ≠ item outcome.** A drive-item launch's terminal disposition describes the drive-item PROCESS (exited_ok / non-zero / owner_gone / unknown). The item outcome (shipped / parked / failed) MUST ALWAYS be derived from durable campaign/run/task/publication state AFTER the wake — never read off the launch disposition.
2. **Attempt-scoped phase.** `continuationId` stays stable as `campaignId+itemId`, but `currentPhase` carries an **item-attempt identity** (e.g. `drive:<itemId>#<attempt>`). Rearming binds a NEW `sourceLaunchId` AND an attempt-specific phase, so a delayed completion from a PRIOR retry cannot advance a NEW attempt.
3. **`nextAction` names the actual next item.** `{ kind:'drive_campaign_item', campaignId, itemId:<the NEXT itemId> }`, or `{ kind:'finalize_campaign', campaignId }` — never ambiguously reuse the completed item's id. Never an opaque shell string.
4. **Campaign-facing command.** Prefer `forge campaign continue` / `forge campaign recover` as the operator surface, reusing the shared consumer core internally (do NOT fork `continue.ts`).

## FG-562 determination: primitive needs NO extension (at per-item granularity)

`ConsumerKind` already includes `"campaign"`; `continuationsInDispatch` is consumer-scoped; and `adoptOrClaimDispatch` is generic. A per-item advancement is one-launch → one-attempt-phase → one-nextAction, expressed natively. **No change to the FG-562 continuation primitive is expected.** Campaign takeover DOES require persisted campaign-side controller ownership/lease state (AC7/AC8); that persistence is part of this ticket and is not an FG-562 primitive extension.

## Two durable identity spaces — do not conflate them

FG-564 joins two different exactly-once boundaries:

1. The **continuation dispatch receipt** from FG-562 is derived from the continuation identity and authorizes exactly one item-boundary action (N → N+1 or finalization).
2. The **campaign item-attempt dispatch key** from FG-596 is derived by `deriveCampaignItemDispatchKey(campaignId, itemId, attemptGeneration)` and identifies exactly one physical item-run.

They are intentionally different keys. The continuation consumer MUST NOT use its receipt with `runByDispatchKey` as a second, parallel authority for finding or creating the campaign item-run. After the continuation claim authorizes N+1, campaign `PhysicalDispatch` uses **`reserveCampaignDriveDispatch` as the sole create/adopt authority** for N+1's item-run:

- `created` — the lease holder may launch/drive it;
- `adopted` — only the lease holder may physically re-drive it, under AC-ADOPT-DRIVE;
- `lost` — dispatch nothing and do not mark the continuation advanced as though work started.

The continuation row records the resulting immutable run identity, but the FG-596 reservation remains authoritative for item-run deduplication.

## Durable launch linkage — binding crash boundary

FG-596's `launchDriveItemUnderForge` currently receives the random `sourceLaunchId` locally and then waits. FG-564 MUST make the relationship between `(campaignId, itemId, attemptGeneration)` and that launch durable before relying on a continuation waiter. Recovery MUST NOT parse launch names, argv, timestamps, or other heuristics to rediscover it.

The implementation must specify and persist a campaign-side item-attempt launch record (or equivalent explicit columns/table) containing at least campaign id, item id, attempt generation, source launch id, controller owner/generation, and lifecycle timestamps/state. The ordering and recovery contract must cover:

- launch created, controller dies before `recordContinuation`;
- continuation recorded, controller dies before the waiter is armed;
- waiter swept while the drive process continues;
- retry/rearm binding a new launch id and attempt phase while a stale prior launch later completes.

Because the launch record is filesystem-backed and campaign/continuation state is SQLite-backed, do not claim cross-store atomicity. Choose an ordered, idempotently repairable protocol and prove both sides of every publication window. A replacement controller must discover the durable item-attempt linkage directly, re-read the authoritative launch record, and either create/rearm the missing continuation or adopt the existing one without launching another item-run.

## Shared consumer core — extract, do not copy

The claim/adopt/observe control flow becomes ONE shared module both consumers call: the `waitOutcome` guard, BD-3 re-read + `deriveTerminalDisposition`, the already-advanced short-circuit, `observeLaunchStatus`, the claim/lease handling, the watchdog record-before-advance hook, and consumer-scoped restart recovery. Generalize the full-identity assertion and parameterize the orchestrator-only recovery filter; do not copy `continuation-consumer.ts`.

The shared core must not assume every `PhysicalDispatch` uses the continuation receipt as its physical run key. The orchestrator adapter retains that behavior. The campaign adapter instead translates an authorized `drive_campaign_item` action into the FG-596 reservation + durable launch-link protocol above, and reports the resulting immutable run identity. `markAdvanced` occurs only after the campaign dispatch boundary is durably recoverable; a failed/lost reservation or an unpersisted launch must leave the continuation recoverable, not falsely advanced.

## FG-425 constraints a continuation claim MUST preserve (settled)

A claim must PRESERVE these, not merely reuse the classifier (**F21**):
- The `awaiting_recovery` park stamps a deliberately **SHARED** `git_state` blocker while a publication is unresolved; cleared at the **centralized ship transition**. The fix was its LIFETIME, not its kind.
- A cancel is terminal and wins; recovery never resurrects a cancelled task — **but the operator must still be told when a cancelled task's candidate DID land.**
- Bounded resume convergence (`CONVERGE_LIMIT = 2`, currently `executor.ts:714`).
- A terminal refusal may NEVER stand over an attempt still recorded `publishing`.

## Locked decisions (operator, 2026-07-19)

- **D1 — Controller identity and durable lease: instance-stable.** `campaign@<campaignId>@<controllerInstanceId>`. This slice persists a campaign-side controller owner + generation/epoch + lease expiry and mutates it through an owner/generation-scoped CAS. The active controller renews it while it owns the item loop/physical drive; a replacement controller MUST NOT renew or impersonate the prior controller and takes over only AFTER expiry. The lease is released/settled when the campaign becomes terminal or durably parks. **Campaign `running` status is NOT a singleton fence** — it does not distinguish two controller instances, and this slice adds NO general one-controller-per-project restriction. The continuation claim authorizes one phase transition; the campaign-controller lease fences the longer-lived physical controller/drive. A default five-minute continuation lease with a single renewal after a blocking `runNext` is NOT sufficient physical-drive fencing: either the drive is launched asynchronously and the dispatch returns promptly, or ownership is renewed throughout the blocking drive.
- **D2 — `running`-campaign takeover is IN this slice.** Continuation recovery is incomplete if a dead controller leaves the campaign at `running` with manual SQL as the only path. The takeover entry point MUST **fail closed while the prior lease remains live**, then adopt the existing continuation/run AFTER expiry. It MUST NOT reset the campaign item or mint a replacement run blindly.
- **D3 — Dead drive-item process is IN scope (residual REJECTED).** The previously-proposed "documented residual" is rejected: it contradicts crash case C6 and would let the new launch boundary reproduce the overnight wedge. See AC-DEAD-DRIVE.
- **D4 — Campaign-facing command:** `forge campaign continue` / `recover`, shared core internally.

## Acceptance Criteria (adoption slice)

- **AC3 (record + claim, attempt-scoped):** the controller records one continuation per item — `continuationId` = deterministic `(campaignId, itemId)`; `currentPhase` = attempt-scoped (`drive:<itemId>#<attempt>`); `sourceLaunchId` = the item's drive-item launch; `nextAction` names the NEXT item explicitly (contract correction 3). On wake it re-reads the authoritative launch record (BD-3) and claims the advance EXACTLY ONCE via the FG-562 phase-bound CAS. Rearming a retry binds a new `sourceLaunchId` + new attempt phase so a stale prior-attempt completion cannot advance the new attempt.
- **AC4 (BD-3 + outcome-from-durable-state):** the advance rests ONLY on a classification the authoritative launch record supports (`readLaunch`/`deriveTerminalDisposition`, incl. reconciled `owner_gone`/`unknown` no-exit dispositions); a fabricated/stale disposition has ZERO effect (proven RED). **AND the item's shipped/parked/failed outcome is derived from durable campaign/run/task/publication state after the wake — never from the launch disposition** (contract correction 1).
- **AC5 (F17 adopt-not-duplicate; two receipts):** `continuationsInDispatch({consumerKind:'campaign'})` recovers the in-flight continuation claim/receipt. Once that claim authorizes N+1, campaign dispatch calls `reserveCampaignDriveDispatch` using N+1's persisted attempt generation; that FG-596 reservation is the sole authority that creates or adopts the item-run. The continuation receipt and item-attempt key remain distinct. `created` may launch under the live campaign lease; `adopted` follows AC-ADOPT-DRIVE; `lost` launches nothing and cannot be marked successfully advanced. A duplicate item-run is NEVER created.
- **AC6 (shared core, not a copy):** the claim/adopt/observe core is a single shared module consumed by BOTH orchestrator and campaign; `consumerKind` branches ONLY at the injected `PhysicalDispatch` and the `recoverInFlightDispatches` parameter; the orchestrator-only guard is generalized.
- **AC7 (controller identity + physical-drive lease — D1):** instance-stable owner `campaign@<campaignId>@<controllerInstanceId>` backed by persisted campaign-side owner, generation/epoch, and expiry. Every renewal and physical-drive authorization is owner/generation-scoped. A replacement cannot renew a live lease and takes over only after expiry; no status-based singleton fence and no one-controller-per-project rule. The lease remains valid for the whole physical-drive ownership interval through asynchronous launch ownership or active renewal. Proven: a fresh controller RED against renewing or driving under a still-live prior lease; GREEN adopting only after expiry; an expired original owner cannot write, advance, audit, or re-drive after takeover.
- **AC8 (running-campaign takeover — D2):** a `forge campaign recover` (running-campaign) entry point recovers a campaign whose controller died — **fails closed while the prior lease is live**, then after expiry adopts in-flight continuations/runs and continues the item loop WITHOUT manual SQL and WITHOUT resetting the item or minting a replacement run. Retires the manual recovery at `concepts.md:910-943` (updated). Proven RED against a takeover that acts while the lease is live, and against a blind item-reset/replacement-run.
- **AC-DEAD-DRIVE (D3, replaces the residual):** when a drive-item launch becomes `owner_gone`, `unknown`, or otherwise terminal **while the campaign item is still nonterminal**, the controller re-reads task/run/item/campaign/publication state and safely does ONE of: **(a)** adopt/re-drive the existing item-run through the normal reconciliation authority WITHOUT creating a duplicate; or **(b)** durably park the campaign in a supported recoverable state with an operator command that needs NO manual SQL. **For the FG-425 publication window specifically:** reattach to the existing run and converge through AD-5 within `CONVERGE_LIMIT`; it may NOT reset the item to `pending` nor mint another item-run. This is C6-consistent.
- **AC9 (falsification + five-level capstone, PRODUCTION PATH):** C1-C5 each get a RED-before-fix test through the production consumer, real durable store, and real launch/reservation boundaries; focused fault injection at those production seams is allowed. C6 and at least one complete N→N+1 recovery/advance capstone run through **real `runNext` + real publisher + real durable rows** and prove truthful convergence at ALL FIVE levels (task, run, campaign-item, campaign, publication), each DERIVED from durable state. A fixture-green suite does NOT satisfy this AC, but every narrow crash case need not repeat the entire publisher workflow.
- **AC10 (durable launch publication/recovery):** the campaign-side item-attempt launch linkage is persisted and uniquely identifies the authoritative `sourceLaunchId`. RED-before-fix tests cover crash-after-launch-before-continuation-record and crash-after-record-before-waiter-arm. Recovery discovers the linkage without heuristic launch matching, creates/rearms at most one continuation for that attempt, and launches no duplicate item-run.

### Crash-window / falsification matrix
- **C1** — controller dies AFTER launching drive-item N, BEFORE observing terminal → today: stuck `running`, manual SQL. Post-fix: `recover` (after lease expiry) observes durable state + advances.
- **C2** — dies AFTER observing terminal, BEFORE claiming advance → no claim; N+1 never dispatched. Post-fix: fresh controller claims once; assert exactly one N+1 run.
- **C3** — dies AFTER the continuation claim (`dispatching`, continuation receipt set), BEFORE N+1's campaign reservation commits → recovery re-adopts the continuation claim, then `reserveCampaignDriveDispatch` creates or adopts exactly one N+1 item-run under the distinct item-attempt key.
- **C4** — dies AFTER N+1's campaign reservation commits (item-attempt key stamped), BEFORE the continuation records the run id / marks advanced → naive resume duplicates or falsely loses the dispatch. Post-fix: recovery re-adopts the continuation claim and the FG-596 reservation returns `adopted`; the lease-gated path uses the one existing run at all five levels.
- **C5** — completion delivered twice OR lost-then-watchdog-recovered → exactly one advance; lost-signal audit row ONLY on watchdog recovery, none on duplicate delivery (F18/BD-5). Attempt-scoped phase (correction 2) blocks a stale prior-attempt completion from advancing a new attempt.
- **C6** — drive-item launch dies mid-publication window (`owner_gone`) after ref advanced, item nonterminal → AC-DEAD-DRIVE path: reattach to the existing run, converge via AD-5 within `CONVERGE_LIMIT`, preserve all four FG-425 invariants (shared `git_state` blocker cleared at centralized ship in the re-driven launched drive; no refusal over a still-`publishing` attempt); NEVER reset item to `pending` or mint another run. Proves the claim PRESERVES the invariants and the boundary is NOT wedge-prone.
- **C7** — dies AFTER `startLaunch` persisted the drive launch, BEFORE `recordContinuation` → recovery finds the durable item-attempt launch linkage, records/rearms exactly one continuation, and waits/observes the original launch; no second launch or item-run.
- **C8** — dies AFTER `recordContinuation`, BEFORE arming the waiter → restart recovery re-arms observation of the recorded authoritative launch; if already terminal, the wait returns immediately and the phase advances once.

## Explicitly NOT in scope

- Everything in FG-596 (launch boundary + executor restructure).
- Redesigning FG-425's publisher/lane/mutex/recovery/worktrees; no PID probing, signalling, identity nonces, zombie classification, reaping.
- Extending the FG-562 primitive (unnecessary at per-item granularity). Campaign-side controller lease and item-attempt launch-link persistence are explicitly IN scope.
- Parallel campaign lanes (FG-396).

## Binding AC — lease-gated adopt→physical-drive conversion (from FG-596, 2026-07-20)

FG-596 ships the atomic reservation such that a drive-item reservation returns `created | adopted | lost`, and FG-596 **physically drives ONLY a `created` reservation** — an `adopted` reservation is linked but never re-driven by FG-596 (it returns a recovery-needed/already-owned outcome identifying the keyed run, dispatches no physical work, mutates no run/task/publication state, and infers no owner liveness). Converting an `adopted` reservation into a physical re-drive is **this ticket's job and is gated on both the continuation claim and the campaign-controller lease:**

- **AC-ADOPT-DRIVE (binding):** ONLY the controller holding BOTH the applicable continuation claim and the persisted campaign-controller owner/generation lease (AC7) may convert an `adopted` FG-596 reservation into a physical re-drive (`runNext` / invoke). Authorization is checked immediately before physical work and remains fenced for the whole drive. A controller without the live lease MUST NOT re-drive an adopted run — takeover occurs only AFTER lease expiry (AC8). Proven RED against a non-lease-holder (or a second concurrent controller) converting an adopted reservation into physical drive while the lease is live; GREEN only after expiry; the expired former owner remains fenced. This is what separates the guarantees: FG-596 provides one item-run + adoptability; the FG-562 claim provides one boundary advancement; FG-564's campaign lease provides one live physical driver.

## AC evidence grid — SHIPPED (merge `1a43bd0`, PR #150; CI `test` + `test-extended` green)

Every acceptance criterion walked against concrete evidence in the merged diff. Reviewed across 5 independent red-review waves (red-wide / red-backend / red-security); build advanced after 6 finding-indexed fix-rounds; CI `test` (fast canonical) and `test-extended` (integration shards + worktree + dashboard) both green at the merge commit — the worktree tier runs the AC9 real-runNext/real-publisher capstone.

| AC | Evidence |
|----|----------|
| **AC3** record+claim, attempt-scoped | `continuation-adapter.ts` + `executor.ts` recorder — `continuationId=(campaignId,itemId)`, phase `drive:<itemId>#<attempt>`, `nextAction` names the next item; BD-3 re-read + phase-bound CAS; retry rearm binds new launch+phase. Tests: `fg564-launch-linkage-recorder.integration.test.ts`, crash-matrix C2/C3/C5. |
| **AC4** BD-3 + outcome-from-durable-state | `consumer-core.ts` (BD-3 re-read, `deriveTerminalDisposition`); item outcome derived from durable campaign/run/task/publication rows post-wake. A fabricated/stale disposition has zero effect — crash-matrix C4/C5 (RED-before-fix). |
| **AC5** F17 adopt-not-duplicate, two receipts | `continuation-adapter.ts` — `continuationsInDispatch({consumerKind:'campaign'})` recovers the claim; `reserveCampaignDriveDispatch` is the sole create/adopt authority (created/adopted/lost); continuation receipt and item-attempt key stay distinct. `continuation-adapter.integration.test.ts`. |
| **AC6** shared core, not a copy | `consumer-core.ts` extracted, consumed by both orchestrator and campaign; `consumerKind` branches only at injected PhysicalDispatch + recover filter; orchestrator guard generalized. `consumer-core.test.ts`; orchestrator tests stay green. |
| **AC7** controller identity + physical-drive lease | `store/campaign-controller.ts` (owner/generation/expiry, owner/generation-scoped CAS); `schema.ts` `campaign_controller_leases`; `executor.ts` renewal heartbeat covering a >TTL drive. Host-stress: `fg564-lease-stress.integration.test.ts` (fresh-controller RED against a live lease; GREEN only after expiry; expired owner cannot write/advance/audit/re-drive). `campaign-controller.test.ts`. |
| **AC8** running-campaign takeover | `cli/commands/campaign.ts` `runCampaignRecovery` — `forge campaign recover`/`continue` fail closed while the prior lease is live, take over only after expiry, continue the item loop with no manual SQL / no item reset / no replacement run. `fg564-campaign-recover-cli.integration.test.ts`; `concepts.md` manual-SQL recovery retired. |
| **AC9** falsification + five-level capstone, production path | `fg564-crash-matrix.integration.test.ts` C1–C5,C7,C8 RED-before-fix through the production consumer + real durable store + real launch/reservation seams; `fg564-capstone.worktree.test.ts` — C6 and a complete N→N+1 advance through **real runNext + real publisher + real durable rows**, five-level convergence (task/run/campaign-item/campaign/publication) read back from durable rows. Green in CI `test-extended` (worktree tier). |
| **AC10** durable launch publication/recovery | `store/campaign-controller.ts` linkage read/write (`campaign_item_launches`, unique `source_launch_id`, immutable born-under token); `executor.ts` links before arming the waiter; recovery discovers the linkage without heuristic matching. `fg564-launch-linkage-recorder.integration.test.ts`, `fg564-controller-lease-migration.integration.test.ts`; crash-matrix C7/C8. |
| **AC-ADOPT-DRIVE** | `continuation-adapter.ts` + `executor.ts` — physical re-drive authorized only with BOTH the continuation claim AND the live lease; the durable born-under token is compared to the live lease immediately before work and re-checked at every wave; fenced for the whole drive. Crash-matrix C4/C7; RED against a non-lease-holder / second concurrent controller. |
| **AC-DEAD-DRIVE** | `executor.ts` — on `owner_gone`/`unknown` while the item is nonterminal, reattach-and-converge within `CONVERGE_LIMIT`, preserving all four FG-425 invariants; never resets the item or mints a second run. Crash-matrix C6 + capstone. |
| **Lane parity** (operator close-the-class directive) | `executor.ts` `prepareCampaignItemDispatch` — one shared lane-aware dispatch authority used by BOTH the normal drive and continuation recovery: `full_feature`→real `startRun`/runNext, invoke lanes→`driveInvokeLaneItem` real invoke path; fail-closed before reservation on missing ticket/projectDir/unresolved-workflow/unknown-lane; adopted runs re-enter their recorded lane driver. `fg564-lane-parity.integration.test.ts`, `fg564-materialize-run.integration.test.ts`. |

**Follow-ups (new scope, not unmet AC):** FG-597 (harden `FORGE_CONTROLLER_ID` bearer identity — accepted for FG-564 under the trusted single-operator-host model); FG-598 (mixed-lane recovery parity test should drive natural loop continuation rather than re-arm between dispatches).
