---
id: FG-607
type: story
status: done
title: "FG-496 Slice B: DB-backed backlog CRUD + per-project storage mode (behind the structured.ts seam)"
created: 2026-07-24
closed: 2026-07-25
closed_commit: a59ba14
---

## Slice B of FG-496 — DB-backed CRUD behind the seam (still default-markdown)

Reimplement the `src/backlog/structured.ts` function surface to operate on the DB when a project's storage
mode is `db`, keeping Markdown behavior for `markdown` mode. Because nearly every consumer imports
`readTicket` / `listTickets` / `ticketExists` / `writeTicket` / `closeTicket` / `retitle` / `move` /
`fillClosedCommit` from this **single seam**, one dual-mode implementation migrates them all at once. Default
mode stays `markdown` in this slice, so live behavior is unchanged until an operator opts a project into `db`.

## Scope

- Dual-mode dispatch behind the **unchanged** structured.ts signatures (every existing caller compiles/passes),
  scoped by the `(project_key, ticket_id)` identity established in Slice A.
- **Storage mode is read from the DB, keyed by `project_key`** (Slice A's host-side record) — NOT from each
  worktree's config. `.forge/config.yml` holds only the durable `project_key`; two worktrees therefore cannot
  disagree about which store is authoritative. The mode is authoritative — NO silent read-through blending of
  DB + Markdown (that reintroduces split-truth).
- **Transactional id allocation:** in db mode, `forge backlog file` allocates the next id from the
  per-`(project_key, prefix)` sequence (Slice A's table) inside the write transaction, so concurrent files in
  two worktrees cannot collide or reuse an id.
- CLI `file` / `edit` / `close` / `show` / `list` work with **no `backlog/` dir present** in db mode.
- CLI surfaces the active storage mode (and which store it read) on every invocation.
- Filing / editing / closing no longer dirties project `git status` in db mode.

## Files (grounded)

- `src/backlog/structured.ts` — the seam; dual-mode behind unchanged signatures.
- `src/store/*` — read/write the host-side storage-mode record + the id-allocation sequence (both from Slice A).
- `src/cli/commands/backlog.ts` — mode banner; drop the `existsSync('backlog')` hard requirement (~line 196).
- `src/store/db.ts` — `BEGIN IMMEDIATE` / writeTxn for atomic DB writes (replaces the `withBacklogLock` fs lock).

## Acceptance Criteria

- **FG-495 shape:** create a ticket in db mode, then read it from a clean secondary worktree/checkout with NO
  Markdown file present — Forge still finds it via the DB, using the same `project_key`.
- Two linked worktrees of one project resolve the SAME storage mode (it lives in the DB under `project_key`);
  changing the mode is visible to both without editing either worktree's files.
- A project with no `backlog/` dir supports full CRUD (file/edit/close/show/list) in db mode.
- `git status` stays clean after file/edit/close in db mode.
- Concurrent `file` in two worktrees allocate distinct ids from the `(project_key, prefix)` sequence (no
  collision, no reuse).
- CLI clearly prints whether it read legacy Markdown or the DB.
- Every existing structured.ts caller (see FG-496 consumer inventory) compiles and passes unchanged.
- Additive schema only; no `user_version` bump.

## AC 1 AMENDED (2026-07-24) — cost target yields to the cross-worktree correctness invariant

AC 1 originally required that a never-imported markdown project pay **no DB open and no git subprocess** on the
seam path. That is not simultaneously satisfiable with AC 2 ("two linked worktrees resolve the SAME storage
mode"), and the first implementation attempt proved it by choosing cost and breaking correctness:
`storage-mode.ts` short-circuited to markdown whenever config had no `project_key` but a local `backlog/`
directory existed — so a linked worktree on a branch predating the `project_key` commit (which has `backlog/`,
because it is git-tracked, and no key, because config is git-tracked and per-branch) resolved **markdown** while
its sibling resolved **db**. Silent split truth, which is the bug FG-496 exists to eliminate.

Distinguishing "never imported" from "imported, but this branch predates the key commit" requires information
that exists only in the DB, so there is no local, free way to satisfy both. Correctness wins.

**AC 1 now reads:** a markdown-mode project that has never been imported produces behavior identical to main,
and pays no per-call cost regression — store resolution is memoized per (process, projectDir), so the
`listTickets`/`readTicket` loops in campaign planner / report / done-audit pay it once rather than per call. On a
host with no `forge.db` at all, resolution stays completely free (no DB created, no git invoked). On a host that
has a `forge.db`, one git evidence computation plus one DB open per process is accepted.

AC 2 is unchanged and is now load-bearing: when config carries no `project_key`, the registry is ALWAYS consulted,
because `repositoryCheckoutIdentity` converging linked worktrees via git-common-dir is the mechanism that makes
AC 2 true.

## Dependencies / Relations

- Parent: FG-496. Epic: FG-593.
- Depends on: Slice A (FG-606 — schema, project identity, host-side mode record, id-allocation sequence).
- Blocks: Slice C (the cutover), Slice D (queue fields).

## Non-Goals

- Does NOT flip the default authority to the DB (that is Slice C). No queue rank/membership/readiness (Slice D),
  claims (Slice E), UI, or dispatcher. No Markdown export.

## Acceptance Evidence

Shipped in `33bc5f2` (slice) + `a59ba14` (store-path / closed-handle fixes), merged to main 2026-07-24.
Required CI green at `a59ba14`: `test` and `test-extended` (all six member jobs).

| AC | Evidence | Verdict |
|---|---|---|
| FG-495 shape: a db-mode ticket is readable from a clean secondary worktree with NO Markdown file, same `project_key` | `src/backlog/fg607-cross-worktree.integration.test.ts:75` — real `git worktree add`, sibling asserted to have no `.forge/config.yml` (`:97`), ticket read back through the real CLI (`:109`) | met |
| Two linked worktrees resolve the SAME storage mode; the mode lives in the DB under `project_key` | `fg607-cross-worktree.integration.test.ts:145` "a sibling worktree with a STALE local backlog/ and no key still resolves db" — the case an earlier implementation got wrong (F8); verified failing pre-fix with `'markdown' !== 'db'`. Resolver: `src/backlog/storage-mode.ts` always consults `registryByEvidence` when config carries no key | met |
| A project with no `backlog/` dir supports full CRUD in db mode | `src/backlog/fg607-store-banner.integration.test.ts`, `fg607-mode-flip.integration.test.ts`, `fg607-seam-consumers.integration.test.ts` drive file/edit/close/show/list with no directory present; `src/cli/commands/backlog.ts` drops the `existsSync('backlog')` gates at `import` and `config --show` | met |
| `git status` stays clean after file/edit/close in db mode | `fg607-db-mode.test.ts:108` "writes create NO files — git status stays clean in db mode"; `fg607-cross-worktree.integration.test.ts:58` `porcelain()` asserts both trees clean after a full CRUD cycle; `fg607-store-banner.integration.test.ts:177` | met |
| Concurrent `file` in two worktrees allocate distinct, non-reused ids | `fg607-id-allocation.integration.test.ts:98` — 6 REAL concurrent child processes against a real on-disk SQLite file (an in-memory DB degenerates `BEGIN IMMEDIATE` to `BEGIN`, `src/store/db.ts:526-543`, so it cannot demonstrate this). `allocateTicketId` runs inside the caller's `writeTransaction` | met |
| CLI clearly prints whether it read legacy Markdown or the DB | `fg607-store-banner.integration.test.ts:97` (markdown), `:117` (db + stale-`backlog/` flag), `:142` asserts the banner never contaminates `--json` stdout (it is stderr-only). `describeBacklogStore` in `storage-mode.ts` | met |
| Every existing structured.ts caller compiles and passes unchanged | Signatures unchanged; `npm run typecheck` clean on the host; the pre-existing `structured.test.ts` / `structured.integration.test.ts` markdown regression suites pass unmodified; `fg607-seam-consumers.integration.test.ts` covers the consumer surface; full CI green at the merged tip | met |
| Additive schema only; no `user_version` bump | `git diff e0c1c2c..HEAD -- src/store/schema.ts` is EMPTY — Slice A (FG-606) had already added every table this slice writes | met |
| AC 1 as AMENDED (see the amendment section): identical markdown behavior, no PER-CALL cost regression, still free with no `forge.db` | `fg607-seam-cost.integration.test.ts` — child process with its own empty `FORGE_HOME` and a recording `git` shim first on PATH; after `backlog list`/`show`/`notes show` no `forge.db` was created and the git shim was never invoked. Memoization asserted (fails with `CACHE_TTL_MS=0`: 1 call = 3 git invocations, 25 calls = 75) | met |

Deferred to FG-608 with reasoning recorded there (neither is this ticket's AC): stale blocker evidence surviving
a re-import (the append-only-import boundary FG-606 settled), and the evidence-key `reidentify` path the Slice C
cutover requires.
