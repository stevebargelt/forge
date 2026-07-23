---
id: FG-572
type: story
status: done
title: "FG-553 Child 5: installed-surface compatibility (seeds/hooks/scripts/dashboard) across a promotion"
created: 2026-07-14
closed: 2026-07-23
closed_commit: 8272e5b
---

**Parent:** FG-553 · **Epic:** FG-561 · **Plan:** `docs/plans/fg553-slice1-architecture.md` (Child 5)
**Depends on:** FG-571 (promotion exists to be compatible with).

**UMBRELLA — decomposed 2026-07-17 after the read-only architecture pass. Closes when its children close.**
Children: **FG-577** (5a, prerequisite) · **FG-578** (5b) · **FG-579** (5c+5d) · **FG-581** (5f — ✓ DONE, `dcc19ec`) ·
**FG-582** (5e — ✓ DONE, `44a305a`) · **FG-583** (5h, non-atomic seed cp loop — the last open child) · **FG-580** (5g — OPERATOR DECISION, campaign critical path).

**Progress (2026-07-22):** FG-581 (5f — `routing-policy.yml` RE-DERIVE / post-promotion compile-failure refusal) shipped in `dcc19ec` (PR #152): the upgrade now neutralizes a stale compiled policy fail-closed instead of warn-and-continue, names the rejected RACI construct, and resolves paths from `FORGE_HOME`. **FG-582 (5e hooks) shipped 2026-07-22 in `44a305a` (PR #153): installed commit-msg hooks now symlink THROUGH `$FORGE_HOME/current/scripts/git-hooks/...`, so a NEW invocation follows a promotion; resolvability-not-existence arm selection, ownership-by-evidence stale repair, foreign-surface refusal, atomic idempotent repoint; docs reconciled. Residual sub-ms TOCTOU tracked as FG-604.** The last open child is **FG-583** (5h non-atomic seed cp). FG-580 (5g dashboard) shipped `bc9286f`. This umbrella cannot close while any child remains open.

Architecture pass: run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811`
(task-architecture-advisor-e950c5), read-only, at `12b13c2`. Its load-bearing claims were independently
re-verified on the host before this decomposition was recorded.

## Problem

The atomic release closure (FG-569/FG-571) covers the executable + node_modules + interpreter + the
control-plane asset dirs it bundles (seeds/, scripts/, docker/). But forge also depends on artifacts INSTALLED
OUTSIDE that closure: `~/.forge` seeds / workflows / routing-policy (verified: **copies, not symlinks**),
installed hooks, scripts, project-local `.forge` command assets, and the **dashboard application surface**. A
promotion that swaps the executable but leaves an OLDER installed surface — or leaves the dashboard
unavailable — can mis-run silently.

## Corrected findings (2026-07-17) — two framings in this ticket were WRONG

**1. "The dashboard is a separate workspace with its OWN node_modules" — FALSE.** This ticket and
`src/v2/release.ts:8-9` both asserted it; verified false at `12b13c2`. Root `package.json` declares
`workspaces:["dashboard"]`; npm **hoists** the dashboard's runtime deps to the root; `dashboard/node_modules`
is **0B**; `marked` (its only non-shared runtime dep) sits at root `node_modules/marked` (936K);
`better-sqlite3` is already a root dep; and the release copies the entire root `node_modules` wholesale. **The
release already ships the dashboard's dependency tree.** The unbundled delta is `dashboard/src` +
`dashboard/client` static assets, with **no build step** (`start: tsx src/server.ts`). The deferral in FG-580
must be decided against this corrected cost model, not the original one. `release.ts:8-9`'s comment is stale
and must be corrected by whichever child resolves 5g.

**2. "No version marker in `~/.forge` ⇒ staleness is undetectable" — FALSE, and the inverse of the real
defect.** `src/v2/seed-drift.ts:57-58` resolves its baseline **module-relative** from `import.meta.url`, so
under a promotion it compares `~/.forge` against the promoted release's own commit-bound `seeds/`. **No version
marker is needed or wanted** — a stamp is strictly weaker than the byte comparison forge can already make,
because it cannot detect an operator hand-edit (the stamp can lie; the bytes cannot — FG-571's "selection
evidence is the BYTES, never the pathname", one boundary outward).

> **CORRECTION (FG-577 architect phase, `task-architect-17823b`).** An earlier revision of this section said
> "detection is already release-correct" **without qualification. That was wrong**, and the unqualified claim
> is dangerous: `seed-drift.ts:56` — `if (process.env.FORGE_REPO_DIR) return join(process.env.FORGE_REPO_DIR,
> "seeds")` — **short-circuits BEFORE** the module-relative resolution at `:57-58`. Detection is release-correct
> **only in the fallback branch**. A divergent or hostile ambient `FORGE_REPO_DIR` re-points the **detector's
> own baseline**, so drift reports "current" against caller-chosen bytes. That failure is **silent**, and
> therefore strictly worse than the noisy wrong-remedy defect this child is named for. The baseline is a
> release-owned asset and is covered by FG-577's contract item 2 — but an implementer reading the unqualified
> narrative would re-point `upgrade.ts` and never open `seed-drift.ts`. Verified on host at `9e38ce5`.

**The real defect is the REMEDY.** `forge upgrade` installs from `~/code/forge`
(`src/cli/commands/upgrade.ts:41,303`) — the dev checkout — and is the exact command `seed-drift.ts:119` names
as the fix. **A promoted stable runtime detects drift against its own bytes, then tells the operator to run a
command that overwrites `~/.forge` with DEV bytes.** That single edge breaks FG-561's "installed surfaces
agree" gate. → FG-577.

## Scope

For each installed surface, decide and implement one of: promotion **re-installs** it, **version-pins** it,
or leaves it **explicitly out of the control path** — and define what happens when an installed copy is
**older** than the promoted runtime. Distinguish the **atomic closure** (moves as one unit with the release)
from these **externally-installed, version-compatible surfaces** (a compatibility policy, not atomic swap).

### Resolved per-surface policy (from the architecture pass)

| Surface | Policy | Child |
|---|---|---|
| `~/.forge/workflows` | **RE-INSTALL** — forge-owned, executable; `loader.ts:44` gives projects a sanctioned override that survives re-install | FG-579 |
| `~/.forge/agents`, `constraints` | **VERSION-PIN** — detect + report, never clobber; `seed-drift.ts:15,30` invites local edits and `paths.ts:7` gives no project override | FG-579 |
| `forge-raci.md` | **OUT OF THE CONTROL PATH** — operator-authored; report informationally, never re-install | FG-578 |
| `routing-policy.yml` | **RE-DERIVE** — pure derivative (`host-policy.ts:4-5`); never install or version-compare; its version is a function of the operator's RACI, not the release's | FG-581 |
| `model-policy.yml` | **OUT OF THE CONTROL PATH** — forge never writes it | — |
| hooks | **✓ SHIPPED `44a305a`** — installed hooks symlink through `$FORGE_HOME/current/scripts/git-hooks/...`; promotion re-points atomically; ownership-by-evidence, foreign refusal, atomic idempotent repoint. Residual TOCTOU → FG-604 | FG-582 |
| dashboard | **RESOLVED — Option A, shipped by FG-580 (`bc9286f`): bundled into the release as a mandatory asset, runs from a promoted release, boots offline** | FG-580 |

## Acceptance (EXECUTED)

- An installed surface copy **older** than the promoted runtime produces a **named, actionable failure** —
  not a silent mis-run. **The refusal must fire on the path that CONSUMES the surface; a `doctor` line the
  operator may never run does not satisfy this.**
- For each surface (seeds/workflows/routing-policy, hooks, scripts, project `.forge`, dashboard): its
  promotion behavior (re-install / version-pin / out-of-path) is implemented and tested.
- `forge dashboard` is available and stable from a promoted release (its FG-569 release-mode refusal is
  lifted), OR its unavailability is an explicit, named, accepted product boundary — and FG-561 is not marked
  complete while it remains unavailable. → **FG-580, operator-owned; this ticket cannot close without it.**
- No installed surface silently loads mutable host code that contradicts the promoted runtime.

## Not in scope
- The release/promotion machinery itself (FG-569/FG-571).

## Closure

All seven children are closed — installed-surface compatibility across a promotion is complete:

| Child | Surface | Shipped |
|-------|---------|---------|
| FG-577 (5a) | installer sources from the executing release (provenance) | done |
| FG-578 (5b) | FORCE ownership: forge-owned re-install vs operator-authored retain | done |
| FG-579 (5c+5d) | seed-drift coverage + workflow drift refusal | done |
| FG-580 (5g) | dashboard bundled into the release, boots offline (`bc9286f`) | done |
| FG-581 (5f) | routing-policy re-derive / post-promotion compile-failure refusal (`dcc19ec`) | done |
| FG-582 (5e) | installed git hooks follow a promotion via `$FORGE_HOME/current` (`44a305a`) | done |
| FG-583 (5h) | host seeds published as one atomic generation; no torn/mixed dispatch (`8272e5b`) | done |

The umbrella closes with its last child (FG-583). Residual follow-ups filed and non-blocking: FG-604 (hook repoint TOCTOU), FG-605 (route preflight consuming policy from the generation).
