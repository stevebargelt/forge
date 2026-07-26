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

`.github/workflows/ci.yml` has the fast `test` job plus the extended merge gate, which is now sharded across seven concurrent jobs behind a fail-closed aggregate:

- **`test`** (check name `CI / test`) — a **required** merge-gate check. Runs `npm run test:all` (unit tier + dashboard workspace, plus `npm run typecheck`) on every push and on every PR into `main`, pinned to the Node version in `.nvmrc` (24) so the better-sqlite3 native module always matches the runner's ABI. The review-loop's own per-round verification does not duplicate this CI job by default (FG-501): on a clean tree it reuses covering evidence for HEAD, or waits for this required check to go green and reuses that once it does. Only a dirty tree, or a wait that finds CI unavailable/failed-precondition/timed-out, falls back to a real local run via `runVerification` (`src/v2/review-loop.ts`), which runs `npm run --silent typecheck` and `npm run --silent test` as two separate steps — the unit tier only, never the literal `npm run test:all` command and never the dashboard workspace — so it needs to stay under the <=60s target / <=120s ceiling. CI's `test` job additionally covers the dashboard workspace on every push/PR; it now completes in ~2.5s server-side, where the pre-FG-495 version took ~107s.
- **`test-extended`** (check name `CI / test-extended`) — also a **required** merge-gate check, not informational, and still the exact branch-protection context. It no longer runs `npm run test:extended` itself; the extended coverage is now split across **seven concurrent jobs** so the required gate finishes in well under 4 min instead of ~9 min sequential: five root-integration shards `integration_1`..`integration_5` (each running `bash scripts/run-integration-tests.sh k/5`), a `worktree` job (`npm run test:worktree`), and a `dashboard_integration` job (`npm run test:integration -w dashboard`). **FG-624:** those shards are no longer partitioned by Node's `--test-shard`. That split the (now 173) `*.integration.test.ts` files by FILE INDEX, which is an arbitrary split of COST — on `main` three shards finished in ~2.5-3 min while `integration_4` ran 5m25s, and adding one file reshuffled the partition and pushed it past the 6-minute job ceiling (a suite reporting `pass 670 / fail 0`, killed by the job clock). `scripts/run-integration-tests.sh` still owns file selection, but now pipes the sorted list to `src/test-shards.ts`, which greedy-bin-packs it over measured per-file durations in `scripts/integration-timings.json` (regenerate with `npm run test:integration:timings`) and prints just that shard's files. A file missing from the manifest still runs — it gets a pessimistic default weight; the union of the shards is always the full discovered list (guarded by `src/test-shards.test.ts` and `src/test-shards.integration.test.ts`). Because the planner can route the F31 preflight test (`node-preflight.integration.test.ts`, which treats `FORGE_TEST_MISMATCHED_NODE` as a HARD requirement) to any shard, all five integration shards provision the ABI-incompatible Node. `test-extended` `needs` all seven and, with `if: always()`, runs a single aggregate step that exits non-zero unless every dependency's `result` is `success` — so a failed, cancelled, or skipped shard fails the required check closed; it can never go green on incomplete extended coverage. No test moved, weakened, or left the required gate — only how it is scheduled changed. Dashboard's slow/integration coverage still runs only here — its share of the canonical `test` gate (`npm run test:all` → `npm test -w dashboard`) is the fast tier only, mirroring how the root's own integration/worktree tiers are kept out of `test`. Branch protection carries both `test` and `test-extended` as required contexts (applied host-side by the orchestrator); a red `test-extended` aggregate blocks merge exactly like a red `test` run. What FG-495 changed is *where* this coverage runs (CI, off-host, in parallel with `test` and with review-loop verification) and how often the operator pays for it interactively — never per round: the review-loop's per-round verification (FG-501) defaults to reusing covering evidence or waiting for the required check to go green rather than running anything locally, and even its CI-unavailable/dirty-tree local fallback only re-runs the fast unit-tier scripts (`typecheck` + `test`), not the dashboard-inclusive `test:all` CI runs. Merge happens once per ticket, and the sharded extended jobs run in parallel with review, so full extended coverage is affordable at that boundary even though it would be too slow to re-run every round. Locally, `npm run test:extended` still runs the whole sequence unsharded (`test:integration` now calls the same `scripts/run-integration-tests.sh`).

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

# Re-measure per-file integration cost and rewrite scripts/integration-timings.json,
# the manifest CI's five shards are balanced against (FG-624). Serial by design —
# ~11 min on a dev box. Run it when the tier's shape changes materially; a stale
# manifest degrades gracefully (unmeasured files still run, at a default weight).
npm run test:integration:timings

# Git worktree, dispatch/fanout orchestration
npm run test:worktree

# Root integration + worktree tiers, plus dashboard's integration tier —
# the local unsharded equivalent of CI's required test-extended merge gate
# (which runs the same coverage as seven concurrent sharded/tiered jobs)
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

