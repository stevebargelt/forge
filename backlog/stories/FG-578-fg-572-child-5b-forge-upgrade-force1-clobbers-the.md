---
id: FG-578
type: story
status: active
title: "FG-572 Child 5b: forge upgrade FORCE=1 clobbers the operator-authored forge-raci.md and recompiles routing-policy.yml from the clobbered source"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`, at `12b13c2`.

## The defect (verified at 12b13c2 — LIVE TODAY, independent of promotion)

`forge upgrade` **silently destroys the operator's authored host RACI**:

1. `src/cli/commands/upgrade.ts:141` invokes `install-seeds.sh` with `FORCE: "1"`.
2. `scripts/install-seeds.sh:83-86` — under `FORCE=1` it unconditionally `cp`s `seeds/forge-raci.md` over
   `$DEST/forge-raci.md`, the **operator-authored** file (`src/util/paths.ts:19` calls it "the installed host
   RACI source (authoring view)"; orchestrator-mediated edits are audited to `raci-audit.log`).
3. `upgrade.ts:173` then recompiles `routing-policy.yml` **from the clobbered source**, propagating the loss
   into the derivative.

A surface the operator is *invited* to edit cannot be legally re-installed. `forge raci apply` exists
precisely so routing changes are gated and audited — `forge upgrade` silently reverts them.

**Materialization status (host, 12b13c2):** NOT yet materialized. `seeds/forge-raci.md` and
`~/.forge/forge-raci.md` are currently **byte-identical**, and `~/.forge/raci-audit.log` does not exist — no
orchestrator-mediated RACI change has ever been applied on this host. So this is a **latent** hazard, not an
active incident: safe by discipline, not by mechanism. The first `forge raci apply` followed by any
`forge upgrade` loses the change.

## Scope

`FORCE=1` must not apply to operator-authored surfaces. `forge-raci.md` is the concrete case
(`install-seeds.sh:82-87`). Consider whether `agents/` + `constraints/` prose share the exemption —
`seed-drift.ts:15,30` explicitly calls them "prose that may carry local edits", and there is NO project-local
override for `AGENTS_DIR` (`src/util/paths.ts:7`), so the operator has no escape hatch there either.

## Acceptance (EXECUTED)

- With a **divergent** host `forge-raci.md`, `forge upgrade` (FORCE=1 path) does **not** overwrite it, and
  `routing-policy.yml` is recompiled from the **operator's** RACI, not the seed. Test observed RED against
  current code (i.e. it must reproduce the clobber before the fix).
- A first-install (no existing `forge-raci.md`) still installs the seed.
- The operator is told what was skipped and why — not silently no-op'd.
- Tests use **disposable FORGE_HOME**; no test touches the real `~/.forge`.