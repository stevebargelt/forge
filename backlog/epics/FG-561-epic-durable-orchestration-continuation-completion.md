---
id: FG-561
type: epic
status: active
title: "[EPIC] Durable orchestration continuation — completion-driven phase advancement with a stable control runtime"
created: 2026-07-14
---

## Source of truth

**PRD:** `docs/prds/durable-orchestration-continuation.md`
**Accepted revision:** **`e6fd56b`** (on `main`)

That commit is the accepted contract. It was audited read-only against the FG-425-merged tree by three
independent reviewers (broad / deep / integrity lenses) plus host provenance probes, corrected through a
bounded eight-item correction set, re-reviewed to PASS at `0109b8c`, landed byte-identical to `main`,
then corrected again for two HIGH contract gaps (FG-555's missing boundary; BD-4 vs. the reconciled
dispositions) and re-verified to PASS at `e6fd56b`.

**If a later edit changes a binding decision, story order, consumer contract, or failure semantics, the
campaign needs a new plan hash and this SHA must be updated.** Do not implement against a remembered
version of this document.

**Non-normative reconciliations since `e6fd56b`:** as Slice-1 children land, the PRD's *current-state /
evidence* map is reconciled to shipped behavior without touching normative content — FG-568 (`275ac63`,
BD-15 premise → shipped additive-only store) and FG-573 (current-state map → landed R1/R2 + exec entry).
No binding decision, story order, consumer contract, or failure semantics changed in either, so `e6fd56b`
remains the accepted contract SHA.

## Goal

An ordinary workflow transition is **completion-driven**: a launch reaches a terminal state, the
controller wakes, rereads durable truth, claims one transition, and advances once. Timers exist only to
recover a lost signal. No routine transition waits on the operator to send another chat message.

Below that sits a prerequisite the FG-425 run exposed: the machine-wide `forge` command is npm-linked to
the live development worktree and selects its interpreter from the caller's PATH — so the control plane
that *observes* the work can be broken by the work itself, or by an ambient environment it never chose.

## Binding decisions (see the PRD for the normative text)

- **BD-1..BD-3** — interactive sessions never own durable work; tmux and the Docker daemon own the two
  durability boundaries; durable state is authoritative.
- **BD-4** — record before notify (**UNMET**). Atomic exit-record commit **and** atomic meta-record
  publication. The matching-record requirement is scoped to **exit-record-driven** completion events;
  reconciled `owner_gone`/`unknown` rest on durable metadata plus independent owner evidence and must
  **never fabricate an exit record**.
- **BD-5..BD-12** — at-least-once delivery / exactly-once claim; close the subscribe race; every failure
  shape wakes the controller; watchers own no work; timers are watchdogs only; one primitive, multiple
  consumers; no operator message as an ordinary transition; no process-name truth.
- **BD-13** — the control plane never executes source under active mutation. **Valid, unmet, and
  insufficient on its own.**
- **BD-14** — **control-plane availability does not depend on the caller's environment.** BD-14 is a
  **prerequisite for satisfying BD-13.** Stable source and stable runtime are separate properties.
  Implementation-neutral: it selects no mechanism (that is OQ-6). Four runtime identities — R1 control
  runtime, R2 exit-recorder runtime, R3 launched top-level executable, R4 nested-shell resolution — must
  each be **captured, derived, or explicitly declared unknowable**. Recording one is not proof of another.
  **R1 and R2 are now captured (FG-569); R3/R4 remain open (FG-555).**
- **BD-15** — concurrent Forge versions must not corrupt the shared store. **Store half shipped additive-only
  (FG-568); the promotion half that creates concurrent versions is FG-571.**

## Slice order

Execute sequentially unless the approved campaign plan proves independence.