### What `forge-test` does before it runs anything (FG-520)

`forge-test` never runs the tests against `/project` directly — the host's `node_modules` carries native modules built for the host platform, so `better-sqlite3` would fail to `dlopen` inside the container. It runs them from a writable scratch at `/tmp/forge-work` instead. Two things happen on **every** invocation, before a single test executes:

- **Source re-sync.** The scratch is mirrored from `/project`: changed files copied in, deleted files removed, `node_modules` / `.git` / `.terraform` left alone. Edit source and re-run `forge-test`, and you are testing the code you just wrote — no cache to bust, nothing to clean out by hand. The scratch keeps its own natively-built `node_modules` (that's the whole point of the scratch) and its own `.git`, copied once when the scratch is created. When `/project` is a linked git worktree that copy is the `gitdir:` pointer file, so the scratch shares the worktree's read-only parent `.git` rather than getting an independent one (FG-559 — the previous `-d` guard was false for a pointer file and left the scratch with no git at all).
- **Dependency validation and repair.** The scratch has to be able to actually load `tsx` and `better-sqlite3`. If `node_modules` is empty, if `package.json`/`package-lock.json` changed since the last install, or if `tsx` won't load, `forge-test` reinstalls (`npm ci`) and rebuilds the native/platform binaries — announcing each step on stderr (`forge-test: installing deps in /tmp/forge-work — …`, `forge-test: deps installed`). The first run in a fresh container therefore takes a minute; later runs are near-instant unless deps actually changed.

**Exit code 2 with a `FATAL` line is an environment failure, not a test failure.** If the scratch can't be repaired — `tsx` still won't load after an install and an esbuild rebuild, or `better-sqlite3` won't load after a from-source rebuild — `forge-test` stops before running the suite and says so:

```
forge-test: FATAL: 'tsx' cannot load from /tmp/forge-work after install + esbuild rebuild.
forge-test: this is an ENVIRONMENT failure, not a test failure — do not report it as red tests.
```

Read that as **infra broken, tests unknown** — no test result was produced. Report it as an infra/environment problem (agents: surface it in `evidence`, not as `tests_failed`); do not report red tests, and do not treat it as a regression in your diff. The failure modes it forecloses are exactly the two that used to look like red tests: a suite silently run against a stale snapshot of the source, and an empty scratch `node_modules` failing every test with `ERR_MODULE_NOT_FOUND: 'tsx'`.

## Naming a new test file

Pick the suffix that matches the slowest operation the test performs:

- No subprocess, no git, no disk DB, no real sleep → `<module>.test.ts`
- CLI spawn, real git fixture setup (`execFileSync`), on-disk DB, or a real wall-clock sleep → `<module>.integration.test.ts`
- Git worktree or orchestration dispatch → `<module>.worktree.test.ts`

If you're unsure whether a fixture helper's `execFileSync("git", ...)` call counts: it does. The content guard (above) will fail the unit tier if it lands there anyway.

Colocate the file next to the module it tests (`src/foo/bar.ts` → `src/foo/bar.test.ts`). Ticket-scoped regression files live under `src/v2/` and follow the same suffix rule.

## Crash-point probes and the crash matrix (FG-530)

`src/v2/crash-points.ts` exports `crashPoint("<name>")` — a test-only kill-injection probe planted between adjacent writes in the finalize sequences (`src/v2/runNext.ts`, `src/v2/gate.ts`, `src/v2/reconcile.ts`). With no hook installed it is one undefined field read and an optional call that never fires, so it is inert in production; the only files that may reach `setCrashHookForTest` are `*.test.ts` files and the one shared crash driver, `src/v2/fg530-harness.ts` — which both FG-530 lanes import and which registers no tests of its own, so it carries no `.test.ts` suffix. That carve-out is named explicitly in the content guards and paid for by a test that fails if any production file imports the harness, which is the only way it could hand production a path to the setter. `src/v2/fg530-crash-matrix.integration.test.ts` arms the hook at one named point per cell, drives the real runner over a fake docker layer, then reconciles to a fixpoint with the hook disarmed and asserts five named lifecycle invariants (no complete without evidence, no permanent wedge, abandoned never overwritten, persisted work never discarded, fixpoint idempotent).

**The cross product is ragged on purpose: coverage is per kill point, not per cell.** No scenario walks every write boundary — a plain auto-gate run never reaches a gate-reject window — so a cell is a **kill cell** where its scenario reaches the armed point (the hook throws mid-sequence and nothing after it writes) and a non-kill **smoke cell** where it does not (the drive runs to its natural end). The invariants must hold on both, so the smoke cells still assert something real; each cell prints which it was as a test diagnostic. The guarantee that every registered point is *actually* killed at is enforced over the whole registry rather than per cell: the matrix's coverage test fails unless every kill point fired in at least one cell, and the invariant-3 cancel-race loop runs each point in the first scenario that reaches it and throws by name when none does. A probe nothing can kill at is loud, not silent.

**Adding a probe means updating three lists, not one.** A `crashPoint()` callsite in production must also be registered in:

- `KILL_POINTS` in `src/v2/fg530-harness.ts` — the registry the matrix imports and iterates. A probe with no entry here is a write boundary no cell ever kills at.
- `PROBE_NAMES` in `src/v2/crash-points.test.ts` — the list inertness is proven against.

`src/v2/fg530-probe-inertness.test.ts` (unit tier) asserts those two sets and the probe names production actually carries are **one set**, in both directions, by reading the sources as text. Add a probe without registering it and that lockstep test fails loudly; delete a probe without dropping its registry entry and it fails the other way. The same file pins the surrounding rules: probes may exist only in the three known write-boundary files, production may import `crashPoint` and never the setter, and the matrix's own coverage test requires every registered kill point to have fired in at least one cell.

**A kill takes the store away, not just throws.** The hook throws *and* swaps the DB handle for one whose every access throws. A throw alone would not model a crash on the reconcile surface: `reconcileRun`'s FG-459 guards deliberately swallow a throw from one task's writes and keep sweeping (the right production contract — a `SQLITE_BUSY` must not abort the pass), so a "dead" process would go on finalizing the run's other tasks and the fresh recovery pass would start from a world no crash could have produced. The guards may still catch the throw; they cannot make the dead process write. A dedicated cell (`FG-530 crash model`) pins this: two tasks stranded identically, killed at the first, and the second must be untouched.

**Probe arguments must be bare string literals.** `crashPoint("gate:before-decision-write")`, never `crashPoint(someExpression)`. A computed argument is evaluated on *every* production call, hook or no hook — cost, and a throw risk, on the finalize path. This is content-guarded against the source, since a hook-unset runtime check cannot see it.

**The matrix is integration tier.** It drives a real DB and a real temp filesystem, so it carries the `.integration.test.ts` suffix and runs under `npm run test:integration` / `npm run test:extended` — i.e. in CI's required `test-extended` check, never in the fast unit tier. The probe-inertness file asserts that tier placement against `package.json`'s scripts directly, so the matrix cannot drift back into the unit tier.

**Known-failure cells are pinned, not muted.** FG-530's scope guard is that a kill point exposing a real bug gets *filed*, not fixed in the same ticket. Such a cell is pinned in `KNOWN_FAILURES` by invariant name + a regex over the violation detail (a signature, not a `(scenario, kill point)` pair — a pair-list would silently absorb a different bug landing in the same cell), and gets a `todo`-marked minimal repro test alongside it, so the suite stays green while any *new* invariant break still fails. Every pin has a filed ticket. None is live today — every pin filed so far has been fixed and deleted (see below) — but the mechanism stays, since the next kill point that exposes a real bug gets pinned the same way. A rot check asserts every known-failure signature is still hit by at least one cell — a pin that stops firing means either the bug was fixed or the scenario stopped reaching it. When the bug is fixed, its `todo` starts passing (node reports it), which is the prompt to delete the pin and flip the repro into a plain passing assertion.

**FG-530-B, FG-530-A and FG-533 are the worked examples of that last step.** The matrix caught `forge gate <id> reject` NULLing the rejected task's result — the reject branch called `failTask()` without `result`, unlike the adjacent request-changes branch that passes it deliberately — and it was pinned and filed as FG-532 rather than fixed in FG-530. FG-532 fixed it (`gate.ts`'s reject branch now passes `result: task.result` through `failTask`, so a rejected task keeps its artifact as the audit record for why it was rejected). The matrix likewise caught the `awaiting_red` crash window at both of its callsites (a crash between the `awaiting_red` status write and the reds' terminal write, in `dispatchSingleStep` and in a wave's `dispatchFanoutStep` parent), pinned as `FG-530-A` and filed as FG-531; FG-531 fixed it with reconcile's `awaiting_red` sweep, which lands the orphaned task fail-safe (see [Orphaned task recovery](concepts.md#orphaned-task-recovery)). It caught the pre-container crash window the same way (a crash after `markTaskRunning` + `task.started` but before `container.started`, leaving a `running` task that neither reconcile nor `forge retry` would rescue since both gated on `container.started`), pinned and filed as `FG-533`; FG-533 fixed it with reconcile's [pre-container sweep](concepts.md#the-pre-container-crash-window), which lands the task as the retryable `pre_container_crash` kind. In all three cases the `KNOWN_FAILURES` entry is deleted and the cells are now plain passing recovery assertions instead of `todo`-marked repros. With the pins gone, a regression fails the matrix loudly.

## Timing data and classification history

`docs/test-suite-timing-fg495.md` has the full per-file/per-tier timing measurements behind FG-495's tiering decision, plus a file → old-tier → new-tier → reason table for every test relocated out of the unit tier when the content guard was extended.
