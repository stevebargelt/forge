---
id: FG-596
type: story
status: active
title: Slice 5a (prerequisite) — extract launchable single-item campaign drive + convert item loop to a launch-per-item controller
created: 2026-07-20
---

**Epic:** FG-561 · **Prerequisite for:** FG-564 (Slice 5b — continuation adoption).
**Depends on:** FG-552 (launch/launch-wait). **Source:** FG-564 bounded architecture pass (run-fg-564-bounded-architecture-pass-e1cc5a, 2026-07-19).

## Why this exists (the honest finding from the FG-564 architecture pass)

FG-564 was scoped as "campaign-side adoption of the durable continuation primitive." The architecture pass established — **verified against the tree** — that it CANNOT be thin wiring:

- **The campaign path has no launch boundary.** `grep -rn 'startLaunch|readLaunch|forge launch' src/campaign/` returns ZERO hits. `forge campaign start` is one long-lived node process whose `driveRemainingItems` loop (`executor.ts:1037`) synchronously drives every item, and `driveWorkflowItem` blocks in-process on docker containers via `runNext` (`executor.ts:904`, `runNext.ts:269`). **Nothing produces a `sourceLaunchId`** for a continuation to observe.
- **The continuation RECORDER half is unwired in production.** `recordContinuation`/`rearmForNextPhase` appear only in `store/continuations.ts` (the definition) and tests — no production consumer records a continuation yet. FG-563 shipped only the CONSUMER (`consumeContinuation` / `forge continue`). So the campaign would be the FIRST end-to-end record→launch→wait→wake→observe→claim→adopt loop; there is no producer loop to copy.

A continuation cannot observe a boundary buried inside an in-process await chain. **This slice creates that boundary. It ships NO continuation primitive** — that is FG-564 (Slice 5b), which becomes genuinely thin once this lands.

## Scope

Extract "drive ONE campaign item to a terminal outcome or a legal park" (today inlined in `driveRemainingItems` at `executor.ts:1468-1878`, covering the `full_feature` `startRun` lane `:1536`, the `quick_implementation` `insertRun` lane `:1652`, and the escape-hatch `insertRun` lane `:1782`) as a **standalone operation invocable under `forge launch`** — e.g. `forge campaign drive-item <campaignId> <itemId>`. Restructure `driveRemainingItems` so the item FOR-LOOP becomes a controller that **launches item N, waits in-process on `forge launch wait`, then advances to N+1**.

**Launch granularity is per-ITEM, not per-wave** (load-bearing — see FG-564 AC2). A within-item wave loop, publication convergence (`runNext.ts:191-203`), gates, and item finalization all stay ORDINARY SYNCHRONOUS **inside** the launched drive. The only campaign-level cross-process boundary is item→item advancement.

## Acceptance Criteria

- **A1 — extracted launchable operation.** Single-item drive is a standalone entry point runnable under `forge launch`, producing a launch whose terminal disposition reflects the item's true outcome (shipped / parked / failed).
- **A2 — item loop becomes a launch-per-item controller.** `driveRemainingItems` drives one launch per item and waits via `forge launch wait`; it no longer blocks in-process on the item's containers.
- **A3 — dispatch_key seam ready.** The item-run stamps the deterministic `dispatch_key` into run metadata BEFORE the run is observable. `full_feature` already threads it (`startRun.ts:115`); the `insertRun` lanes (`executor.ts:1652`/`:1782`) are routed through the same stamp so they are adoptable by `runByDispatchKey` (`runs.ts:84`). (Low-severity trap from the pass: unstamped `insertRun` lanes silently duplicate on F17 adoption.)
- **A4 — five-level production-path proof.** A real `full_feature` item drives to shipped through `startRun` + **real** `runNext` + **real** integration-publisher under a launch, with truthful convergence at ALL FIVE levels: task, run, campaign-item, campaign, publication. **No fixture doubles for the publisher** (the FG-425 failure pattern). Red-before-fix where a defect is being closed.
- **A5 — FG-425 invariants preserved byte-for-byte inside the launched drive.** Shared `git_state` blocker lifetime cleared at the centralized ship (`executor.ts:773-793`); cancel-is-terminal-but-surface-a-landed-candidate; `CONVERGE_LIMIT=2` (`executor.ts:682`); no terminal refusal over a still-`publishing` attempt. Proven by a within-item drive test, not asserted.

## Explicitly NOT in scope

- The FG-562 continuation primitive, `recordContinuation`, claim/adopt, controller identity, `running`-campaign takeover — ALL of that is FG-564 (Slice 5b).
- Redesigning the FG-425 publisher/lane/mutex/recovery/worktrees; no PID probing, signalling, identity nonces, zombie classification, reaping.
- Parallel campaign lanes (FG-396).

## Risk

`driveRemainingItems` is monolithic; the real work and real risk of the whole FG-564 effort live HERE, in the executor restructure — not in the (subsequently thin) continuation wiring. Do not accept a single-PR FG-564 that smuggles this refactor into an "adoption" plan.
