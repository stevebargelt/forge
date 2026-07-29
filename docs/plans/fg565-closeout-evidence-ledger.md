# FG-565 — Slice 6 Closeout Evidence Ledger

> **Lifecycle:** shipped and closed in `1b3989e`. Retained as durable closeout
> evidence.

**Ticket:** FG-565 (Slice 6 — cross-layer recovery, observability, and campaign closeout)
**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ accepted SHA `e6fd56b`
**Author:** orchestrator (evidence inventory gating the FG-565 implementation_full dispatch)
**Date:** 2026-07-21

## Purpose

FG-565 is the campaign CLOSEOUT slice. It **verifies** the durable-continuation model composes as one
system, exposes the closeout evidence through an operator surface, and reconciles the temporary guidance —
it does **not** re-open upstream decisions or add continuation features. This ledger is the durable
inventory that must precede any production edit: it maps every falsification-matrix row (F1–F35 + T9),
every binding decision (BD-1..BD-15), and every FG-565 acceptance criterion to its owning slice, current
production implementation, test/durable evidence, RED provenance, current green verification, operator
surface, and any remaining gap. The gaps this ledger identifies — and ONLY those — are what the FG-565
pipeline implements.

Evidence file:line citations were gathered by five read-only audits of the tree at `bf03690` and are
recorded inline. This ledger is the artifact the final reviewer maps evidence against (an FG-565 AC:
"a final reviewer maps evidence to every binding decision and matrix row — approving from green CI alone
is explicitly insufficient").

## Prior-slice status (FG-565 depends on every prior slice)

| Slice | Ticket | Status | Merge |
|---|---|---|---|
| 0 | FG-551 | ✅ done | `7f6091b` |
| 1 (children 0–4) | FG-567 / FG-568 / FG-569 / FG-570 / FG-571 | ✅ done | `97363ca` / `275ac63` / `1b11f25` / `5044c5d` / `2f80496` |
| 1 (child 5) | FG-572 (installed-surface) | ◐ **open** — children FG-581/582/583 | — |
| 1b | FG-555 | ✅ done | `cd8a036` |
| 2 | FG-552 | ✅ done | `017352a` |
| 3 | FG-562 | ✅ done | `727e05f` |
| 4 | FG-563 | ✅ done | `9a3235d` (PR #143) |
| 5a | FG-596 | ✅ done | `02e3b70` (PR #149) |
| 5b | FG-564 | ✅ done | `1a43bd0` (PR #150) |
| 6 | **FG-565** | this ticket | — |

**FG-572 open-child impact on FG-565 = NONE.** FG-572's remaining children are installed-surface
robustness across a promotion (FG-581 post-promotion RACI compile warning; FG-582 git-hook symlink
anchoring; FG-583 non-atomic seed cp loop). None appears in FG-565's acceptance criteria. Critically,
the T9 question FG-565 must *verify* (F26–F28: is a running process affected by a mid-flight promotion?)
is **settled by execution** — `docs/plans/fg553-slice1-architecture.md:233` "T9 — SETTLED BY EXECUTION
(5 host probes)", shipped in FG-571 as swap-and-retain/no-GC, runtime-uniform (ESM=CJS=native dlopen).
FG-582's *installed-pointer* anchoring is a distinct question and is **also already decided** by the
operator (2026-07-17: "symlink-through-current … the T9 decision is now made — both blockers cleared").
**FG-565 is therefore not blocked by any undecided upstream architecture question** → no checkpoint /
FG-598-fallback trigger on this axis.

## Binding decisions → status

| BD | Decision (paraphrase) | Status | Evidence |
|---|---|---|---|
| BD-1 | Interactive sessions never own durable work | MET | tmux/Docker ownership FG-535/536; orchestrator policy `seeds/orchestrator-template.md` |
| BD-2 | Two durability boundaries (tmux + Docker) | MET | FG-535/536 |
| BD-3 | Durable state is authoritative; no invented terminal | MET | `classifyExit`/`isTerminalStatus` sole terminality authority (`src/v2/launch.ts`, `src/store/continuations.ts:observeLaunchStatus`); F7/F8 tests |
| BD-4 | Record before notify (atomic exit + meta) | MET (FG-552) | `writeJsonAtomic` temp+rename; `src/v2/launch.test.ts:94`; observer stress `FG552_STRESS_ATOMIC=0` |
| BD-5 | Delivery ≥once; advancement exactly-once claimed | MET at primitive (FG-562) + adopted (FG-563/564) | `claimContinuationDispatch` CAS `src/store/continuations.ts`; F13/F14/F17 tests |
| BD-6 | Close the subscribe race | MET (FG-552) | `waitForLaunchTerminal` read→install→reread; `src/v2/launch-wait.test.ts:129` |
| BD-7 | Success + every failure shape wakes controller | MET (FG-552) | six dispositions; `launch-wait.test.ts:260/282` bounded-retry |
| BD-8 | Watchers own no work | MET | disposable waiter; F12 substrate |
| BD-9 | Timers are watchdogs only | MET (FG-563) + **verified installed** | `CLAUDE.md:505`, `seeds/orchestrator-template.md:417-425`, `docs/concepts.md:91`, `docs/quick-start.md:272` all watchdog-only |
| BD-10 | One primitive, multiple consumers | MET (FG-563 + FG-564) | shared consumer-core; orchestrator + campaign both consume `forge launch wait`/continuation claim |
| BD-11 | No operator message as an ordinary transition | MET (FG-563/564) | `consumeContinuation`; F22 tests |
| BD-12 | No process-name truth | MET | policy + `pgrep` ban; FG-492 lesson |
| BD-13 | Control plane never executes source under active mutation | MET (FG-571) | `bin/forge` vs `bin/forge-dev` split; promotion `src/v2/promote.ts`; F23/F25 |
| BD-14 | Control-plane availability independent of caller env; R1–R4 accounted | MET (FG-569 R1/R2, FG-555 R3/R4, FG-570 ABI) | F29/F30/F31 |
| BD-15 | Concurrent versions must not corrupt shared store (additive-only) | MET (FG-568) | `applyMigrations` additive-only `src/store/db.ts`; F35 |

All fifteen binding decisions are MET as of the prior slices. FG-565 adds no BD; it verifies them
composing and closes the observability + parity gates below.

## Falsification matrix F1–F35 + T9 → evidence grid

Columns: **row** · required result (paraphrase) · owning slice · production code · test (durable
evidence) · RED provenance · operator surface · **gap**.

### Launch-wait / atomic-record / classification (F1–F11, F32–F34) — owned by FG-552

| Row | Required | Prod code | Test | RED | Gap |
|---|---|---|---|---|---|
| F1 | already-terminal → immediate | `launch.ts:waitForLaunchTerminal` | `launch-wait.test.ts:121,129` | shares BD-6 reread red | none |
| F2 | finish between read & install → post-install reread | `waitForLaunchTerminal` | `launch-wait.test.ts:129`; `fg552-launch-wait-observer.integration.test.ts` | observer header "OBSERVED FAILING" | none |
| F3 | missed fs event → reconcile recovers | `realWaitHarness` reconcile tick | `launch-wait.test.ts:151` | watcher-never-invoked injection | none |
| F4 | interrupted write → no partial terminal JSON | `parseExitRecord`, `writeJsonAtomic` | `launch.test.ts:94,63`; observer `:137,195` | `FG552_STRESS_ATOMIC=0` reproduces tear | none |
| F5 | exit 0 → exited_ok | `classifyExit` | `launch.test.ts:21` | behavior-guard | none |
| F6 | nonzero → exited_error, not running | `classifyExit` | `launch.test.ts:25`; `launch-wait.test.ts:142` | pins not-still-running | none |
| F7 | OS signal → signal, no sender | `classifyExit` WIFSIGNALED | `launch.test.ts:30`; `bin-forge-signal-fidelity.integration.test.ts:85` | signal-fidelity bug header | none |
| F8 | deliberate 143 → numeric, no invented signal | `classifyExit` | `launch.test.ts:42,48` | names guarded bug | none |
| F9 | pane dies before record → owner_gone | `readLaunch` | `fg552-launch-wait-cli.integration.test.ts:260`; `launch-wait.test.ts:187` | watch-only times out (red) | label folded into F34/owner_gone (behaviorally covered) |
| F10 | restart no record/owner → unknown | `readLaunch` | `launch-wait.test.ts:209`; cli `:126` | tick-observed | none |
| F11 | transiently unreadable → bounded retry | `readLaunch` | `launch-wait.test.ts:260,282` | names fabricate-terminal bug | none |
| F32 | reader during meta publish → never absent | `launch.ts:930,993,1055` atomic | `launch.test.ts:526`; observer `:137` | counts `notFound` = defect | none |
| F33 | observer where better-sqlite3 can't load | `cli/index.ts` thin dispatcher; `commands/launch-wait.ts` (node:fs only) | `launch-wait.integration.test.ts:338`; `fg552-launch-wait-cli.integration.test.ts:219` | sabotage native resolution; registry cmd dies, observer lives | none |
| F34 | owner_gone/unknown by reconcile; watch-only fails | `launch.ts:1241` mandatory reconcile | `launch-wait.test.ts:187`; observer `:96`; cli `:260` | no-op startReconcile → watch-only fails | none |

### Continuation claim / crash windows / watchdog (F12–F19, F22) — owned by FG-562/563/564

| Row | Required | Prod code | Test | RED | Gap |
|---|---|---|---|---|---|
| F12 | listener swept → tmux+Docker continue; reattach | `continuation-consumer.ts:recoverInFlightDispatches`; `store/continuation-lost-signal.ts`; `idle-watchdog.ts` | reattach `continuation-consumer.integration.test.ts:194,208,226`; detached `fg536-idle-bound.integration.test.ts:146` | reattach red via real-path suite | **named-but-not-bodied**: no test body asserts "sweep listener → tmux command continues." Covered only via reattach + FG-536 detached survival |
| F13 | double delivery → one claim, one dispatch | `claimContinuationDispatch`; `runByDispatchKey` | `continuation-consumer.integration.test.ts:178`; real `.real-path.integration.test.ts:296` | real-path "each reverted in turn and caught" | none |
| F14 | two controllers race → one wins | `claimContinuationDispatch` CAS | `fg562-continuation-claim.integration.test.ts:183` (cross-process) | `:191` RED baseline | none |
| F15 | die after observe, before claim → recovery claims | `observeLaunchStatus`+`claimContinuationDispatch`; `recoverInFlightDispatches` | `fg562…:` BD-3 claimability; `continuation-consumer.integration.test.ts:208` | — | **indirect**: no F15-tagged case; subsumed by terminal-but-unadvanced watchdog path (behaviorally covered) |
| F16 | die after claim, before dispatch → recoverable/visible | `renewClaim` lease; `adoptOrClaimDispatch` | `fg562-continuation-claim.integration.test.ts:8` (lease recovery) | mutant discipline in header | none |
| F17 | die after dispatch, before receipt → adopt, no dup | `adoptOrClaimDispatch`; `runByDispatchKey`; UNIQUE(dispatch_key) | `fg562…:268`; `.real-path…:318`; `fg563-dispatch-key-index.test.ts:83` | `:291` RED baseline; fg563 "observed RED vs non-unique" | none |
| F18 | watchdog after normal advance → no dup, no false lost-signal | `continuation-lost-signal.ts:recordLostSignalRecovery` | `continuation-consumer.integration.test.ts:226`; real `:435` | real-path lost-signal discipline | none |
| F19 | job > any estimate → no wake, no duration inference | `idle-watchdog.ts` fixed const; consumer no-advance-while-running | `.real-path…:375,383` | — (note: fg523 "F19" is a *different* row, do not credit) | none |
| F22 | operator sends nothing → chain reaches next decision | `consumeContinuation`; `continuation-adapter.ts`; `campaign continue`/`recover` | `continuation-consumer.integration.test.ts:346`; cli `fg564-campaign-continue-cli.integration.test.ts:99` | — | none (rides on F19/FIX2 scenarios) |

### Cross-layer seams FG-565 explicitly owns (F20, F21)

| Row | Required | Prod code | Test | RED | Gap |
|---|---|---|---|---|---|
| **F20** | interactive session disappears → tmux command continues; detached container continues even if Forge watcher also dies | tmux ownership `launch.ts` (FG-535); detached bound `reconcile` + `idle-watchdog.ts` (FG-536) | closest: `fg536-idle-bound.integration.test.ts:146`; `fg551-agent-image-tmux.test.ts` | none for F20 scenario | **GAP (test coverage) — PRIMARY.** Zero `\bF20\b` in `src`. No test written as the interactive-session-disappears cross-layer seam. FG-565 AC names F12/F20 as a seam no single slice owns |
| **F21** | campaign continuation preserves: shared `git_state` blocker survives to ship; cancelled never resurrected **yet landed candidate surfaced**; `CONVERGE_LIMIT=2` bounded across wakes | `continuation-adapter.ts:consumeCampaignContinuation`; `executor.ts:837 CONVERGE_LIMIT`; shared blocker in campaign store | convergence `fg564-capstone.worktree.test.ts:420`; git_state `fg425-campaign-lost-window.worktree.test.ts:400,502`; cancel `fg484-auto-gate-cancel-race.integration.test.ts:149` | fg484/fg425 real-publisher red discipline | **GAP (test coverage) — the "landed candidate for a CANCELLED task is surfaced to the operator" sub-clause has no clearly matching assertion.** fg484 proves the run is not resurrected; it does not prove the landed candidate is surfaced. Verify behavior exists; add the assertion (or flag if genuinely absent) |

### Control-runtime isolation / promotion / provenance (F23–F31, F35, T9) — owned by FG-553 children + FG-555/568

| Row | Required | Prod code | Test | RED | Gap |
|---|---|---|---|---|---|
| **F23** | broken dev source → stable readers + launch observer still work | `release.ts` pinned closure; `promote.ts` `current` | side-effect only: `fg571-env-identity.integration.test.ts:586` (F25 asserts stable side) | doc §4:399 "red by construction (FG-425 AC5)" | **GAP (test coverage, partial).** No dedicated F23 test; the **launch-observer** arm under broken dev source is untested |
| **F24** | broken export → stable commands work in this **and unrelated** projects | same isolation | none carrying "unrelated project" clause | doc §4:400 flags this clause "most likely quietly dropped" | **GAP (test coverage) — clause dropped.** No test runs a stable forge command in a *second/unrelated* project dir with broken dev source |
| F25 | live-source cmd fails locally; stable unchanged | `bin/forge` vs `bin/forge-dev`; `release.ts` shim | `fg571-env-identity.integration.test.ts:586,609,633(MUTANT),668` | line 633 delegating-forge-dev reddens | none |
| F26 | validated promotion atomic; whole closure one unit | `promote.ts:promote/validateCandidate/atomicSymlinkSwap` | `fg571-promote.integration.test.ts:174`; `:208 MUTANT (swap-before-validate)`; `release.test.ts:100` | line 208 mutant | none |
| F27 | interrupted promotion → previous runtime usable | `promote.ts` seams; `runtime-store.ts:installInterpreter` | `fg571-promote.integration.test.ts:246,291,343,377,407`; `fg571-interpreter-store…:532` | SIGKILL-mid-seam executed | none |
| F28 | promotion w/ in-flight launch → identity diagnosable + BD-15 | `promote.ts` swap-and-retain; store `db.ts` | `fg571-promote.integration.test.ts:448` | `:548 MUTANT` delete-anchored → native load red | none |
| **T9** | running process (ESM/CJS/native/handle) unaffected; retained, no GC | `promote.ts` "SWAP AND RETAIN … never deletes" | `fg571-promote.integration.test.ts:448,548 MUTANT`; host probe `fg553-probes/t9-anchoring.sh` | §4:409/§1:233 "SETTLED BY EXECUTION" | none — CI test exists (not probe-only) |
| F29 | control plane RUNS under hostile PATH/env; clean failure ≠ pass | `release.ts:300` env-sanitize + `renderShim/renderEntry` | `fg571-env-identity.integration.test.ts:116,145,168(MUTANT),193`; `upgrade.integration.test.ts:141` | `:145` proven-red NODE_OPTIONS=--import evil; `:168` mutant | none |
| F30 | R1–R4 each captured/derived/unknowable | R1/R2 `cli/commands/launch.ts:59`+`release.ts:collectProvenance`; R3/R4 `launch.ts:workloadR3/R4Line` | R1/R2 `forge-bin.integration.test.ts`, `bin-forge-signal-fidelity…`; R3/R4 `launch-provenance-cli.integration.test.ts:68,95,132,165,285`; `launch-workload.integration.test.ts:74` | FG-555 header mutant+baseline | **low: no aggregate F30 test.** Diffuse across FG-569+FG-555; behaviorally covered (all four arms CI-runnable). Optional traceability polish, not a hole |
| F31 | incompatible ABI refused before native load | `cli/node-abi.ts:checkAbi`; `node-preflight.ts` | `node-preflight.integration.test.ts:286`; `launch-provenance-cli.integration.test.ts:303` | asserts `/refusing to run/` + `doesNotMatch(OPAQUE)` | none — CI `test-extended` provisions real Node 26/ABI 147 (`FORGE_TEST_MISMATCHED_NODE`, `ci-workflow.test.ts:158`); local skips if unset |
| F35 | two versions on one store → additive-only, no destructive under in-flight | `store/db.ts:applyMigrations`; `runDestructiveConvergenceMigration` | `fg568-store-compatibility.integration.test.ts` E1/E2/E4/E6/E7/HIGH1/HIGH2 | header "red baseline: DROP COLUMN killing A's insert" | none |

**Matrix RED-provenance verdict:** strong and honest where present — file headers state "OBSERVED RED / RED
baseline / reverted in turn and caught"; env toggles (`FG552_STRESS_ATOMIC=0`) and mandatory mutants
reproduce the defect. Behavior-guard-only rows (F5, F9-as-owner_gone, F10) are acceptable. F20 has
neither a test nor a red baseline — the sharpest matrix gap.

## Operator-visible evidence (7 questions) → answerable?

Durable schema is COMPLETE; the gap is the read surface. Existing surfaces: `forge launch show/list`
(filesystem launch records) and `forge lost-signals` (`continuation_lost_signal_recoveries`). The
`continuations` and `continuation_stale_observations` tables have **no read-only CLI**; `forge continue`
emits rich lines but is a mutating on-wake command, not a queryable after-the-fact surface.

| Q | Question | Durable store | Verdict |
|---|---|---|---|
| Q1 | Which launch completed / what does its record prove? | launch record `meta/exit/runtime.json`; `continuations.last_observed_status` | **ANSWERABLE** — `forge launch show`; test `launch-cli.integration.test.ts:242` |
| Q2 | Delivered normally, or recovered? | `continuation_lost_signal_recoveries.recovery_trigger` | **ANSWERABLE (watchdog)** via `forge lost-signals recovered-by=watchdog`; **minor gap**: `--recover` replay writes no durable row (LOW) |
| Q3 | Which controller/consumer claimed it? | `continuations.claim_owner`+`consumer_kind` | **GAP (normal path)** — surfaced only for watchdog recoveries; no CLI renders normal-path `claim_owner` |
| Q4 | What next action was selected? | `continuations.next_action` | **GAP** — no CLI renders `next_action` |
| Q5 | Was a run/task dispatched, what durable id? | `continuations.dispatched_run_id/task_id`; run `metadata.dispatchKey` | **PARTIAL** — watchdog path via `forge lost-signals run=/task=`; normal path only transient `forge continue` stdout; `runByDispatchKey` has no CLI |
| Q6 | Duplicate arrived, ignored safely? | `continuation_stale_observations` | **GAP** — zero CLI/report readers of `staleObservationsFor` |
| Q7 | Blocked, what operator action required? | `continuations.state='blocked'` | **GAP (HIGH)** — no CLI lists blocked continuations; the "stuck, human needed" case has no standing surface |

**Root cause:** one read-only `forge continuation show <id>` / `forge continuation list [--state blocked]`
command over the two existing tables (mirroring the shipped `forge lost-signals` pattern) moves Q3–Q7
from GAP to ANSWERABLE. This is new CLI over **existing durable evidence stores** — no schema change, no
new architecture, no new recovery path.

## Policy reconciliations → status

| Item | FG-565 requirement | Status |
|---|---|---|
| Monitor workaround | retired OR retained as named fallback (decided FG-563) | **RESOLVED** — `seeds/orchestrator-template.md:419` retains Monitor as named single-shot `forge launch wait` transport; polling variant retired; no stale poll prose in installed policy |
| ScheduleWakeup / BD-9 | watchdog-only in INSTALLED policy | **RESOLVED** — `CLAUDE.md:505`, seed `:417-425`, `concepts.md:91`, `quick-start.md:272` all watchdog-only. Only PRD `:512` retains the FG-542-era action-item line (PRD self-tracking) |
| Seed → CLAUDE.md block parity | TESTED | **TESTED** — `orchestrator-block-parity.test.ts:21` runs real installer, asserts `unchanged` |
| Docs parity (concepts + quick-start agree w/ seed) | "Parity is TESTED, not assumed" | **GAP (test coverage)** — docs AGREE by manual authoring; no test asserts docs↔seed launch-wait/ScheduleWakeup agreement |
| FG-542-era prose update | update prose that says ScheduleWakeup owns ordinary delays | installed policy already correct; **PRD `:512`/`:64`** is the residual reconciliation (documentation) |

Out-of-scope-but-noted drift (owned by **FG-582**, not FG-565): `docs/concepts.md:40` and
`docs/quick-start.md:80` still describe slash-commands-as-symlinks — unrelated to launch-wait policy.

**CORRECTION (2026-07-21, from the architect wave + red-wide, run …-e1e030):** the original ledger cited
`docs/autonomous-run-prompt.md` as a third parity surface and a G6 tightening target. That file is
**gitignored** (`.git/info/exclude:19`) in the control checkout and is **absent from origin/main and the
writer clone** — it is NOT part of the repo. The real, committed parity surfaces are **`docs/concepts.md`
and `docs/quick-start.md`** (+ `seeds/orchestrator-template.md` as the canonical source). G5 covers only
those; G6 drops the autonomous-run-prompt line-45 item. Separately, red-wide proved the **G4 behavior
already EXISTS**: `forge show` renders a published candidate for a `cancelled`-kind task in both human
output and JSON (contradicting the ledger's "possibly absent / investigate fg484 seam" framing). G4 is a
pure test-coverage assertion against `forge show` (`src/cli/commands/show.ts`), not a behavior
investigation and not the fg484 cancel-race seam.

## Consolidated gap list → what FG-565 implements

Classified per the operator's taxonomy. **Only proven gaps; each uses existing production paths.**

| # | Gap | Class | Scope | FG-565 AC |
|---|---|---|---|---|
| G1 | **Operator continuation-evidence read surface** — `forge continuation show/list [--state blocked]` (+ `--json`) over `continuations` + `continuation_stale_observations`, rendering claim_owner/consumer_kind (Q3), next_action (Q4), dispatched ids (Q5), stale/duplicate observations (Q6), blocked state + required action (Q7). Mirror `forge lost-signals`. | observability + behavior | new read-only CLI over existing tables; no schema/arch change | "Operator-visible evidence must be answerable without transcript archaeology" |
| G2 | **F20 cross-layer seam test** — interactive session disappears → tmux command continues; detached container continues even if the Forge watcher also dies. Dedicated test with a red baseline. | test coverage | existing FG-535/536 substrate | "F12/F20 — the seams no single slice owns" |
| G3 | **F23/F24 tests** — stable machine-wide readers **and the launch observer** still work under broken dev source, **including in an unrelated project** (F24 clause). Red baseline vs broken source. | test coverage | existing FG-571 isolation | "F23/F24 … in this and unrelated projects" |
| G4 | **F21 cancelled-candidate-surfaced assertion** — behavior EXISTS (red-verified): `forge show` (`src/cli/commands/show.ts`) renders a published candidate for a `cancelled`-kind task in human output AND `--json`. Add the missing test asserting that surfacing (human + JSON). NOT the fg484 cancel-race seam; NOT a behavior investigation. | test coverage | existing `forge show` surface | "F21 … a cancelled task whose work reached the target is an operator-visible fact" |
| G5 | **Docs-parity test** — assert `docs/concepts.md` + `docs/quick-start.md` agree with `seeds/orchestrator-template.md` on the completion-driven launch-wait + ScheduleWakeup-watchdog-only (BD-9) policy. Assert the extracted NORMATIVE CLAIM, not byte-parity (no generator exists, unlike `orchestrator-block-parity.test.ts`). autonomous-run-prompt.md is NOT a surface (gitignored, not in repo). | test coverage | existing parity-test pattern | "Canonical seed → … docs → installed surfaces all AGREE. Parity is TESTED, not assumed" |
| G6 | **Documentation reconciliation** (documentation-maintainer, docs phase) — reconcile the residual FG-542-era prose: PRD `:512`/`:64` action-item + add a closeout revision-log entry noting FG-565 shipped; confirm no FG-542-era "ScheduleWakeup owns ordinary delays" prose remains anywhere. (autonomous-run-prompt line-45 item dropped — file not in repo.) Optional low-value F-row traceability tags (F9/F12/F15/F30) may be recorded here as evidence-classification. Non-normative only; contract SHA `e6fd56b` stands. | documentation drift | docs only | "Update the FG-542-era prose"; "Final documentation-maintainer consistency pass" |
| — | **Closeout verification** (not an edit) — `npm run test:all` + `npm run test:extended` green at closeout (CI `test` + `test-extended`); FG-551 agent-image launch tier still green (no skips); this ledger + the focused review map evidence to every BD + matrix row. | verification | — | closeout gate |

**Explicitly NOT implemented** (verified already-satisfied or out of scope): all fifteen BDs;
F1–F19/F22/F25–F35/T9 (covered, strong RED provenance); Monitor status; ScheduleWakeup/BD-9 installed
policy; seed↔CLAUDE.md parity; F30/F12/F15 label-diffusion (behaviorally covered — traceability polish
only). **No FG-597 identity hardening. No FG-598 test refinement** (separate; no binding FG-565 criterion
depends on it). **No new continuation features, no new recovery path, no reopened upstream decision.**

## Dispatch decision

Route: **implementation_full** (cross-cutting closeout touching an operator-visible evidence surface +
cross-layer recovery seams; policy-decisive). Pipeline steps must be file-disjoint (G1 CLI+store-readers
cohesive = one step; G2/G3/G4/G5 are separable test files; G6 is the docs phase). The pipeline's
shipping-reviewer red reviews the diff against FG-565's AC; a final focused review maps evidence against
this ledger before closeout.
