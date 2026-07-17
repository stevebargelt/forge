---
id: FG-578
type: story
status: done
title: "FG-572 Child 5b: forge upgrade FORCE=1 clobbers the operator-authored forge-raci.md and recompiles routing-policy.yml from the clobbered source"
created: 2026-07-17
closed: 2026-07-17
closed_commit: d9dacbb
---

**Parent:** FG-572 · **Epic:** FG-561 · **Sequence:** land AFTER FG-577 (same files: `upgrade.ts`, `install-seeds.sh` — sequential avoids a merge conflict).
**Sources:** FG-572 architecture pass + bounded pre-implementation security audit
(`run-fg-577-fg-578-bounded-pre-implementation-audit-...-b19e9a`, task-red-security-125943, **HIGH-2,
confirmed 0.98**). Contract below is CONSOLIDATED from that audit.

## The defect (verified at 12b13c2 — LIVE TODAY, independent of promotion)

`forge upgrade` **silently destroys the operator's authored host RACI**:

1. `src/cli/commands/upgrade.ts:141` invokes `install-seeds.sh` with `FORCE: "1"`.
2. `scripts/install-seeds.sh:27` — the generic copy predicate `[[ "${FORCE:-0}" == "1" || ! -e "$dst/$rel" ]]`
   then `cp -f`s over **everything**, and `:82-87` does the same for `forge-raci.md`, the **operator-authored**
   file (`src/util/paths.ts:19` = "the installed host RACI source (authoring view)"; orchestrator-mediated
   edits are audited to `raci-audit.log`, `paths.ts:27`).
3. `upgrade.ts:173` then recompiles `routing-policy.yml` **from the clobbered source**, propagating the loss
   into the derivative.

An operator applies an audited RACI change via `forge raci apply` — the gated, confirm-before-write channel
that exists precisely so routing changes are reviewable — then runs the ordinary supported `forge upgrade`,
and their approved routing controls are **silently reverted**. A surface the operator is *invited* to edit
cannot be legally re-installed.

**Materialization status (host, 12b13c2):** NOT yet materialized. `seeds/forge-raci.md` and
`~/.forge/forge-raci.md` are currently **byte-identical**, and `~/.forge/raci-audit.log` does not exist — no
orchestrator-mediated RACI change has ever been applied on this host. This is a **latent** hazard: safe by
discipline, not by mechanism. The first `forge raci apply` followed by any `forge upgrade` loses the change.

## Audit HIGH-2 — the decision this ticket must make explicitly

The **identical** overwrite mechanism (`install-seeds.sh:27`) also hits `agents/` + `constraints/`, for which
**there is no project override** (`src/util/paths.ts:7`) and which `seed-drift.ts:15,30` explicitly calls
"prose that may carry local edits". The implementation **must decide and test** the local-edit policy for
agents/constraints rather than leaving them subject to the generic FORCE branch by omission.

Note `install-seeds.sh:27`'s asymmetry: a **bare** (non-FORCE) invocation SKIPS existing files, so a plain
re-install is a **no-op against drift by construction**. Neither branch is currently correct: FORCE clobbers
authored work, bare never repairs.

## The new failure this fix introduces — name it, don't ignore it

An operator whose RACI is now never refreshed **silently runs an old RACI against a new compiler**. The
exemption therefore needs a companion signal: output must name the file as **operator-authored / out of the
control path**, and byte drift against the release seed may be reported **informationally** — but must never
be a false claim that it was refreshed. (The compile-failure half of this is FG-581.)

## Acceptance (EXECUTED)

- With a **divergent** host `forge-raci.md`, `forge upgrade` (FORCE path) does **not** overwrite it, and
  `routing-policy.yml` is recompiled from the **retained operator** RACI, not the seed. Observed RED against
  current code — the test must reproduce the clobber before the fix.
- **First install** (no existing `forge-raci.md`) still creates it from the seed.
- A **bare** non-FORCE reinstall demonstrably leaves existing files unchanged.
- Divergent `agents/` + `constraints/` follow the **decided, documented** policy — and that policy is tested,
  not implied.
- The operator is **told what was skipped and why** (human output + `--json`), not silently no-op'd; the
  message names the file as operator-authored, and does not claim a refresh that did not happen.
- Every regression test is **mutation-sensitive**: red against the precise defective behavior.
- Tests use **disposable FORGE_HOME**; the real `~/.forge` is never touched.

## Not in scope
- The post-promotion compile-failure escalation (FG-581).
- Atomic publication of the installed surface (FG-583).