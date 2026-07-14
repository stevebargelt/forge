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

## Design questions (decide at plan time — do NOT assume one)

- **Should the control-plane read path avoid executing repo source at all?** A minimal `forge`-independent reader (the launch record and run/task rows are already durable files + SQLite) would let a controller observe state even while the tree is broken. Cheapest robust fix; does not stop the machine-wide breakage.
- **Should the installed `forge` be decoupled from the working tree?** e.g. run the CLI from a built/pinned snapshot (`dist/`, or a linked copy at a known-good sha) that an agent's in-progress edits cannot reach, with an explicit opt-in to run from live source. This fixes both harms but changes the "committed source is immediately live" property the operator currently relies on for fast iteration — that tradeoff is a real decision, not an obvious win.
- **Or is a health-check + fallback enough?** The controller detects the broken-CLI signature and falls back to direct record reads until the tree parses again.
- Whatever is chosen must not slow down the ordinary forge-on-forge loop.

## Acceptance Criteria

- An orchestrator/controller can read run, task, and launch state while an agent is mid-write on forge's own source — no forge command in the observation path can be broken by the tree under edit. Proven by a test that mutates the source tree into an unparseable state and asserts the observation path still works.
- The machine-wide blast radius is either eliminated or explicitly documented with a decision recording why it is accepted.
- If a snapshot/build-decoupled CLI is chosen: `forge upgrade` and the "commit and it's live" workflow are reconciled, and the docs say which one is in force.
- The FG-425-era tmux-pane-polling workaround is retired or documented as the sanctioned pattern.
