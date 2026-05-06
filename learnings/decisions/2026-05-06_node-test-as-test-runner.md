# Decision: Use Node's built-in `node:test` runner with `tsx` loader

**ID**: FORGE-DEC-010
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Steven (forge build, after first end-to-end run revealed test gap)
**Supersedes**: N/A
**Scope**: forge

---

## Context

Forge shipped v0 with no automated tests. The first run's red-wide auditor on the `testability` lens flagged this as a `severity: high` finding. Several real bugs (orphaned spawn, missing upstream-context bridge, the `--append-system-prompt-file` non-existent flag) would have been caught earlier with even minimal unit tests.

The repo currently has three runtime dependencies (better-sqlite3, commander, gray-matter). The dependency budget is tight by design — the project is small and personal, and every new dep is more surface area to keep current.

---

## Problem

**Which test runner should forge use for unit and integration tests?**

---

## Options Considered

### Option A: `node:test` (built-in, Node 20+) ✅

```
npm test  →  node --import tsx --test src/**/*.test.ts
```

**Pros**:
- Zero new runtime dependencies (tsx is already a devDep for the bin shim)
- Stable in Node 20+; no experimental flags
- Async/await works natively; subtests via `t.test()`
- `node:assert/strict` is sufficient for this codebase's needs
- No config file required

**Cons**:
- No watch mode by default (Node 22+ has `--watch`, fine)
- No coverage built in (use `c8` if needed later)
- Smaller ecosystem of plugins

---

### Option B: vitest

**Pros**:
- Excellent watch mode and parallelization
- First-class TS via vite
- Snapshot testing, mocking, fixtures all included
- Strong ecosystem

**Cons**:
- Adds vitest + vite to devDeps — large surface area for a CLI that has no frontend
- Configuration required (vitest.config.ts)
- Forge has no use for vite's bundling

---

### Option C: uvu

**Pros**:
- Smallest, fastest

**Cons**:
- Project less actively maintained than the alternatives
- No watch mode, no parallelization
- Smaller community

---

## Decision

**Chose**: Option A — `node:test` + `tsx` loader.

**Rationale**: Forge's tests are pure-function unit tests and in-memory SQLite integration tests. None of the features that justify a full framework (snapshot diffing, vite-style mocking, frontend assertions) apply here. `node:test` is good enough, ships with Node, and adds zero deps. If forge ever grows a need (browser tests, large fixture matrices, snapshot regression suites), revisit; the test code itself is portable enough that a runner swap is a few imports.

---

## Consequences

**Positive**:
- `npm test` works the moment a `.test.ts` file lands; no framework setup
- Test code uses standard Node patterns (no DSL to remember)
- Test files coexist with source via the `*.test.ts` convention; no separate test directory

**Negative / Trade-offs**:
- No watch mode without `--watch` (Node 22+) or a small wrapper
- Coverage requires adding `c8` later if we want it
- IDE integration is less polished than vitest's

---

## Implementation Notes

- `npm test` → `node --import tsx --test 'src/**/*.test.ts'`
- Test file convention: colocate as `<module>.test.ts` next to `<module>.ts`
- For DB tests: open an in-memory SQLite via `new Database(':memory:')` rather than the on-disk store. Add a small helper that exec()s `SCHEMA_SQL`
- Use `node:assert/strict` for all assertions
- For fixture files (constraint markdown, agent CLAUDE.md), use `os.tmpdir() + crypto.randomUUID()` to avoid test-to-test contamination

---

## Revisit Conditions

- If forge gains a frontend or a more complex async pipeline that needs `vi.mock`-style helpers
- If coverage becomes a hard requirement (CI gates) and `c8` proves awkward
- If parallelization becomes valuable as the suite grows past a few hundred tests