| Slice | Ticket | What |
|---|---|---|
| 0 | **FG-551** ✅ | Agent test-environment parity — `agent-dev-worker` can run the tmux launch tests. **Landed (`7f6091b`).** |
| 1 | **FG-553** ◐ | Isolate the Forge control runtime — an agent editing Forge cannot break machine-wide commands, observation, or unrelated projects. **Not closable on the source axis alone** (BD-14). **Delivered via bounded children — see decomposition below. Children 0–4 landed; Child 5 (FG-572) open.** |
| 1b | **FG-555** | The **launched workload's** execution environment. **Distinct but coordinated with Slice 1 — do NOT fold into FG-553.** BD-14 protects the control runtime (R1); FG-555 governs what the submitted command resolves (R3/R4). A stable Forge on pinned Node 24 can still faithfully launch a caller-supplied `bash -lc` that resolves Node 23 and reproduce the ABI false-red **with BD-14 fully satisfied**. Requires exact argv preservation, an environment contract for Forge-owned unattended callers, and honest R3/R4 provenance. |
| 2 | **FG-552** | Atomic terminal record + the `forge launch wait` primitive. **AC reconciled against the corrected BD-4** — see the ticket. |
| 3 | **FG-562** | Durable continuation claim — observing a terminal state cannot duplicate or lose the next action. |
| 4 | **FG-563** | Interactive orchestrator adoption. |
| 5 | **FG-564** | Campaign-runner adoption — same primitive, same vocabulary. |
| 6 | **FG-565** | Cross-layer recovery, observability, closeout. |

**FG-553 (Slice 1) decomposition** (`docs/plans/fg553-slice1-architecture.md` — six bounded children, each one reviewable PR):

| Child | Ticket | Status |
|---|---|---|
| 0 | **FG-567** | Landed (`97363ca`) — `bin/forge` signal/exit fidelity; later **superseded by FG-569's exec-not-spawn** (no child process left to re-raise). |
| 1 | **FG-568** | Landed (`275ac63`) — additive-only store on the ordinary open path; destructive DDL moved to the operator's quiesce-gated `forge store converge`. |
| 2 | **FG-569** | Landed (`1b11f25`) — exec-not-spawn entry + inert immutable release closure + manifest + R1/R2 provenance. |
| 3 | **FG-570** | Landed (`5044c5d`) — exact bounded ABI assertion (equality; upper AND lower bound) replacing the minimum-major floor; refuses a mismatched ABI (older OR newer) with a named message before native load. F31 gate-enforced: CI `test-extended` provisions a real Node 26/ABI 147 and the arm reddens rather than skips. |
| 4 | **FG-571** | Open — atomic promote/rollback + `/bin/sh` PATH shim + env-sanitization (swap-and-retain, no GC). |
| 5 | **FG-572** | Open — installed-surface compatibility across a promotion. Its dashboard sub-item is DONE: FG-580 (`bc9286f`) bundles the dashboard and lifts the FG-569 release-mode refusal, so `forge dashboard` now runs from a promoted release. The other FG-572 children (seeds/hooks/scripts) remain open. |

**UPDATE 2026-07-17 — FG-571 landed (`2f80496`), so this no longer holds.** Children 0–2 were inert (runtime provenance + store compatibility, no promotion). **Child 4 (FG-571) ships promotion**: the `current` pointer, atomic promote/rollback, the near-frozen `/bin/sh` PATH shim, a content-addressed immutable interpreter store, bounded env-sanitization and fail-closed release identity. **F29 is now closed on the live path** — a promoted release runs under its own pinned interpreter with ambient Node injection neutralized, proven by execution incl. a mandatory mutant showing PATH-pinning alone is insufficient. The machine-wide `forge` on THIS host still resolves to the live checkout because the campaign deliberately never promoted on it; promotion is the operator's explicit `release build` → `promote` → `install-shim`. **Honest limit (FG-571):** same-principal `$FORGE_HOME` tampering is out of scope — see the FG-571 ticket's threat boundary and the plan's §4b. ~~**FG-561 is not complete while stable `forge dashboard` from a promoted release remains unavailable** (FG-572).~~ **UPDATE 2026-07-17 — this dashboard-availability condition is now MET by FG-580 (`bc9286f`):** the dashboard is bundled into the release and `forge dashboard` runs from a promoted release (offline-booting). FG-561 remains open on the *other* FG-572 children and the later slices, but no longer on dashboard availability.

## Operating constraints for this campaign

**Two constraints compose here, and getting them wrong recreates FG-553. Read both.**

