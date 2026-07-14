---
id: FG-553
type: story
status: active
title: "forge-on-forge: an agent mid-writing forge's own source breaks the live CLI machine-wide, taking down the orchestrator's control plane"
created: 2026-07-14
---

## Problem

On this host `forge` is npm-linked to the repo and runs `tsx src/cli/index.ts` — there is no build step, so the working tree IS the live binary. When an agent implements a change **to forge itself**, every `forge` command on the machine executes the agent's half-written source.

Hit live 2026-07-13 during the FG-425 AC5 run. The engineer was mid-write on a cross-surface change; `src/cli/commands/retry.ts` had already gained `import { PublishedTaskRetryError } from '../../v2/retry.js'` while `src/v2/retry.ts` had not yet been written with the export. Every forge command on the host died at module load:

```
SyntaxError: The requested module '../../v2/retry.js' does not provide an export named 'PublishedTaskRetryError'
```

`forge launch show`, `forge status`, `forge backlog` — all of them. The orchestrator's **control plane went down because of the work it was supervising.** It recovered by itself seconds later when the agent finished writing the other half, so the damage was bounded — but the failure mode is not.

Two distinct harms:

1. **The controller cannot observe its own run.** The orchestrator polls durable state via the forge CLI (`forge launch show`, `forge status`). Those commands are exactly what breaks. A watcher whose health is coupled to the work it watches is not a watcher. (Worked around for FG-425 by monitoring the tmux pane's dead-status directly — CLI-free — but every controller would have to know to do that.)
2. **Blast radius is machine-wide, not run-scoped.** Any OTHER forge session, on any other project, running any command during that window also crashes. Same shape as the shared-DB-migration hazard, but triggered by an ordinary uncommitted edit rather than a schema change.

This is a forge-on-forge hazard specifically: agents editing forge are now the process default (the old "implement directly, agents corrupt the host" rule is dead), so this window opens on every forge-on-forge implementation run.

## Prior art / relationship

- The dependency shadow volume (DEC-019) solved the *native-binary* half of forge-on-forge contamination. This is the *source* half, and it is unsolved.
- `forge runs from linked source` is already a known operational fact (memory: project_forge_runs_from_linked_source) — but only its DB-migration consequence was ever mitigated. The "the CLI is unrunnable mid-edit" consequence was not.

## Slice 1 of the FG-561 campaign — SETTLED BY THE ACCEPTED PRD

**Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (Slice 1)

## ⚠️ FG-553 IS A SLICE-LEVEL PARENT — DO NOT DISPATCH IT AS ONE IMPLEMENTATION STORY

The scope below spans packaging/promotion, ABI enforcement, launch provenance, installed-surface
compatibility, and SQLite version policy — **several subsystems.** It cannot responsibly land as one
implementation PR, and no single reviewer can hold it.

**Required sequence:**

1. **Architecture / planning FIRST.** Route `architecture` (and then `planning`) to decide the three
   questions that constrain everything downstream:
   - **OQ-6** — the stable-runtime packaging and promotion mechanism (pinned snapshot / dedicated stable
     worktree / release dir + atomic `current` symlink / vendored interpreter / equivalent).
   - **BD-15** — the concurrent-version store policy.
   - **T9** — whether an already-running process is affected by a mid-flight promotion (dynamic
     `import()`, lazy requires, open handles). **Settle empirically. The PRD asserts neither immunity nor
     exposure.**
   - **OQ-2 FEASIBILITY SPIKE (probe only — see below).**

### OQ-2 feasibility spike — a PROBE, not a decision

**Decision ownership for OQ-2 remains with FG-563.** This spike exists only so Slice 2 is not designed
against an adapter that cannot exist. **It must NOT select the adapter, and must NOT expand FG-553 into
orchestrator adoption.**

**Before Slice 2 (FG-552) begins**, establish **with host evidence**:

- Whether **any supported mechanism** can convert a `forge launch wait` completion into a **Claude session
  wake** when `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`.
- **Who owns that adapter's lifetime.**
- How it behaves **when swept**, **when the session disappears**, and **after restart**.
- Whether it can produce a **supported wake directly**, or whether the honest production shape is a
  **disposable Monitor running one blocking `forge launch wait`**.

> **"A disposable Monitor running one blocking `forge launch wait`" is an ACCEPTABLE RESULT — not a
> failure of the spike.** It still removes fixed-estimate model polling, still uses the canonical terminal
> classifier, and still permits durable lost-signal evidence. **Do NOT require "Monitor eliminated" if the
> harness exposes no supported external wake channel.** FG-563 still selects and adopts the production
> adapter and decides whether the Monitor is retired or retained as a **named fallback**.

**Reporting contract:** the spike must report **VERIFIED FACT**, **INFERENCE**, and **OPEN QUESTION**
**separately**. An inference presented as a fact here would design Slice 2 against a wake channel that does
not exist.
2. **Then create bounded implementation children** from that plan, each independently reviewable with its
   own acceptance evidence.
3. **FG-553 closes only when its children's AGGREGATE evidence passes** the acceptance criteria below.
   It is not closed by any single child.

Do not create the children before the architecture pass — their boundaries are an *output* of the OQ-6
decision, not an input to it.

> **The two options this ticket originally left open are now CLOSED by the accepted PRD. Do not reopen them.**
>
> - **"Is a health-check + fallback enough?" — NO.** BD-13: *"A read-only fallback observer is useful
>   defense in depth but is not sufficient closure for FG-553. The machine-wide blast radius must be
>   ELIMINATED, not merely documented."*
> - **"Eliminated OR explicitly documented" — NOT A CHOICE.** Documenting the blast radius does not close
>   this ticket. Elimination is the acceptance bar.
>
> Preserving an explicit live-source development path (`forge-dev` / `npm run forge`) remains required —
> the "commit and it's live" property is *relocated* to an explicit dev entry point, not abolished.
> Promotion to the machine-wide `forge` becomes "validated promotion and it is live."

## Binding decisions this slice must satisfy

- **BD-13** — the control plane never executes source under active mutation. Valid, **unmet**, and
  **insufficient on its own**.
- **BD-14** — **control-plane availability does not depend on the caller's environment. BD-14 is a
  PREREQUISITE for satisfying BD-13.** Stable source and stable runtime are **separate properties**;
  neither substitutes for the other. Implementation-neutral — it selects no mechanism (**OQ-6** owns that).
- **BD-15** — concurrent Forge versions must not corrupt the shared store. **The store-version policy is
  decided HERE, not at closeout** — it constrains the promotion mechanism this slice builds.

## Scope

- **Atomic executable/runtime closure.** Define the artifacts that move as **ONE indivisible unit**: entry
  point, source tree, `node_modules`, native bindings, and interpreter identity. A promotion that swaps a
  subset is **not atomic** — the interpreter and the native binding are a matched pair (Node 24/ABI 137
  loads the repo's `better-sqlite3`; Node 23/ABI 131 and Node 26/ABI 147 both fail).
- **Atomic promotion and rollback**, identifying the exact runtime commit/path. An interrupted promotion
  leaves the previous stable runtime selected and usable.
- **R1 and R2 provenance** (BD-14). **This slice owns BOTH:**
  - **R1 — the control runtime**: the interpreter + native-binding ABI + dependency set actually executing
    the `forge` CLI, its launch observer, and every routine state-reader.
  - **R2 — the exit-recorder runtime**: the interpreter executing the launch wrapper's exit recorder
    (`process.execPath` of *that* process). **R2 was previously unowned by any ticket — it is assigned here.**
    R2 must be captured, derived, or explicitly declared unknowable, **like every other runtime identity.**
    **Critically: `process.execPath` of the exit recorder identifies R2 and NOTHING ELSE.** It is not
    evidence of R3 (the launched top-level executable) or R4 (nested-shell resolution). Recording R2 and
    calling the launch "provenanced" is precisely the substitution BD-14 forbids.
  - `forge launch` records enough runtime identity to diagnose which control version owns an in-flight
    command. **Today `LaunchMeta` is 8 fields with no interpreter, Node version, ABI, PATH, or source SHA —
    no runtime provenance is recoverable post-launch at all** (`src/v2/launch.ts:44-58`).
  - **R3/R4 are FG-555's** (Slice 1b). Together the two slices must account for all four; neither may
    assume the other covered its half.
- **Bounded ABI enforcement.** Assert `NODE_MODULE_VERSION` against the ABI the native bindings were built
  for — an **upper AND lower** bound, not a version floor. *Today `src/cli/node-preflight.ts:26` admits any
  major ≥ 24, so it passes Node 26, whose ABI cannot load the binding — the operator gets an opaque native
  crash instead of the guard's clear message. The guard catches downgrades and waves upgrades through.*
- **Installed-surface compatibility** (separate from the atomic closure): `~/.forge` seeds / workflows /
  routing-policy (**verified: copies, not symlinks**), installed hooks and scripts, project-local `.forge`
  command assets, and dashboard assets. For each, state whether promotion **re-installs**, **version-pins**,
  or leaves it **explicitly outside** the control path — and what happens when an installed copy is older
  than the promoted runtime.
- **Store-version policy (BD-15).** Concurrent Forge processes of different versions share one SQLite by
  default: a long tmux-owned launch starts under version A, a promotion happens, a new command runs under
  version B against the same store. Migrations run **unconditionally on every writable open** and include a
  **destructive `DROP COLUMN`** (`src/store/db.ts:91`). Decide the policy — schema-version gate, refusal,
  backward-compatible-migration-only, or promotion-quiesce — **before the promotion mechanism closes.**
- **T9 — the in-flight / lazy-import question is settled HERE, empirically, not at closeout.** Determine
  whether a process already running under runtime A is affected by a mid-flight promotion to runtime B
  (dynamic `import()`, lazy requires, open file handles). **The PRD deliberately asserts NEITHER immunity
  NOR exposure.** A `current`-symlink swap is not self-evidently atomic for a running process. This answer
  constrains the promotion design, so it cannot be deferred to the slice that only *verifies* it.
- Whatever is chosen must not slow down the ordinary forge-on-forge loop.

**Mechanism is open (OQ-6):** pinned snapshot, dedicated stable worktree, release dir + atomic `current`
symlink, vendored interpreter, or equivalent. Compiled `dist/` is optional; **isolation is mandatory.** A
pinned tsx snapshot remains consistent with the no-build decision.

## Acceptance Criteria

- **The machine-wide blast radius is ELIMINATED.** Documenting it does not close this ticket.
- `forge` executes a stable, last-known-good runtime isolated from **all** active development worktrees.
- An explicit development entry point retains live-source iteration.
- **F23** — an agent makes development source syntactically invalid → stable machine-wide Forge state
  readers and the launch observer still work.
- **F24** — a transient missing-export / cross-file inconsistency → stable Forge commands still work **in
  this and unrelated projects**.
- **F25** — the explicit live-source command run against broken source fails **locally**, without changing
  the stable runtime.
- **F26** — validated promotion succeeds: new commands atomically use the recorded promoted version; no
  mixed tree is ever visible.
- **F27** — promotion is interrupted: the previous stable runtime remains selected and usable.
- **F28** — promotion occurs with an in-flight launch: runtime identity stays diagnosable and
  store/schema compatibility follows the recorded policy. **Includes T9** (settled above).
**F29, F30, and F31 are THREE DIFFERENT OUTCOMES. Do not collapse them into "the control plane runs."**
Each is a separate acceptance case with a separate pass condition:

- **F29 — AVAILABILITY.** The **bare, stable `forge`** command **RUNS CORRECTLY** regardless of the
  caller's ambient PATH, invoked **from a shell the operator did NOT pre-sanitize**. Test at minimum:
  - **ENV-A** nvm Node v24.17.0 / ABI 137 — the only environment proven to work today.
  - **ENV-B** login shell (`bash -lc`) → `/usr/local/bin/node` v23.3.0 / ABI 131. *Today `forge launch
    list` and `forge status --json` exit 1 with empty stdout — evidence-honest, but **the control plane did
    not run**.* **"Fails cleanly" is NOT a pass for F29. It must RUN.**
  - **A caller-applied PATH pin is containment, not isolation, and does NOT satisfy F29.**
- **F30 (this slice's HALF) — PROVENANCE of R1 and R2, plus the CONTRACT for R3/R4.** **R1 and R2 are each
  independently accounted for** — captured, derived, or **explicitly declared unknowable**. Recording one
  runtime is **not** proof of another: the exit recorder's `process.execPath` satisfies **R2 only** and does
  **not** satisfy R1, R3, or R4.

  **The provenance contract this slice ships must EXPLICITLY establish the future R3/R4 dispositions** — a
  contract that merely leaves room for them is not sufficient, because FG-555 would then be free to satisfy
  it with a substitution the PRD forbids:

  - **R3 — the launched top-level executable — MUST be captured or derived as the executable RESOLVED AT
    SPAWN TIME. Argv alone is NOT R3 evidence** (argv is a string, not a resolution).
  - **R4 — nested-shell resolution — MUST be captured, derived, or EXPLICITLY DECLARED UNKNOWABLE.** The
    contract **must never imply that argv, or the exit recorder's `process.execPath`, proves R4.**
  - **FG-555 implements and proves the R3/R4 dispositions against this contract** — it does not renegotiate
    them.
  - **Full F30 remains a CAMPAIGN-LEVEL condition, satisfied after FG-555 and verified by FG-565.**

  > **FG-553 does NOT wait on FG-555 to close.** This slice closes on **R1 + R2 + the R3/R4 contract above**.
  > FG-555 depends on FG-553; FG-553 must therefore never depend back on FG-555, or the two deadlock.
- **F31 — REFUSAL.** Forcing an **incompatible interpreter** is **REFUSED by the bounded ABI assertion
  BEFORE any native module is loaded**, with a named, actionable mismatch. Test **ENV-C**: Homebrew-first
  PATH → v26.3.1 / ABI 147. **Never tested today, and expected to fail badly** — the minimum-major preflight
  *passes* (26 ≥ 24) and `better-sqlite3` then throws an opaque native error. **F31's pass condition is a
  clean, pre-load refusal — NOT an opaque `ERR_DLOPEN_FAILED`, and NOT a successful run.** This is the
  disproof of the claim that the existing guard is adequate closure; without ENV-C the fix is validated only
  against the downgrade direction it already handles.
- **F35** — version-skew store compatibility: old and new Forge processes against one SQLite, under the
  BD-15 policy decided in this slice.
- `forge upgrade` and the "commit and it's live" workflow are reconciled, and the docs say which is in force.

**Every falsification test must be observed RED against its pre-fix baseline.** A test that cannot go red
does not prove the defect was covered.

## Not in scope

- The **launched workload's** environment — that is **FG-555 (Slice 1b)**, a distinct boundary. BD-14
  protects the control runtime (R1); FG-555 governs what the submitted command resolves (R3/R4). A stable
  Forge on pinned Node 24 can still faithfully launch a caller-supplied `bash -lc` that resolves Node 23
  and reproduce the ABI false-red **with BD-14 fully satisfied**. **Closing FG-553 does not close FG-555.**
- The wait primitive (FG-552) and the continuation claim (FG-562).
- **The fate of the FG-425-era Monitor / tmux-pane-polling workaround is NOT this slice's call.** **FG-563**
  decides whether it is retired or retained as a named fallback; **FG-565** confirms the decision was
  carried out. This slice makes the workaround *unnecessary* by fixing the control plane; it does not
  declare it retired.
