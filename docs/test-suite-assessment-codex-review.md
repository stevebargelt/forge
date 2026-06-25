# Codex Addendum: Test Suite Assessment

**Snapshot date:** 2026-06-24  
**Scope reviewed:** root `src/**/*.test.ts`, dashboard workspace tests, and Forge's draft `docs/test-suite-assessment.md`.  
**Worktree caveat:** this review was done while FG-398 was dirty/uncommitted, so counts include its in-progress tests.

## Bottom Line

Forge's assessment is directionally right: the suite is not wasteful in a systemic way, and the ticket-scoped regression tests are mostly protecting real control-plane behavior. I would not authorize a broad deletion pass.

The additional concern is not raw test count; it is **suite shape**. The root `npm test` mixes cheap unit tests, CLI subprocess tests, and git/worktree integration tests into one 76-second command, while dashboard tests are outside that command. That is acceptable for a host gate, but it is too blunt for rapid Forge-on-Forge iteration and makes redundancy harder to reason about.

## Verification

- `npm test` passed: **1820 tests**, 0 failures, **76.7s**.
- `npm --workspace=dashboard test` passed: **27 tests**, 0 failures, **0.47s**.
- Root static scan: **139** `src/**/*.test.ts` files.
- Dashboard static scan: **5** `dashboard/src/**/*.test.ts` files.

The Forge-authored assessment says "all `src/**/*.test.ts`" and reports ~1796 tests. That was probably accurate before the active FG-398 work, but it is already stale in this dirty tree. Treat it as a point-in-time assessment, not a durable inventory.

## Additional Findings

### 1. Root `npm test` is not the whole repo test suite

Root `package.json` runs only `src` tests:

- `package.json:14` expands `find src -name '*.test.ts' ...`

Dashboard has its own tests and script:

- `dashboard/package.json:10` expands `find src -name '*.test.ts' ...` inside the workspace.

That split is fine if intentional, but `docs/test-suite-assessment.md` should say "root src suite", not "all tests", or root should gain an aggregate script such as `test:all` that runs both root and dashboard. This matters for campaign-runner confidence because dashboard/operator visibility work is active backlog territory.

### 2. The suite needs tiers more than it needs deletion

The root suite currently uses one command for everything:

- cheap pure tests in milliseconds;
- CLI subprocess tests that cost ~0.5-2s each;
- git/worktree integration tests where individual cases can cost 3-16s.

The full run is still reasonable at 76.7s, but the lack of tiers means an agent working on a pure helper has the same default validation shape as an agent changing fan-out worktree semantics. Recommended split:

- `test:unit`: no subprocess, no git worktree, no network, no long-running child processes.
- `test:integration`: CLI spawn / DB / filesystem integration.
- `test:worktree`: git/worktree dispatch integration.
- `test:all`: root + dashboard aggregate gate.

Do not weaken the final gate. The point is to make local iteration and campaign item validation more targeted.

### 3. Some tests are false-confidence tests, not just redundant tests

`src/cli/commands/backlog-notes.test.ts` is the clearest example. It says it "mirrors the command logic without spawning a subprocess", but it mostly re-implements the production file operations inline:

- `src/cli/commands/backlog-notes.test.ts:28-94`

Those tests can pass while the real command is broken because they do not call a production helper. The integration file already exercises the CLI path:

- `src/cli/commands/backlog-notes.integration.test.ts:54-178`

Recommendation: either delete the unit file and keep the integration coverage, or extract real pure helpers for `notes show/add/replace` and test those helpers directly. Mirroring production logic in a test should be treated as worse than ordinary overlap.

### 4. The backlog integration cluster is now the main cleanup target

`src/backlog/structured.integration.test.ts` is doing useful work, but it has become an accretion point for multiple tickets:

- baseline CLI behavior: `src/backlog/structured.integration.test.ts:182-433`
- FG-397 ghost/atomicity coverage: `src/backlog/structured.integration.test.ts:448-597`
- FG-398 lock coverage: `src/backlog/structured.integration.test.ts:612-825`

The FG-398 additions are valuable while the race fix is active, but after it lands I would trim them to the minimum set that proves:

- concurrent writers produce unique IDs on stdout and on disk;
- the lock spans story and epic types;
- configured prefixes work under concurrency;
- dead-process stale lock recovery works;
- lock cleanup happens.

The test at `src/backlog/structured.integration.test.ts:656-665` is especially worth revisiting because it encodes "old timestamp held by our own live PID is reclaimable." That is a product decision, not just a test case. If Forge changes the lock to never steal from a live PID, this test should be removed or rewritten to cover markerless/dead-holder recovery instead.

### 5. The noisy expected warnings are a real maintainability cost

The full run emits many expected warnings such as project mount preflight messages and worktree advisories. Some of this traces back to global setup creating hardcoded placeholder directories:

- `src/test-setup.ts:8-23`

Those directories satisfy existence checks but remain intentionally empty, so tests that exercise mount preflight can produce warning-looking output during a green run. This is not a correctness bug, but it weakens log signal when Forge is trying to triage failures unattended.

Recommendation: move placeholder project creation into shared fixtures that create the exact shape each test needs (`package.json`, `.git`, empty directory, missing directory), and suppress or assert expected warnings inside the owning tests. Green full-suite output should not look like an incident report.

### 6. Forge's high-confidence cleanup list is mostly right

I agree with these parts of `docs/test-suite-assessment.md`:

- `show.test.ts` has many small formatter/state-helper tests that should become tables, not disappear. The cluster starts around `src/cli/commands/show.test.ts:276` and includes `computeElapsed`, `formatTimeAgo`, `tailLines`, `deriveNextCommandForTask`, and `groupFailedByKind`.
- RACI parser/schema/compiler tests overlap around syntax constraints, but keep the seam separation. Parser tests should own source grammar; schema tests should own derived policy shape; compiler tests should own transformation. The extra schema round trips at `src/raci/compile.test.ts:84-99` are the best trim candidates.
- The `src/v2/fgNNN-*` files should not be bulk-deleted. The better move is a shared harness and behavior-oriented filenames. `src/v2/fg353-dispatch.integration.test.ts` is long, but its header accurately describes distinct fan-out integration invariants.

## Recommended Feedback To Forge

1. Update `docs/test-suite-assessment.md` to include the root/dashboard scope distinction and the current dirty-tree counts after FG-398 lands.
2. File a small follow-up for test tiers/scripts before doing deletion work.
3. Treat `backlog-notes.test.ts` as a real cleanup candidate because it mirrors logic instead of calling production code.
4. After FG-398 lands, trim the lock tests to the strongest non-overlapping set and revisit the live-PID stale-lock semantic.
5. Add a shared fixture/harness task for the v2 worktree tests and the global `/tmp` placeholder setup.

The suite is a little heavy, but it is buying real safety. The cleanup should be surgical: remove false-confidence tests, table-drive noisy granular cases, and improve tiering. Do not optimize by deleting ticket-scoped regression coverage just because the filenames look old.
