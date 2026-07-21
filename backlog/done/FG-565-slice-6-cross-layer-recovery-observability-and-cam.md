---
id: FG-565
type: story
status: done
title: Slice 6 — cross-layer recovery, observability, and campaign closeout for durable continuation
created: 2026-07-14
closed: 2026-07-21
closed_commit: 1b3989e
---

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 6)
**Depends on:** every prior slice. This is the closeout slice.

## Problem

The prior slices prove their individual layers, but Forge does not yet have one durable campaign-level
proof that the launch, stable-runtime, continuation, claim, watchdog, campaign-recovery, promotion, and
version-skew guarantees compose without losing or duplicating work. The operator also cannot yet answer
every closeout question from Forge-owned durable evidence alone, and temporary wait/recovery guidance may
still disagree across installed surfaces. Without this final cross-layer audit and reconciliation, the
epic could appear complete while failures remain at seams no individual slice owns.

## Goal

Prove the ownership and continuation model **as one system**, then retire the temporary guidance. Each
prior slice proves its own layer; this slice proves they compose, and that the seams between them do not
lose or duplicate work.

## Scope

- The **end-to-end fault matrix** — **F1–F35 plus T9 as decided by FG-553** — exercised as one system. **T9
  is not open at closeout:** FG-553 settles the in-flight/lazy-import question empirically because it
  constrains the promotion mechanism FG-553 builds. This slice **verifies that decision holds** under the
  full matrix; it does not re-open it.
- Delivery / claim / watchdog-recovery evidence exposed through an **operator surface**.
- Clear retirement — or explicit fallback status — for the hand-built `Monitor` polling workaround.
- Update the FG-542-era prose that still says `ScheduleWakeup` owns ordinary delays.
- Final documentation-maintainer consistency pass.
- A focused review against the PRD before campaign closeout.

## Operator-visible evidence (must be answerable without transcript archaeology)

- Which launch completed, and what does its durable record **prove**?
- Was the completion observation **delivered normally, or recovered** by watchdog/replay?
- Which controller/consumer **claimed** the continuation?
- What next action was selected?
- Was a run/task dispatched, and what **durable id** proves it?
- Did a duplicate event arrive, and was it ignored safely?
- Is continuation blocked, and what explicit operator action is required?

Exact event/table names are **not prescribed by the PRD** — but by the time this slice runs they have
**already been selected and implemented upstream** (FG-562 owns the continuation storage, OQ-1). **They are
NOT open at closeout.** This slice **verifies** that the selected names/tables actually answer the questions
above; it does not choose them. The evidence must live in **Forge-owned durable state**, not only in a
transcript or Monitor output.

## Acceptance Criteria

- **Every falsification test was observed RED against its appropriate pre-fix baseline and green after its
  slice.** A test that cannot go red does not prove the defect was covered. This is a campaign-level gate,
  audited here.
- The cross-layer matrix passes, including the seams no single slice owns:
  - **F12/F20** — the interactive session disappears → the tmux command continues; the detached container
    continues even if the Forge watcher also dies.
  - **F23/F24** — an agent makes development source syntactically invalid or creates a transient
    missing-export inconsistency → stable machine-wide Forge state readers and the launch observer still
    work, **in this and unrelated projects**.
  - **F25** — an explicit live-source command run against broken source fails **locally** without changing
    the stable runtime.
  - **F26/F27/F28** — validated promotion is atomic; an interrupted promotion leaves the previous stable
    runtime selected and usable; a promotion with an in-flight launch keeps runtime identity diagnosable
    and follows the recorded store/schema-compatibility policy. **Includes T9** (the in-flight/lazy-import
    case), which is **DECIDED IN FG-553** — this slice verifies the decision holds under the full matrix.
  - **F29, F30, and F31 are THREE DISTINCT CLOSEOUT ASSERTIONS. Do not recombine them** — they have
    different, partly *opposite* pass conditions, and asserting "the control plane must run" across all three
    would **REJECT a correct F31 implementation**, whose whole point is a clean refusal.
    - **F29 — RUNS.** The bare stable `forge` **runs correctly** from a shell whose PATH resolves a different
      interpreter, invoked from a shell the operator did **not** pre-sanitize. *"Fails cleanly" is NOT a pass
      for F29.* A caller-applied PATH pin is containment, not isolation, and does not satisfy it.
    - **F30 — PROVENANCE (campaign-level).** **R1–R4 are EACH durably captured, derived, or explicitly
      recorded as unknowable.** R1/R2 land in FG-553, R3/R4 in FG-555 — **full F30 is only satisfiable after
      FG-555**, and this slice is where it is verified end to end. Argv alone does not satisfy R3; the exit
      recorder's `process.execPath` does not satisfy R1, R3, or R4.
    - **F31 — REFUSED.** An interpreter whose ABI the native bindings were not built for is **refused by a
      bounded ABI assertion, before any native module loads** — a too-new major with an incompatible ABI must
      be **rejected, not admitted**. **F31's pass condition IS a clean refusal, not a successful run.** An
      opaque `ERR_DLOPEN_FAILED` is a FAIL; so is running anyway.
  - **F35** — version-skew store compatibility: old and new Forge processes against one SQLite, under the
    **BD-15 policy decided in FG-553**.
