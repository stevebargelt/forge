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
**Refined by:** FG-564 bounded architecture pass, 2026-07-19 (run-fg-564-bounded-architecture-pass-e1cc5a).

## Architecture finding (why this was re-scoped)

FG-564 as originally written ("adopt the primitive, no second mechanism") **cannot be implemented as thin wiring** — verified against the tree:
- `src/campaign/` has **zero** launch-primitive coupling (no `startLaunch`/`readLaunch`/`forge launch`); the campaign is one long-lived process whose `driveRemainingItems` loop synchronously blocks on containers. **Nothing produces a `sourceLaunchId`.**
- The continuation **recorder** (`recordContinuation`/`rearmForNextPhase`) is **unwired in every production path** — FG-563 shipped only the consumer. The campaign is the FIRST end-to-end record→launch→wait→wake→observe→claim→adopt loop.

Therefore the launch boundary + executor restructure is a **prerequisite refactor, split out as FG-596**. THIS ticket is the adoption slice that sits on top of it and is genuinely thin once FG-596 lands. The refactor is NOT hidden inside this ticket's plan.

## The load-bearing decision: per-ITEM launch granularity

Adoption is thin **if and only if** the launch boundary is per-item. The pass rejected the alternatives:
- **Outer campaign-start launch — REJECTED.** It becomes terminal only when the whole campaign finishes; its disposition cannot gate item→item advancement that already happened. A launch whose completion post-dates every advancement it gates is not a boundary.
- **Per-wave launch — REJECTED.** A `runNext` wave is a fan-out of N parallel containers (`runNext.ts:269`) plus a publication reconciled in the NEXT wave's prologue. FG-562 binds ONE `source_launch_id` per phase — it cannot express N concurrent launches, and per-wave would fracture the `CONVERGE_LIMIT` window and the shared `git_state` blocker lifetime (both span multiple waves within one item). **Per-wave is the design that turns FG-562-is-sufficient into FG-562-is-insufficient.**

**Exactly ONE continuation claim per item boundary (advance-to-next-item).** Every within-item transition — waves, publication convergence (AD-5 / `CONVERGE_LIMIT`), gate handling, item finalization — stays ORDINARY SYNCHRONOUS inside the launched drive and MUST NOT take a claim.

## FG-562 determination: NO extension needed (at per-item granularity)

`ConsumerKind` already includes `"campaign"` (`continuations.ts:44`); `continuationsInDispatch` is consumer-scoped (`:248`); `adoptOrClaimDispatch`/`runByDispatchKey`/`startRun` dispatchKey stamp are all generic. A per-item advancement is exactly one-launch → one-phase → one-nextAction, which the primitive expresses natively. **No schema and no API change.** (Per-wave would have been a finding against FG-562 — avoided by the granularity choice.)

## Shared consumer core — extract, do not copy

The campaign path is NOT a parallel `continuation-consumer.ts`. The claim/adopt/observe control flow is consumer-kind AGNOSTIC and becomes a single shared module both consumers call: the `waitOutcome` guard, BD-3 re-read + `deriveTerminalDisposition`, the already-advanced short-circuit, `observeLaunchStatus`, the `dispatchAndAdvance` claim→adopt-not-duplicate→record→markAdvanced sequence, the watchdog record-before-advance hook, and `recoverInFlightDispatches`. **The seam:** `assertFullIdentity`'s hard rejection of `consumerKind !== 'orchestrator'` (`continuation-consumer.ts:202-207`) splits into a generic full-identity assertion + a `consumerKind`-keyed `PhysicalDispatch` selection. **Two hardcodes to parameterize:** `recoverInFlightDispatches` `consumerKind:'orchestrator'` (`:483`); the orchestrator-only guard (`:202`). Each consumer owns only its `PhysicalDispatch` (campaign: `kind:'drive_campaign_item'` → the item-run/drive-item launch with `dispatch_key` stamped) and its wake command surface.

## FG-425 constraints a continuation claim MUST preserve (unchanged, settled)

A claim must PRESERVE these, not merely reuse the classifier (**F21**):
- The `awaiting_recovery` park stamps a deliberately **SHARED** `git_state` blocker while a publication is unresolved; cleared at the **centralized ship transition**. Do NOT simplify to a non-shared park kind — the fix was its LIFETIME, not its kind.
- A cancel is terminal and wins; recovery never resurrects a cancelled task — **but the operator must still be told when a cancelled task's candidate DID land.**
- Bounded resume convergence (`CONVERGE_LIMIT = 2`, `executor.ts:682`).
- A terminal refusal may NEVER stand over an attempt still recorded `publishing`.

## Acceptance Criteria (adoption slice)

