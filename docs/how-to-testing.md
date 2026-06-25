# How-to: writing and running tests

## Test tiers

The suite is split into three tiers selected by **filename suffix**. Every `*.test.ts` file belongs to exactly one tier — `src/test-tiers.test.ts` enforces this as a partition proof that fails the suite if any file is in two tiers or in none.

| Tier | Suffix | Command | Count |
|------|--------|---------|-------|
| Unit | `*.test.ts` (excluding the two below) | `npm run test:unit` | 1473 |
| Integration | `*.integration.test.ts` | `npm run test:integration` | 313 |
| Worktree | `*.worktree.test.ts` | `npm run test:worktree` | 85 |
| Aggregate (root) | all three above | `npm test` | 1871 |
| Shipped-claim aggregate | root + dashboard workspace | `npm run test:all` | 1898 |

`npm test` (root aggregate) runs the full root suite and is the regression gate. `npm run test:all` additionally runs the dashboard workspace (`npm test -w dashboard`, 27 tests) and is the gate to run before claiming work shipped.

## What belongs in each tier

**Unit** — pure functions and in-memory logic only. No subprocess spawning, no real filesystem I/O beyond `os.tmpdir()` scratch, no SQLite on disk, no git operations, no `sleep` or deliberately long-running operations. Use `new Database(':memory:')` for any schema tests. If a test needs to verify that a CLI command parses correctly or that the database persists across a reconnect, it belongs in integration or worktree — not unit.

**Integration** — tests that spawn a CLI subprocess, write to a real (temp) filesystem, or open an on-disk SQLite database. One process per test, no git worktrees. Typical: `forge backlog list`, reading/writing backlog files, verifying CLI error messages, real-DB round-trips.

**Worktree** — tests that create git worktrees, exercise dispatch/fanout/merge-back orchestration, or measure control-plane timing. These are expected to be slow. Anything that calls `spawn` for a git worktree operation or tests the full orchestration pipeline at the worktree seam lives here.

## Placement rule

> **Do not put subprocess-heavy, git/worktree, real-DB, or sleep/long-running tests in the unit tier.** Those go to integration (`.integration.test.ts`) or worktree (`.worktree.test.ts`). The unit tier must stay fast and pure so it remains useful for rapid local iteration.

The convention is mechanically enforced: `src/test-tiers.test.ts` asserts that the three suffix sets are pairwise disjoint and their union equals the complete `src/**/*.test.ts` corpus. If you add a file with a suffix that matches two tiers (impossible with the current naming scheme) or somehow create a file that matches none, the partition test fails the suite.

## Running a specific tier

```bash
# Fast, pure — run while iterating on a pure helper or formatter
npm run test:unit

# CLI subprocess / real FS / real DB
npm run test:integration

# Git worktree, dispatch/fanout orchestration
npm run test:worktree

# Full root suite (all three tiers)
npm test

# Full shipped-claim gate (root + dashboard)
npm run test:all
```

## Agent-iteration contract

Within an agent's in-loop validation, use `forge-test` at the right tier:

- **`forge-test`** (unit tier, no args) — the default. Fast and pure; run this while iterating on most changes.
- **`forge-test --integration`** — when the change touches CLI-spawn, real filesystem, or real DB boundaries.
- **`forge-test --worktree`** — when the change touches git-worktree operations, dispatch-fanout, or orchestration paths.
- **`forge-test <file.test.ts>`** or **`forge-test --test <pattern>`** — run a specific file or pattern regardless of tier.

**A green unit tier is in-loop confidence, not a shipped claim.** The orchestrator runs `npm run test:all` (the shipped-claim aggregate: root suite + dashboard workspace) on the host before a run is called complete. Agents must report their validation tier honestly in their result — `status: "complete"` means the diff was validated at the level appropriate for its change; it does not mean the full aggregate has been verified.

## Naming a new test file

Pick the suffix that matches the slowest operation the test performs:

- No subprocess, no git, no disk DB → `<module>.test.ts`
- CLI spawn or on-disk DB → `<module>.integration.test.ts`
- Git worktree or orchestration dispatch → `<module>.worktree.test.ts`

Colocate the file next to the module it tests (`src/foo/bar.ts` → `src/foo/bar.test.ts`). Ticket-scoped regression files live under `src/v2/` and follow the same suffix rule.