**(a) FG-559 — no history-dependent agent runs against a linked-worktree project mount until FG-559
lands.** A linked worktree's `.git` is a pointer file into the parent repo, which is outside the container
mount, so **every git command fails inside the agent** — silently, today. Any agent that must consult
history (every reviewer, every fixer, anything diffing a range) must be given a git-capable mount, and its
brief must make the required `git diff` / `git log` / `git show` evidence **explicit** so it fails closed
rather than substituting a working-tree read.

This is not optional hygiene: a reviewer that cannot see the diff it is reviewing is not a reviewer. It was
caught only because one brief made a diff mandatory and the reviewer honestly returned `inconclusive`
instead of certifying what it could not check.

**(b) But "use a git-capable `main` checkout" is NOT safe for a WRITER until FG-553's promotion lands.**
`main` IS the live control runtime — the machine-wide `forge` is npm-linked to it. A **writing** fixer
mounted on `main` mutates the control plane while it runs, which is precisely the FG-553 hazard this
campaign exists to eliminate. A workaround for FG-559 must not resurrect FG-553.

**The rule, by agent kind:**

| Agent | Mount | Why |
|---|---|---|
| **Read-only reviewer** | clean `main` mounted **read-only**, or a standalone clone | Cannot mutate the control runtime; OS-level read-only mount enforces it. |
| **Any writer / fixer, until FG-553's promotion is in force** | **standalone clone ONLY** | A writer on `main` mutates the live control plane. Never mount `main` writable for an agent until FG-553's isolation is in force. |
| **Any history-dependent agent** | never a linked worktree, until FG-559 | Git is silently broken in that mount. |

**Children 0–2 landing does NOT relax (b).** They are inert — no promotion — so the machine-wide `forge`
still executes the live working tree, and a writer on `main` still mutates the control plane. (b) relaxes
only when FG-571's atomic promotion is in force so the machine-wide `forge` executes a promoted release
rather than the working tree. (a) stands until FG-559 is closed.

## Code defects the PRD documents (owned by the slices, not by this epic)

Established against the FG-425-merged tree; each is honestly represented in the PRD. Resolved items are
marked with the child that fixed them; the rest remain owned by their slice and must not be re-asserted as
done:

- Exit record written with a bare `writeFileSync` — no temp+rename (`src/v2/launch.ts:130`), and the
  reader maps an empty/unparseable exit file to a terminal `unknown` (`launch.ts:102,287,289`), so a
  launch that **exited 0** can read as unrecoverable. **RESOLVED (FG-552, Slice 2):** the exit record is
  committed via temp+rename; the reader treats an empty/unparseable/schema-invalid record as bounded-retry
  (never terminal on a single read), and a persistently-invalid record wakes to a terminal disposition only
  on independent terminal owner evidence.
- `meta.json` written twice during `startLaunch` (`launch.ts:240,269-270`) — a reader in the truncate
  window sees a **running** launch as "no such launch." **RESOLVED (FG-552, Slice 2):** `meta.json` is now
  published once atomically (temp+rename), so a reader in the window never sees a running launch as absent.
- Node preflight was a **minimum-major** check (`src/cli/node-preflight.ts:26`) — it admitted Node 26, whose
  ABI cannot load the repo's `better-sqlite3` binding, producing an opaque native crash instead of the
  guard's clear message. **RESOLVED (FG-570 — `5044c5d`):** replaced with an exact ABI equality assertion (upper AND
  lower bound) that refuses a mismatched ABI with a named message before native load; F31 executes under a
  real Node 26/ABI 147 in CI `test-extended`.
- The CLI eagerly imports all command modules before argv is parsed (`src/cli/index.ts`), transitively
  loading `better-sqlite3` — so `forge launch wait` would be coupled to the entire import graph even
  though `readLaunch` needs only `node:fs` and the tmux binary. **Source isolation alone never fixes this.**
  **RESOLVED (FG-552, Slice 2):** `src/cli/index.ts` is a thin dispatcher that routes `launch wait` to a
  native-free path (`node:fs` + tmux only) before the eager command registry (extracted to `program.ts`,
  dynamically imported), so the observer resolves without `better-sqlite3`.
