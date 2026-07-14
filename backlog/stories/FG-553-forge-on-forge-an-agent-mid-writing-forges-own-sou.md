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
- **R1 provenance** (BD-14's control runtime) is captured and durably recorded. `forge launch` records
  enough runtime identity to diagnose which control version owns an in-flight command. **Today `LaunchMeta`
  is 8 fields with no interpreter, Node version, ABI, PATH, or source SHA — no runtime provenance is
  recoverable post-launch at all** (`src/v2/launch.ts:44-58`).
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
- **F29 / F30 / F31 — the control plane RUNS from at least two incompatible PATH/Node environments**,
  invoked as **bare `forge` from a shell the operator did NOT pre-sanitize**:
  - **ENV-A** nvm Node v24.17.0 / ABI 137 — the only environment proven to work today.
  - **ENV-B** login shell (`bash -lc`) → `/usr/local/bin/node` v23.3.0 / ABI 131. *Today `forge launch
    list` and `forge status --json` exit 1 with empty stdout — evidence-honest, but **the control plane did
    not run**.* **"Fails cleanly" is NOT a pass. It must RUN.**
  - **ENV-C** Homebrew-first PATH → v26.3.1 / ABI 147. **Never tested; expected to fail badly** — the
    preflight passes and `better-sqlite3` then throws an opaque native error. This is the disproof of the
    claim that the existing guard is adequate closure, and it **must** be in the suite, or the fix is
    validated only against the downgrade direction it already handles.
  - **A caller-applied PATH pin is containment, not isolation, and does NOT satisfy these.**
- **F35** — version-skew store compatibility: old and new Forge processes against one SQLite, under the
  BD-15 policy decided in this slice.
- `forge upgrade` and the "commit and it's live" workflow are reconciled, and the docs say which is in force.
- The FG-425-era tmux-pane-polling workaround is retired or documented as the sanctioned pattern.

**Every falsification test must be observed RED against its pre-fix baseline.** A test that cannot go red
does not prove the defect was covered.

## Not in scope

- The **launched workload's** environment — that is **FG-555 (Slice 1b)**, a distinct boundary. BD-14
  protects the control runtime (R1); FG-555 governs what the submitted command resolves (R3/R4). A stable
  Forge on pinned Node 24 can still faithfully launch a caller-supplied `bash -lc` that resolves Node 23
  and reproduce the ABI false-red **with BD-14 fully satisfied**. **Closing FG-553 does not close FG-555.**
- The wait primitive (FG-552) and the continuation claim (FG-562).
