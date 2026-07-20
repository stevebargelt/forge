---
id: FG-596
type: story
status: done
title: Slice 5a (prerequisite) — extract launchable single-item campaign drive + convert item loop to a launch-per-item controller
created: 2026-07-20
closed: 2026-07-20
closed_commit: 02e3b70
---

**Epic:** FG-561 · **Prerequisite for:** FG-564 (Slice 5b — continuation adoption).
**Depends on:** FG-552 (launch/launch-wait). **Source:** FG-564 bounded architecture pass (2026-07-19). **Split + per-item boundary approved by operator 2026-07-19. Additive schema change (attempt-generation) approved by operator 2026-07-20 — see Approved schema change.**

## Why this exists (the honest finding from the FG-564 architecture pass)

FG-564 was scoped as "campaign-side adoption of the durable continuation primitive." The pass established — **verified against the tree** — that it CANNOT be thin wiring:

- **The campaign path has no launch boundary.** `grep -rn 'startLaunch|readLaunch|forge launch' src/campaign/` returns ZERO hits. `forge campaign start` is one long-lived node process whose `driveRemainingItems` loop (`executor.ts:1037`) synchronously drives every item, and `driveWorkflowItem` blocks in-process on docker containers via `runNext` (`executor.ts:904`, `runNext.ts:269`). **Nothing produces a `sourceLaunchId`** for a continuation to observe.
- **The continuation RECORDER half is unwired in production.** FG-563 shipped only the CONSUMER. The campaign is the FIRST end-to-end record→launch→wait→wake→observe→claim→adopt loop.

This slice creates the launch boundary. It ships NO continuation primitive — that is FG-564 (Slice 5b).

## Scope

Extract "drive ONE campaign item to a terminal drive-process outcome or a legal park" (today inlined in `driveRemainingItems` at `executor.ts:1468-1878`, covering the `full_feature` `startRun` lane `:1536`, the `quick_implementation` `insertRun` lane `:1652`, and the escape-hatch `insertRun` lane `:1782`) as a **standalone operation invocable under `forge launch`** — `forge campaign drive-item <campaignId> <itemId>`. Restructure `driveRemainingItems` so the item FOR-LOOP becomes a controller that **launches item N, waits in-process on `forge launch wait`, then advances to N+1**.