- `readLaunch` shells out to the `tmux` binary — it is not a pure durable-record read. **ADDRESSED (FG-552,
  Slice 2):** degraded/absent tmux is handled as a named observation input (classifies, never crashes),
  covered by a required test.
- Migrations *previously* ran unconditionally on every writable DB open, including a destructive `DROP COLUMN`
  (`src/store/db.ts:91`), while version skew between concurrent Forge processes is the default state.
  **RESOLVED (FG-568, `275ac63`):** the ordinary open path is now additive-only on every open (read-only
  callers' first opens included); the destructive `DROP COLUMN` moved off it into
  `runDestructiveConvergenceMigration`, invoked only via the operator's quiesce-gated `forge store converge`.
- `LaunchMeta` had 8 fields (`launch.ts:44-58`) — no interpreter, Node version, ABI, PATH, or source SHA,
  so no runtime provenance was recoverable post-launch. **RESOLVED (FG-569, `1b11f25`):** `meta.json` now
  carries a `control` R1 record (the submitting CLI's `execPath`/`abi`/`nodeVersion`/trusted `releaseId`)
  and `runtime.json` carries the independent R2 exit-recorder record; both surface in `forge launch show`.
  R3/R4 provenance is **RESOLVED (FG-555, merged `21af80c`):** `workload.json` records R3 (launched
  top-level executable, resolved at spawn time) and R4 (nested-shell resolution, default `unknowable`),
  surfaced in `forge launch show` / `--json`.

## Acceptance (the campaign closeout gate)

The PRD's closeout gate governs. In summary: FG-551 parity resolved without changing work ownership;
FG-553 + BD-14 eliminate machine-wide mutable-source coupling **and** caller-environment dependence, with
promotion/rollback/runtime-identity/store-compatibility proven; FG-555 closes the launched-workload
boundary; the exit record is atomic and authoritative; a controller-facing wait covers every terminal
disposition and closes the subscribe race; lost and duplicate notifications are proven safe; the
orchestrator and campaign runner share one primitive with durable idempotent continuation; ScheduleWakeup
is a lost-signal watchdog only; the hand-built Monitor workaround is retired or explicitly retained as a
fallback; canonical seed, generated project block, docs and installed surfaces agree; **every
falsification test was observed red against its baseline before it went green**; and a final reviewer maps
evidence to every binding decision and matrix row rather than approving from green CI alone.
## 2026-07-21 — Slice 6 (FG-565) SHIPPED; durable-continuation core COMPLETE

**FG-565 (Slice 6 — cross-layer recovery, observability, closeout) shipped and closed** (merge `1b3989e`, PR #151). This was the last continuation slice: the launch / stable-runtime / continuation-claim / watchdog / campaign-recovery / promotion / version-skew guarantees are now proven to compose as one system (cross-layer matrix F1–F35+T9 verified; evidence ledger `docs/plans/fg565-closeout-evidence-ledger.md`), the closeout evidence is exposed through the new read-only `forge continuation show/list` operator surface, `ScheduleWakeup` is watchdog-only across installed policy (BD-9 contradiction gone, parity-tested), and the `Monitor` workaround is retained only as the named single-shot `forge launch wait` transport.

**Two honest scope items surfaced at closeout, filed as follow-ups (NOT epic blockers):**
- **FG-599** — `forge lost-signals` durably records only *watchdog* recoveries; normal delivery is answerable by absence-of-row and replay-recovery is not durably recorded. Docs/policy corrected to state this accurately (recovery-ledger framing). FG-599 owns making it a positive durable record (finding against FG-562/FG-563).
- **FG-600** — `forge continuation` read-only parity (drop `ensureForgeDirs`) + F21 should drive the real `forge cancel` CLI; both fail-safe/fidelity, core invariants met.

**Epic remains OPEN only on FG-572** (Slice 1 Child 5 — installed-surface compatibility across a promotion: FG-581 post-promotion RACI-compile, FG-582 git-hook symlink anchoring, FG-583 non-atomic seed cp). None of these is a continuation-model gap — they are release-promotion installed-surface robustness. All other slices (0–6) are done.