- The `Monitor` workaround's status is explicit: retired, or retained as a named fallback adapter (the
  retirement decision itself belongs to **FG-563**; this slice confirms it was carried out).

## This slice VERIFIES decisions; it does not MAKE them

Every open question this campaign must answer is owned by the slice whose implementation it constrains. A
decision made for the first time at closeout is a decision made after the code that depends on it was
already written.

| Open question | **Decided in** | Verified here |
|---|---|---|
| **T9** — is a running process affected by a mid-flight promotion (dynamic `import()`, lazy requires, open handles)? | **FG-553** — it constrains the promotion mechanism | under the full matrix (F26–F28) |
| **BD-15 store-version policy** — concurrent Forge versions against one SQLite | **FG-553** — it constrains the promotion mechanism | F35 |
| **OQ-4** — cancelling an *observer* vs. cancelling the *work* (distinct commands, distinct audit events) | **FG-552** (the waiter's own cancel semantics) + **FG-563** (adoption) | end-to-end |
| **OQ-5** — host-reboot continuation policy (today: no exit record + no tmux session ⇒ `unknown`; may Docker/reconcile evidence refine it?) | **FG-552** (terminal classification) + **FG-562** (continuation policy on `unknown`) | after a real restart |
| **OQ-2** — the production session adapter | **FG-563** | end-to-end |
| **OQ-1** — durable continuation storage | **FG-562** | end-to-end |
| **OQ-3** — watchdog owner + interval | **FG-563** | end-to-end |
| **OQ-6** — stable-runtime packaging/promotion mechanism | **FG-553** | F26–F28 |

If this slice discovers an open question that was never decided upstream, that is a **finding against the
owning slice**, not a decision to be improvised here.
- A final reviewer **maps evidence to every binding decision and matrix row** — approving from green CI
  alone is explicitly insufficient.

## The PRD's closeout gate, restated in full — every line is required

- **Focused tests pass after EACH slice** (not only at the end).
- **The full and extended suites pass at final closeout** — `npm run test:all` **and** `npm run test:extended`
  (required CI checks `test` **and** `test-extended`; a red `test-extended` blocks exactly like a red `test`).
- **FG-551's image parity remains GREEN.** The `agent-dev-worker` image still runs the launch tier with no
  failures and no skips. Slice 0's fix must not have rotted across the campaign — if the image regressed,
  every agent's suite is untrustworthy again and the campaign's own test evidence is in doubt.
- **Canonical seed → generated project block → docs → installed surfaces all AGREE.**
  `seeds/orchestrator-template.md`, the marker-managed `CLAUDE.md` block (re-rendered via `forge-dev upgrade` —
  NOT stable `forge upgrade`, which since FG-577 renders the executing release's template; validating the wrong
  propagation path would make this gate pass on a block the seed edit never reached),
  `docs/quick-start.md`, `docs/concepts.md`, `docs/autonomous-run-prompt.md`, and any installed host skill
  that independently prescribes launch waiting must all say the same thing. **Parity is TESTED, not assumed.**
  *(Ownership note, FG-347: the seed and the marker block are orchestrator-policy surfaces — the
  documentation-maintainer must not hand-edit them.)*
- **`ScheduleWakeup` is documented and used ONLY as a lost-signal watchdog** — the BD-9 contradiction is gone
  from the installed policy, not merely from the PRD.
- **Every falsification test was observed RED against its appropriate baseline and green after its slice.**
- **The `Monitor` workaround's status is explicit** (decided in FG-563; confirmed here).
- **Every non-`none` docs-impact across the campaign is resolved** — updated, `not_needed: <reason>`, or
  `deferred: #<ticket>`.

## Not in scope

- New continuation features. This slice closes the campaign; it does not extend it.

## Acceptance Evidence

Shipped in merge `1b3989e` (PR #151). Full matrix/BD mapping: `docs/plans/fg565-closeout-evidence-ledger.md`. Final verification review: task-red-wide-584a5e (2 medium fail-safe findings dispositioned → FG-600; core invariants met).

| AC | Evidence | Verdict |
|---|---|---|
| Every falsification test observed RED against its baseline, green after (campaign-level gate) | Ledger audits RED provenance across F1–F35+T9 (headers "OBSERVED RED", env toggle `FG552_STRESS_ATOMIC=0`, mandatory mutant arms in fg571/fg562). FG-565's own new tests redden via injected mutants: F20 no-op reconcile+watchdog; F23/F24 broken-export; F21 negative control — each documented in its header. | met |
| F12/F20 — session disappears → tmux command continues + detached container continues if watcher dies | `src/v2/fg565-f20-cross-layer-seam.integration.test.ts` — real `forge launch run` tmux ownership + real tmux session kill (`assert.ok(hasTmux)`, fails never skips) + real `reconcileRun` surviving-bound recovery; mutant reddens the real assertion. F12 substrate: continuation-consumer recover + fg536-idle-bound. | met |
| F23/F24 — broken dev source → stable readers + launch observer still work, in this AND unrelated projects | `src/v2/fg565-f23-f24-broken-source.integration.test.ts` — broken-export injection; stable readers + launch observer verified in-project and in a second unrelated project dir; hermetic per-test FORGE_HOME (never the real install). | met |
| F25 — live-source command against broken source fails locally, stable runtime unchanged | Ledger F25: `src/v2/fg571-env-identity.integration.test.ts:586,633` (forge-dev FAILS, stable forge SUCCEEDS; mutant). Owned by FG-571; verified here. | met |
| F26/F27/F28 (+T9) — atomic promotion / interrupted / in-flight + T9 process-anchoring | Ledger: `src/v2/fg571-promote.integration.test.ts:174,208(mutant),246–407(SIGKILL seams),448/548(T9+mutant)`; T9 settled-by-execution (FG-553 plan §1/§4). Owned by FG-571; verified here. | met |
| F29/F30/F31 — three distinct assertions (RUNS / PROVENANCE / REFUSED) | Ledger: F29 `fg571-env-identity.integration.test.ts:116,145,168(mutant)` (RUNS under hostile PATH/env); F30 R1/R2 (FG-569) + R3/R4 (FG-555) `launch-provenance-cli.integration.test.ts`; F31 `node-preflight.integration.test.ts:286` + CI real Node 26/ABI 147 (`ci-workflow.test.ts:158`) — clean REFUSAL, not a run. | met |
| F35 — version-skew store compatibility (BD-15 additive-only) | Ledger: `src/store/fg568-store-compatibility.integration.test.ts` (additive-only; no destructive migration under an in-flight peer). Owned by FG-568; verified here. | met |
| Monitor workaround status explicit (decided FG-563, confirmed here) | `seeds/orchestrator-template.md:419` retains Monitor as the named single-shot `forge launch wait` wake transport; the 20s-polling variant is retired. No stale poll prose in installed policy. | met |
| Operator-visible evidence — the 7 questions answerable from Forge-owned durable state | New `forge continuation show/list [--state blocked] [--json]` (`src/cli/commands/continuation.ts`) answers Q3 (claim_owner+consumer_kind), Q4 (next_action), Q5 (dispatched ids), Q6 (stale/duplicate via continuation_stale_observations), Q7 (blocked + ACTION-REQUIRED); Q1 `forge launch show`; Q2 recovered-by-watchdog via `forge lost-signals`. **Q2 honest scope:** normal-delivery is answerable by absence-of-row and replay-recovery is not durably recorded — the surfaces were corrected to state this (recovery-ledger framing, `3a30546` + merge); durable normal/replay recording is a finding against FG-562/FG-563 filed as **FG-599** (the ticket's verify-and-surface model). | met |
| Canonical seed → generated block → docs → installed surfaces AGREE (parity TESTED) | seed↔CLAUDE.md: `orchestrator-block-parity.test.ts`. docs↔seed launch-wait + ScheduleWakeup-watchdog-only + lost-signals delivery-mode: new `src/cli/commands/fg565-docs-parity.test.ts` (claim-agreement + delivery-mode overclaim rejection, falsifiable by construction). | met |
| ScheduleWakeup used/documented ONLY as a lost-signal watchdog (BD-9 contradiction gone from installed policy) | seed:417/420 + CLAUDE.md:505/508 + concepts.md:91 + quick-start.md:272 all watchdog-only; asserted by the G5 parity test. | met |
| Full + extended suites green at closeout; FG-551 image parity | CI at merge head `c26350d` (run 29865733392): `test`, `test-extended` (integration_1–4 + worktree + dashboard_integration) all GREEN; FG-551 launch tier runs inside the agent image via test-extended. | met |
| Every non-`none` docs-impact resolved | G1 operator_behavior_changed → docs phase documented `forge continuation` in concepts.md + quick-start.md (updated); G6 PRD reconciliation (non-normative, SHA e6fd56b stands). | met (updated) |
| Final reviewer maps evidence to every binding decision + matrix row (green CI alone insufficient) | `docs/plans/fg565-closeout-evidence-ledger.md` maps BD-1..BD-15 + F1–F35+T9 to production code / test / RED provenance / operator surface; final red-wide verification (task-red-wide-584a5e) reviewed the closeout diff against AC. | met |