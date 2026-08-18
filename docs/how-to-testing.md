# How-to: writing and running tests

## Test tiers

The root suite is split into three tiers selected by **filename suffix**. Every `src/**/*.test.ts` file belongs to exactly one tier — `src/test-tiers.test.ts` enforces this as a partition proof that fails the suite if any file is in two tiers or in none, plus a content guard (see "Content-guard purity" below) that catches subprocess/sleep patterns creeping into the unit tier regardless of filename.

The `dashboard` workspace has its own fast/integration split over `dashboard/src/` (see the FG-495 review fix below), plus a **browser tier** selected by directory rather than suffix — `dashboard/browser-tests/*.test.ts`, which drive a real Chrome. The root partition proof covers `src/` only, so it says nothing about those.

| Tier | Suffix | Command | Steady-state wall time |
|------|--------|---------|---|
| Unit (canonical/default) | `*.test.ts` (excluding the two below) | `npm test` / `npm run test:unit` | ~2s |
| Integration | `*.integration.test.ts` | `npm run test:integration` | ~93s |
| Worktree | `*.worktree.test.ts` | `npm run test:worktree` | ~2s |
| Dashboard browser | `dashboard/browser-tests/*.test.ts` (directory, not suffix) | `npm run test:browser -w dashboard` | ~6.5s |
| Extended (integration + worktree + dashboard integration) | — | `npm run test:extended` | ~95s |
| Canonical deterministic gate | unit + dashboard workspace | `npm run test:all` | ~2.5s |

