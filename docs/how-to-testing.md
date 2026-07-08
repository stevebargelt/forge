# How-to: writing and running tests

## Test tiers

The suite is split into three tiers selected by **filename suffix**. Every `*.test.ts` file belongs to exactly one tier — `src/test-tiers.test.ts` enforces this as a partition proof that fails the suite if any file is in two tiers or in none, plus a content guard (see "Content-guard purity" below) that catches subprocess/sleep patterns creeping into the unit tier regardless of filename.

| Tier | Suffix | Command | Steady-state wall time |
|------|--------|---------|---|
| Unit (canonical/default) | `*.test.ts` (excluding the two below) | `npm test` / `npm run test:unit` | ~2s |
| Integration | `*.integration.test.ts` | `npm run test:integration` | ~93s |
| Worktree | `*.worktree.test.ts` | `npm run test:worktree` | ~2s |
| Extended (integration + worktree + dashboard integration) | — | `npm run test:extended` | ~95s |
| Canonical deterministic gate | unit + dashboard workspace | `npm run test:all` | ~2.5s |

**FG-495 review fix: the dashboard workspace has the same two-tier split as the root.** Round 1 of FG-495 renamed `dashboard/src/routes-backlog.integration.test.ts` but left `dashboard/package.json`'s `"test"` script matching every `*.test.ts` file, so the "integration" name was cosmetic — that file (which boots a real HTTP server on a real port against a real fixture backlog) still ran inside `npm test -w dashboard`, and therefore inside `npm run test:all`, the canonical gate. `dashboard/package.json`'s `"test"` script now excludes `*.integration.test.ts` (mirroring `test:unit`'s `find` exclusion above), and a new `"test:integration"` script runs just that file. The dashboard integration tier runs in `npm run test:extended`, alongside the root's integration/worktree tiers; the canonical gate (`npm run test:all` → `npm test -w dashboard`) now runs only dashboard's fast tier.

**FG-495: `npm test` is the unit tier, not a three-tier aggregate.** Before FG-495, bare `npm test` (and therefore `npm run test:all`, and therefore the CI required check AND the review-loop's own per-round verification, which runs `scripts["test"]` — see `runVerification` in `src/v2/review-loop.ts`) ran all three tiers combined, at ~107s. That was too slow to be the deterministic check paid on every commit and every review-loop round. `npm test` now aliases `npm run test:unit`; `npm run test:all`'s script text is unchanged (`npm test && npm test -w dashboard`) but is fast because `npm test` is now unit-only. The slow integration + worktree coverage didn't disappear — it moved to the explicit `npm run test:extended` tier, which runs in CI as its own required merge check (see below) rather than as part of the fast per-round gate. Full before/after timing data and the list of files reclassified into integration/worktree lives in `docs/test-suite-timing-fg495.md`.

`npm run test:all` is deliberately left as the literal command string both `.github/workflows/ci.yml`'s `test` job and `REQUIRED_CI_GATE_COMMAND` (`src/store/host-verifications.ts`) reference for FG-419/FG-474's content-verified evidence-reuse and anti-spoofing matching — changing the command name would have required touching that matching logic too. The speed fix is entirely in what `npm test` now means, not in renaming the gate.

That command-matching pairing is necessary but not sufficient for CI-sourced evidence: since a later FG-495 review finding (commit f59b47b), a green paired `CI / test` check no longer mints a `source: 'ci'` host-verification row by itself. `findCoveringGateEvidence` (`src/store/host-verifications.ts`) also requires **every** job in the matched CI workflow — `test` AND `test-extended` — to be green at the exact same sha; a red, pending, or absent sibling job fails closed to no CI coverage.

## Continuous Integration (FG-474, tiering FG-495)

`.github/workflows/ci.yml` has two jobs:

- **`test`** (check name `CI / test`) — a **required** merge-gate check. Runs `npm run test:all` (unit tier + dashboard workspace, plus `npm run typecheck`) on every push and on every PR into `main`, pinned to the Node version in `.nvmrc` (24) so the better-sqlite3 native module always matches the runner's ABI. The review-loop's own per-round verification is narrower than this CI job: `runVerification` (`src/v2/review-loop.ts`) runs `npm run --silent typecheck` and `npm run --silent test` as two separate steps — the unit tier only, never the literal `npm run test:all` command and never the dashboard workspace — so it needs to stay under the <=60s target / <=120s ceiling. CI's `test` job additionally covers the dashboard workspace on every push/PR; it now completes in ~2.5s server-side, where the pre-FG-495 version took ~107s.
- **`test-extended`** (check name `CI / test-extended`) — also a **required** merge-gate check, not informational. Runs `npm run test:extended` (root integration + worktree tiers, plus the dashboard workspace's own integration tier via `npm run test:integration -w dashboard`) on the same push/PR triggers. Dashboard's slow/integration coverage only runs here — its share of the canonical `test` gate (`npm run test:all` → `npm test -w dashboard`) is the fast tier only, mirroring how the root's own integration/worktree tiers are kept out of `test`. Branch protection carries both `test` and `test-extended` as required contexts (applied host-side by the orchestrator); a red `test-extended` run blocks merge exactly like a red `test` run. What FG-495 changed is *where* this coverage runs (CI, off-host, in parallel with `test` and with review-loop verification) and how often the operator pays for it interactively — never per round, since the review-loop's per-round verification only re-runs the fast unit-tier scripts (`typecheck` + `test`), not the dashboard-inclusive `test:all` CI runs. Merge happens once per ticket, so the ~95s extended job (93s root integration + 1.9s root worktree + 0.7s dashboard integration) running in parallel with review is affordable at that boundary even though it would be too slow to re-run every round.

Running the aggregate on the host is still normal during local iteration (`forge-test --all`, or `npm run test:all` directly); what changed with FG-474 is that the merge decision reads CI's result rather than triggering a second, invisible host run of the same suite. What changed with FG-495 is that the per-round host/CI cost is now fast (canonical gate is unit-only), while full coverage — including the slow integration/worktree tiers — still gates the actual merge via the parallel `test-extended` check.

## What belongs in each tier

**Unit** — pure functions and in-memory logic only. No subprocess spawning, no real filesystem I/O beyond `os.tmpdir()` scratch, no SQLite on disk, no git operations, no `sleep` or deliberately long-running operations. Use `new Database(':memory:')` for any schema tests. If a test needs to verify that a CLI command parses correctly or that the database persists across a reconnect, it belongs in integration or worktree — not unit.

**Integration** — tests that spawn a CLI subprocess, write to a real (temp) filesystem, or open an on-disk SQLite database. One process per test, no git worktrees. Typical: `forge backlog list`, reading/writing backlog files, verifying CLI error messages, real-DB round-trips.

**Worktree** — tests that create git worktrees, exercise dispatch/fanout/merge-back orchestration, or measure control-plane timing. These are expected to be slow. Anything that calls `spawn` for a git worktree operation or tests the full orchestration pipeline at the worktree seam lives here.

## Placement rule

> **Do not put subprocess-heavy, git/worktree, real-DB, or sleep/long-running tests in the unit tier.** Those go to integration (`.integration.test.ts`) or worktree (`.worktree.test.ts`). The unit tier must stay fast and pure so it remains useful for rapid local iteration — and, since FG-495, it IS the canonical gate CI and the review-loop run on every commit/round, so purity here is load-bearing for suite speed, not just local ergonomics.

The convention is mechanically enforced two ways:

- **Partition proof** — `src/test-tiers.test.ts` asserts that the three suffix sets are pairwise disjoint and their union equals the complete `src/**/*.test.ts` corpus. If you add a file with a suffix that matches two tiers (impossible with the current naming scheme) or somehow create a file that matches none, the partition test fails the suite.
- **Content-guard purity (FG-406/408, extended FG-495)** — the same file also inspects unit-tier file *content*, not just filename, so a file can't dodge the guard by simply omitting the `.integration`/`.worktree` suffix while still doing integration-shaped work. It flags: (a) a non-type `child_process` import combined with a standalone `execSync`/`spawnSync`/`spawn`/`execFileSync`/`execFile`/`exec` call, (b) a literal `spawn("sleep")`, and (c) the promisified-sleep idiom `new Promise((r) => setTimeout(r, N))` regardless of `child_process` usage (real wall-clock sleep, not a fake timer). FG-495 added the `execFileSync` pattern and the promisified-sleep check — the original guard's pattern list had a real gap (`execFileSync` wasn't in it), which let 10 unit-tier files spawn real `git` subprocesses or sleep on a real clock undetected; see `docs/test-suite-timing-fg495.md` for the full list and where each one moved. `mock.timers`-based fake-timer tests (e.g. `idle-watchdog.test.ts`) never match the sleep pattern, since they never call real `setTimeout` from the test file.

## Running a specific tier

```bash
# Fast, pure, canonical — the default; what CI and the review-loop run
npm test
npm run test:unit

# CLI subprocess / real FS / real DB
npm run test:integration

# Git worktree, dispatch/fanout orchestration
npm run test:worktree

# Root integration + worktree tiers, plus dashboard's integration tier —
# what CI's required test-extended merge check runs
npm run test:extended

# Canonical deterministic gate: unit tier + dashboard workspace
npm run test:all
```

## Agent-iteration contract

Within an agent's in-loop validation, use `forge-test` at the right tier:

- **`forge-test`** (unit tier, no args) — the default. Fast and pure; run this while iterating on most changes.
- **`forge-test --integration`** — when the change touches CLI-spawn, real filesystem, or real DB boundaries.
- **`forge-test --worktree`** — when the change touches git-worktree operations, dispatch-fanout, or orchestration paths.
- **`forge-test --extended`** — when the change plausibly affects both slow tiers at once, or you want the full non-canonical coverage locally before pushing (mirrors CI's `test-extended` job).
- **`forge-test --all`** — the canonical deterministic gate (unit tier + dashboard workspace); fast enough (~2.5s) to run routinely, not just before claiming shipped.
- **`forge-test <file.test.ts>`** or **`forge-test --test <pattern>`** — run a specific file or pattern regardless of tier.

**A green unit tier is in-loop confidence for most changes; it is not, by itself, proof the integration/worktree tiers still pass.** Since FG-495 the unit tier is the fast gate the review-loop re-runs every round via `runVerification` (`npm run --silent typecheck` + `npm run --silent test` — not the literal `npm run test:all` command, and never the dashboard workspace), and CI's `test-extended` job independently re-verifies the integration/worktree tiers as its own required check before merge — both `test` and `test-extended` must be green to merge, not just the fast one. If your change touches CLI-spawn, real-FS/DB, or git-worktree/dispatch code, also run the matching `forge-test --integration` / `--worktree` / `--extended` before reporting complete: the fast gate proves the fast tier, not the slow tiers CI's `test-extended` job covers. Agents must report their validation tier honestly in their result — `status: "complete"` means the diff was validated at the level appropriate for its change.

## Naming a new test file

Pick the suffix that matches the slowest operation the test performs:

- No subprocess, no git, no disk DB, no real sleep → `<module>.test.ts`
- CLI spawn, real git fixture setup (`execFileSync`), on-disk DB, or a real wall-clock sleep → `<module>.integration.test.ts`
- Git worktree or orchestration dispatch → `<module>.worktree.test.ts`

If you're unsure whether a fixture helper's `execFileSync("git", ...)` call counts: it does. The content guard (above) will fail the unit tier if it lands there anyway.

Colocate the file next to the module it tests (`src/foo/bar.ts` → `src/foo/bar.test.ts`). Ticket-scoped regression files live under `src/v2/` and follow the same suffix rule.

## Timing data and classification history

`docs/test-suite-timing-fg495.md` has the full per-file/per-tier timing measurements behind FG-495's tiering decision, plus a file → old-tier → new-tier → reason table for every test relocated out of the unit tier when the content guard was extended.
