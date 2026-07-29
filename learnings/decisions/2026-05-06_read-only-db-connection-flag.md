# Decision: Optional read-only flag on the DB singleton, plus a 5s busy_timeout

**ID**: FORGE-DEC-012
**Date**: 2026-05-06
**Status**: Decided
**Decided by**: Steven (forge build, fixing backlog item #29)
**Supersedes**: N/A
**Scope**: forge

> **Amended 2026-07-29 (FG-608).** The decision stands; two of its recorded consequences no longer describe the code. This ADR predicted both and left them unpaid, and FG-608 paid them because the dashboard and the in-container ticket reader are pure readers that must never mutate a store:
>
> - **A read never creates or migrates the store.** `getDb({readOnly: true})` against a missing `~/.forge/forge.db` now throws `StoreUnavailableError` instead of falling through to a writable open — which used to exec the schema and run every migration, so a `forge status` on a fresh host silently minted the database. It also no longer calls `ensureForgeDirs()`, so a read does not create `~/.forge/` either. Callers that legitimately tolerate "no store yet" call `storeExists()` first; the survey commands do, and answer empty (see `src/cli/no-store.ts`).
> - **An un-migrated store is READ AS-IS, not migrated and not refused.** The open path is additive-only (FG-568/BD-15), so an older file's shape is a strict subset of the current one; a query for a table this binary knows and the file lacks raises an ordinary SQLite error naming it. Refusing instead would break every read of a store written by an older peer, which is the compatibility that policy exists to preserve.
>
> The bullets below marked *(superseded — see the amendment above)* are kept for the record.

---

## Context

Forge stores all run state in a single SQLite file at `~/.forge/forge.db`, opened via a process-wide singleton in `src/store/db.ts`. The singleton is initialized writable (with `journal_mode = WAL`, `foreign_keys = ON`, schema apply) on first call. Every store accessor (`runs.ts`, `tasks.ts`, `verdicts.ts`, `events.ts`, `gates.ts`) calls `getDb()` directly with no arguments.

During the v0 dashboard run we hit a real friction: running `forge status` while a `forge next` was mid-flight occasionally appeared to hang. With WAL, *readers* never block writers — but `forge status <run-id>` calls `reconcileRun`, which writes. And even pure-read commands like `forge show` were opening a writable connection, so SQLite would briefly contend on the small commit window of the live writer.

The handoff for this session named two related fixes:
- "DB-lock contention between concurrent forge invocations" (#29)
- Suggested approach: "add `getReadOnlyDb()` and use it in status/show commands"

---

## Problem

**How should read-mostly CLI commands (`forge show`, `forge status`) acquire a DB connection that doesn't contend on writes against a concurrent `forge next`?**

---

## Options Considered

### Option A: Separate `getReadOnlyDb()` plus parallel read-only accessors

Add a sibling singleton — `getReadOnlyDb()` — that opens with `{readonly: true}`. Add read-only variants of every accessor (`getRunReadOnly`, `tasksForRunReadOnly`, etc.) that route through it. Read-mostly commands import the read-only accessors.

**Pros**:
- Explicit at every call site: impossible to accidentally write from a read-only command
- Two singletons coexist cleanly; no temporal coupling

**Cons**:
- Roughly doubles the surface area of `src/store/`
- Every new accessor needs a read-only twin or a shared lower-level helper
- Most of the surface area exists to express something the connection already knows (its mode), so the duplication is bookkeeping, not semantics

---

### Option B: Optional `{readOnly}` flag on `getDb()`, called once before the first store access ✅

Keep the single-singleton model. `getDb({readOnly: true})` opens the file with `{readonly: true}` *if* called before any other code has touched the singleton. Subsequent calls — including from store accessors that don't pass any flags — return the same instance. Read-mostly CLI commands call `getDb({readOnly: true})` at the top of their action handler; everything downstream sees a read-only connection without needing to know.

**Pros**:
- Tiny diff: one new code path in `db.ts`, one line per opt-in command
- Store accessors remain mode-agnostic (single set of functions)
- Composes cleanly with the existing `setDbForTest`/`makeInMemoryDb` test seam — those already replace the singleton outright
- Pairs well with `busy_timeout` so the *writable* path also stops hanging

**Cons**:
- Order-dependent: the read-only call has to come before any store call. If a future CLI command forgets, it silently gets a writable connection (correct, but misses the contention benefit)
- Less self-documenting at call sites in the store layer

---

### Option C: Just add `busy_timeout` and call it done

Set `db.pragma("busy_timeout = 5000")` on the writable singleton. With WAL, that alone resolves the perceived hang: a contending writer waits up to 5s for the lock instead of failing or appearing stuck.

**Pros**:
- Minimum diff. Solves the symptom directly.

**Cons**:
- A read-mostly command that *only* reads still acquires a writable handle and could in principle write. The intent isn't expressed in code.
- A `forge status` running concurrent with a long writer still gets a 1–2 sec pause where it could in principle have proceeded immediately on a read-only handle.

---

## Decision

**Chose**: Option B + the `busy_timeout` from Option C — both, layered.

**Rationale**: Option C is the actual contention fix; busy_timeout is what stops `forge status` from appearing to hang. Option B is the right *intent* shape: `forge show` never wrote, so giving it a read-only handle is just code matching reality. Option A's parallel accessor surface is real overhead for a single-process CLI where the singleton model is doing fine.

We accept the order-dependent nature of Option B because (1) CLI command files are the only callers that opt in, and (2) they're short — the `getDb({readOnly: true})` call is right next to `ensureForgeDirs()` at the top of the action. If that proves brittle later, we can switch to Option A, which is a strictly larger refactor of the same idea.

---

## Consequences

**Positive**:
- `forge show` is read-only by construction — physically can't write
- `forge status --read-only` lets a user inspect a run without ever taking a write lock, useful when `forge next` is actively spawning
- The writable path is more forgiving of contention thanks to busy_timeout — fewer "did it hang?" moments even without --read-only
- Default `forge status` behavior is unchanged: stuck-task reconciliation still runs, just on a writable handle that now waits up to 5s instead of giving up

**Negative / Trade-offs**:
- Order-dependence: a future CLI command that wants read-only mode must call `getDb({readOnly: true})` before any store accessor. There's no compile-time check enforcing this.
- *(superseded — see the amendment above)* A read-only open on a non-existent DB file would fail (SQLite refuses to create files in readonly mode), so `getDb` falls through to the writable path when `DB_PATH` doesn't exist yet. Read-only callers on a fresh install simply observe an empty DB.

**Risks**:
- A future schema migration runs in `getDb()` on the writable path. If a read-only call lands on a process where the writable path *would have* migrated, the DB stays at the old schema. Mitigation: schema migrations should be a `forge migrate` command, not implicit on first connection. (Not a problem in v0 — schema is `IF NOT EXISTS` and immutable.)

---

## Implementation Notes

- *(superseded — see the amendment above)* `getDb(opts?: {readOnly?: boolean})` — when `readOnly: true` *and* the DB file already exists, opens `new Database(path, {readonly: true})` and skips schema/pragma application. Always sets `busy_timeout = 5000`, on both modes.
- `forge show` calls `getDb({readOnly: true})` unconditionally — the command is purely read-only.
- `forge status` accepts `--read-only`. Without the flag: writable connection, runs `reconcileRun` for stuck-task recovery (existing behavior). With the flag: read-only connection, skips reconcile.
- The first `getDb()` call wins. A second call with different options returns the cached instance. This is fine for the singleton model but worth knowing if you're debugging "why is my readOnly flag ignored" — something else called `getDb()` first.
- Tests use `setDbForTest(makeInMemoryDb())` to bypass the on-disk singleton entirely — this decision doesn't affect the test seam.

---

## Revisit Conditions

- If forge ever needs to fan out CLI calls into a long-lived process (daemon mode, despite the spine sketch's stance against it), the singleton model breaks down and we'd want Option A's per-connection handles
- If we add a CLI command that *should* be read-only but accidentally gets a writable connection because of call order, switch to Option A so the type system enforces it
- If schema migrations become non-trivial, move them out of `getDb()` so a read-only call doesn't silently skip them
