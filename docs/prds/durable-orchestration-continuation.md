# Durable Orchestration Continuation

**Status:** shipped and closed. The continuation campaign, including FG-565
closeout, is complete; inline progress statements are preserved as point-in-time
implementation history.
**Captured:** 2026-07-13  
**Last revised:** 2026-07-15  
**Primary backlog:** FG-551, FG-552, FG-553, FG-555
**Landed foundation:** FG-535, FG-536, FG-542  
**Landed Slice 1 (partial):** FG-551 (test parity), FG-567 (signal fidelity), FG-568 (additive-only store), FG-569 (exec entry + inert release closure + R1/R2 provenance), FG-570 (bounded ABI assertion — `5044c5d`). **FG-571 (promotion) LANDED `2f80496`.** FG-553 child 5 (FG-572 installed-surface) remains open. **R3/R4 launched-workload provenance LANDED (FG-555, `cd8a036`) — R3/R4 now recorded; workload provenance + the `--require-control-toolchain` contract delivered [SHIPPED 2026-07-18].**  
**Landed Slice 2:** FG-552 (atomic records + `forge launch wait`/`waitForLaunchTerminal` — `017352a`) — BD-4/BD-6/BD-7 MET [SHIPPED 2026-07-18].  
**Landed Slice 3 (primitive):** FG-562 (durable continuation-claim primitive — `727e05f`) — the durable `continuations` table + phase-bound CAS claim; BD-5 MET **at the primitive** [SHIPPED 2026-07-19]. Consumer adoption (FG-563 orchestrator / FG-564 campaign) remains open — this is the primitive, not end-to-end adoption.  
**Landed Slice 5a (launch boundary prerequisite):** FG-596 (launchable single-item campaign drive) [SHIPPED 2026-07-20] — extracted "drive ONE campaign item to a terminal outcome or a legal park" as the launchable `forge campaign drive-item <cid> <itemId>`, and converted `campaign start`/`resume`'s item loop into a controller that launches one drive-item per item under `forge launch`, waits via `forge launch wait`, and advances. The item outcome is derived from durable state, never the launch disposition; the drive-item run is stamped with a deterministic dispatch key + item attempt generation (`campaign_items.attempt_generation`) so a dead drive-item is adoptable. This establishes the launch boundary FG-564 adopts; it ships **NO** continuation primitive, `recordContinuation`, claim/adopt, or dead-drive-item recovery — those remain FG-564.  
**Upstream context:** [anthropics/claude-code#76249](https://github.com/anthropics/claude-code/issues/76249), [#25188](https://github.com/anthropics/claude-code/issues/25188), [#72851](https://github.com/anthropics/claude-code/issues/72851), [#68625](https://github.com/anthropics/claude-code/issues/68625)

## How to use this document

This is the shared working document for the next durability campaign, which follows the now-landed FG-425 corrective run. It exists because the relevant behavior is currently split across landed tickets, active tickets, source comments, orchestrator prose, and one live-session workaround. No agent should be asked to reconstruct the system from those fragments again.

Sections marked **Binding decision** are operator-controlled constraints. An agent may find a contradiction or propose a change, but it must surface that conflict rather than silently revise the decision. Sections marked **Open question** are deliberately unresolved and may be decided during planning, subject to the binding decisions and acceptance matrix here.

This document is not itself an executable backlog item. Before implementation:

1. Review and accept or amend the binding decisions.
2. Commit the accepted revision.
3. Allocate a parent epic and bounded child stories through `forge backlog`.
4. Record this document's commit SHA in the epic and campaign approval rationale.
5. Require a new plan hash if a later edit changes a binding decision, story order, consumer contract, or failure semantics.

## Executive outcome

Interactive orchestrator sessions make decisions; they do not own valuable work. Long-running host commands remain owned by tmux. Agent containers remain owned by the Docker daemon. Durable Forge records remain the source of truth. Completion events provide prompt attention but never truth or survival.

The missing system behavior is durable continuation. The diagram below is the **target shape this campaign must produce — not a description of the current system.** Every annotation in it is a required outcome; none may be read as a property Forge has today.

```text
Claude/orchestrator session
        │ short submit
        ▼
stable, last-known-good Forge control runtime
        │ durable launch
        ▼
tmux-owned Forge command (must account durably for R1-R4: capture, derive, or explicitly declare unknowable; BD-14)
        │ detached dispatch
        ▼
Docker-daemon-owned agent container
        │ edits an isolated development worktree, never the control runtime
        │ durable result
        ▼
launch record + task/run/campaign state
        │ advisory completion event
        ▼
controller wakes, rereads truth, claims one transition, advances once
```

The happy path must be completion-driven. Timers exist only to recover a lost completion signal. An ordinary workflow transition must never depend on the operator sending another chat message.

## Problem

FG-535, FG-536, and FG-542 fixed work survival but not work continuation:

- `forge launch` moves a long-running host command under tmux and writes durable launch metadata, logs, and an OS-derived exit record.
- Agent containers run detached, so the Docker daemon owns them and disposable `docker logs -f` / `docker wait` watchers may die without killing agent work.
- `forge claude` disables Claude Code's harness-owned background-task facility, preventing accidental use of the channel FG-535 proved unsafe for valuable work.

But a terminal `forge launch` tells no controller that it finished. The orchestrator currently has to guess a wakeup time, poll on another model turn, or create a disposable Monitor that polls the launch record and converts terminal state into a session event. The FG-425 corrective run uses the last shape: work under tmux, a 20-second Monitor, and a 30-minute `ScheduleWakeup` watchdog. *(Superseded 2026-07-21, FG-565 closeout: the completion-driven happy path shipped — FG-563 (orchestrator) and FG-564 (campaign) adopted the durable continuation claim over `forge launch wait` + `forge continue`, and `ScheduleWakeup` is now a fixed health-bound lost-signal watchdog only in every installed policy surface (BD-9). This paragraph is preserved as the accepted record of the pre-continuation workaround that motivated the campaign, not a description of current behavior; see the 2026-07-21 FG-565 revision-log entry.)*

That workaround is safe for the work because the Monitor owns nothing. It is still incomplete as a product contract:

- Each controller hand-builds its watcher.
- A fixed poll interval is arbitrary.
- A lost signal has no first-class delivery or recovery evidence.
- A duplicate wake can dispatch a phase twice unless the consumer owns an idempotent claim.
- A controller crash after observing completion but before dispatching the next phase can lose continuation.
- A controller crash after dispatch but before recording advancement can duplicate continuation on recovery.
- The orchestrator and campaign runner could grow different mechanisms for the same lifecycle.

The FG-425 AC5 run exposed a prerequisite below all of those gaps. The machine-wide `forge` command is npm-linked to this repository and executes `tsx src/cli/index.ts` directly, so an engineer's half-written Forge source is also the live control-plane binary. A transient cross-file edit made every Forge command on the host fail at module load, including the `forge launch show` command the completion Monitor depended on. The tmux-owned work and detached agent survived, but observation and phase advancement temporarily disappeared. FG-553 owns this source-coupling hazard.

The immediate CLI-free tmux-pane Monitor is an acceptable advisory wakeup, not a new source of terminal truth. Pane death says to inspect the durable launch record; it does not prove success, failure, signal, or sender. The durable-continuation design cannot standardize a `forge launch wait` observer until the `forge` binary executing that observer is isolated from the source agents are editing.

## Evidence and upstream boundary

FG-535's local evidence is stronger and more specific than the public upstream reports. A live `SA_SIGINFO` sentinel captured `SIGTERM` with `si_pid` equal to that Claude Code session's own harness process; the same process swept multiple registered background tasks. Supacode/zmx was not the sender in that capture.

The upstream issues corroborate the broken background-work contract but do not prove one identical trigger:

- `anthropics/claude-code#76249` reports a task killed by the harness without a matching `TaskStop`.
- `#25188` describes session cleanup/compaction SIGTERMing long-running Bash work; it is closed as a duplicate, not documented as fixed.
- `#72851` and `#68625` describe Desktop idle/lock lifecycle teardown killing background process trees.

Forge must not make correct ownership depend on a particular upstream diagnosis or version. Even after an upstream fix, an interactive session can exit, crash, upgrade, disconnect, or be intentionally closed. Native task notification may become a safer delivery adapter later; it does not become the owner of the work.

## Current system map

| Concern | Current owner | Ticket | State |
|---|---|---|---|
| Long host command | tmux server / `forge launch` pane | FG-535 | Landed |
| Agent container | Docker daemon via `docker run -d` | FG-536 | Landed |
| Agent result | Bind-mounted task directory and Forge store | Existing + FG-536 recovery | Landed |
| Unsafe harness background dispatch | Disabled for `forge claude` children | FG-542 | Landed |
| tmux availability in agent test image | `agent-dev-worker` image | FG-551 | Landed (`7f6091b`) |
| Control-plane executable + provenance (R1, R2) | npm-linked mutable Forge working tree; single-process `/bin/sh` exec entry so R1 (`process.execPath`) is self-evidencing; exit-recorder captures R2 independently | FG-553 / FG-569 | **Closed on the live path** — R1/R2 recorded + exec entry (FG-569, `1b11f25`); source isolation + atomic promotion shipped (FG-571, `2f80496`). Honest limit: same-principal `$FORGE_HOME` tampering is out of scope (FG-571 threat boundary) |
| Launched-workload environment (R3/R4) | `forge launch` preserves argv, records R3/R4 workload provenance at spawn time, and offers the `--require-control-toolchain` pinned-PATH-trust contract for Forge-owned unattended callers | FG-555 | **Shipped (`cd8a036`, 2026-07-18) — R3/R4 recorded; `--require-control-toolchain` contract delivered** |
| Launch completion notification | Canonical `forge launch wait` / `waitForLaunchTerminal` blocking subscription over atomic records | FG-552 | **Shipped (`fg552-launch-wait-primitive`, `017352a`, 2026-07-18) — race-free subscription to every terminal disposition (BD-4/BD-6/BD-7 MET); push-notification delivery evidence remains open below. The idempotent-continuation-claim primitive has since shipped (FG-562, `727e05f`, 2026-07-19); its consumer adoption remains open below** |
| Notification delivery evidence | None | New slice | Missing |
| Idempotent continuation claim | Durable `continuations` table + phase-bound CAS claim (`claimContinuationDispatch`, `src/store/continuations.ts`) | FG-562 | **[SHIPPED 2026-07-19 (FG-562) — durable continuations table + phase-bound CAS claim; consumer adoption in FG-563/FG-564] — the PRIMITIVE is shipped: exactly-once-CLAIMED advancement over at-least-once delivery, `adoptOrClaimDispatch`/deterministic `dispatch_key` receipt (F17) + `continuationsInDispatch` restart-replay collector + durable stale-observation audit. Physical-dispatch adoption (check the receipt before spawning) is the consumer's job (FG-563 orchestrator / FG-564 campaign) — still open, NOT end-to-end adopted** |
| Orchestrator adoption | Session prose and live workaround | New slice | Missing |
| Campaign adoption | Campaign runner | New slice | Missing |
| Full cross-layer failure proof | Split across FG-535/536 tests | New slice | Missing |

## Binding decisions

### BD-1 — Interactive sessions never own durable work

The orchestrator session owns judgment and phase-selection decisions. It does not own the lifetime of a long Forge command or an agent container. No implementation may move valuable work back under Bash `run_in_background`, `&`, `nohup`, `disown`, or another session-child mechanism merely to obtain `<task-notification>`.

### BD-2 — Preserve the two durability boundaries

tmux owns the long-running host-side Forge command. The Docker daemon owns the detached agent container. These are complementary, not competing implementations:

- tmux preserves the normal Forge watcher/finalizer path when the submitting session disappears.
- Docker detachment preserves the agent's work if the tmux-owned Forge watcher itself disappears.

FG-535 and FG-536 are foundations. Do not reopen their ownership choices without a falsifying test.

### BD-3 — Durable state is authoritative

A notification is never proof of success, failure, signal, or publication. On every wake the consumer rereads the launch record and the relevant run/task/campaign state. Existing attribution rules remain binding:

- A recorded OS signal proves a signal landed, not who sent it.
- Exit code 143 without OS signal evidence remains an exit code, never inferred SIGTERM.
- No exit record plus a dead owner remains `owner_gone` or `unknown` according to the evidence; it is never guessed into success.

### BD-4 — Record before notify

**Status: MET (Slice 2, FG-552). [SHIPPED 2026-07-18 (FG-552) — atomic records / bounded-retry completion disposition delivered].** Both records are now committed atomically in `src/v2/launch.ts`: the exit record is written to a sibling temp file and `renameSync`d into place inside the exit-recorder script, and `meta.json` is published *twice* during startup — each write atomic (temp + rename via `writeJsonAtomic`): first before the tmux session exists, marked as a startup record (`starting`) so a directory-discovering reader classifies an as-yet-owner-less launch `running` rather than a terminal `unknown` — a classification `readLaunch` bounds to launcher-pid (`launcherPid`) liveness, so a launcher that crashes mid-startup falls through to owner-evidence reconciliation and settles to a terminal disposition (`unknown`/`owner_gone`) instead of reading `running` forever — then republished once the owner pid is knowable (which clears the flag). Because each publish is atomic, a consumer never observes partially-written JSON as a terminal result, nor a running launch as "no such launch"; completion is observed through the blocking `forge launch wait` / `waitForLaunchTerminal` subscription over these atomic records, not a push notification. The reader (`readLaunch`) no longer treats an empty or unparseable exit record as terminal: only a parseable record is authoritative, and an unreadable one falls through to owner evidence under bounded retry. The design narrative below is preserved as the accepted record.

The terminal record must become complete and readable before any happy-path completion signal is observable. Two records are in scope:

- **Atomic exit-record commit.** The exit record must be written atomically (temporary file plus rename, or an equivalent proven operation), so a consumer never observes partially written JSON as a terminal result.
- **Atomic meta-record publication.** The meta record has the identical non-atomic defect and is equally binding. `meta.json` is written twice during launch startup — once before the pane holds the real command, once after the owner pid is knowable — and a reader arriving inside that window can observe a *running* launch as "no such launch." Publication of the meta record must be atomic.

**A reader must not treat an empty or unparseable record as terminal.** BD-7 already states that transient missing or unreadable files are not terminal on their own, and the current reader contradicts it: it maps an empty or unparseable exit file to a terminal `unknown`, which is exactly the write window BD-4 exists to close. An unreadable record is an invitation to retry, not a disposition. Only bounded retry plus independent terminal evidence may produce `unknown`.

Record and notification do not need impossible cross-system exactly-once atomicity. A crash after the record commit but before notification is a lost-signal case and must be recovered from the record.

**The matching-record requirement is scoped to exit-record-driven completion events.** For any completion event that claims an exit, the exit record must already be committed and readable: a signal asserting an exit that never happened is a defect and must not advance a phase.

This requirement does **not** extend to the reconciled dispositions. `owner_gone` and `unknown` produce **no filesystem artifact at all** (see the reconciliation requirement under the controller-facing subscription, and F34) and are discovered only through reconciliation. They rely on **durable launch metadata plus independent owner evidence**, and they advance under their own explicit failure/blocker policy (BD-7, F9, F10) — not under an exit record. **A reconciled disposition must never fabricate an exit record to satisfy this decision.** Requiring one would demand the invention of a terminal result the system elsewhere proves cannot exist, which BD-3 forbids outright.

### BD-5 — Delivery is at least once; advancement is exactly once claimed

**Status: MET at the primitive (Slice 3, FG-562). [SHIPPED 2026-07-19 (FG-562) — durable `continuations` table + phase-bound CAS claim (`claimContinuationDispatch`); consumer adoption in FG-563/FG-564].** The durable claim now exists (`src/store/continuations.ts`): on wake a controller records the observed terminal disposition (via the canonical `classifyExit`/`isTerminalStatus` classifier, BD-3) and claims the single `awaiting_completion|ready -> dispatching` transition through a phase-bound compare-and-set whose predicate binds `source_launch_id + consumer_kind + current_phase + next_action + expected prior state + lease`, so a delayed completion from launch A can never advance a newer phase B. `adoptOrClaimDispatch` + the deterministic `dispatch_key` receipt (written at claim time, before dispatch) give F17 adopt-not-duplicate; `continuationsInDispatch` is the restart-replay collector; a stale observation is recorded durably (`continuation_stale_observations`) and ignored. This ships the PRIMITIVE only — the physical-dispatch adoption (checking the receipt before spawning an agent/run) is the CONSUMER's job in FG-563 (orchestrator) / FG-564 (campaign) and remains open; this is not yet end-to-end adoption. The decision below is preserved as the accepted record.

Duplicate events are expected. Delivery may be delayed or lost. The consumer must make advancement idempotent through a durable claim or an already-existing durable state transition with equivalent semantics.

"Exactly once" applies to the successful claim of the next transition, not to physical event delivery. Tests must cover two wakes racing to advance the same completed launch.

### BD-6 — Close the subscribe race

**Status: MET (Slice 2, FG-552).** The canonical subscription primitive `waitForLaunchTerminal` (`src/v2/launch.ts`) now closes the subscribe race: it reads the authoritative record, installs the observation mechanism, and rereads immediately, so either read observes an already-terminal launch — no check-then-subscribe gap can strand a completed launch. Controllers no longer hand-build a watcher.

A launch may finish before a subscriber attaches or while subscription is being installed. The subscription algorithm must:

1. Read the authoritative record before waiting.
2. Install the observation mechanism.
3. Reread immediately after installation.
4. Treat either read as sufficient to observe an already-terminal launch.

No check-then-subscribe gap may strand a completed launch.

### BD-7 — Success and every failure shape wake the controller

**Status: MET (Slice 2, FG-552). [SHIPPED 2026-07-18 (FG-552) — atomic records / bounded-retry completion disposition delivered].** Failure is now a completion disposition, not silence: `waitForLaunchTerminal` (`src/v2/launch.ts`) wakes for every terminal disposition — exit 0, ordinary non-zero, OS signal, signal-range code, `owner_gone`, and `unknown`. An empty, unreadable, or invalid exit record is bounded-retry, never prematurely terminal (F11); a *persistently* unreadable/invalid record wakes to a terminal disposition (`owner_gone`/`unknown`) only after a bounded (60s, `DEFAULT_INVALID_BOUND_MS`) retry plus independent owner evidence — it neither blocks forever nor is mapped straight from an empty file to terminal `unknown` (see BD-4). The requirement below is preserved as the accepted record.

The controller must wake for:

- exit 0;
- ordinary non-zero exit;
- OS-recorded signal;
- owner gone without an exit record;
- unknown/no-owner state discovered after restart;
- persistently unreadable or invalid records after bounded retry and independent terminal evidence.

Failure is a completion disposition, not silence. Transient missing or unreadable files are not terminal on their own.

### BD-8 — Watchers own no work

A session-side listener, Monitor task, filesystem watcher, or blocking `forge launch wait` process is disposable. Killing it may lose latency, never the command, container, durable result, or ability to reconstruct state later.

### BD-9 — Timers are watchdogs only

`ScheduleWakeup` may detect that a notification or listener was lost. It is not the normal completion path and must not be sized from a guessed job duration. A watchdog wake records that it recovered a lost signal before advancing.

Cheap process-level safety checks inside a disposable waiter are allowed; repeated model wakeups while work remains running are not.

### BD-10 — One primitive, multiple consumers

**Status: UNMET, owned by Slice 5 (adopting the Slice 2 primitive).** This is a required property, not an accomplished one. The shared primitive does not exist yet, and the campaign runner has zero coupling to launch records today — see the factual note below.

The interactive orchestrator and campaign runner consume the same launch-completion primitive and terminal vocabulary. They may have different continuation state, but they must not implement different event transports or different interpretations of launch truth.

Factual note: the campaign runner has **zero coupling to launch records today** — nothing outside the `forge launch` command surface reads them. "One primitive, two consumers" is therefore a **goal of this campaign, not a property being preserved.** Consumer-specific constraints belong to the slice that adopts the primitive (see Slice 5 and F21), not to this decision, which stays generic: one primitive, one terminal vocabulary, multiple consumers.

### BD-11 — No operator message as an ordinary transition

**Status: UNMET, owned by Slice 4.** This is a required property, not an accomplished one. The orchestrator's happy path today still depends on a guessed wakeup, a hand-built Monitor, or another operator turn.

The system may return to the operator for a real product/scope decision, exhausted review policy, non-mechanical CI failure, or a blocker explicitly requiring authority. Normal success, routine failure classification, test-engineer chaining, documentation passes, review-loop progression, CI observation, and merge/closeout do not wait for the operator to ping the session.

### BD-12 — No process-name truth

Process-name matching and PID existence are debugging evidence, not completion truth. The design continues to prefer launch records, task/run/campaign state, result artifacts, Docker state, and explicit terminal evidence. No `pgrep -f <role|ticket|command>` completion condition.

**Decision dependency:** BD-14 is a prerequisite for satisfying BD-13. Decision numbers are stable identifiers, not execution order.

### BD-13 — The control plane never executes source under active mutation

The machine-wide `forge` command, its launch observer, and every routine state-reader must execute from a stable, last-known-good runtime (**see BD-14**) isolated from development worktrees. An agent's partial edit, syntax error, missing export, dependency rewrite, or failed experiment may break an explicit development command; it may not make the host's control plane unloadable or affect unrelated Forge projects.

BD-13 is a **valid normative source-isolation decision that is unmet today and insufficient on its own.** Satisfying it exactly as written leaves the runtime-provenance failure fully intact: on the operator's host, `bash -lc 'forge launch list'` exits 1 with empty stdout today *with source fully valid* (operator-supplied evidence, P5). BD-13's predicate is source mutation; that failure occurs with no source mutation at all, so BD-13 is not falsified by it — it simply does not reach it. Source isolation without BD-14 produces a stable source tree executed by an arbitrary interpreter.

This does not require abandoning the tsx/no-build decision. A pinned snapshot or dedicated stable checkout may continue to execute TypeScript through tsx with isolated dependencies. Preserve an explicit live-source path such as `forge-dev` or `npm run forge` for intentional rapid iteration. Promotion to the machine-wide `forge` runtime is atomic and follows the selected trust gates; "commit and it is live" is replaced by "validated promotion and it is live."

A read-only fallback observer is useful defense in depth but is not sufficient closure for FG-553. The machine-wide blast radius must be eliminated, not merely documented.

### BD-14 — Control-plane availability does not depend on the caller's environment

This decision is **implementation-neutral**. It states a required property and the evidence that property must produce. It does not select a mechanism — absolute shebang, wrapper script, pinned snapshot, vendored interpreter, container, `current` symlink, or anything else. Mechanism selection remains **OQ-6**.

**Required property.** The availability of the control plane must not depend on the caller's ambient environment. Stable source and stable runtime are **separate properties**; neither substitutes for the other. A PATH pin applied by a caller is **containment, not a property of the system**, and does not satisfy this decision. An honest preflight failure proves evidence integrity, not control-plane availability: a command that fails cleanly and truthfully is still a command that did not run.

Four distinct runtimes are in play. These are separate facts; recording one is **not** proof of any other:

| | Runtime identity | What it is | Currently recorded? |
|---|---|---|---|
| **R1** | Control runtime | the interpreter + native-binding ABI + dependency set actually executing the `forge` CLI, its launch observer, and every routine state-reader | **Yes (FG-569)** — the single-process exec entry makes `process.execPath` self-evidencing; captured at submission in the CLI as `meta.json`'s `control` record and rendered as `launch show`'s `control:` line (old pre-FG-569 launches read "not recorded", never manufactured) |
| **R2** | Exit-recorder runtime | the interpreter executing the launch wrapper's exit recorder (`process.execPath` of that process) | **Yes (FG-569)** — captured inside the recorder as `runtime.json`, independent of R1; still not evidence of R3 or R4 |
| **R3** | Launched top-level executable | the executable named as argv[0] of the submitted launch command, as resolved at spawn time | **No** — argv is recorded, but argv is a *string*, not a resolution |
| **R4** | Nested-shell resolution | how a caller-supplied shell (e.g. `bash -lc …`) later resolves `node`, `npm`, `forge`, or any other command *inside* the launched command | **No — and may be inherently unknowable.** The design must say so rather than imply argv covers it |

**Required evidence.** The design must state, for each of R1–R4, whether it is durably captured at launch, derived, or explicitly declared **unknowable**. Argv recording is not runtime identity. `process.execPath` of the exit recorder is not the runtime of the launched workload.

**Required enforcement.** Compatibility must be asserted against the ABI the native bindings were actually built for — a bounded check, not a version floor. **Landed (FG-570 — `5044c5d`):** the preflight is now an exact ABI equality assertion (`checkAbi`, upper AND lower bound) against the release manifest's abi (else the pinned `REQUIRED_ABI`); a mismatched ABI — older OR newer — is refused with a named message before native load, and F31 executes the real CLI entry against a release manifest naming an ABI the running interpreter does not have (**FG-647:** manufactured in the manifest, so it is deterministic under the one `.nvmrc` interpreter — the earlier real-Node-26 CI arm and its provisioning are gone). (Pre-FG-570 the preflight was a minimum-major floor that admitted any major at or above it, and therefore admitted an ABI that cannot load.)

Subordinate acceptance: **F29**, **F30**, **F31**.

### BD-15 — Concurrent Forge versions must not corrupt the shared store

Concurrent Forge processes of **different versions** share one SQLite database by default. This is the ordinary case, not an edge case: a long tmux-owned launch starts under version A, the operator promotes, and a new command runs under version B against the same store while the launch is still in flight.

**Historical premise (pre-FG-568 — no longer current).** Two facts once made this unsafe. Migrations ran **unconditionally on every open** — not merely every writable one — and they included a **destructive `DROP COLUMN`**. Every process migrated the store on its first open, including a logically read-only caller: `getDb({ readOnly: true })` finds no writable handle in-process, falls through to the writable `getDb()`, and that path runs `SCHEMA_SQL` plus the migrations (`applyMigrations`, `src/store/db.ts`). The read-only callers that therefore migrate on their first open are `show`, `status`, `runs`, `export`, `metrics`, `ops`, `report`, and `sweep` (`src/cli/commands/`) — that fan-out is still current, and it is why the ordinary open path had to become additive-only rather than merely be avoided by convention. What is NOT current is the destructive half: an older process opening the store after a newer one had migrated it, or a newer process destructively migrating a store an older in-flight process was still reading, was not a hypothetical before FG-568. The residual destructive risk is now confined to the explicitly invoked `forge store converge` (below); no ordinary open — read-only or writable — can reach it.

**As shipped in FG-568 (`275ac63`), the ordinary open path is now additive-only.** `applyMigrations` runs ONLY additive, backward-compatible migrations — on every open, logically read-only callers' first opens included — and executes no `DROP` and no destructive DDL; old readers and writers of an in-flight peer keep working by construction. The destructive `DROP COLUMN` that once ran here now lives ONLY in `runDestructiveConvergenceMigration`, invoked explicitly via `forge store converge`: an operator-invoked, quiesce-gated, one-way boundary — never the ordinary open path. This does not change BD-15's decision (additive-only was always the decision); it records that the premise's destructive-open hazard has been removed from the shared path and confined to an explicit operator step.

The design must **decide the policy** and record it. The candidates:

- a schema-version gate (a process refuses to open a store whose schema is newer than it understands);
- outright refusal to run concurrent versions;
- backward-compatible-migration-only (no destructive statements; old readers keep working);
- explicit promotion-quiesce (no promotion while a launch is in flight).

Naming this a compatibility concern is not a decision. "The design addresses store compatibility" is not a decision. One of the above — or a stated equivalent — must be selected, and the destructive-migration behavior must be reconciled with it.

Subordinate acceptance: **F35**.

## Selected first implementation shape

The subscription below is downstream of FG-553. `forge launch wait` is not an independent observer if the `forge` executable itself imports the source tree the supervised agent is editing. The campaign must establish a stable control runtime first, and the wait command must run from that runtime.

### Controller-facing subscription

The first implementation should provide a blocking controller primitive:

```text
forge launch wait <launch-id> [--json]
```

Default behavior:

- Return immediately if the launch is already terminal.
- Otherwise block without waking a model until the launch becomes terminal.
- Emit exactly one structured terminal observation for this waiter invocation.
- Exit successfully when it observed and rendered a terminal launch disposition; the launch's own exit code remains data, not the wait command's process exit status.
- Refuse an unknown launch ID distinctly from a known launch whose status is `unknown`.

Implementation guidance, not an excuse to weaken the contract:

- Watch the launch directory/atomic exit-record rename for the ordinary path.
- Recheck immediately after installing the watcher.
- **Reconciliation is mandatory, not a fallback.** `owner_gone` and `unknown` produce **no filesystem artifact at all**, so a watch-then-reread design **structurally cannot** cover two of the six terminal dispositions. Reconciliation is not insurance against missed events; it is the only path by which those two dispositions are ever observed.
- Reuse `readLaunch`/one canonical classifier rather than creating a second status vocabulary.
- Keep any timeout an explicit optional operator/testing result such as `wait_timeout`, never a fabricated launch terminal state.

From a controller's perspective this is an event subscription: completion unblocks the waiter and the harness/adapter wakes the session. It is not a fixed-estimate model poll. The waiter is disposable and owns none of the work.

### Why this shape first

- A completion callback executes arbitrary commands from a lifecycle wrapper and creates new quoting, security, and crash windows.
- A Unix socket or daemon introduces a new long-lived service before the consumer contract is proven.
- An event row alone still needs a blocking consumer or polling adapter.
- Existing external notification providers notify humans but do not provide a supported orchestrator wake channel.
- A blocking wait composes with the current Monitor/task-notification boundary, CLI automation, tests, and the campaign runner while preserving durable truth.

This choice does not forbid a later event stream or daemon. Any later transport must preserve the same record-first, at-least-once, replayable contract.

## Durable continuation contract

Notification alone does not make a multi-phase chain safe. The controller must own a durable continuation record or identify an existing durable state transition that provides the same guarantees.

Minimum conceptual state:

```text
continuationId
sourceLaunchId
consumerKind             orchestrator | campaign
currentPhase
nextAction               structured action, never an opaque shell string
state                    awaiting_completion | ready | dispatching | advanced | blocked
claimOwner
claimExpiresAt           only if claims are renewable/recoverable
dispatchedRunId/taskId   when known
lastObservedStatus
createdAt/updatedAt
```

The exact storage schema is an **Open question**, but these crash windows are binding acceptance cases:

1. Crash before observing completion: replay from launch record.
2. Crash after observing completion but before claiming: another controller may claim.
3. Crash after claim but before dispatch: claim must expire/recover or remain visibly blocked; it cannot disappear.
4. Crash after dispatch but before recording the run/task ID: recovery must discover/adopt the dispatched work using an idempotency key or durable dispatch receipt, not dispatch a duplicate.
5. Duplicate event after advancement: observe `advanced`, perform no action.

Campaigns already have durable campaign/item state and may satisfy much of this contract through a transactional extension. An ad hoc orchestrator chain currently does not have equivalent durable state; its adoption story must provide or explicitly reuse one before claiming exactly-once advancement.

## Proposed campaign decomposition

Allocate final IDs only once this document is accepted. Execute sequentially unless the approved campaign plan proves independence.

### Slice 0 — FG-551: agent test-environment parity

Goal: the standard `agent-dev-worker` image can run the host-oriented tmux launch tests without ten false failures.

Required decisions/tests:

- Add the minimum supported tmux dependency to `docker/agent-dev-worker.Dockerfile`, or prove a cleaner test-environment mechanism that does not skip the production behavior.
- Rebuild the image and run the FG-535 launch integration tier inside it.
- Do not make agents use tmux to own their own task work; this is test-tool availability, not an ownership change.

### Slice 1 — FG-553: isolate the Forge control runtime

Goal: an agent editing Forge cannot break machine-wide commands, observation, or unrelated projects — **and** the control plane resolves to a known runtime regardless of the caller's ambient environment (BD-14).

**Landed so far (2026-07-16):** children 0–3 — FG-567 (signal fidelity), FG-568 (additive-only store), FG-569 (exec-not-spawn entry + inert immutable release closure + manifest + R1/R2 provenance), FG-570 (bounded ABI assertion — `5044c5d`). These shipped the runtime-provenance, store-compatibility and interpreter-compatibility halves, deliberately inert. **UPDATE 2026-07-17: Child 4 — FG-571 (atomic promote/rollback + PATH shim + env-sanitization + fail-closed identity) — LANDED as `2f80496`, so the slice is no longer inert and F29 is closed on the live path.** Child 5 — **FG-572** (installed-surface compatibility) — remains open. **UPDATE 2026-07-18: R3/R4 launched-workload provenance (FG-555) SHIPPED as `cd8a036` — R3/R4 are now recorded at spawn time and the `--require-control-toolchain` launch-environment contract is delivered.**

**FG-553 is not closable on the source axis alone.** Stable source and stable runtime are separate properties. A slice that isolates the source tree and leaves the interpreter to the caller's PATH has not closed this ticket: the observed control-plane outage reproduces with source fully valid. Both axes must close.

Binding outcome:

- `forge` executes a stable, last-known-good runtime isolated from all active development worktrees.
- Control-plane availability does not depend on the caller's PATH, shell, or login environment (BD-14).
- An explicit development entry point retains live-source iteration.
- Promotion and rollback are atomic and identify the exact runtime commit/path.
- `forge launch` records enough runtime identity to diagnose which control version owns an in-flight command, and states for each of R1–R4 whether it is captured, derived, or unknowable.
- A source tree made syntactically invalid or cross-file inconsistent cannot break stable `forge launch show`, `forge launch wait`, `forge status`, `forge backlog`, or another project's Forge command.
- The design addresses in-flight launches and shared-store/schema compatibility during promotion (BD-15); it does not silently swap incompatible code beneath a running controller.

Open mechanism choice: a pinned snapshot, dedicated stable worktree, release directory plus atomic `current` symlink, or an equivalent design. Compiled `dist/` is optional; isolation is mandatory.

#### The atomic executable/runtime closure

Define the set of artifacts that must change as **one indivisible unit** for a promotion to be atomic. At minimum:

- the executable entry point,
- its source tree,
- its `node_modules`,
- its native bindings,
- its interpreter identity.

A promotion that swaps a subset of this closure is **not atomic**, because the parts are ABI- and API-coupled to one another. The operator's host is the proof: three mutually ABI-incompatible Node binaries are on PATH, and the repository's `better-sqlite3` loads under exactly one of them (operator-supplied evidence, P3). The interpreter and the native binding are a matched pair; promoting source without the interpreter promotes a tree that may not load.

Whether an **already-running** process is affected by a mid-flight promotion — through dynamic `import()`, lazy requires, or open file handles — is an **open acceptance case (T9), not an established fact.** The design must not assert either immunity or exposure. It must test it.

#### Externally installed surfaces (version-compatibility, not atomic swap)

Separate from the atomic closure above, these surfaces are **installed copies that live outside the promoted unit** and therefore need a **version-compatibility policy** rather than atomic swap:

- `~/.forge` seeds, workflows, and routing-policy — verified on the operator's host as **copies, not symlinks into the repository**, so they do not follow a source promotion;
- installed hooks and scripts;
- project-local `.forge` command assets;
- dashboard assets.

For each surface, the design must state whether promotion **re-installs** it, **version-pins** it, or leaves it **explicitly out of the control path** — and what happens when an installed copy is older than the promoted runtime. "It is installed by `forge upgrade`" is not an answer to that question.

The direct tmux-pane watcher remains only an emergency advisory signal until this slice lands. It never interprets pane death as the launch result.

### Slice 1b — FG-555: the launched workload's execution environment

> **[SHIPPED 2026-07-18 (FG-555, `cd8a036`) — R3/R4 now recorded; workload provenance + the `--require-control-toolchain` contract delivered.]** The binding outcomes below are DELIVERED: `forge launch run` records R3 (resolved `argv[0]`) and R4 (whether a later runtime resolution is knowable — `unknowable` otherwise) at spawn time, and `--require-control-toolchain` supplies the refuse-before-execute environment contract (pinned-PATH trust) for Forge-owned unattended callers. See `docs/concepts.md` "Durable launch" and `docs/quick-start.md` §13 for the operator surface. The design narrative is preserved below as the accepted record.

**Coordinated with Slice 1/BD-14, but a distinct boundary with a distinct owner. Do not fold this into FG-553.**

BD-14 protects the **Forge control runtime** — the interpreter, ABI, and dependency set executing `forge` itself (R1). FG-555 governs the **environment of the launched workload** — what the submitted command resolves once it is running. These are not the same boundary:

> A Forge running a stable, pinned Node 24 control runtime can faithfully launch a caller-supplied `bash -lc <chain>` whose login shell resolves Node 23, and reproduce the original ABI-mismatch false-red **with BD-14 fully satisfied.** Control-runtime provenance does not imply launched-workload provenance.

Closing FG-553 therefore does not close this. A slice that pins Forge's own interpreter and leaves the launched workload's environment to the caller's login shell has not reached the failure that actually burned a verification cycle.

Binding outcome:

- **Exact argv preservation.** `forge launch run` is an argv launcher: it preserves and executes the submitted argv and **does not insert or rewrite a shell.** The recorder wraps the supplied argv and spawns `argv[0]` with the remaining arguments directly. The earlier claim that Forge synthesized a `bash -lc` login shell was false and **must not be reintroduced** — the caller supplied the shell. Generic operator argv is never silently transformed; a caller may still intentionally supply `bash -lc`.
- **An explicit environment contract for Forge-owned unattended callers.** Define what execution environment a Forge-owned caller may rely on when it submits a command, so an unattended verification does not depend on ambient login-shell `PATH` mutation as an implementation detail. A workload that requires a shell declares it and gets a contract; it does not inherit one accidentally.
- **Honest R3/R4 provenance** (BD-14's table). R3 — the launched top-level executable, as resolved at spawn time — must be captured or derived; argv is a *string*, not a resolution. R4 — how a caller-supplied nested shell later resolves `node`, `npm`, or `forge` *inside* the launched command — must be captured, derived, or **explicitly declared unknowable.** R4 may be inherently unknowable, and the design must say so rather than imply argv covers it. The exit recorder's `process.execPath` identifies R2 only and proves nothing about R3 or R4.
- Either the workload runs under the intended compatible toolchain, or the launch **refuses before executing it** with a named, actionable runtime/toolchain mismatch — not hundreds of downstream test failures the controller must reverse-engineer.
- No remediation rebuilds or replaces shared native dependencies merely to match an accidentally selected runtime.

Coordination fence: FG-555 consumes BD-14's R1–R4 vocabulary and must not grow a second, conflicting runtime-selection mechanism alongside FG-553's. It reuses that vocabulary on the other side of the launch boundary.

### Slice 2 — FG-552: atomic terminal record plus launch wait primitive

> **[SHIPPED 2026-07-18 (FG-552) — atomic records / bounded-retry completion disposition delivered.]** The scope below is DELIVERED on branch `fg552-launch-wait-primitive` (tip `017352a`): atomic exit-record and `meta.json` commits (temp + rename), a reader that never maps an empty/unparseable record to a terminal state, the canonical `waitForLaunchTerminal` primitive with mandatory reconciliation, `forge launch wait <id> [--json]`, and a native-free minimal observer (F33). BD-4, BD-6, and BD-7 are MET. The scope and design narrative below are preserved as the accepted record.

Goal: one canonical, race-free subscription to every launch terminal disposition.

Scope:

- Atomic exit-record commit.
- **Atomic meta-record publication** (BD-4). The meta record is written twice during startup; a reader inside that window sees a running launch as absent.
- **A reader that does not map an empty or unparseable record to a terminal state** (BD-4, BD-7).
- Canonical `waitForLaunchTerminal` library behavior.
- `forge launch wait <id> [--json]`.
- **A minimal observer.** The wait/observer path **must not transitively load `better-sqlite3` or the command registry.** Lazily register commands, or ship the observer as a minimal entry point. Today the CLI eagerly imports every command module, so an observer that needs only `node:fs` drags in the native binding — which means **`forge launch wait` is not an independent observer even after FG-553 lands**, because source isolation does not touch the ABI failure mode. This is a correctness requirement for the observer, not a startup-time optimization.
- **Mandatory reconciliation**, because `owner_gone` and `unknown` create no filesystem artifact for any watcher to see.
- **Degraded or absent tmux as an observation input.** The reader shells out to the `tmux` binary to decide liveness; a missing, wedged, or version-mismatched tmux is an observation condition the design must classify, not an assumption it may make.
- Existing-terminal, normal completion, failure, signal, owner-gone, unknown, transient-unreadable, and cancellation tests.
- Documentation of record-first/advisory semantics.

Non-scope:

- No generic daemon.
- No arbitrary `--on-complete <shell command>` hook in the first slice.
- No campaign-specific event format.
- No phase advancement embedded in the launch wrapper.

### Slice 3 — Durable continuation claim

> **[SHIPPED 2026-07-19 (FG-562, `727e05f`) — the durable continuation-claim PRIMITIVE.]** The scope below is DELIVERED as a primitive on branch `fg562-durable-continuation-claim`: the additive-only `continuations` table (`src/store/schema.ts`), the phase-bound CAS `claimContinuationDispatch`, the `adoptOrClaimDispatch` + deterministic `dispatch_key` receipt for the claim-to-dispatch crash window (F17), `continuationsInDispatch` as the restart-replay collector, and the append-only `continuation_stale_observations` audit. BD-5 is MET **at the primitive** and the F13/F14/F15/F16/F17 crash-window cases are covered at the primitive level. **This slice ships the primitive only** — the physical-dispatch adoption (checking the receipt before spawning) is the consumer's job in Slice 4 (FG-563, orchestrator) / Slice 5 (FG-564, campaign) and remains open. The design narrative below is preserved as the accepted record. See `docs/SCHEMA-CONTRACT.md` for the schema/consumer contract.

Goal: observing a launch terminal state cannot duplicate or lose the next action.

Scope:

- Select/reuse durable controller state.
- Transactional/idempotent claim semantics.
- Dispatch receipt or idempotency mechanism for the claim-to-dispatch crash window.
- Replay after controller restart.
- Duplicate/racing wake tests.

This slice may be split into a generic primitive and consumer adapters if the plan proves that is the smallest reviewable shape.

### Slice 4 — Interactive orchestrator adoption

Goal: replace the FG-425 Monitor-polling and fixed-estimate wakeup happy path.

Scope:

- Orchestrator launches long work only through `forge launch`.
- A disposable session adapter waits through `forge launch wait` and wakes on every terminal disposition.
- On wake, the orchestrator rereads the launch and controller records, claims the next action, and advances.
- `ScheduleWakeup` remains only a low-frequency lost-signal watchdog.
- A watchdog recovery records evidence that the event path was missed.
- Update the actual policy source and propagation path, not only prose in the current checkout.

Propagation surfaces:

- `seeds/orchestrator-template.md` — canonical policy source.
- Marker-managed orchestrator block in `CLAUDE.md`, deterministically regenerated through `forge-dev upgrade` — the block is rendered from the **executing** forge's template, so a checkout edit to the seed above propagates only through the checkout's own entry point; stable `forge upgrade` would re-render it from the promoted release's bytes (FG-577).
- `docs/quick-start.md`.
- `docs/concepts.md`.
- Init/upgrade/template regression tests.
- Any installed host skill that independently prescribes launch waiting.

### Slice 5 — Campaign-runner adoption

> **[Launch boundary landed as Slice 5a — FG-596, `feat/fg596-launchable-single-item-campaign-drive`, 2026-07-20.]** The prerequisite refactor is in: `campaign start`/`resume` now launch one `forge campaign drive-item <cid> <itemId>` per item under `forge launch` and wait via the Slice 2 `forge launch wait` primitive, instead of driving items in-process. The drive-item run is stamped with a deterministic dispatch key + item **attempt generation** so a dead drive-item is left **adoptable**, and the item outcome is derived from durable campaign/run/task/publication state — never the launch disposition (the process-only disposition contract). All three FG-425 constraints below were preserved byte-for-byte inside the launched drive. What remains open for FG-564 (the actual Slice 5 adoption): consuming the Slice 3 continuation claim (`recordContinuation`/`adoptOrClaimDispatch`), controller identity + running-campaign takeover, and dead-drive-item recovery over the adoptable boundary. Slice 5a deliberately shipped none of those. See [Start (sequential execution)](../concepts.md#start-sequential-execution) for the operator-facing boundary.

Goal: campaign phase/item advancement consumes the same completion observation and status vocabulary.

Scope:

- Reuse the Slice 2 wait/subscription primitive.
- Map completion into existing durable campaign/item state and Slice 3 claim semantics.
- Preserve campaign blocker and continue-policy behavior.
- Do not build a second watcher, second terminal classifier, or campaign-only event table unless a documented storage boundary requires it.

This is where a generic continuation primitive meets the real campaign, so the campaign's specific constraints are named here rather than in BD-10. A continuation claim must preserve all three:

- **The `awaiting_recovery` park and its deliberately shared `git_state` blocker.** The blocker is shared on purpose and is cleared only at the centralized ship transition. A continuation claim must not clear it early, per-item, or as a side effect of observing a launch terminal.
- **Cancel is terminal and wins.** Recovery never resurrects a cancelled task. But the operator must still be told when a cancelled task's candidate landed — a cancelled task whose work reached the target is an operator-visible fact, not a silent no-op.
- **The bounded `CONVERGE_LIMIT = 2` resume convergence.** Resume convergence is bounded; a continuation claim may not turn it into an unbounded retry loop by re-entering it on every wake.

### Slice 6 — Cross-layer recovery, observability, and closeout

> **[SHIPPED 2026-07-21 (FG-565) — cross-layer seams verified, operator continuation-evidence surface delivered, temporary guidance retired.]** FG-565 VERIFIES the ownership + continuation model composes as one system; it adds no binding decision, no new continuation feature, and no new recovery path. `forge continuation show/list [--state blocked] [--json]` renders the closeout evidence (Q3–Q7) from durable state alone; the F20 / F23–F24 / F21 seam gaps and docs↔seed parity now have dedicated tests; the FG-542-era prose is reconciled. See `docs/plans/fg565-closeout-evidence-ledger.md` and the 2026-07-21 revision-log entry. The scope below is preserved as the accepted record.

Goal: prove the ownership and continuation model as one system, then retire temporary guidance.

Scope:

- End-to-end fault matrix below.
- Delivery/claim/watchdog recovery evidence exposed through an operator surface.
- Clear retirement or fallback status for the hand-built Monitor workaround.
- Update FG-542-era prose that currently says ScheduleWakeup owns ordinary delays. *(Done 2026-07-21, FG-565: grep confirms no installed policy surface — `CLAUDE.md`, `seeds/orchestrator-template.md`, `docs/quick-start.md`, `docs/concepts.md`, `docs/SCHEMA-CONTRACT.md` — states ScheduleWakeup owns ordinary delays; every one describes it as a fixed health-bound lost-signal watchdog only (BD-9). No residual FG-542-era "owns ordinary delays" prose remains anywhere.)*
- Final documentation-maintainer consistency pass.
- Focused review against this document before campaign closeout.

## Falsification and acceptance matrix

Each new regression must be observed failing against its relevant pre-fix baseline before the implementation is accepted. A test that cannot go red does not prove the defect was covered.

| Case | Fault/interleaving | Required result |
|---|---|---|
| F1 | Launch finishes before waiter starts | Wait returns terminal result immediately |
| F2 | Launch finishes between first read and watcher installation | Post-install reread observes it; no hang |
| F3 | Exit record filesystem event is missed | Internal reconciliation or watchdog recovers from durable record |
| F4 | Exit record writer is interrupted during write | No partial terminal JSON is observable; status remains evidence-honest. A reader observing an empty or unparseable record must **not** report a terminal state — the write window is transient, not `unknown` |
| F5 | Command exits 0 | Controller wakes and reads `exited_ok` |
| F6 | Command exits ordinary nonzero | Controller wakes and reads `exited_error`; failure does not look running |
| F7 | Command is OS-signalled | Controller wakes with signal evidence and no sender attribution |
| F8 | Command deliberately returns 143 | Remains numeric exit with no invented signal |
| F9 | Wrapper/pane dies before exit record | Wait detects `owner_gone`; work result is not invented |
| F10 | Host/session restarts with no exit record or owner | Known launch reads `unknown`; controller surfaces recovery/blocker policy |
| F11 | Record is transiently unreadable | Bounded retry; no premature terminal failure |
| F12 | Listener/Monitor is swept | tmux command and Docker agent continue; watchdog/restart can reattach |
| F13 | Completion event delivered twice | One continuation claim and one next-phase dispatch |
| F14 | Two controllers race on one completion | One wins durable claim; loser observes claimed/advanced state |
| F15 | Controller dies after observation, before claim | Recovery claims and advances |
| F16 | Controller dies after claim, before dispatch | Claim is recoverable/visible; transition is not lost |
| F17 | Controller dies after dispatch, before receipt update | Recovery adopts original dispatch; no duplicate agent/run |
| F18 | Watchdog fires after normal event already advanced | No duplicate action; watchdog records no false lost-signal claim |
| F19 | Happy-path job runs longer than any estimate | No model wake until completion; no fairness/timeout inference from duration |
| F20 | Interactive session disappears | tmux command continues; detached container continues if Forge watcher also dies |
| F21 | Campaign consumes completion | A continuation claim **preserves** the campaign's real invariants — not merely that "the same classifier" is used: the shared `git_state` blocker survives until the centralized ship transition; a cancelled task is never resurrected, yet a landed candidate for a cancelled task is still surfaced to the operator; `CONVERGE_LIMIT = 2` remains bounded across wakes |
| F22 | Operator sends no messages | Routine chain reaches its next decision/blocker without operator scheduling |
| F23 | Agent makes development source syntactically invalid | Stable machine-wide Forge state readers and launch observer still work |
| F24 | Agent creates a transient missing-export/cross-file inconsistency | Stable Forge commands in this and unrelated projects still work |
| F25 | Explicit live-source command runs against broken source | Development command fails locally without changing the stable runtime |
| F26 | Validated runtime promotion succeeds | New commands atomically use the recorded promoted version; no mixed tree is visible. The **entire executable/runtime closure** moves as one unit — entry point, source, `node_modules`, native bindings, interpreter identity. A promotion that swaps a subset is a failure, not a partial success |
| F27 | Promotion is interrupted | Previous stable runtime remains selected and usable; no partially promoted closure is reachable |
| F28 | Promotion occurs with an in-flight launch | Runtime identity stays diagnosable and store/schema compatibility follows the BD-15 policy |
| T9 | Promotion lands while a process is already running (dynamic `import()`, lazy require, open file handle) | **Open acceptance case.** The behavior is not yet established — the test must determine whether a running process is immune or exposed. Neither may be assumed by the design |
| F29 | Control plane is invoked from a shell whose PATH resolves a different interpreter | The control plane runs. Availability does not depend on the caller's ambient environment (BD-14). A clean, honest preflight failure **does not pass this row** — a command that fails truthfully is still a command that did not run |
| F30 | A launch is submitted and later inspected | R1–R4 are each either durably captured, derived, or explicitly recorded as unknowable. Argv alone does not satisfy R3; the exit recorder's `process.execPath` does not satisfy R1 or R4 |
| F31 | Forge runs under an interpreter whose ABI the native bindings were not built for | Refused by a **bounded ABI assertion**, not a minimum-version floor. A too-new major with an incompatible ABI must be rejected, not admitted |
| F32 | A reader arrives during meta-record publication | A running launch never reads as absent or as "no such launch" |
| F33 | Observer runs where `better-sqlite3` cannot load | `forge launch wait` still observes and reports terminal dispositions — the observer path does not transitively load the native binding or the command registry |
| F34 | Launch reaches `owner_gone` or `unknown`, producing no filesystem artifact | Reconciliation observes both dispositions. A watch-only design must be observed failing this row |
| F35 | Two Forge versions open the shared store concurrently (long launch under version A, new command under version B) | The BD-15 policy holds; no destructive migration runs beneath an in-flight process of another version |

## Operator-visible evidence

The final design must make these questions answerable without transcript archaeology:

- Which launch completed, and what does its durable record prove?
- Was a completion observation delivered normally or recovered by watchdog/replay?
- Which controller/consumer claimed the continuation?
- What next action was selected?
- Was a run/task dispatched, and what durable ID proves it?
- Did a duplicate event arrive, and was it ignored safely?
- Is continuation blocked, and what explicit operator action is required?

Exact event/table names are an **Open question**. The evidence must live under Forge-owned durable state, not only in a Claude transcript or Monitor output.

## Non-goals and fences

- Do not redesign FG-425's integration publisher, lane, mutex, recovery, or worktrees.
- Do not move validation outside FG-425's lane turn.
- Do not add publisher process supervision, PID probing, signalling, nonce, zombie classification, or reaping.
- Do not reopen tmux ownership (FG-535) or detached Docker ownership (FG-536) without a failing test.
- Do not make the launch wrapper execute an opaque arbitrary continuation command as the source of workflow truth.
- Do not treat external SMS/ntfy delivery as the controller event bus.
- Do not infer completion from process-name matching.
- Do not accept a permanently live-linked mutable source tree for machine-wide `forge` and call the blast radius documented.
- Do not remove the explicit live-source development loop; isolate it from the stable command instead.
- Do not wake a model on a fixed estimated interval in the normal path.
- Do not build separate completion mechanisms for the orchestrator and campaign runner.
- Do not combine this campaign with unrelated SQLite, publication, CI-duplication, or backlog work merely because it also involves concurrency.
- Do not collapse all slices into one broad implementation PR. The document and campaign are batched; code remains reviewably sliced.

## Open questions to settle before implementation planning completes

### OQ-1 — Durable continuation storage

Can existing run/task/campaign rows represent every claim and crash window, or is a small generic continuation/receipt table required? The answer must cover the ad hoc interactive chain, not only campaigns.

### OQ-2 — Session adapter

What supported mechanism converts `forge launch wait` completion into a session wake when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` disables ordinary Bash background dispatch? The current Monitor tool is evidence that a disposable adapter exists. The plan must name the production adapter and its restart behavior rather than assuming `<task-notification>` can be emitted externally.

### OQ-3 — Watchdog owner and interval

Which durable component schedules lost-signal recovery, and how is recovery evidence recorded? The interval should be a health bound, not a guessed task duration.

### OQ-4 — Consumer cancellation

How does an operator intentionally cancel a waiter or continuation without cancelling the tmux-owned work? Cancellation of observation and cancellation of work must remain distinct commands and audit events.

### OQ-5 — Host reboot semantics

The current launch vocabulary reports no exit record plus no tmux session as `unknown`. Decide what continuation policy is safe after reboot, including whether Docker/reconcile evidence can refine the result for Forge commands that dispatched agents.

### OQ-6 — Stable runtime packaging and promotion

**This is the home of mechanism selection.** BD-14 states the required property and evidence but deliberately selects no mechanism; BD-13 requires source isolation; BD-15 requires a store-compatibility policy. Choosing *how* — absolute shebang, wrapper script, pinned snapshot, vendored interpreter, container, release directory plus atomic `current` symlink, or an equivalent — is settled here.

Choose the smallest mechanism that provides: an isolated last-known-good runtime; a control plane whose availability does not depend on the caller's environment; the full atomic executable/runtime closure (entry point, source, `node_modules`, native bindings, interpreter) promoted as one unit; explicit live-source development; atomic promote/rollback; R1–R4 runtime evidence; a bounded ABI assertion; and the BD-15 policy for in-flight processes sharing Forge's database. A compiled build is one option, not a requirement; a pinned tsx snapshot remains consistent with the no-build decision.

A caller-applied PATH pin is **not** a candidate mechanism. It is containment an operator can apply to a single shell; it is not a property of the system, and it does not survive the next caller.

## Campaign closeout gate

The initiative is complete only when all of the following are true:

- FG-551 test-environment parity is resolved without changing work ownership.
- FG-553 closes **both** axes: machine-wide mutable-source coupling is eliminated (stable commands remain usable while development source is broken) **and** control-plane availability no longer depends on the caller's environment. Neither axis alone closes the ticket.
- Stable-runtime promotion, rollback, runtime identity (R1–R4), and in-flight/store compatibility are proven.
- The launch exit record **and meta record** are atomic and remain authoritative.
- A controller-facing wait/subscription covers every terminal disposition and closes the subscribe race.
- Lost and duplicate notifications are proven safe.
- The orchestrator has durable, idempotent continuation and no routine operator-message gate.
- The campaign runner consumes the same primitive.
- ScheduleWakeup is documented and used only as a lost-signal watchdog.
- The hand-built FG-425 Monitor polling workaround is retired or explicitly retained only as a fallback adapter.
- Canonical orchestrator seed, generated project block, docs, and installed surfaces agree.
- Every falsification test was observed red against the appropriate baseline and green after its slice.
- Focused tests pass after each slice; full and extended suites pass once at campaign closeout.
- A final reviewer maps evidence to every binding decision and matrix row rather than approving from green CI alone.

## Revision log

### 2026-07-21 — FG-565 Slice-6 closeout SHIPPED (cross-layer seams verified, operator evidence surface, temporary guidance retired)

- **FG-565 (Slice 6 — the campaign CLOSEOUT slice) shipped.** It VERIFIES the durable-continuation model composes
  as one system and reconciles the temporary guidance; it adds no binding decision, no new continuation feature, no
  new recovery path, and reopens no upstream decision. All fifteen binding decisions (BD-1..BD-15) remain MET and the
  falsification matrix (F1–F35 + T9) is proven with RED provenance per
  `docs/plans/fg565-closeout-evidence-ledger.md`.
- **Operator-visible evidence surface (G1).** `forge continuation show <id>` / `forge continuation list [--state
  blocked]` (both `--json`) now render the continuation closeout evidence — `claim_owner` + `consumer_kind` (Q3),
  `next_action` (Q4), dispatched run/task ids (Q5), stale/duplicate observations from
  `continuation_stale_observations` (Q6), and blocked state + the required operator action (Q7) — from durable state
  alone (single-store projection, BD-3), mirroring `forge lost-signals`. No schema change, no write path. This closes
  the Operator-visible-evidence questions Q3–Q7 (previously answerable only for watchdog recoveries).
- **Cross-layer seam coverage closed (G2/G3/G4).** The F20 interactive-session-disappears seam (tmux-owned command
  and detached container survive even when the Forge watcher also dies), the F23/F24 broken-dev-source arms (stable
  machine-wide readers AND the launch observer keep working under a broken/missing-export dev source, in this project
  AND an unrelated project dir), and the F21 cancelled-candidate-surfaced assertion (a landed candidate for a
  cancelled task is an operator-visible standing fact, distinct from the fg484 not-resurrected CAS assertion) now
  each have a dedicated test, observed red against the appropriate injection/mutant baseline.
- **Docs↔seed parity is now TESTED, not assumed (G5).** A parity test asserts `docs/quick-start.md` and
  `docs/concepts.md` agree with `seeds/orchestrator-template.md` on the completion-driven launch-wait policy and the
  `ScheduleWakeup`-watchdog-only rule (BD-9) — claim-agreement, not byte-parity.
- **Temporary guidance retired (G6).** Grep confirms no installed policy surface (`CLAUDE.md`,
  `seeds/orchestrator-template.md`, `docs/quick-start.md`, `docs/concepts.md`, `docs/SCHEMA-CONTRACT.md`) still says
  `ScheduleWakeup` owns ordinary delays — every one describes it as a fixed health-bound lost-signal watchdog only.
  The Slice 6 scope bullet and the Problem-section FG-425-workaround paragraph are annotated as the accepted
  historical record, not current behavior.
- **No normative change.** This is a current-state / non-normative reconciliation of the same class as the
  FG-562/FG-552 entries below: no binding decision, story order, consumer contract, or failure semantic moves, and
  the accepted contract SHA `e6fd56b` stands. Only current-state status labels and closeout evidence are updated.

### 2026-07-19 — FG-562 Slice-3 durable continuation-claim PRIMITIVE SHIPPED (BD-5 MET at the primitive)

- **BD-5 (delivery at-least-once; advancement exactly-once-claimed) flipped from UNMET to MET at the primitive.**
  FG-562 (branch `fg562-durable-continuation-claim`, tip `727e05f`) shipped the durable continuation-claim
  primitive: the additive-only `continuations` table (`CREATE TABLE IF NOT EXISTS`, BD-15) plus the phase-bound
  CAS `claimContinuationDispatch` in `src/store/continuations.ts`. The claim grants the single
  `awaiting_completion|ready -> dispatching` transition in one `BEGIN IMMEDIATE` UPDATE whose WHERE binds
  `source_launch_id + consumer_kind + current_phase + next_action + expected prior state + lease`, so a delayed
  completion from launch A can never advance a newer phase B (uniqueness alone would not stop that).
- **F17 adopt-not-duplicate is a real function, not a comment.** `adoptOrClaimDispatch(req)` derives the
  deterministic `dispatch_key` (written at claim time, before dispatch) and returns `disposition:'adopt'` on an
  existing dispatch (the consumer adopts the already-created run), `'claim'` on a fresh `ready -> dispatching`
  grant, or `'unclaimable'` otherwise. `continuationsInDispatch({consumerKind?})` is the restart-replay collector
  returning the crash-window (`dispatching`, un-advanced) slots to resume.
- **BD-3 evidence authority + durable stale-observation audit.** `observeLaunchStatus` derives terminality
  through the one canonical `isTerminalStatus` classifier (never a caller assertion), so only a real terminal
  `LaunchStatus.state` — including the reconciled `owner_gone`/`unknown` with no exit record — can promote a slot
  to `ready`. A delayed, launch-mismatched observation is appended to the additive `continuation_stale_observations`
  audit table (observed-recorded-and-ignored) rather than silently discarded.
- **PRIMITIVE only, not end-to-end adoption.** This slice ships the mechanism; the physical-dispatch adoption
  (checking the receipt before spawning an agent/run) is the CONSUMER's job — FG-563 (orchestrator, Slice 4) and
  FG-564 (campaign, Slice 5) — and remains open. BD-5 is MET at the primitive, NOT fully end-to-end adopted.
- **No normative change.** This is a current-state reconciliation of the same class as the FG-552 entry below:
  the accepted binding decisions (BD-5's decision body and the rest), the Slice 3 design narrative, and the
  F-row matrix are untouched. FG-563/FG-564/FG-565 and the remaining open slices stay open. Only the MET/UNMET
  status labels and the stale "no idempotent continuation claim exists today" current-state descriptions move.
  The schema/consumer contract is recorded in `docs/SCHEMA-CONTRACT.md`.

### 2026-07-18 — FG-552 Slice-2 atomic records + launch wait primitive SHIPPED (BD-4/BD-7 MET)

- **BD-4 (record before notify) and BD-7 (failure is a completion disposition) flipped from UNMET to MET.**
  FG-552 (branch `fg552-launch-wait-primitive`, tip `017352a`) shipped atomic exit-record and `meta.json`
  commits (sibling temp + `renameSync`) in `src/v2/launch.ts`, so a consumer never observes partially-written
  JSON as a terminal result nor a running launch as "no such launch."
- **The reader no longer maps an empty exit file straight to terminal `unknown`.** `readLaunch` treats only a
  parseable exit record as authoritative; an empty, unreadable, or invalid record is not terminal on a single
  read (F11) and falls through to owner evidence under bounded retry. A *persistently* unreadable/invalid
  record wakes to a terminal disposition (`owner_gone`/`unknown`) after a bounded 60s retry
  (`DEFAULT_INVALID_BOUND_MS`) plus independent owner evidence, rather than blocking forever.
- **The canonical `waitForLaunchTerminal` primitive wakes for every terminal disposition** (six dispositions +
  the waiter's own timeout/cancel outcomes). BD-6 (subscribe race) was reconciled earlier in this slice; see
  BD-6 above.
- **No normative change.** This is a current-state reconciliation of the same class as the FG-555 entry below:
  the accepted binding decisions (BD-4/BD-6/BD-7 and the rest), the Slice 2 design narrative, and the F-row
  matrix are untouched. Only the MET/UNMET status labels and the stale "current behavior is X" descriptions
  move. FG-562/FG-563/FG-564/FG-565 and the remaining open slices stay open; the "FG-552 … stay open" phrasing
  in the 2026-07-18 FG-555 entry below described the pre-FG-552 state and is superseded by this entry.

### 2026-07-18 — FG-555 launched-workload provenance + launch-environment contract SHIPPED (`cd8a036`)

- **BD-14's R3/R4 "Currently recorded?" flipped from No to Yes.** FG-555 shipped the recorder's R3/R4
  provenance for the launched workload: R3 is the resolved top-level executable (`argv[0]`), recorded at spawn
  time *before* the spawn (so it survives a failed spawn); R4 is whether a later runtime resolution is even
  knowable at launch time, recorded `unknowable` for anything that resolves Node only *after* `argv[0]` is
  spawned (a shell, a script, or a launcher such as `npm`/`npx`/a `#!/usr/bin/env node` binary) and `not
  applicable` only when `argv[0]` is itself a terminal `node`/`nodejs`. Old, pre-FG-555 launches render "not
  recorded", never manufactured. The operator surfaces (`forge launch show`'s `workload:`/`nested:` lines and
  `--json`'s `workload` object) render them; see `docs/concepts.md` "Durable launch" and `docs/quick-start.md`
  §13.
- **The explicit environment contract for Forge-owned unattended callers shipped as `--require-control-toolchain`
  (pinned-PATH trust).** It pins the workload's `PATH` to forge's control-runtime node dir (control node first)
  and decides *before executing* whether to run or refuse: a name-resolved `forge`/`npm`/`npx` (trusted under
  the pin) or a `node`/`nodejs` whose probed ABI matches is allowed; a PATH-mutating assignment, a login or
  non-login shell, a wrong-ABI interpreter, an explicit-path control tool, a script, or an unknown wrapper is
  refused with one named, actionable message. The gate only probes the ABI; it never rebuilds a native
  dependency. **Honest residual (operator-decided Option A):** a name-resolved `npm`/`npx` is trusted to START
  under the pinned control node, but the contract does **not** deep-verify `npm run` lifecycle-script node
  resolution — `npm` prepends the project's `node_modules/.bin` to the lifecycle PATH, so a project-provided
  `node` there could resolve a different ABI *after* the gate. That later resolution is recorded R4
  `unknowable`, not guaranteed; a strict guarantee requires launching `node`/`forge` directly rather than via
  an `npm run` lifecycle script.
- **No normative change.** This is a current-state reconciliation of the same class as the FG-569/FG-573 entry
  below: the accepted binding decisions (BD-14 and the rest), the Slice 1b design narrative, the candidate
  policies, the slices, and the F-row matrix are untouched. FG-552/FG-562/FG-563 and the remaining FG-572
  installed-surface work stay open. Only current-state evidence moves.

### 2026-07-17 — dashboard availability from a promoted release satisfied (FG-580, `bc9286f`)

- **The open dashboard-availability condition is now MET.** FG-580 (FG-553 Child 5, operator Option A) bundles
  the dashboard into the promoted release as a mandatory asset and retires the FG-569 release-mode refusal of
  `forge dashboard`: the command now runs from a promoted release (resolved from `assetRoot()`, never the dev
  checkout; a torn release still fails named + nonzero), and the release manifest's `selfContainedFor` is
  always `control-plane+dashboard`. The dashboard also boots offline — its client libs (preact/htm/marked) are
  vendored as first-party files and the server sends `Content-Security-Policy: script-src 'self'` (this offline/
  CDN-vendoring behavior was advisor-generated hardening, NOT an operator requirement — the operator approved
  release *bundling* only; described here only because the code landed in `b6c6542`) — though its
  provider/data APIs may still need network. This satisfies the "`forge dashboard` unavailable from a promoted
  release" gap the closeout tracked under FG-572; the broader FG-572 installed-surface work is unaffected.
- **No normative change.** This is a current-state reconciliation of the same class as the FG-568/FG-573
  entries below: no binding decision, story order, consumer contract, or failure semantics moves, and the
  accepted contract SHA stands. Only current-state evidence is updated.

### 2026-07-17 — Slice 4 propagation-path mechanics reconciled to the execution-mode split (FG-577)

- **The Slice 4 propagation surface "Marker-managed orchestrator block in `CLAUDE.md`, deterministically
  regenerated through `forge upgrade`" is corrected to `forge-dev upgrade`.** FG-577 resolves every
  release-owned asset — the seed installer's source and the orchestrator template alike — from the tree the
  running forge executes from (`assetRoot()`, `src/v2/asset-root.ts`). The stable `forge` therefore re-renders
  the block from the **promoted release's** bundled template, not from a `seeds/orchestrator-template.md` edit
  sitting in the checkout. Propagating that edit is `forge-dev upgrade`, which executes from the checkout.
  Nothing ambient (`FORGE_REPO_DIR`, `--forge-repo`) redirects the install source; those name only the
  checkout that dev-advancement targets.
- **No normative change.** This is a current-state/mechanics reconciliation of the same class as the FG-568 and
  FG-573 entries below: no binding decision, story order, consumer contract, or failure semantics moves, and no
  new plan hash is required. Slice 4's scope, the propagation requirement itself ("update the actual policy
  source and propagation path, not only prose in the current checkout"), the slices, and the F-row matrix are
  untouched — only the named command that performs the propagation is corrected to the shipped behavior.

### 2026-07-17 — promotion landed; F29 closed on the live path; threat boundary recorded (FG-571, `2f80496`)

- **FG-571 (FG-553 Child 4) LANDED as `2f80496` (PR #124).** The slice is no longer inert: the `current`
  pointer, atomic promote/rollback, the near-frozen `/bin/sh` PATH shim, a content-addressed immutable
  interpreter store, the bounded env-sanitization contract, fail-closed release identity, and the stable/dev
  split (`bin/forge-dev` is new — before it the machine-wide `forge` and the live-source entry were the SAME
  npm-link'd artifact).
- **F29 is CLOSED on the live path.** A promoted release runs under its own pinned absolute interpreter with
  ambient Node injection neutralized, proven by execution — including the mandatory mutant showing that
  pinning PATH while leaving `NODE_OPTIONS` live still executes injected code, invisibly (forge still exits 0).
  An absolute pinned interpreter is necessary but NOT sufficient.
- **Mechanism corrections forced by four read-only red-security audits** (fourteen confirmed HIGH; eleven
  closed with executed exploit-proving mutants): the shim now reads a **forge-authored canonical execution
  descriptor** inside the immutable unit and never parses the release manifest (a hand-rolled POSIX-sh reader
  diverged from `JSON.parse` on duplicate keys — a candidate that PASSED validation exec'd an attacker's
  interpreter); the interpreter store is **content-addressed on the full SHA-256** (`process.version` + ABI
  never pinned content); and **selection evidence is the bytes, never the pathname** (a path-equality
  shortcut was being treated as provenance).
- **THREAT BOUNDARY recorded (operator decision).** Protected: untrusted candidates, candidate
  symlinks/traversal/parser ambiguity, malformed manifests, hostile ambient caller environment, crashes and
  interrupted publication, concurrent supported Forge operations. **Honest limit:** a principal able to
  arbitrarily rewrite `$FORGE_HOME` can subvert Forge and the surrounding user account — that principal is
  the operator's own UID, which already owns the shell startup files, the checkout, the shim and the
  validator. `chmod`/read-only-at-rest is an operational **accident barrier, not a security boundary against
  its owner**. Stronger hostile-host protection would need a separate trust domain (another OS principal,
  root-owned storage, hardware-backed signing) and is **not FG-571 scope**. Full statement: the FG-571 ticket
  and the plan's §4b.
- **Still open:** FG-572 (installed-surface compatibility — `forge dashboard` refuses in release mode until
  it is decided) and FG-555 (R3/R4). *(Superseded 2026-07-18: FG-555's R3/R4 launched-workload provenance +
  the `--require-control-toolchain` contract SHIPPED as `cd8a036`; see the 2026-07-18 entry above. FG-572
  remains open.)* *(Superseded 2026-07-17: the `forge dashboard` release-mode refusal is
  retired and the dashboard is bundled into the release as of FG-580, `bc9286f`; see the 2026-07-17 dashboard
  entry above. The rest of FG-572 remains open.)* **No normative change:** BD-13/BD-14/BD-15, the candidate
  policies, the slices and the F-row matrix are untouched; only current-state evidence moves.

### 2026-07-15 — current-state map reconciled to landed R1/R2 + exec entry (FG-569, `1b11f25`; FG-573)

- **BD-14's R1/R2 "Currently recorded?" flipped from No to Yes.** FG-569 shipped the single-process `/bin/sh` exec-not-spawn entry (R1 = `process.execPath` is self-evidencing; captured at submission as `meta.json`'s `control` record and surfaced as `launch show`'s `control:` line) and the independent exit-recorder capture of R2 (`runtime.json`). Old, pre-FG-569 launches render "not recorded", never manufactured. **R3/R4 stay No/unknowable** (FG-555, open). *(Superseded 2026-07-18: FG-555 shipped as `cd8a036` — R3/R4 are now recorded at spawn time; see the 2026-07-18 entry above.)*
- **Current system map:** the R1 executable row now distinguishes the shipped exec entry + R1/R2 recording from the still-open source-isolation/promotion axis (FG-571). The header records the landed Slice-1 children (FG-551/567/568/569) and the open ones (FG-570/571/572, FG-555). *(Superseded 2026-07-16: FG-570 landed as `5044c5d`; the open children are now FG-571/572 + FG-555.)*
- **Slice 1 section** carries a landed-so-far note: children 0–2 are inert (no promotion/`current`/PATH change); children 3–5 remain open, so F29 (control-plane availability under a hostile/node-free environment) is not yet closed on the live path. *(Superseded 2026-07-17: FG-570 landed as `5044c5d` and **FG-571 landed as `2f80496`**, so the slice is no longer inert and **F29 IS closed on the live path**; only FG-572 + FG-555 remain open. See the 2026-07-17 entry.)*
- **Superseded phrasing.** The "no runtime identity is recorded today" claim in the 2026-07-14 audit-closure entry below described the pre-FG-569 state and is superseded by this reconciliation (that entry now carries an inline superseded marker pointing here). R1/R2 are recorded; R3/R4 are not.
- **No normative change.** BD-13/BD-14/BD-15 decisions, the candidate policies, the slices, and the F-row matrix (acceptance criteria, tense-neutral) are untouched. Only the current-state/provenance evidence is updated to what has landed.

### 2026-07-15 — BD-15 premise reconciled to shipped behavior (FG-568, `275ac63`)

- **BD-15's premise is now reconciled to the shipped store evolution.** FG-568 (FG-553 Child 1, `275ac63`) made the ordinary open path (`applyMigrations`) **additive-only**: every open — logically read-only callers' first opens included — runs only additive, backward-compatible migrations and no destructive DDL. The destructive `DROP COLUMN` that previously ran on every open was moved OFF that path into `runDestructiveConvergenceMigration`, invoked explicitly via `forge store converge` (operator-invoked, quiesce-gated, one-way boundary).
- The "migrations run **unconditionally on every open** … including a **destructive `DROP COLUMN`**" phrasing in the BD-15 body and in the two 2026-07-14 entries below (the "BD-15 premise correction" and the "every writable open … destructive `DROP COLUMN`" line in the audit-correction pass) described the pre-FG-568 code and is **superseded by this reconciliation**.
- **BD-15's decision is unchanged** — additive-only was always the decision, and it is now implemented. Only the premise/evidence is updated; F35, the candidate policies, and every other binding decision, slice, and matrix row are untouched.

### 2026-07-14 — BD-15 premise correction

- **BD-15's premise corrected from "every writable open" to "every open."** The code is stronger and worse than the accepted revision (`e6fd56b`) stated: a process's *first* store open runs the migrations — including the destructive `DROP COLUMN` — even when the caller is logically read-only, because `getDb({ readOnly: true })` bootstraps a writable handle when none exists in-process. This **strengthens** BD-15's evidence; it does not contradict it. BD-15's decision, its candidate policies, F35, and every other binding decision, slice, and matrix row are unchanged. The "every writable open" phrasing in the C1–C8 entry below is superseded by this correction.

### 2026-07-14 — acceptance-review corrections (D1–D4)

- Bounded correction set from the operator's acceptance review. No redesign, no re-audit, no ticket allocation.
- **D1:** added **FG-555** to the primary backlog, the current system map, and the decomposition as **Slice 1b** — a distinct slice coordinated with FG-553/BD-14, not folded into it. BD-14 protects the Forge control runtime (R1); FG-555 governs the launched workload's environment (R3/R4). A stable control runtime can still launch a caller-supplied `bash -lc` whose login shell resolves an incompatible Node, with BD-14 fully satisfied. The slice requires exact argv preservation (Forge does not insert a shell — an earlier false claim that must not return), an explicit environment contract for Forge-owned unattended callers, and honest R3/R4 provenance including R4's possible inherent unknowability.
- **D2:** narrowed **BD-4**'s matching-terminal-record requirement to *exit-record-driven completion events*. Reconciled `owner_gone` and `unknown` produce no filesystem artifact and rely on durable metadata plus independent owner evidence under their own failure/blocker policy; they must never fabricate an exit record. BD-4's intent is unchanged — a completion signal claiming an exit that never happened still must not advance a phase.
- **D3:** the executive-outcome diagram no longer says Forge must *record* all of R1–R4; it must **account durably** for them — capture, derive, or explicitly declare unknowable — matching BD-14, which allows R4 to be inherently unknowable.
- **D4:** removed stale pre-FG-425 temporal framing (FG-425 has landed and merged) and updated the header status from "awaits operator acceptance" to accepted, pending decomposition.
- No other normative content changed. BD-13/BD-14/BD-15, BD-5/6/7/10/11, the C1–C8 corrections, and the F-row matrix are untouched.
- **System-map reconciliation:** the FG-551 row (tmux availability in the agent test image) moved from `Active gap` to `Landed (7f6091b)`. Slice 0 merged; the `agent-dev-worker` image installs tmux and guards it with a final-RUN smoke assertion, and the FG-535 launch tier runs clean inside it. Factual status only — no normative content changed.

### 2026-07-14 — audit correction pass (C1–C8)

- Applied a bounded, pre-agreed correction set from the FG-552 audit. No re-audit, no redesign.
- Added **BD-14**, an implementation-neutral control-plane runtime-provenance prerequisite to BD-13. It names four distinct runtimes (R1–R4), requires each to be captured, derived, or declared unknowable, and requires a bounded ABI assertion rather than a version floor. Mechanism selection stays in OQ-6.
- Scoped **BD-13**: it is a valid, unmet, and *insufficient* source-isolation decision. Its predicate is source mutation; the observed control-plane outage occurs with source fully valid, so BD-13 is not falsified by it — it does not reach it. Slice 1's goal now states FG-553 is not closable on the source axis alone.
- Extended **BD-4** to the meta record (identical non-atomic defect) and fixed the reader contradiction against BD-7: an empty or unparseable record is not terminal. BD-4 is marked UNMET, owned by Slice 2.
- **Slice 2**: the observer must be minimal (no transitive `better-sqlite3` or command-registry load), reconciliation is mandatory rather than a fallback (`owner_gone` and `unknown` produce no filesystem artifact), and degraded/absent tmux is an observation input.
- **Slice 1**: defined the atomic executable/runtime closure, and inventoried externally installed surfaces that need a version-compatibility policy rather than atomic swap.
- Added **BD-15**, a shared-store compatibility decision — concurrent Forge versions share one SQLite while migrations run unconditionally on every writable open and include a destructive `DROP COLUMN`.
- Kept **BD-10** generic; moved FG-425 specifics (the `awaiting_recovery` park and its shared `git_state` blocker, cancel-is-terminal, bounded `CONVERGE_LIMIT = 2`) to Slice 5 and F21. Noted that the campaign runner has zero coupling to launch records today, so "one primitive, two consumers" is a goal, not a preserved property.
- Extended the acceptance matrix with **F29–F35** and the open **T9** in-flight/lazy-import case; strengthened F4, F21, F26–F28.
- Restored ascending physical order of the binding decisions (BD-12 → BD-13 → BD-14 → BD-15) after BD-14 was initially placed before BD-13. Decision IDs and bodies are unchanged; an explicit dependency statement before BD-13 now carries the prerequisite relationship that the ordering previously implied.
- Host evidence cited in this pass (P1–P5, `~/.forge` copies) is operator-supplied and was not reproduced in the authoring environment.
- Closure fixes from the review of this pass: the executive-outcome diagram is now explicitly target-state and its runtime annotation reflects BD-14's R1–R4 table (no runtime identity was recorded as of this 2026-07-14 pass — **superseded: R1 and R2 are now recorded per FG-569; see the 2026-07-15 "current-state map reconciled to landed R1/R2 + exec entry" entry above**); **BD-5, BD-6, BD-7, BD-10, and BD-11** now carry an explicit `Status: UNMET` declaration in BD-4's form. Status labels only — no normative content changed.

### 2026-07-13 — FG-553 control-plane isolation added

- Recorded the live FG-425 AC5 incident in which a half-written cross-file edit made every npm-linked Forge command fail at module load.
- Added control-plane runtime isolation as BD-13 and as a prerequisite campaign slice before FG-552.
- Preserved explicit live-source iteration while making stable, validated promotion the machine-wide default.
- Added falsification cases for broken development source, atomic promotion/rollback, runtime identity, and in-flight compatibility.

### 2026-07-13 — initial draft

- Consolidated FG-535/536/542 ownership, FG-551 test parity, and FG-552 completion notification.
- Selected a blocking `forge launch wait` subscription as the first controller-facing primitive.
- Separated advisory delivery from durable continuation claiming.
- Added explicit consumer crash windows, campaign reuse, propagation surfaces, and falsification matrix.
- Kept transport/storage questions open only where the current repository does not yet supply a proven primitive.
