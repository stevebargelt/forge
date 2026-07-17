---
id: FG-577
type: story
status: active
title: "FG-572 Child 5a: forge upgrade installs assets from the DEV checkout, so a promoted release repairs ~/.forge with dev bytes"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (§"Externally installed surfaces")
**Blocks:** FG-579, FG-583 (every other Child-5 item is unsound while the remedy installs from the wrong tree).
**Sources:** FG-572 architecture pass (`run-fg-572-...-75b811`) + bounded pre-implementation security audit
(`run-fg-577-fg-578-bounded-pre-implementation-audit-...-b19e9a`, task-red-security-125943, **verdict: fail,
2 HIGH / 3 MEDIUM**), both read-only. Contract below is CONSOLIDATED from that audit — implement against it,
do not re-derive.

## The defect (verified on host at 12b13c2)

Detection is already release-correct; the **remedy is not**. `src/v2/seed-drift.ts:55-59` resolves
`defaultRepoSeedsDir` **module-relative** from `import.meta.url`, so under a promotion it already compares
`~/.forge` against the promoted release's own commit-bound `seeds/`. **No version marker is needed or wanted**
(a stamp cannot detect a hand-edit — it can lie; the bytes cannot. FG-571: "selection evidence is the BYTES,
never the pathname").

But `src/cli/commands/upgrade.ts:41,303` resolves `forgeRepoDir` = the **dev checkout** (`~/code/forge`), and
`:133` joins it for `install-seeds.sh`, `:209` for the orchestrator template. So a promoted stable runtime
detects drift against its own bytes and then names, as the fix (`seed-drift.ts:119`), a command that
**overwrites `~/.forge` with DEV bytes**. That single edge breaks FG-561's "installed surfaces agree" gate.
A release has no `.git`, so `upgrade.ts:93`'s `git pull` mutates a **different directory than the one it is
executing from** — it is not even self-referential.

`scripts/install-seeds.sh:6` already resolves `$HERE` from the script's own parent — the shell installer is
already release-correct. **The bug is purely the caller.**

## Audit HIGH-1 (confirmed, 0.99) — widen beyond seeds

`upgrade.ts:209` takes the **orchestrator template** from `forgeRepoDir` too. A partial fix that re-points the
seed installer but leaves the template on dev bytes is the failure mode. Also: `FORGE_REPO_DIR` / `--forge-repo`
let a **hostile ambient environment** (F29 — explicitly INSIDE the settled threat boundary, unlike same-UID
`~/.forge` tampering) redirect release-owned bytes into machine-wide authority. Not hypothetical: merely
having a divergent `~/code/forge` is enough.

## Audit MEDIUM-5 (confirmed) — the fail-closed trap this ticket MUST avoid

A blanket refusal at the current `forgeRepoDir` existence gate (`upgrade.ts:62`) **exits before reaching the
release-bundled installer**. On a host with no dev checkout, the remedy `seed-drift.ts:119` names becomes
unavailable **exactly in the broken state** — forcing manual filesystem repair. That is a fail-closed
availability defect and would be a regression, not a fix.

**Therefore: split asset-installation from dev-checkout advancement BEFORE that gate.** Release-mode asset
repair must resolve and run its **own bundled** script independently. Only `git pull` / `npm install` / image
rebuild / dev-template operations may refuse.

## Implementation contract (consolidated from the audit)

1. **The executing release is the sole source for every release-owned asset** — `install-seeds.sh`, the
   seed-drift baseline, AND the orchestrator template. Resolve module-relative from `import.meta.url`;
   `init.ts:283,650,786` is the correct in-repo prior art.
2. **No ambient `FORGE_REPO_DIR` / `--forge-repo` may redirect release-owned bytes in release mode.** Keep a
   separately named dev-checkout operation for live-dev mode only.
3. **Dev-checkout advancement is distinctly named and refuses in release mode** — with a named, actionable
   message pointing at `forge-dev` — and does not silently mutate `~/code/forge` under the operator (BD-13).
4. **Repair remains callable with no dev checkout** (MEDIUM-5). Split before the gate.
5. Do **not** claim to fix the non-atomic install (FG-583) or the workflows coverage gap (FG-579). Do not
   regress them either.

## Acceptance (EXECUTED)

- From a promoted release with a **divergent dev checkout**, `forge upgrade` proves **both** the host seed
  install **and** the project orchestrator template are **release bytes**, never dev bytes. Observed RED
  against current code.
- From a promoted release with **no dev checkout at all**, asset repair **still works** (MEDIUM-5). Observed
  RED against a naive blanket-refusal implementation — this test must fail if the split is done at the wrong
  place.
- With `FORGE_REPO_DIR` / `--forge-repo` set to a hostile/divergent tree, release mode does **not** install
  those bytes. Observed RED.
- From a promoted release, the dev-checkout-advancing half **refuses** with a named, actionable error and does
  not mutate `~/code/forge`.
- From a live dev checkout, current behavior is preserved.
- Each refusal/state asserted across **every** consumer: human output, `--json`, exit code, doctor, retry
  advice, campaign/dispatch. Audit-named consumers that would otherwise silently disagree: seed-drift/doctor,
  loader/next/cancel/runNext/gate, route preflight/startRun/campaign lane classification, raci apply/route
  compile/setup/init, and upgrade's release-check tail.
- Every regression test is **mutation-sensitive**: red against the *precise* defective behavior, not merely
  red because a feature is absent.
- All tests use **disposable FORGE_HOME + disposable install prefixes**. No test touches the real `~/.forge`,
  promotes this host, runs `npm link`, or mutates `~/code/forge`.