- **AC3 (record + claim):** the controller records one continuation per item — `continuationId` derived deterministically from `(campaignId, itemId)` (NOT per-run; a retry mints a new runId), `sourceLaunchId` = the item's drive-item launch, structured `nextAction = { kind:'drive_campaign_item', campaignId, itemId }` for the next item or `{ kind:'finalize_campaign', campaignId }` for the terminal transition (never an opaque shell string). On wake it re-reads the authoritative launch record (BD-3) and claims the advance EXACTLY ONCE via the FG-562 phase-bound CAS.
- **AC4 (BD-3 consumer-enforcement):** the advance rests ONLY on a classification the authoritative launch record supports (`readLaunch`/`deriveTerminalDisposition`, incl. the reconciled `owner_gone`/`unknown` no-exit dispositions). A fabricated/stale/caller-supplied disposition has ZERO effect — proven RED against a fabricated status.
- **AC5 (F17 adopt-not-duplicate):** before dispatching item N+1's physical work, `continuationsInDispatch({consumerKind:'campaign'})` + `runByDispatchKey` adopt an existing in-flight item-run rather than spawning a duplicate. A duplicate item-run is NEVER created.
- **AC6 (shared core, not a copy):** the claim/adopt/observe core is a single shared module consumed by BOTH orchestrator and campaign; `consumerKind` branches ONLY at the injected `PhysicalDispatch` and the `recoverInFlightDispatches` parameter; the orchestrator-only guard is generalized.
- **AC7 (controller identity):** the campaign controller establishes a stable `FORGE_CONTROLLER_ID` (no `CLAUDE_CODE_SESSION_ID` exists for it). Two live controllers are fenced by the campaign status CAS; crash-takeover is by **lease expiry**, not same-owner renewal of a live lease. **[OPEN — needs operator call: campaign-stable `campaign@<id>` vs controller-instance-stable `campaign@<id>@<launchId>`. Advisor recommends instance-stable + status CAS as the singleton fence.]**
- **AC8 (running-campaign takeover):** a NEW entry point recovers a campaign whose controller died — adopts in-flight continuations and continues the item loop WITHOUT manual SQL — replacing the manual recovery documented at `concepts.md:910-943`, which is updated. **[OPEN — needs operator call: is this takeover entry point in THIS slice or a separate ticket? It changes the paused-only resume contract (`executor.ts:160`). Advisor recommends including it here.]**
- **AC9 (five-level falsification, PRODUCTION PATH):** for each crash point below, a RED-before-fix production-path test asserts the specific defect and goes GREEN only against **real `runNext` + real publisher + real durable rows**. A fixture-green suite does NOT satisfy this AC. Truthful convergence at ALL FIVE levels: task, run, campaign-item, campaign, publication.

### Crash-window / falsification matrix
- **C1** — controller dies AFTER launching drive-item N, BEFORE observing terminal → today: stuck `running`, manual SQL; item may be terminal but campaign never advances (five-level FAIL). Post-fix: takeover observes + advances.
- **C2** — dies AFTER observing terminal, BEFORE claiming advance → no claim recorded, N+1 never dispatched. Post-fix: fresh controller claims once; assert exactly one N+1 run.
- **C3** — dies AFTER claim (`dispatching`, dispatch_key set), BEFORE N+1 run created → `runByDispatchKey` empty → dispatch now; assert exactly one N+1 run, no duplicate.
- **C4** — dies AFTER N+1 run created (dispatchKey stamped), BEFORE record/markAdvanced → naive resume duplicates (two runs, split verdicts, double publish). Post-fix: `runByDispatchKey` FOUND → adopt; one run at all five levels.
- **C5** — completion delivered twice OR lost-then-watchdog-recovered → exactly one advance; lost-signal audit row ONLY on watchdog recovery, none on duplicate delivery (F18/BD-5).
- **C6** — FG-425 within-item crash: drive-item launch dies mid-publication window (`owner_gone`) after ref advanced → MUST preserve all four FG-425 invariants THROUGH the claim (item parks `awaiting_recovery` + shared `git_state` blocker; resume converges via AD-5 within `CONVERGE_LIMIT`; no refusal over a still-`publishing` attempt; blocker cleared at centralized ship in the re-driven launched drive). Proves the claim PRESERVES the invariants, not merely reuses the classifier.

## Explicitly NOT in scope

- Everything in FG-596 (launch boundary + executor restructure).
- Redesigning FG-425's publisher/lane/mutex/recovery/worktrees; no PID probing, signalling, identity nonces, zombie classification, reaping.
- Extending the FG-562 primitive (unnecessary at per-item granularity).
- **Known residual gap (documented, NOT fixed here):** a launched drive-item process that itself dies mid-item (`owner_gone` within an item), leaving the item stuck at lifecycle `running` — `campaignBlocker` treats it as `recovery_needed` (`executor.ts:129-138`); FG-490's drive-error park is alive-process only. This slice fixes CONTROLLER death, not launched-drive death.
- Parallel campaign lanes (FG-396).

## Open questions for operator (surfaced by the pass)

1. Controller identity: campaign-stable vs controller-instance-stable (AC7).
2. `running`-campaign takeover entry point: in this slice or separate (AC8).
3. Wake surface ergonomics: `forge continue --consumer-kind campaign` (extend) vs sibling `forge campaign continue` — both reuse the shared core; architecture-neutral.
4. Confirm the launched-drive-item-death residual is an accepted, documented gap for this slice.
