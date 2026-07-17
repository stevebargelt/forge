---
id: FG-577
type: story
status: active
title: "FG-572 Child 5a: forge upgrade installs assets from the DEV checkout, so a promoted release repairs ~/.forge with dev bytes"
created: 2026-07-17
---

**Parent:** FG-572 · **Epic:** FG-561 · **PRD:** `docs/prds/durable-orchestration-continuation.md` @ `e6fd56b` (§"Externally installed surfaces")
**Source:** FG-572 read-only architecture pass, run `run-fg-572-installed-surface-compatibility-read-only-architecture-pass-75b811` (task-architecture-advisor-e950c5), at `12b13c2`.

## The defect (verified on host at 12b13c2)

Detection is already release-correct; the **remedy is not**. `src/v2/seed-drift.ts:55-59` resolves
`defaultRepoSeedsDir` **module-relative** from `import.meta.url`, so under a promotion it already compares
`~/.forge` against the promoted release's own commit-bound `seeds/`. No version marker is needed.

But `src/cli/commands/upgrade.ts:41,303` resolves `forgeRepoDir` = the **dev checkout** (`~/code/forge`), and
`upgrade.ts:133` joins it to find `install-seeds.sh`. So a promoted stable runtime detects drift against its
own bytes and then names, as the fix (`seed-drift.ts:119`), a command that **overwrites `~/.forge` with DEV
bytes**. That single edge breaks FG-561's "installed surfaces agree" closeout gate.

Note `scripts/install-seeds.sh:6` already resolves `$HERE` from the script's own parent — the shell installer
is already release-correct. The bug is purely the **caller**.

## Scope

- upgrade's **asset-install half** resolves module-relative — the pattern `init.ts:283,650,786` already uses
  correctly.
- **Split upgrade's two conflated operations:** "advance the dev checkout" (`git pull` + `npm install`,
  upgrade.ts:93,117) is a DEV-mode operation that must **refuse from a promoted release** with a named error
  rather than silently mutate `~/code/forge` under the operator (BD-13: the control plane never executes
  source under active mutation). "Install this runtime's assets into `~/.forge`" must be release-relative.

## Acceptance (EXECUTED)

- From a promoted release, `forge upgrade` installs assets from the **release's own** `seeds/`, never the dev
  checkout. Test observed RED against current code.
- From a promoted release, the dev-checkout-advancing half **refuses** with a named, actionable error; it does
  not mutate `~/code/forge`.
- From a live dev checkout, current behavior is preserved.
- All promotion/install tests use **disposable FORGE_HOME + disposable install prefixes**. No test touches the
  real `~/.forge` or promotes this host.

## Notes
- Prerequisite for FG-579; every other Child-5 item is unsound while the remedy installs from the wrong tree.