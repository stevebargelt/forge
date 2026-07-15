---
id: FG-295
type: story
status: done
title: Usage capture silently fails on fresh installs — insertUsageRows writes dropped legacy columns
---

**Closed:** 2026-06-05.

**Correctness bug, external-user-facing.** On a forge DB created fresh today, `model_calls` usage capture silently records nothing. Steve's host is unaffected only because his DB was migrated up from 0.1.x and still carries the legacy columns.

**Root cause:** `insertUsageRows` (src/store/model-calls.ts ~328) INSERTs into `prompt_tokens, completion_tokens, cost` (writing 0,0,0):
```
INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at, prompt_tokens, completion_tokens, cost)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
```
But those three are the **0.1.x legacy columns**. The current `SCHEMA_SQL` (src/store/schema.ts) creates `model_calls` WITHOUT them, and the #155 reshape migration (src/store/db.ts ~58) only ADDs the new columns (`input_tokens` etc.) — it never adds `prompt_tokens/completion_tokens/cost`. So:
- **Migrated DB (0.1.x → now):** legacy columns still present → insert succeeds. (Steve.)
- **Fresh DB (install today):** legacy columns absent → `SqliteError: table model_calls has no column named prompt_tokens` → thrown → swallowed by `captureUsageForTask`'s try/catch → returns `{ rowCount: 0 }`. **No usage data is ever recorded; `forge usage` is empty forever, with no error surfaced.**

**Discovered:** during #292, writing a `captureUsageForTask` unit test against `makeInMemoryDb` (fresh schema). The pure parsers (`extractUsageFrom*`) are fine; only the insert is broken.

**Fix (small, isolated):** drop the three legacy columns from the INSERT — they only ever write 0 and serve nothing:
```
INSERT INTO model_calls (task_id, request_id, model, alias, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
```
Verify against BOTH a fresh DB and a legacy-migrated DB (legacy columns are NOT NULL — confirm they have a DEFAULT so an insert omitting them still works on migrated DBs; if not, the migration must backfill a default or the columns be dropped).

**Related / why it stayed hidden:**
- `captureUsageForTask` swallows all errors by design (telemetry must never break task semantics) — correct, but it masks this. Consider logging the swallowed error at debug, or counting capture failures so they're observable.
- This is squarely #141 (SQL schema single-source-of-truth): the INSERT column list and `SCHEMA_SQL` drifted apart with no compile-time check. A fix here is a patch; #141 is the systemic guard.

**Acceptance:**
- A unit test inserts a usage row into a fresh-schema DB (e.g. `makeInMemoryDb`) and reads it back — proving capture works without a 0.1.x migration history.
- The same passes on a DB that DID migrate from 0.1.x (legacy columns present).
- `forge usage` shows non-empty data after a real run on a fresh install.

Relations: #141, #155, src/store/model-calls.ts, src/store/db.ts, src/store/schema.ts.

---

**2026-07-15 — Superseded by FG-568 (`275ac63`).** The **Fix** above prescribed *dropping* the three legacy columns (`prompt_tokens/completion_tokens/cost`) from the INSERT, and warned that a 0.1.x-migrated store would need a column DEFAULT or destructive removal for the fresh-only INSERT to work. FG-568 (FG-553 Child 1) took a different, backward-compatible path and that prescription no longer describes the code:

- `insertUsageRows` (`src/store/model-calls.ts`) is now **dual-shape**. It inspects `model_calls` at write time: on a fresh store (legacy columns absent) it runs the fresh-only INSERT; on an unconverged 0.1.x store (all three legacy columns present, NOT NULL) it appends them to the column list and writes the established `0/0/0` placeholders as SQL literals. A store carrying only *some* legacy columns is an inconsistent schema and is rejected explicitly rather than written.
- **Nothing is dropped to make usage capture work.** Usage capture now succeeds on both shapes without altering the schema, so FG-295's fresh-install failure stays fixed while a 0.1.x-migrated store keeps working with no destructive change.
- Removing the legacy columns is no longer coupled to this fix. It is now the separate, explicit operator step `forge store converge` (`runDestructiveConvergenceMigration` in `src/store/db.ts`) — quiesce-gated and a one-way boundary — not something the usage-capture path performs. The ordinary store-open path is additive-only and drops nothing.

FG-295's acceptance still holds; this note records only that the prescribed *mechanism* (drop the legacy columns) was superseded by the dual-shape writer.