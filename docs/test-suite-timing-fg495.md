# FG-495: test suite timing data and tier classification

Snapshot date: 2026-07-08. Measured on the forge-test container (same
better-sqlite3-rebuild scratch flow forge-test itself uses), Node 24.

## Methodology

1. Batched per-tier timing: `npm run test:<tier>` run to steady state (scratch
   dir warm, no first-run rebuild overhead) — this is what CI/agents actually pay.
2. Per-file timing: each `*.test.ts` file run individually via
   `tsx --import ./src/test-setup.ts --test <file>`, wall-clock timed, to find
   the specific slow files within a tier (node:test's default spec reporter
   doesn't print per-file duration when running many files in one invocation).

## Before (pre-FG-495 tiering)

| Command | What it ran | Steady-state wall time |
|---|---|---|
| `npm test` (bare) | unit + integration + worktree combined (203 files, 3313 tests) | ~107s |
| `npm run test:all` | the above + dashboard workspace — **the CI required gate and the review-loop's per-round verification (`runVerification` in `src/v2/review-loop.ts`, which runs `scripts["test"]`)** | ~107.6s |

Both were far over the <=60s target / <=120s ceiling, and the review-loop paid
the ~107s cost on every round via its own `npm run test` verification step —
not just CI.

## After (this change)

| Command | What it runs | Steady-state wall time |
|---|---|---|
| `npm test` / `npm run test:unit` | unit tier only (125 files, 1968 tests) | ~2s |
| `npm run test:all` | unit tier + dashboard workspace — **unchanged command string** (still `npm test && npm test -w dashboard`), now fast because `npm test` is now unit-only | ~2.5s |
| `npm run test:integration` | 64 files, 1238 tests | ~93s |
| `npm run test:worktree` | 14 files, 107 tests | ~1.9s |
| `npm run test:extended` (new) | integration + worktree combined | ~94s |

`npm run test:all` — the literal string CI's `test` job runs, and the string
hardcoded as `REQUIRED_CI_GATE_COMMAND` in `src/store/host-verifications.ts`
for FG-474/FG-419's anti-spoofing content-guard — was deliberately left
untouched at the text level. It is fast now purely because `test` (which it
calls) was redefined to mean the unit tier. This means the FG-474 evidence-
reuse and gate-spoofing guards, and the branch-protection required-check
context (`CI / test`), needed zero changes: same command, same check name,
now backed by fast content.

The review-loop's own per-round verification (`runVerification` → `npm run
--silent test`) is fixed by the same change, since it calls the `test` script
by name.

## Why the unit tier is fast even though FG-406/408 already tiered the suite

FG-406/408 split the suite into unit/integration/worktree tiers, but the root
aggregate (`npm test`, what `test:all` called) still ran all three tiers
combined — the CI/review-loop gate never actually used the fast tier alone.
FG-495's fix is: point the canonical gate commands at the already-fast unit
tier, and give the two slow tiers an explicit combined name (`test:extended`)
instead of leaving them folded into the default `npm test`.

## The two dominant integration-tier files

Per-file timing surfaced two outliers that account for **119.6s of the
174.8s** summed per-file integration wall time (the batched run is faster at
~93s because node:test runs files with some concurrency):

| File | Solo wall time | Why it's slow | Disposition |
|---|---|---|---|
| `src/cli/commands/campaign.integration.test.ts` | ~91.5s | 121 tests, each spawning the real `forge` CLI as a subprocess (`forge campaign plan/approve/start/...`) — CLI-subprocess-per-test is inherent to what this file verifies (real CLI argv parsing, exit codes, stdout/JSON shape) | Stays in `test:integration` — this is exactly what the integration tier is for; rewriting to avoid subprocess spawns would lose the CLI-surface coverage, which is a non-goal (per-test optimization) |
| `src/backlog/structured.integration.test.ts` | ~28.2s | 56 tests, same pattern — real CLI spawns for backlog CRUD/migration/lock-concurrency behavior (FG-397/FG-398 lock coverage) | Stays in `test:integration` — same rationale |

No test in either file was deleted, skipped, or rewritten. They are correctly
tiered already (real CLI-subprocess coverage belongs in `integration`, not
`unit`); the fix that matters for FG-495 is that the canonical gate no longer
includes this tier at all, rather than trying to make ~180 real CLI spawns
fast.

## Content-guard gap found and closed

The FG-406/408 unit-tier purity guard (`src/test-tiers.test.ts`) flagged
standalone `execSync`/`spawnSync`/`spawn`/`execFile`/`exec` calls guarded by a
`child_process` import, but the pattern list never included `execFileSync` —
a real gap, since `execFileSync` is the idiom this codebase actually uses for
subprocess calls (`execFileSync("git", [...])`, `execFileSync("npm", [...])`).
Extending the guard to include it (plus a second, import-independent check for
the promisified-sleep idiom `new Promise((r) => setTimeout(r, N))`) surfaced
10 real unit-tier files spawning real `git` subprocesses or sleeping on a real
clock — undetected until now because the guard's own pattern list had a hole,
not because the tiering discipline was being ignored.

## Classification table: files reclassified out of the unit tier

All 10 were caught by the extended content guard (not filename inspection)
and moved to the tier matching what they actually do. No tests were deleted,
weakened, or skipped — every test still runs, just in `test:integration` or
`test:worktree` instead of `test:unit`.

| File (old → new) | Tests | Reason | New tier |
|---|---|---|---|
| `src/cli/commands/recover.test.ts` → `recover.integration.test.ts` | 29 | `execFileSync("git", ["init", ...])` fixture setup — real subprocess + real temp FS | integration |
| `src/cli/commands/review-loop.test.ts` → `review-loop.integration.test.ts` | 30 | `execFileSync("git", ...)` fixture setup | integration |
| `src/v2/invoke.test.ts` → `invoke.integration.test.ts` | 42 | `execFileSync("git", ["init", "-q"], ...)` fixture setup | integration |
| `src/v2/reconcile.test.ts` → `reconcile.integration.test.ts` | 63 | `execFileSync("git", ["init", "-q"], ...)` fixture setup | integration |
| `src/v2/runNext.test.ts` → `runNext.integration.test.ts` | 56 | `execFileSync("git", ["init", "-q"], ...)` fixture setup | integration |
| `src/campaign/executor.test.ts` → `executor.integration.test.ts` | 108 | `execFileSync("git", ...)` fixture setup | integration |
| `src/campaign/report.test.ts` → `report.integration.test.ts` | 101 | `execFileSync("git", ...)` fixture setup | integration |
| `src/util/run-lock.test.ts` → `run-lock.integration.test.ts` | 15 | real wall-clock sleeps (`new Promise((r) => setTimeout(r, 60-100))`) testing lock TTL/expiry timing — needs a real clock, not fake-timer-safe | integration |
| `src/v2/dependency-provisioning.test.ts` → `dependency-provisioning.integration.test.ts` | 44 | real wall-clock sleeps (20-300ms) testing concurrent dependency-cache lock acquisition + real temp FS | integration |
| `src/v2/worktree-lifecycle.test.ts` → `worktree-lifecycle.worktree.test.ts` | 6 | real `git worktree`-adjacent lifecycle (`git init`, real branch/worktree disposal helpers) — the file's own header says "Real git repos ... so this runs on Linux CI same as macOS" | worktree |

None of these were spawning slowly enough to matter for the <=60s target on
their own (the batched unit tier ran in ~4s even with all ten included) — the
reclassification is about tier-purity correctness (matching the written
placement rule in `docs/how-to-testing.md`) and closing the guard gap so new
subprocess/sleep tests can't silently land in the unit tier going forward.

## Trust-sensitive coverage — not weakened

Every relocated test still runs, unmodified, in `test:integration` or
`test:worktree`. Those tiers run in CI on every push/PR via the new
`test-extended` job (`.github/workflows/ci.yml`) — a **required** merge
check, same as `test`, and not merely informational. What changed vs
pre-FG-495 is *where* this coverage runs (CI, off-host, in parallel with
`test` and with review-loop verification) and how often the operator pays
for it interactively (never per round — the per-round gate the review-loop
re-runs is the fast unit tier via `npm run test:all`). Nothing was deleted,
skipped, or downgraded to non-blocking.
