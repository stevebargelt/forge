---
id: FG-613
type: story
status: done
title: "campaign.integration.test.ts: 10 FG-416/FG-490 tests fail on macOS host at origin/main while CI is green — host-red suite masks real regressions"
created: 2026-07-25
closed: 2026-07-25
closed_commit: d92a063
---

## Evidence (2026-07-24, during FG-607)

`src/cli/commands/campaign.integration.test.ts` fails **10 tests on this macOS host at `origin/main`**
(commit e0c1c2c), verified in a clean detached worktree with no FG-607 changes present:

- FG-416 integ: `campaign resume` — dependency-held item prints blocker guidance, not 'run resume again'
- FG-416 integ: `campaign resume` — readiness-held pause still prints refine message (regression guard)
- FG-416 integ: `campaign start` — DB-injected dependency-held state emits blocker guidance
- FG-416 branch-ordering integ: readiness-held wins over dependency-held (start handler)
- FG-416 branch-ordering integ: readiness-held wins over dependency-held (resume handler)
- integ FG-490 review: `campaign start --json` renders a drive-error as structured JSON
- integ FG-490 review: `campaign start` (human) prints the wrapped drive-error with resume guidance
- integ FG-490 review: `campaign resume --json` renders a fresh drive-error as structured JSON
- integ FG-490 review: `campaign resume` (human) prints the wrapped drive-error with resume guidance
- FG-490 reopen integ: `campaign start --json` guidance stays bare resume, not retry

`main` is branch-protected on `test-extended`, which runs the integration tier — so these are GREEN in Linux CI
and RED only on the macOS host. Same host-only class as FG-575 / FG-556 / FG-557, different file.

## Why this matters beyond noise

A permanently-red block of 10 tests in the tier makes host integration runs unreadable: during FG-607 the build
agent reported "3691/3701" and the real host number was 20 failures, of which these 10 were pre-existing. The
only way to tell a real regression from the standing noise was to re-run the same file against `origin/main` in
a separate worktree and diff the sets — which is not a workflow anyone will repeat under time pressure. That is
the actual cost: a diff that genuinely broke campaigns would look identical to today's baseline.

## Scope

- Determine why these fail on macOS but pass in Linux CI. The FG-416/FG-490 assertions are about CLI guidance
  strings and JSON error shapes, so the likely candidates are path canonicalization (`/var` vs `/private/var`,
  the FG-575/FG-556 class), a temp-dir or DB-fixture assumption, or an ordering/timing dependency — establish
  which before changing anything.
- Fix the tests (or the code, if the host reveals a genuine platform bug the Linux runner hides).
- Do NOT "fix" by skipping on darwin. A skipped test on the developer's only machine is worse than a red one:
  it removes the signal silently instead of loudly.

## Acceptance Criteria

- `node --test src/cli/commands/campaign.integration.test.ts` passes on the macOS host from a clean checkout.
- Still passes in Linux CI (`test-extended`).
- The root cause is stated in the ticket or commit — if it is path canonicalization, say so and check whether
  the same pattern remains anywhere else in the tier.

## Relations

- Same host-red class as FG-575 (release.integration.test.ts), FG-556 (fg425-publication-cas.worktree.test.ts),
  FG-557 (fg520-forge-test-resync.integration.test.ts). Worth fixing the class together if the cause is shared.

## CORRECTION — these are NOT permanently red; they fail only IN AGGREGATE (2026-07-24)

Re-measured on the same baseline worktree (origin/main, e0c1c2c):

- Whole file: 10 failures.
- The SAME tests run alone via `--test-name-pattern "drive-error as structured JSON"`: **2 pass, 0 fail.**

So this is **cross-test interference / shared-state pollution inside the file (or the tier)**, not a
deterministic platform bug and NOT the `/var` vs `/private/var` canonicalization class of FG-575/FG-556/FG-557.
That also explains why the failure COUNT moved between runs (baseline 10, the FG-607 branch 8) — it is
order- and timing-dependent, i.e. flaky in aggregate.

Revise the scope accordingly: find the shared state these tests contend over, rather than hunting a path bug.

## Likely shared cause with FG-614 — sequence this AFTER it

`src/cli/commands/campaign.integration.test.ts` is the same file that leaked a fixture cwd into the host-wide
tmux server and bricked every `forge launch run` (**FG-614**). That means these tests already create sessions on
the DEFAULT tmux socket and share server state with each other and with everything else on the host. FG-614's fix
requires every tmux-touching test to use its own socket (`tmux -L <name>`), which removes exactly that shared
state.

**Do FG-614 first, then re-measure this file before investigating further.** The failure set may shrink or vanish
outright, and any remaining failures will be measured against a clean isolation baseline instead of a polluted one.
Candidate contended state to check if failures survive: the shared `~/.forge/forge.db`, temp-dir reuse across
cases, and fixed ports.

## Acceptance Evidence — resolved by FG-614 (`d92a063`), not by a separate fix

The corrected diagnosis above was right: these tests fail only IN AGGREGATE, so the cause was shared state, not a
platform bug. FG-614's per-test tmux socket isolation (`src/test-setup.ts`, every tmux-touching test gets a private
`TMUX_TMPDIR`) removed exactly the state they were contending over — and `campaign.integration.test.ts` is the same
file that leaked a fixture cwd into the host tmux server in the first place.

| AC | Evidence | Verdict |
|---|---|---|
| `node --test src/cli/commands/campaign.integration.test.ts` passes on the macOS host from a clean checkout | Run on this host after FG-614: **127 tests, 127 pass, 0 fail, 0 skipped** (launch `launch-fg613-verify-jr5myz`). Baseline for comparison: the SAME file on the SAME host at `origin/main` failed **10** (measured in a clean detached worktree at e0c1c2c) | met |
| Still passes in Linux CI (`test-extended`) | Green at `d92a063`; `integration_*` shards all pass. It was always green on Linux — hence the host-only classification | met |
| The root cause is stated, and the pattern checked for elsewhere | Root cause: contention over the shared default-socket tmux server. FG-614 fixes it suite-wide, not just for this file, and adds a guard test that FAILS and names any test bypassing socket isolation — so the class cannot silently return | met |
| NOT "fixed" by skipping on darwin | No skip was added. The tests run and pass on macOS | met |

Measured on the macOS host deliberately: the implementing agent reported 127/127 from its Linux container and
explicitly refused to let that count as evidence here, since Linux was already green. That caveat is why the
decisive run was done on the platform where the failures actually lived.
