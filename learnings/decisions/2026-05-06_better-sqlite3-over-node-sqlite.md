# Decision: Use `better-sqlite3` for the blackboard

**ID**: FORGE-DEC-001
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Claude Code (forge build)
**Supersedes**: N/A
**Scope**: forge

---

## Context

Forge needs a SQLite client for the blackboard. Node 22+ ships an experimental `node:sqlite` module; the established options are `better-sqlite3` (synchronous, native binding), `sqlite3` (async, callback-style), and `@libsql/client` (async, optional remote/turso support).

The forge CLI runs short, one-phase-at-a-time. There is no long-lived server, no concurrent request load, and no need for async DB I/O at the application level. The whole CLI's lifetime is typically seconds to minutes.

---

## Problem

**Which SQLite library should the blackboard use?**

---

## Options Considered

### Option A: `node:sqlite` (built-in)

**Pros**:
- Zero dependencies
- Native to the platform

**Cons**:
- Marked experimental in Node 22; behavior may shift
- Requires `--experimental-sqlite` flag at runtime in some Node versions
- Less production validation than `better-sqlite3`

---

### Option B: `better-sqlite3` ✅

Native binding, synchronous API.

**Pros**:
- Synchronous API matches the use pattern: forge does small bursts of DB work, not concurrent reads
- `prepare()` + transaction primitives are clean
- Battle-tested in CLIs and desktop tools
- WAL mode and PRAGMA support work as expected

**Cons**:
- Native dependency — first install does a build (acceptable for personal CLI)

---

### Option C: `sqlite3` (callback-async)

**Pros**:
- Mature

**Cons**:
- Async-everywhere wraps every store call in a Promise for no benefit; complicates the spine code

---

## Decision

**Chose**: Option B — `better-sqlite3`

**Rationale**: forge's blackboard usage is a sequence of small, fast queries from a single process. Synchronous calls keep the spine code straight-line — `insertTask(task)` is one line, not a `.then()` chain. The native build is a one-time cost on `npm install`. `node:sqlite` would be tempting once it's stable, but until then, `better-sqlite3` is the lower-risk choice.

---

## Consequences

**Positive**:
- Store-layer code is plain function calls, no async noise
- Transaction support is simple to wire in if needed later

**Negative / Trade-offs**:
- Requires a C++ toolchain on first install (handled automatically on macOS/Linux dev machines)

**Risks**:
- If forge ever needs to run inside a process that requires async-only I/O (e.g., a future web UI), this would force a port — small cost given how localized the store layer is

---

## Implementation Notes

- All store functions are synchronous (`insertRun`, `insertTask`, etc.)
- DB opened lazily via `getDb()` in `src/store/db.ts`; `WAL` and `foreign_keys = ON` set at open
- Schema applied via `db.exec(SCHEMA_SQL)` — `CREATE TABLE IF NOT EXISTS` makes init idempotent

---

## Revisit Conditions

- If `node:sqlite` reaches stable status and gains the same query ergonomics
- If forge grows a long-lived process or concurrent writers