**FG-495 review fix: the dashboard workspace has the same two-tier split as the root.** Round 1 of FG-495 renamed `dashboard/src/routes-backlog.integration.test.ts` but left `dashboard/package.json`'s `"test"` script matching every `*.test.ts` file, so the "integration" name was cosmetic — that file (which boots a real HTTP server on a real port against a real fixture backlog) still ran inside `npm test -w dashboard`, and therefore inside `npm run test:all`, the canonical gate. `dashboard/package.json`'s `"test"` script now excludes `*.integration.test.ts` (mirroring `test:unit`'s `find` exclusion above), and a new `"test:integration"` script runs just that file. The dashboard integration tier runs in `npm run test:extended`, alongside the root's integration/worktree tiers; the canonical gate (`npm run test:all` → `npm test -w dashboard`) now runs only dashboard's fast tier.

**FG-495: `npm test` is the unit tier, not a three-tier aggregate.** Before FG-495, bare `npm test` (and therefore `npm run test:all`, and therefore the CI required check AND the review-loop's own per-round verification, which runs `scripts["test"]` — see `runVerification` in `src/v2/review-loop.ts`) ran all three tiers combined, at ~107s. That was too slow to be the deterministic check paid on every commit and every review-loop round. `npm test` now aliases `npm run test:unit`; `npm run test:all`'s script text is unchanged (`npm test && npm test -w dashboard`) but is fast because `npm test` is now unit-only. The slow integration + worktree coverage didn't disappear — it moved to the explicit `npm run test:extended` tier, which runs in CI as its own required merge check (see below) rather than as part of the fast per-round gate. Full before/after timing data and the list of files reclassified into integration/worktree lives in `docs/test-suite-timing-fg495.md`.

`npm run test:all` is deliberately left as the literal command string both `.github/workflows/ci.yml`'s `test` job and `REQUIRED_CI_GATE_COMMAND` (`src/store/host-verifications.ts`) reference for FG-419/FG-474's content-verified evidence-reuse and anti-spoofing matching — changing the command name would have required touching that matching logic too. The speed fix is entirely in what `npm test` now means, not in renaming the gate.

That command-matching pairing is necessary but not sufficient for CI-sourced evidence: since a later FG-495 review finding (commit f59b47b), a green paired `CI / test` check no longer mints a `source: 'ci'` host-verification row by itself. `findCoveringGateEvidence` (`src/store/host-verifications.ts`) also requires **every** job in the matched CI workflow — `test` AND `test-extended` — to be green at the exact same sha; a red, pending, or absent sibling job fails closed to no CI coverage.

## Continuous Integration (FG-474, tiering FG-495)

`.github/workflows/ci.yml` has the fast `test` job plus the extended merge gate, which is now sharded across thirteen concurrent jobs behind a fail-closed aggregate:

- **`test`** (check name `CI / test`) — a **required** merge-gate check. Runs `npm run test:all` (unit tier + dashboard workspace, plus `npm run typecheck`) on every push and on every PR into `main`, pinned to the Node version in `.nvmrc` (24) so the better-sqlite3 native module always matches the runner's ABI. The review-loop's own per-round verification does not duplicate this CI job by default (FG-501): on a clean tree it reuses covering evidence for HEAD, or waits for this required check to go green and reuses that once it does. Only a dirty tree, or a wait that finds CI unavailable/failed-precondition/timed-out, falls back to a real local run via `runVerification` (`src/v2/review-loop.ts`), which runs `npm run --silent typecheck` and `npm run --silent test` as two separate steps — the unit tier only, never the literal `npm run test:all` command and never the dashboard workspace — so it needs to stay under the <=60s target / <=120s ceiling. CI's `test` job additionally covers the dashboard workspace on every push/PR; it now completes in ~2.5s server-side, where the pre-FG-495 version took ~107s.
- **`test-extended`** (check name `CI / test-extended`) — also a **required** merge-gate check, not informational, and still the exact branch-protection context. It no longer runs `npm run test:extended` itself; the extended coverage is split across **thirteen concurrent jobs** so the required gate finishes with headroom under 5 min instead of running sequentially: **eight** root-integration bulk shards `integration_1`..`integration_8` (each running `bash scripts/run-integration-tests.sh k/8`), a dedicated **`integration_serial`** lane (`bash scripts/run-integration-tests.sh serial`), a `worktree` job (`npm run test:worktree`), a `dashboard_integration` job (`npm run test:integration -w dashboard`), a `dashboard_browser` job (`npm run test:browser -w dashboard`, the real-Chrome tier described in [The dashboard browser tier](#the-dashboard-browser-tier-fg-642) below), and a `fg693_alias_identity` job (the FG-693 identity suite re-run with `TMPDIR` pointed at a symlink). **FG-624:** the bulk shards are not partitioned by Node's `--test-shard`. That split the `*.integration.test.ts` files by FILE INDEX, which is an arbitrary split of COST — on `main` three shards finished in ~2.5-3 min while one ran 5m25s, and adding one file reshuffled the partition and pushed it past the job ceiling. `scripts/run-integration-tests.sh` still owns file selection, but pipes the sorted list to `src/test-shards.ts`, which greedy-bin-packs it over measured per-file durations in `scripts/integration-timings.json` and prints just that shard's files. A file missing from the manifest still runs — it gets a pessimistic default weight — but a fast-unit-tier guard (`src/integration-timings-coverage.test.ts`, FG-704) fails the PR once manifest coverage of the discovered tier drops below 95%, so an unmeasured file can't stay that way indefinitely; see [Refreshing the timing manifest](#refreshing-the-timing-manifest-fg-704) below. The union of the eight bulk shards is always the full discovered list minus one file (guarded by `src/test-shards.test.ts` and `src/test-shards.integration.test.ts`). **FG-704: eight bulk shards, not six.** CI evidence showed the ~1481s x64 bulk test-time over 6 shards ran ~4.1–5.5m worst-case — a single 222s file (`campaign.integration.test.ts`, since split by FG-728 — see [Refreshing the timing manifest](#refreshing-the-timing-manifest-fg-704) below) anchors a shard floor no packer can split below — so 6 (and 7) shards could not meet the sub-5min + p95<4:15 target; over 8 shards the worst case is ~3.8m, the headroom that target needs against normal runtime variance. **FG-681/FG-704: the serial lane.** `src/orchestrator/fg576-codex-adapter.integration.test.ts` (fg576) carries AC9 correlation tests that observe a real 30-second production window and prove correlation at ordinary operating capacity — they must run with **nothing else concurrent**, not merely in a smaller bucket, or the same scheduling flake is only postponed. fg576 is therefore excluded from the bin-packer entirely (bulk packing is a clean eight-way split of discovered-minus-fg576) and runs alone, under `--test-concurrency=1`, in its own `integration_serial` job — concurrently with the eight bulk shards, never skipped, weakened, or moved to a separate/nightly run. **FG-647:** every shard now runs on the `.nvmrc` interpreter alone — none of them downloads a second Node. The shards used to provision Node 26 (ABI 147) and export `$FORGE_TEST_MISMATCHED_NODE` for a preflight arm that executed under a genuinely ABI-incompatible interpreter; that arm searched the host for one and skipped when it found none, which made the tier's outcome depend on environment inventory (and left the only skip in the tier). It is deleted. The ABI contract it claimed is proven deterministically instead — see [The ABI preflight coverage](#the-abi-preflight-coverage-fg-647) below. `test-extended` `needs` all thirteen and, with `if: always()`, runs a single aggregate step whose fail-closed check is **derived from `${{ toJSON(needs) }}`** (FG-704) rather than a hand-maintained results string — a job present in `needs` is therefore automatically covered by the gate, so a job added to `needs` and forgotten in a hand-written results list can no longer happen — and exits non-zero unless every dependency's `result` is `success`; a failed, cancelled, or skipped job fails the required check closed and it can never go green on incomplete extended coverage. Every job's `timeout-minutes` stays 10 — a hang ceiling, not the latency budget; see [runtime policy](#refreshing-the-timing-manifest-fg-704) below. No test moved, weakened, or left the required gate — only how it is scheduled changed. Dashboard's slow/integration coverage still runs only here — its share of the canonical `test` gate (`npm run test:all` → `npm test -w dashboard`) is the fast tier only, mirroring how the root's own integration/worktree tiers are kept out of `test`. Branch protection carries only `test` and `test-extended` as required contexts (applied host-side by the orchestrator) — the individual shard/job names underneath `test-extended` are never required contexts themselves; a red `test-extended` aggregate blocks merge exactly like a red `test` run. What FG-495 changed is *where* this coverage runs (CI, off-host, in parallel with `test` and with review-loop verification) and how often the operator pays for it interactively — never per round: the review-loop's per-round verification (FG-501) defaults to reusing covering evidence or waiting for the required check to go green rather than running anything locally, and even its CI-unavailable/dirty-tree local fallback only re-runs the fast unit-tier scripts (`typecheck` + `test`), not the dashboard-inclusive `test:all` CI runs. Merge happens once per ticket, and the sharded extended jobs run in parallel with review, so full extended coverage is affordable at that boundary even though it would be too slow to re-run every round. Locally, `npm run test:extended` still runs the whole sequence unsharded (`test:integration` now calls the same `scripts/run-integration-tests.sh`, bulk followed by the serial tail).

### Refreshing the timing manifest (FG-704)

`scripts/integration-timings.json` is the per-file duration manifest `src/test-shards.ts` bin-packs the eight bulk shards against.

**FG-704: the packer balances batched-execution cost, not the raw manifest weight.** `scripts/measure-integration-timings.ts` times each file in its OWN `node --test` process, so every manifest weight is `process_startup + test_exec`. A CI shard, though, runs all its files in ONE `node --test` batch and pays that process-startup cost ~once, not once per file — so packing directly on the manifest's raw per-file weights over-weights a shard that holds many small files relative to one that holds a few large ones. `src/test-shards.ts` corrects for this before packing: it discounts a constant estimated per-file startup, `STARTUP_DISCOUNT_MS` (2400ms), from each file's raw weight, floored positive (`packWeight = max(FLOOR_MS, rawWeight - STARTUP_DISCOUNT_MS)`), and packs on that discounted weight instead. The 2400ms figure is derived from the x64 measurement run itself: the manifest's serial per-file total (`measuredWith.serialTotalMs`) against the actual batched bulk total summed from a real sharded CI run implies ~2.4s of overhead paid once-per-file under serial measurement but ~once-per-shard under batched execution; see the derivation and re-derive procedure documented inline in `src/test-shards.ts`. Balancing raw serial weight is what mis-balanced the tier at six shards — a bin-packer optimizing for a cost no shard actually pays skews toward shards with more, smaller files. `src/fg704-batched-balance.test.ts` pins the acceptance property on the real manifest: the eight-way batched partition stays within ~10% of ideal, including the shard holding the heaviest unsplittable file.

The coverage guard and refresh procedure below are unchanged by the batched cost model — it only changes how a measured weight is *consumed* when packing, not how the manifest itself is measured or regenerated.

**The canonical refresh is the `Measure integration timings` CI job** (`.github/workflows/measure-integration-timings.yml`, `workflow_dispatch` only). Trigger it from the Actions tab, let it run (~15-20 min serial), download the `integration-timings` artifact it uploads, and commit `scripts/integration-timings.json`. It must be the canonical refresh because the manifest has to be measured on **the same x64 architecture CI runs**: the arm64→x64 slowdown is NON-UNIFORM (subprocess-heavy tests scale ~2x, others ~1.3x), so an arm64-balanced partition — e.g. one measured in an Apple-Silicon Docker container — mis-balances on the x64 CI runner even though the timings are "relative-weight-only". The job runs `npm run test:integration:timings` on `ubuntu-latest` with the same `.nvmrc`/`npm ci` setup as the integration shards, and echoes the resulting `measuredWith` (platform/node/serialTotalMs) to its run summary so it is visibly confirmed as `linux-x64`. Since FG-728, `scripts/measure-integration-timings.ts` spawns each file with the same build preload (`--import ./src/integration-build-preload.ts`) the runner uses, in the same argv position, so a CLI-spawning file measures against the built entry rather than failing to find it; the ppid-shared build-once coordination means the whole measure run still builds only once.

The local command remains valid for a **rough/relative** refresh, but is **NOT authoritative for CI balance** if run on a different architecture than CI (e.g. an arm64 laptop or container):

```bash
npm run test:integration:timings
```

The manifest's own `$comment`/`measuredWith` fields record what produced it (node version, platform, core count, total serial time) so a stale or off-platform regeneration is visible in the diff.

**Thirteen integration tests require host tmux/docker/git-identity setup that fails fast in a plain container** (see [Tmux socket isolation](#tmux-socket-isolation-for-tests-that-touch-tmux-fg-614fg-680) below, and the FG-621/FG-664 host-only smokes further below) — a bare container measurement would under-weight those files and risk unbalancing a shard. For that set, the committed weight is `max(container measurement, prior working-linux manifest value)`, so a container run that fails fast can never push a file's weight down. This reconciliation is what `measuredWith.reconciledEnvDependent` in the manifest counts.

**The coverage guard.** `src/integration-timings-coverage.test.ts` (fast unit tier — it gates every PR) fails when the manifest measures less than 95% of the discovered `*.integration.test.ts` corpus, so a newly-added or renamed integration file can't stay unmeasured indefinitely. If it reds, regenerate the manifest as above — do not lower the floor or hand-edit `scripts/integration-timings.json`.

**Runtime policy.** The objective is sub-five-minute PR feedback with headroom: the p95 of the slowest *healthy* integration job should land under 4:00–4:15, and every healthy job should finish under 5:00. `scripts/run-integration-tests.sh` emits a `::warning::` once a job crosses 4 minutes — well before the 10-minute job-clock ceiling — so the objective slipping is visible as a warning, not only as a cancellation at the ceiling. The 10-minute `timeout-minutes` is a **hang ceiling**, not the latency SLO: it bounds how long a genuinely stuck job is allowed to run, and is deliberately not tightened to the 5-minute objective.

**Current status (2026-08-18): the single-file anchor behind the p95 gap is gone.** The hard gate was already met pre-FG-728 (worst observed ~289–297s, on the shard holding the old `campaign.integration.test.ts`), but the p95 <4:00–4:15 headroom target was not: that file was a single ~222–290s CLI-spawning file, and no sharding can split a single file below its own runtime, so whichever shard held it was anchored above 4:15 regardless of how the rest of its load was packed. **FG-728** (the [build-once CLI spawn](#build-once-cli-spawn-for-integration-tests-fg-728)) removed that anchor two ways: `campaign.integration.test.ts` is now four files, `campaign-a/b/c/d.integration.test.ts` (64/27/12/36s in the refreshed manifest, none close to the old single-file cost), and every migrated CLI-spawning file dropped per-spawn cost by launching the prebuilt CLI instead of cold-transpiling it. Against the manifest refreshed on x64 post-migration, the packer's projected weight across all eight bulk shards is now tightly balanced (~208–208.4s each) — well under the 4:00–4:15 target, with no shard singled out by a large file the way the old single shard was. That is the manifest's projected weight, not yet reconfirmed against real CI wall-clock runs on the new topology; the next few `test-extended` runs are what settle whether the p95 headroom target is actually met, not just projected.

**Diagnosing drift.** Each job emits a machine-readable `FORGE_INTEGRATION_JOB_SUMMARY` line on stdout and a per-job table in `$GITHUB_STEP_SUMMARY` (selected files, projected weight from the manifest, actual duration, manifest coverage, and the projected-vs-actual skew percentage), plus node:test's own parsed TAP pass/fail counts — so a job that timed out mid-run (no summary, `status=no_node_test_summary_likely_cancelled`) is distinguishable from a genuine assertion failure (`status=assertion_failure`). **A growing projected-vs-actual skew is the signal a shard has drifted out of balance; the fix is a manifest refresh** (`npm run test:integration:timings`), not a hand edit to the shard count or selectors.

Running the aggregate on the host is still normal during local iteration (`forge-test --all`, or `npm run test:all` directly); what changed with FG-474 is that the merge decision reads CI's result rather than triggering a second, invisible host run of the same suite. What changed with FG-495 is that the per-round host/CI cost is now fast (canonical gate is unit-only), while full coverage — including the slow integration/worktree tiers — still gates the actual merge via the parallel `test-extended` check.

## The ABI preflight coverage (FG-647)

`src/cli/node-preflight.integration.test.ts` proves the contract F31 exists for: forge refuses an incompatible release ABI **by name, before any native module loads**, so the operator reads a named refusal rather than better-sqlite3's opaque `ERR_DLOPEN_FAILED`. Each ABI arm stages a release tree, writes a manifest, and runs the **real CLI entry** inside it — an executed assertion, not a pure-function one, because a pure-function test stays green even when the native binding loads three imports earlier and crashes. (Two arms are shaped differently on purpose: the dev-checkout arm stages the tree and writes *no* manifest, and the import-graph probe runs no CLI entry at all.)

The mismatch is manufactured in the **manifest**, never by finding a second interpreter, so the whole file is deterministic under the one `.nvmrc` Node that is always present:

- a manifest ABI **newer than** the running interpreter's (`999`) → refused by name, naming both ABIs (string and unquoted-number forms — the numeric one refuses by that same named message rather than `TypeError`-ing on its own manifest's type);
- a manifest ABI **older than** the running interpreter's (`1`) → refused as a NEWER-actual (the exact case the pre-FG-570 `major >= 24` floor waved through);
- a manifest ABI **equal to** the running interpreter's → runs, no false refusal (string and unquoted-number forms);
- **unreadable ABI evidence fails closed** — empty, unparseable, missing `abi`, a truncated/malformed manifest, or a structurally garbage value → refused by name, naming the manifest, never falling back to the pinned constant and never a stack trace;
- a **dev checkout** (no manifest) falls back to the pinned `REQUIRED_ABI`, and asserts that constant has not drifted from the interpreter this checkout's binding was built for;
- the preflight's own **import graph is native-free** — a fresh process imports it and inspects the real CJS module cache for a loaded binding, because the guard only beats the crash if nothing in its own graph triggers it first.

Every arm that expects a **refusal** additionally asserts `doesNotMatch(/NODE_MODULE_VERSION|ERR_DLOPEN/)` — the refusal has to *beat* the native loader, not merely coexist with it. The arms that expect the entry to **run** assert the converse instead: the two equal-ABI arms take a clean exit 0, a printed version, and no `refusing to run`; the dev checkout takes a clean exit 0 plus the `REQUIRED_ABI` drift check; the import-graph probe takes an empty native module cache.

**There is no second-interpreter arm and no CI provisioning behind it.** Before FG-647 the file also searched `~/.nvm/versions/node` and `/usr/local/n/versions/node` for an ABI-incompatible Node, and CI compensated by downloading Node 26 into all five integration shards and exporting `$FORGE_TEST_MISMATCHED_NODE`. That arm tested the host's inventory rather than forge, duplicated the coverage above, and skipped wherever no second interpreter was installed — the only skip in the whole integration tier. It was deleted rather than replaced: **do not reintroduce a skip, an optional probe, or any other environment-conditional arm here.** `src/v2/ci-workflow.test.ts` fails if any CI job provisions a second interpreter again.

Half of that prohibition enforces itself; the other half is review-enforced. `src/cli/fg647-preflight-no-skip.integration.test.ts` spawns the preflight suite as a real child (with `NODE_TEST_CONTEXT` cleared so the child emits its own TAP summary rather than folding into the parent's stream) and reads the counts it reports: `skipped` and `todo` must both be `0`, `fail` must be `0`, and `pass` must be at least the twelve arms that existed when FG-647 landed — a floor, so adding deterministic coverage is fine and quietly losing it is not. A skip introduced by any mechanism — `t.skip()`, the `{ skip }` option, `test.skip`, `todo` — reddens instead of reading as green in a summary where a skipped arm and a passing arm look alike. Its second arm reads the suite's source for the deleted discovery machinery *by name* (`FORGE_TEST_MISMATCHED_NODE` and the two interpreter roots), which catches what the counts cannot: a revival of that particular arm as a *mandatory* test, which would redden rather than skip and so put the tier's outcome back on the host's inventory.

What neither arm sees is an arm that consults the environment and returns green when it finds nothing — a different interpreter root, a `which`, any `if (!present) return`. It registers as a pass, keeps the twelve-arm floor met, and matches none of the three denylisted strings. So only the skip/todo half, and a by-name revival of the deleted machinery, are mechanical; **no optional probe, no other environment-conditional arm** is a prohibition enforced at review. Reintroducing environment dependence in a shape the guard does not name is a review rejection, not a red suite — and if you find yourself wanting one, manufacture the mismatch in the manifest instead.

## The dashboard browser tier (FG-642)

`dashboard/browser-tests/*.test.ts` is sixteen suites / 99 tests that drive a **real Chrome** through `playwright-core` against a fixture HTTP server serving the dashboard's actual shell and client bundle. It is the only tier that proves the rendered UI, so it is where UI regressions (the backlog aggregate count, the FG-608 cutover labels, offline boot of the released client) are pinned.

```bash
npm run test:browser -w dashboard      # the whole tier, ~6.5s with a browser present
```

**It is not in any aggregate script.** `npm run test:extended` and `npm run test:all` do not run it, and `forge-test` has no `--browser` flag — the command above is its only entry point. Before FG-642 it also ran in CI nowhere, which is how it went dark: anywhere but a Chrome-carrying host it found no browser, skipped every test, and reported green — which is how it hid a live FG-608 red. It now runs in CI as the `dashboard_browser` job feeding the required `test-extended` aggregate.

### Finding Chrome

One resolver, `src/util/chrome-bin.ts`, serves both the browser tier and the host-side CDP session capture behind `forge auth-profile login`. It resolves in this order:

1. **`FORGE_CHROME_BIN`** — **authoritative when set.** If it is set, it is the *only* thing consulted. A value naming a path that does not exist, or naming a directory (`/Applications/Google Chrome.app` is the natural macOS mistake — the executable is several levels inside it), **fails** with the named precondition below. It does not fall through to another Chrome, so a stale override is reported as the stale override rather than silently running a different browser. This is a behavior change: the pre-FG-642 capture path treated the variable as a first candidate and fell through when it missed.
2. **`CHROME_PATH`** — a lenient first candidate, kept for its long-standing meaning here: if it does not resolve, probing continues.
3. The known locations, in order — the two macOS app bundles, `/usr/bin/google-chrome`, `/usr/bin/google-chrome-stable`, `/usr/bin/chromium`, `/usr/bin/chromium-browser`, and `/usr/local/bin/chromium` (the agent image's symlink to Playwright's chromium; without this entry the tier is dark in exactly the container the verify phase runs in).

A candidate must be a **file**. Symlinks are followed deliberately — the agent image's `/usr/local/bin/chromium` *is* a symlink.

### It fails, it never skips

A Chrome-less environment takes every one of the 99 tests **red** on a file-wide `before` hook, with a precondition that names what is missing and how to supply it:

```
chrome precondition: the dashboard browser tier requires a real Chrome/Chromium binary and none was
found — FORGE_CHROME_BIN is set to /nonexistent and no file exists there. Set FORGE_CHROME_BIN to its
path (agent containers ship /usr/local/bin/chromium; macOS: /Applications/Google Chrome.app/Contents/
MacOS/Google Chrome; ubuntu: npx playwright-core install --with-deps chromium). A Chrome-less
environment must FAIL this tier, never skip to green (FG-642).
```

Modeled on the FG-551 tmux tier: an environment that cannot run the work fails loudly instead of reporting a green nothing. `dashboard/src/fg642-browser-tier-fail-first.integration.test.ts` pins it by spawning the real tier with the override pointed at an absent path and asserting the Chrome-less run reports `tierTestTotal()` failures / 0 passes / 0 skips — reproducible on a laptop, a runner, or a container alike, precisely because the override outranks a working `CHROME_PATH`. Since FG-694 the test carries no count literal of its own: `src/util/browser-tier-census.ts` is the one source of truth for the tier's suite set and per-suite counts (99 tests across 16 suites as of FG-395, which added `fg395-campaigns.test.ts`), and both this guard and `src/util/fg642-browser-tier-consistency.test.ts` resolve their expectation from it — see [`browser-tier-census.ts`](../src/util/browser-tier-census.ts).

### Running it in an agent container

The tier works out of the box — the agent image ships chromium at `/usr/local/bin/chromium`, which the resolver probes. But `/project` is not where tests run: its `node_modules` is unusable from the container (see [What `forge-test` does](#what-forge-test-does-before-it-runs-anything-fg-520)), so run the tier from `forge-test`'s scratch instead:

```bash
forge-test src/util/chrome-bin.ts        # any invocation: syncs source + installs deps in the scratch
cd /tmp/forge-work/dashboard && npm run test:browser
```

`FORGE_CHROME_BIN=/nonexistent npm run test:browser` in the same directory is the one-command demonstration that the tier fails rather than skips.

### In CI

The `dashboard_browser` job provisions the browser the same way the agent image does — `npx playwright-core install --with-deps chromium`, driven through the *pinned* `playwright-core` the tier itself imports, so the browser always matches the client with no version bump of either. Playwright installs under `~/.cache/ms-playwright`, which is not one of the resolver's system locations, so the job then sets `FORGE_CHROME_BIN` to `require('playwright-core').chromium.executablePath()`. A runner that somehow lacks a browser fails the job on the precondition — an unprovisioned runner is loud, not silently empty. `src/v2/fg642-ci-browser-job-shape.test.ts` pins that job shape.

### Typechecking

`dashboard/tsconfig.json`'s `include` now covers `browser-tests/**/*.ts` alongside `src/**/*.ts`, so `npm run typecheck -w dashboard` typechecks the tier. Note that CI's `Typecheck` step and the review-loop's fast gate run the **root** `npm run typecheck`, whose `tsconfig.json` includes `src/**/*.ts` only — the dashboard workspace's typecheck is not currently wired into any automated gate, so run it yourself when you touch dashboard or browser-test sources.

## What belongs in each tier

**Unit** — pure functions and in-memory logic only. No subprocess spawning, no real filesystem I/O beyond `os.tmpdir()` scratch, no SQLite on disk, no git operations, no `sleep` or deliberately long-running operations. Use `new Database(':memory:')` for any schema tests. If a test needs to verify that a CLI command parses correctly or that the database persists across a reconnect, it belongs in integration or worktree — not unit.

**Integration** — tests that spawn a CLI subprocess, write to a real (temp) filesystem, or open an on-disk SQLite database. One process per test, no git worktrees. Typical: `forge backlog list`, reading/writing backlog files, verifying CLI error messages, real-DB round-trips. If the subprocess you spawn is `forge` itself, read [Spawning a `forge` CLI child](#spawning-a-forge-cli-child-fg-645) first — inside an agent container such a child resolves the *container's* backlog authority, not your fixture, and the suite goes green on a host either way — and launch it through the shared spawn authority described in [Build-once CLI spawn for integration tests](#build-once-cli-spawn-for-integration-tests-fg-728), not a hand-rolled `tsx src/cli/index.ts` spawn.

**Worktree** — tests that create git worktrees, exercise dispatch/fanout/merge-back orchestration, or measure control-plane timing. These are expected to be slow. Anything that calls `spawn` for a git worktree operation or tests the full orchestration pipeline at the worktree seam lives here.

**Dashboard browser** — assertions that need a rendered page: the dashboard's UI contracts, driven in a real Chrome. These live in `dashboard/browser-tests/`, not under `src/`, and are the one tier that must resolve a browser — see [The dashboard browser tier](#the-dashboard-browser-tier-fg-642). Never guard one with a skip when Chrome is missing; use `requireChrome()` so the absence fails.

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

# Rough/relative re-measure of per-file integration cost. NOT authoritative for CI
# balance, and its output must NOT be committed unless it was measured on the x64 CI
# architecture. The CANONICAL refresh that produces the committed
# scripts/integration-timings.json — the manifest CI's eight bulk shards are balanced
# against (FG-624/FG-704) — is the x64 "Measure integration timings" CI job
# (workflow_dispatch): run it, download the integration-timings artifact, and commit that
# (see "Refreshing the timing manifest" above). An off-architecture local run — e.g. an
# arm64 laptop, or a linux node:24 container on Apple Silicon — mis-balances the x64
# shards even though the weights are relative-only, because the arm64->x64 slowdown is
# non-uniform. Serial by design; useful locally as a rough aid when the tier's shape
# changes materially, or when the coverage guard (src/integration-timings-coverage.test.ts)
# reds — a stale manifest degrades gracefully (unmeasured files still run, at a
# default weight) until coverage drops below its 95% floor.
npm run test:integration:timings

# Git worktree, dispatch/fanout orchestration
npm run test:worktree

# Root integration + worktree tiers, plus dashboard's integration tier —
# the local unsharded equivalent of CI's required test-extended merge gate
# (which runs the same coverage as thirteen concurrent sharded/tiered jobs).
# NOTE: this does NOT include the dashboard browser tier — that one is not in
# any root aggregate script; run it explicitly (next).
npm run test:extended

# Dashboard browser tier: 16 suites / 99 tests against a real Chrome (FG-642).
# Needs a browser — a Chrome-less environment FAILS all 99, it never skips.
npm run test:browser -w dashboard

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
- **`forge-test <file.test.ts>`** or **`forge-test --test <pattern>`** — run a specific file or pattern directly, with no tier flag.

**A tier flag plus paths narrows that tier, it never runs it broader than asked (FG-695).** `forge-test --unit|--integration|--worktree <path>...` runs exactly those files through the named tier's own runner (its preloads included) — but only after confirming every path is a member of that tier's own file set, derived from the tier's own selection so the two cannot drift. A path may be given relative to the project root or absolute under either the source checkout or the scratch. A non-member path, a missing or directory path, any other flag mixed in, or a tier whose file set the wrapper cannot reproduce **refuses the whole invocation** (exit 2, diagnostic on stderr) rather than silently falling back to the whole tier — before FG-695 the tier flag matched as the first argument only and every path after it was dropped without a word, so `forge-test --integration src/foo.integration.test.ts` ran the entire integration tier while the caller believed it ran one file. `--extended` and `--all` do not accept paths: they chain multiple tiers (and, for `--all`, the dashboard workspace), so there is no single file set to narrow — either refuses with a diagnostic naming what to run instead.

There is no `forge-test --browser`. When your change touches the dashboard UI, run that tier by hand from the scratch — `cd /tmp/forge-work/dashboard && npm run test:browser` — after any `forge-test` invocation has synced and installed there; see [Running it in an agent container](#running-it-in-an-agent-container).

**A green unit tier is in-loop confidence for most changes; it is not, by itself, proof the integration/worktree tiers still pass.** Since FG-495 the unit tier is the fast gate the review-loop re-runs every round via `runVerification` (`npm run --silent typecheck` + `npm run --silent test` — not the literal `npm run test:all` command, and never the dashboard workspace), and CI's `test-extended` job independently re-verifies the integration/worktree tiers as its own required check before merge — both `test` and `test-extended` must be green to merge, not just the fast one. If your change touches CLI-spawn, real-FS/DB, or git-worktree/dispatch code, also run the matching `forge-test --integration` / `--worktree` / `--extended` before reporting complete: the fast gate proves the fast tier, not the slow tiers CI's `test-extended` job covers. Agents must report their validation tier honestly in their result — `status: "complete"` means the diff was validated at the level appropriate for its change.

### What `forge-test` does before it runs anything (FG-520)

`forge-test` never runs the tests against `/project` directly — the host's `node_modules` carries native modules built for the host platform, so `better-sqlite3` would fail to `dlopen` inside the container. It runs them from a writable scratch at `/tmp/forge-work` instead. Three things happen on **every** invocation, before a single test executes:

- **Source re-sync.** The scratch is mirrored from `/project`: changed files copied in, deleted files removed, `node_modules` / `.git` / `.terraform` left alone. Edit source and re-run `forge-test`, and you are testing the code you just wrote — no cache to bust, nothing to clean out by hand. The scratch keeps its own natively-built `node_modules` — that's the whole point of the scratch.
- **Scratch commit (FG-644).** The scratch has its OWN throwaway git repo, and the synced source is committed into it every run (`forge-test: committed the synced source into the scratch's own git`). Two things depend on this. Tests that walk up from cwd looking for a repo find a working one, whatever shape `/project` is (FG-559: the old cold `cp -R` of `/project/.git` copied a `gitdir:` pointer file for a linked worktree, leaving the scratch sharing the operator's read-only admin dir). And the release-build suites can run at all: forge refuses to build a release from a dirty tree, so an agent with work in flight had no way to execute them — the scratch is now a *clean* candidate whose HEAD describes the edits the agent just made, rather than last-committed code. The repo is always one `forge-test` created (marked by `.git/.forge-scratch-repo`); anything inherited is replaced, never committed through.
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

## Spawning a `forge` CLI child (FG-645)

**Any test that spawns a `forge` CLI child and asserts against its own fixture needs the container-authority test seam.** A spawned `forge` resolves its ticket authority from a *compiled-in* path — `CONTAINER_AUTHORITY_MOUNT` (`/forge-backlog`) in `src/backlog/container-authority.ts` — which is probed **before** the environment. Inside an agent container that path carries a real dispatched marker, so the child answers from the host's mounted snapshot instead of from the fixture the test just built. Mutating verbs refuse; read verbs are worse — they exit **0** with foreign content, which is how suites asserting on exit status (or on `match(/FG-10/)`, which any real forge backlog satisfies) went green against the wrong store. On a host neither signal exists, so the same suite passes honestly there: the failure is visible only in a container, i.e. nowhere the author would see it. This is what FG-645 repaired across the suites that spawn a CLI child.

Three helpers in `src/backlog/container-authority.testkit-spawn.ts`, by how the child is launched:

- **`withAuthorityTestkit(entry, args)`** — the argv for a `tsx`/`node` child: it `--import`s the preload *ahead of* `entry`. Order matters — an `--import` after the entry point is an argument to the CLI, not a node flag. Since FG-728, it selects **which** testkit to import from `entry`'s own extension: a built `.js` entry (the build-once CLI spawn below) gets the built `.js` testkit, a `.ts`/tsx entry keeps the `.ts` testkit — they must come from the same tree as `entry`, because the container-authority mount is a per-module-instance singleton and a mismatched pair arms one instance while the CLI reads another.
- **`authorityTestkitEnv()`** — the env overlay for that child. Spread it over `process.env` **last**, so it wins over an inherited container pointer.
- **`authorityTestkitBinEnv()`** — the same seam for a child launched through `bin/forge`, which builds its own node argv and so has nowhere to take an `--import` from the caller. It carries the base overlay plus a `NODE_OPTIONS` naming `bin/forge-loader.mjs` **before** the testkit (an inherited `NODE_OPTIONS` is preserved, not clobbered). That ordering is load-bearing, not cosmetic: `NODE_OPTIONS` imports run before the argv ones, and the testkit is TypeScript — nothing can parse it until tsx is registered.

**Both env keys are required; a partial overlay fails only inside a container.** `FORGE_TEST_AUTHORITY_MOUNT` points the compiled-in probe at an empty, marker-free directory (`neutralAuthorityMount()`, created once per test process and never written to) — that is what the probe checks first. `FORGE_BACKLOG_SNAPSHOT_DIR` is set to `""` because it is exported into every agent container as the fallback pointer, and leaving it inherited means the child still resolves a mounted authority even with the probe repointed. On a host, arming the seam changes nothing — there is no marker at the fixed path and no pointer in the environment — which is the point: a seamed suite means the same thing in both places, so nothing needs to skip on "am I in a container".

**The seam is opt-in, and that is what keeps FG-608's F2 gate intact.** The env vars alone do nothing: `FORGE_TEST_AUTHORITY_MOUNT` is read by exactly one module, `src/backlog/container-authority.testkit.ts`, which no production path imports — a child reaches it only through an explicit `--import`. So a dispatched agent still cannot move the authority gate by setting a variable, because choosing what code your *own* process loads was never something the gate could prevent. `src/backlog/fg645-authority-opt-in.integration.test.ts` pins this from both sides: the variable is inert without the preload, and it may be named by no non-test file except the testkit and its parent-side helper module (a third reader would make the seam ambient, which *is* the bypass).

**The shipped reader is the deliberate exception.** `docker/forge-backlog-reader.mjs` — the entire forge surface a container has — compiles its mount root in with no runtime override at all, because an env- or preload-reachable override there would be one `NODE_OPTIONS` away from the agent. Its suite (`src/backlog/fg608-shipped-reader.integration.test.ts`) therefore applies the seam to a **copy**: it rewrites the single `const MOUNT = "/forge-backlog";` line and asserts the copy differs from the shipped file in exactly one line, so if that declaration ever moves the suite fails loudly and the seam is retargeted rather than silently lost. Do not add a setter or an env read to the shipped reader to make a test easier.

## Build-once CLI spawn for integration tests (FG-728)

**An integration test that spawns the `forge` CLI to exercise CLI behavior must launch it through the shared spawn authority, `src/integration-cli-spawn.ts` — never hand-roll a `tsx src/cli/index.ts` spawn.** Before FG-728, every CLI-spawning integration file cold-spawned `tsx` against the source entry, re-transpiling the whole CLI import graph on every call (~600–700ms), hundreds of times across the tier — the tier's dominant runner-minute cost. `src/integration-cli-spawn.ts` exports the constants a migrated file spawns instead:

- `NODE_EXEC` — `process.execPath`, in place of resolving `node_modules/.bin/tsx`.
- `BUILT_CLI_ENTRY` — the prebuilt CLI entry (`.forge-integration-build/cli/index.js`), in place of `src/cli/index.ts`.
- `BUILT_AUTHORITY_TESTKIT_URL` — the built `.js` container-authority testkit, for callers that need to `--import` it directly rather than through `withAuthorityTestkit()` above.

A migrated file's `spawnSync(tsx, [entry, ...args])` call body stays byte-identical — only the `tsx`/`entry` constants it imports change — so it now launches `node <BUILT_CLI_ENTRY>` (a plain Node cold-start, ~50–80ms) instead of `tsx src/cli/index.ts`.

**The build itself.** `src/integration-build-preload.ts` is a `--import` preload wired into every lane of `scripts/run-integration-tests.sh`, `docker/forge-test.sh`'s narrowed `--integration` runner, and `scripts/measure-integration-timings.ts` (so per-file timing measurement finds the built entry too). It esbuild-transpiles the whole `src/` graph — per file, structure-preserving, never a single-file bundle — into `.forge-integration-build/` (gitignored, one level under the repo root, a sibling of `src/`) exactly ONCE per `node --test` invocation: `node:test` runs each file in its own subprocess, so the preload coordinates across siblings by `process.ppid` (a lock dir + ready sentinel in the OS tmpdir) rather than rebuilding per file. It is manifest-less (so `asset-root.ts` resolves `dev` mode exactly as tsx does) and fails closed — if esbuild throws, the whole job throws rather than running against a stale or absent tree. It is integration-tier only; it must never move into `src/test-setup.ts`, which the unit and worktree tiers also load.

**What still spawns `tsx` — deliberately.** Three shapes stay on `tsx src/cli/index.ts` (or an equivalent tsx spawn) because the build-once pattern does not apply to what they test:

- A file that spawns an arbitrary `.ts` **driver**, not the CLI entry (e.g. `src/backlog/fg607-seam-cost.integration.test.ts`'s per-call driver scripts) — there is no CLI entry to swap in.
- A file that asserts the **tsx-loader/interpreter/release/preflight seam itself** — `src/backlog/fg645-testkit-spawn.integration.test.ts` (proves load order between the tsx loader and the testkit preload) and the release/provenance suites (`src/v2/fg571-*.integration.test.ts`, which assert `process.execPath` identity against a real installed interpreter). Swapping in the built CLI would test the build preload's own seam instead of the one these files exist to prove.
- A file using the `node --import tsx` idiom to test **that mechanism** directly, rather than to run the CLI for its own sake.

If you're adding a CLI-spawning integration test and it doesn't fall into one of those three shapes, import from `integration-cli-spawn.ts` — don't add a fourth exemption without a reason as specific as the three above.

**What this does not address.** The dominant integration costs remaining after FG-728 are files this pattern was never going to touch, because none of them are a build-once-eligible CLI spawn:

- `src/fg693-alias-regression.integration.test.ts` (~121s) — spawns `node --import tsx --test <nested file>` to run a *nested* `node --test` regression suite; it genuinely needs tsx to parse that nested file, not the CLI.
- `src/v2/fg530-crash-matrix.integration.test.ts` (~108s) — drives the real `runNext` in-process against a fake `dockerExec`; it never spawns a CLI subprocess at all.
- The `src/v2/fg571-*.integration.test.ts` release/provenance suites (~40–95s each) — spawn built-release interpreters and assert `process.execPath` provenance, which is the seam exemption above.

These are not missed migrations; the build-once CLI spawn has no purchase on an in-process test or a test whose whole point is the interpreter/loader seam.

## Tmux socket isolation for tests that touch tmux (FG-614/FG-680)

**No test may resolve the DEFAULT tmux socket.** The tmux server is a host-wide daemon that outlives every session and holds exactly one working directory — the first client's. A test that starts a session on the default socket from a fixture directory it later deletes leaves the *operator's* server stuck in a dead directory, and from then on every `forge launch run` on the machine dies at node bootstrap (ENOENT/uv_cwd) until someone runs `tmux kill-server` by hand — which also kills unrelated live work. That was the FG-614 incident.

`src/test-setup.ts` arms the isolation with two halves, both required:

- **`TMUX_TMPDIR`** is set to a per-test-process directory (`/tmp/forge-test-tmux-*`, deliberately under `/tmp` rather than `os.tmpdir()` — a unix socket path has a ~104-char limit and macOS's per-user tmpdir eats most of it). This relocates the socket *directory* a bare tmux client falls back to.
- **`TMUX` is deleted** from `process.env`. A tmux client given neither `-L` nor `-S` resolves its socket from `$TMUX` **first** and only consults `TMUX_TMPDIR` when `$TMUX` is unset. Inside a tmux pane — which is what `forge launch run` creates, and the dispatch pattern forge requires for long-running work like a full test suite — `$TMUX` is inherited and names the operator's default socket. Before FG-680, `TMUX_TMPDIR` alone bought nothing there: every bare `tmux …` in the test process, including the exit hook's own `kill-server`, reached the *operator's* server instead of a private one. Deleting `TMUX` is a named deletion, never a blanket `TMUX_*` scrub — `TMUX_PANE` is informational and selects no server, and `-L`/`-S` are flags, not environment.

The test process's exit hook runs a bare `tmux kill-server` on teardown, and it is safe to reach the private socket *only because both halves hold*. That two-part invariant is enforced from both sides:

- `src/v2/fg614-tmux-socket-isolation.test.ts` asserts the mechanism is armed (`TMUX_TMPDIR` set to a real per-process directory, `TMUX` absent) and that no tmux-touching test builds a subprocess environment that fails to inherit `process.env`/`TMUX_TMPDIR` or that explicitly reintroduces `TMUX`.
- `src/v2/fg680-tmux-client-env.integration.test.ts` and `src/v2/fg680-tmux-cli-subprocess.integration.test.ts` prove the *enforcement* half rather than the happy path: they hand a test process (and, respectively, a real `forge launch run` subprocess) a `$TMUX` naming a real stand-in server, and assert that server — and the session it was holding — is still alive after the harness's teardown runs.

**When you write a test that spawns a subprocess touching tmux:** spread `...process.env` (or otherwise pass `TMUX_TMPDIR` through) so the child inherits the private socket, and never set `TMUX` in that subprocess's environment — even alongside an otherwise-inherited `process.env`. The content guard in `fg614-tmux-socket-isolation.test.ts` fails the unit tier on either mistake.

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

## Proving the private-clone container boundary (FG-621)

`scripts/fg621-clone-boundary-smoke.sh` is the live proof that a mutating agent's private clone ([Private writable Git for mutating agents](concepts.md#private-writable-git-for-mutating-agents)) cannot write to the parent repository from inside a container. It is **deliberately outside every npm tier and outside CI**, and that is not an oversight to be fixed: no tier here can run a real Docker container (agent containers have no daemon, and no CI job builds or runs the agent image), so the only test that could exist would be skip-capable — and a green skip is a *false* security proof. The boundary is therefore proven the way FG-559 proved its own: once, host-side, against the candidate build, with the output pasted into the ticket. Do not add a CI job for it and do not make it a required check.

```bash
./scripts/fg621-clone-boundary-smoke.sh [--project-dir DIR] [--image IMAGE]
```

- `--project-dir` — the parent repo to prove unwritable (default: the repo the script lives in).
- `--image` — the candidate agent image (default: `$FORGE_AGENT_IMAGE`, else `agent-dev-worker:latest`; build one with `./docker/build.sh`).
- `FORGE_SMOKE_RUN_ID` / `FORGE_SMOKE_TASK_ID` override the generated evidence labels; `FORGE_SMOKE_WORKDIR` sets the parent directory for the throwaway clone. `FORGE_HOME` is redirected into that throwaway dir, so nothing lands in the operator's real `~/.forge`.

**Run it on the macOS host, never inside an agent container.** It needs a reachable Docker daemon, the agent image, `git`, and this repo's `node_modules` — the last because it builds its fixture through forge's own `createTaskClone` rather than a hand-rolled `git clone --shared`. That distinction is what separates evidence from theatre: a hand-built fixture that also supplied `GIT_AUTHOR_*` would report success while real dispatch failed with "Author identity unknown". Workspace isolation itself is macOS-only until FG-358.

**It fails closed.** Every missing prerequisite exits **2** with a `FATAL:` line; a failed assertion exits **1** and dumps the container log; only an all-pass run exits **0**. Nothing skips. It touches the parent repo only through the one deterministic `forge/<runId>/<taskId>` ref — anchored when `createTaskClone` builds the fixture, then advanced by the host-side capture fetch AC 11 requires, which happens strictly *after* the parent-unchanged comparison — and that ref is deleted on exit.

On success it prints a copy-pasteable evidence block (host, docker version, image id, project dir, base SHA, the exact mounts, and a per-probe verdict with the command each probe actually attempted). Paste that into FG-621's acceptance-evidence grid for AC 2 and AC 11, citing the candidate SHA and image it ran against, and **re-run it whenever the clone substrate or the mount planner changes** — acceptance evidence against a superseded SHA is worse than none, because it reads as proof.

What it proves is that the mount shape is safe on a real kernel. What it does *not* prove is that forge emits that shape; the argv-shape assertions in `src/v2/fg621-clone-git-mount.worktree.test.ts` and `src/v2/fg559-worktree-git-mount.worktree.test.ts` cover that half, and `src/v2/fg621-smoke-script.integration.test.ts` covers the script's own adjudication logic (that a probe which never ran, or a typo'd command, can never be scored as a refusal). The two halves together are AC 2's coverage.

## Proving the reviewer's database engine (FG-664)

`scripts/fg664-reviewer-engine-smoke.sh` is the live proof that a **read-only reviewer container can load the project's real native database driver** — the half of FG-664 that removes the hazard, as opposed to the half that fails closed when the hazard is met. It exists for the same reason as the FG-621 smoke, and is **deliberately outside every npm tier and outside CI** for the same reason: no tier here can run a real container, so the only test that could exist would be skip-capable, and a green skip is a false proof. Here that is doubly true — the defect being closed is a lane reporting a verdict for a suite it never actually executed against the real engine.

```bash
./scripts/fg664-reviewer-engine-smoke.sh [--project-dir DIR] [--image IMAGE] [--package NAME] [--runtime NAME]
```

- `--project-dir` — the project whose reviewer environment is under proof (default: the repo the script lives in).
- `--image` — the candidate agent image (default: `$FORGE_AGENT_IMAGE`, else the resolved runtime's own image; build one with `./docker/build.sh`).
- `--package` — the native dependency to prove loadable (default: `better-sqlite3`, the shipping driver).
- `--runtime` — the runtime to resolve the image and project mount path from (default: `claude`, the same auto-detection a dispatch does).

**It runs three probes, and the negative one is what makes the positive one mean anything.** P1 runs a container with the read-only reviewer mount shape — project `:ro`, every lockfile-keyed dependency volume `:ro`, no read-write dependency mount — and asserts the real driver loads, answers a query, and reports the *container's* `process.versions.modules` from an ELF artifact. P2 runs the same container with the dependency volumes **absent** and asserts the load **fails**, on the host's Mach-O artifact seen through the project bind: that reproduces the live defect and is what rules out P1's green having come from the host's darwin `node_modules`. P3 asserts the argv carries no read-write dependency mount, no `FORGE_NM_INSTALL_ROOT` and no install command, and corroborates it in the kernel (writes to `/project` and to the mounted `node_modules` are refused), so FG-376's "reviewer containers never install" invariant is visible in the proof rather than asserted in prose.

**Run it on the macOS host.** It refuses to run anywhere else, and that refusal is the coverage boundary, not a portability gap: on Linux the host's `node_modules` already carry the container's platform, so the ABI mismatch the proof is about does not exist and P2 could not reproduce it. It derives the mount shape and the volume names from forge's **own** `planDependencyVolumes` / `buildProvisionerDockerArgs` (so it needs this repo's `node_modules`), and on a cold cache key it provisions through forge's own provisioner under the real `~/.forge/dependency-cache` lock — deliberately **not** a redirected `FORGE_HOME`, because a different lock would let it race a live dispatch installing into the same volume.

**It fails closed.** Every missing prerequisite — not macOS, no docker binary, no reachable daemon, no image, no node, no lockfile, a project whose `.git` is a worktree pointer, a driver with no host build or a non-darwin one — exits **2** with a `FATAL:` line naming what was missing. A failed assertion exits **1** and dumps both container logs. There is exactly one literal `exit 0`, the last line. Nothing skips.

**What a green run does and does not say.** It closes FG-664 AC 1 on the darwin + npm-lockfile configuration, which is the only configuration where the hazard exists. It says **nothing** about half (B) — that a lane which *cannot* load the driver is recorded `blocked_environment` rather than as a verdict; that holds on every host and is proven by the unit suites, and the two claims must never be quoted for each other. It also does not prove forge *emits* the reviewer mount shape (the argv-shape assertions in `src/v2/fg664-reviewer-dependency-environment.test.ts` cover that half), and it cannot detect an agent that loads the real driver and fabricates output anyway.

Paste the evidence block into FG-664's acceptance grid, citing the candidate SHA and image, and **re-run it whenever the mount planner or the dependency-environment resolver changes** — the same standing instruction the FG-621 smoke carries, for the same reason: acceptance evidence against a superseded SHA is worse than none, because it reads as proof.

### Replaying a recheck through the repaired lane

`scripts/fg664-recheck-replay.sh` is the other operator-run half: it re-executes a recheck **through the repaired lane** and prints what the ledger actually recorded, which is how a review whose findings came from a substituted engine is shown to come back differently once the real driver is loadable. It dispatches a real agent container against a real candidate, so it is outside every npm tier and outside CI for the same reason the smoke is.

```bash
./scripts/fg664-recheck-replay.sh [--project-dir DIR] [--review ID] [--candidate SHA]
                                  [--db PATH] [--route KEY] [--image IMAGE]
```

- `--project-dir` — the checkout the replay dispatches against (default: this repo); it must contain the candidate as a commit object.
- `--review` — the review to replay (default: `review-6b9e07e48cc6`, FG-662's). The finding refs it adjudicates are pinned to `RF-1`, `RF-3`, `RF-4` — the three the substituted engine produced false `still_present` verdicts for — and are not a flag.
- `--candidate` — the candidate sha being proven (default: `593f88bad31813383c53c42a27fd9ef095759db8`, FG-662's fix candidate). Must be a full 40- or 64-character lowercase hex sha and must resolve to a **commit object** in `--project-dir`.
- `--db` — the source ledger (default: `$FORGE_DB_PATH`, else `$FORGE_HOME/forge.db`, else `~/.forge/forge.db`). On the copy path below it is checksummed (store **and** `-wal`) before and after and asserted byte-identical, so a replay that was supposed to touch only the copy cannot quietly have written to it.
- `--route` / `--image` — the routing-policy key for the dispatch (without it the replay runs `--unrouted`, and which was used is printed), and an agent image to assert exists before dispatching.

**`--candidate` selects which candidate is asserted; it never disables the assertion.** The review must still be *bound* to the sha supplied, exactly as recheck ingestion requires — a recheck at another candidate is not evidence about this one, and the harness refuses the replay rather than relaxing it. The flag exists because the pinned default is one specific historical review; a controlled replay of any other review needs to name its own candidate.

**The re-entry question is answered by the product, not by the script.** It asks `forge review continue --dry-run` which transition the row may legitimately take: if the answer is `recheck` the row is replayed in place on the live ledger; otherwise (a `settled` row is terminal, and no verb reverses that) an *equivalent* recheck is materialized over the same finding ids at the same candidate on a **copy** of the ledger, and the divergence is printed — the original row copied byte-for-byte and rewound past Stage 8, never a hand-built fixture. It fails closed the same way the smoke does: a missing prerequisite exits **2**, and the single `exit 0` is reached only when every replayed finding came back `resolved` with `coverage: executed` and non-empty cited runner output. A finding coming back `blocked_environment` is reported as a **failure** — half (A) did not take on this host.

## Timing data and classification history

`docs/test-suite-timing-fg495.md` has the full per-file/per-tier timing measurements behind FG-495's tiering decision, plus a file → old-tier → new-tier → reason table for every test relocated out of the unit tier when the content guard was extended.