**Launch granularity is per-ITEM, not per-wave.** Within-item waves, publication convergence (`runNext.ts:191-203`), gates, and item finalization stay ORDINARY SYNCHRONOUS **inside** the launched drive. **Park-on-throw containment (`parkCampaignOnStartRunThrow` ~1546, `parkCampaignOnDriveThrow` 718/766, the `loadWorkflow` catch ~1478) MUST run INSIDE the launched child** so a park is committed durably before the child exits — a throw becomes a launch disposition, not a controller exception (architect risk #1).

## Contract correction — a launch disposition is NOT an item outcome (binding)

A drive-item launch's terminal disposition describes the drive-item PROCESS (exited_ok / non-zero / owner_gone / unknown), NOT whether the item shipped/parked/failed. The item outcome MUST ALWAYS be derived from durable campaign/run/task/publication state AFTER the wake — never read off the launch disposition. The controller's post-wake path MUST NOT branch on `WaitOutcome.status` to decide the item's fate.

## Approved schema change + generation semantics (operator, 2026-07-20 — BINDING)

An additive **attempt-generation** field on `campaign_items` is approved. It identifies a **logical item attempt, NOT a process invocation**:

- **Allocate/increment atomically ONLY when beginning a genuinely new logical attempt** — the item's initial dispatch, or an explicit `forge campaign` retry. Nothing else bumps it.
- **A controller restart, launch reattachment, watchdog recovery, or re-drive of the SAME attempt MUST reuse the persisted generation unchanged.**
- **Persist the generation BEFORE creating the launch or the run.**
- **Deterministic dispatch key** derived from a namespaced canonical identity — `campaignId + itemId + attemptGeneration` — computable identically by any future re-launcher (FG-564) from durable state alone. (Do NOT key off the launch id — `startLaunch` uses `Math.random()`, `launch.ts:~911` — nor off a continuation input; `deriveDispatchKey` `continuations.ts:163` is continuation-coupled and out of scope here. A new non-continuation deterministic helper is required.)
- **Crash after generation allocation but before launch/run creation** → resume using that SAME generation and key (no new attempt).
- **Crash after run creation but before campaign-item `runId` linkage** → find and ADOPT the run by that same key (`runByDispatchKey`, `runs.ts:84`); never duplicate.
- **An explicit retry receives a NEW generation** and therefore cannot collide with the prior attempt.
- **Representation:** non-null integer with a safe default, UNLESS repository migration conventions require another additive representation. **Verify migration compatibility against a legacy DB containing existing campaign rows.**
- **Legacy in-flight items — fail closed:** if an item already has a `runId` but predates the generation/dispatch-key stamp, **adopt that recorded run OR park for supported recovery. NEVER mint a replacement merely because `runByDispatchKey` cannot find legacy metadata.**

## Acceptance Criteria

- **A1 — extracted launchable operation.** `forge campaign drive-item <campaignId> <itemId>`, runnable under `forge launch`; its launch disposition reflects the drive-item PROCESS only; item outcome read from durable state after the wake.
- **A2 — item loop becomes a launch-per-item controller.** `driveRemainingItems` drives one launch per item and waits via `forge launch wait`; no longer blocks in-process on the item's containers.
- **A3 — generation + deterministic key stamped before observability, all three lanes.** The attempt-generation is persisted before launch/run creation; the deterministic dispatch key `H(campaignId, itemId, attemptGeneration)` is stamped into run metadata BEFORE the run is observable, via ONE shared helper across `full_feature` (`startRun.ts:115`) and both `insertRun` lanes (`executor.ts:1652`/`:1782`). An unstamped lane silently duplicates on F17 adoption.
- **A4 — five-level production-path proof.** A real `full_feature` item drives to shipped through `startRun` + **real** `runNext` + **real** integration-publisher under a launch, with truthful convergence at ALL FIVE levels — task, run, campaign-item, campaign, publication — **derived from durable state**, not the launch disposition. **No fixture doubles for the publisher.** Red-before-fix where a defect is closed. Run the heavier test tiers (CLI-spawn / real DB / launch boundary), not just unit.
- **A5 — FG-425 invariants preserved byte-for-byte inside the launched drive.** Shared `git_state` blocker lifetime cleared at centralized ship (`executor.ts:773-793`); cancel-is-terminal-but-surface-a-landed-candidate; `CONVERGE_LIMIT=2` (`:682`); no terminal refusal over a still-`publishing` attempt.
- **A6 — the boundary is adoptable, not wedge-prone.** A killed drive-item (`owner_gone`/`unknown`) leaves the item-run ADOPTABLE by its deterministic key — proven by an A4-tier test that a killed drive-item leaves an adoptable item, not a wedged one. FG-596 does not implement continuation recovery (FG-564), but must not foreclose it.
- **A7 — generation semantics + migration compatibility (from the approved schema change).** Atomic allocate-only-on-new-logical-attempt; reuse-on-restart/reattach/recovery/re-drive; retry→new generation; the crash-window behaviors above; and legacy fail-closed handling — each demonstrated by test. Migration verified against a legacy DB with existing campaign rows (no destructive rewrite).

## This PR contains (one PR, per operator)

Migration (additive `campaign_items` attempt-generation) · the non-continuation deterministic dispatch-key helper · all three lane stamps · legacy-compatibility coverage · the FG-596 launch-boundary implementation. **No FG-562 change. No FG-564 work.**

## Explicitly NOT in scope

- The FG-562 continuation primitive, `recordContinuation`, claim/adopt, controller identity, `running`-campaign takeover, dead-drive-item continuation recovery — FG-564.
- Redesigning the FG-425 publisher/lane/mutex/recovery/worktrees; no PID probing, signalling, identity nonces, zombie classification, reaping.
- Parallel campaign lanes (FG-396).

## Risk

`driveRemainingItems` is monolithic; the real work and real risk live HERE, in the executor restructure. Do not accept a single-PR FG-564 that smuggles this refactor into an "adoption" plan.
