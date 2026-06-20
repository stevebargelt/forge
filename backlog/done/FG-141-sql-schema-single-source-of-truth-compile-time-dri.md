---
id: FG-141
type: story
status: done
title: SQL schema single-source-of-truth (compile-time drift protection for dashboard + future readers)
closed: 2026-06-20
---

Filed 2026-05-24 during the dashboard un-split follow-up (#140). Honest follow-on to a scope caveat called out in docs/SCHEMA-CONTRACT.md.

**Why filed.** After #140 merged the dashboard back as an npm workspace, dashboard/src/queries.ts now re-exports forge's Run/Task types via @forge/types. That cleaned up duplicate type *exports*, but the actual drift surface — the inline `as Array<{...}>` row casts inside each query function — still hardcodes snake_case SQL column names (project_dir, agent_role, run_id, started_at, completed_at, etc.). A column rename on forge's side is still a dashboard runtime failure, not a build error. The drift protection #140's spec promised is only half there.

**Same risk in forge itself, not just the dashboard.** src/store/runs.ts and src/store/tasks.ts have private RowToX functions that mirror SQL column names in their type definitions. Forge's own store layer breaks too if a column gets renamed — it just breaks closer to the change, so the bug is found faster. Dashboard is the canary because it lives across a workspace boundary.

**Fix shape — three options to consider:**

1. **Typed column-name constants.** Single TS file (probably src/store/schema.ts) exports const objects like `RUNS_COLS = { id: 'id', projectDir: 'project_dir', ... } as const`. Every SQL query string is built from these constants; every row cast type references them. Forge changes a column → update the constant → typecheck breaks everywhere wrong. Lowest-disruption shape — doesn't change the SQL strings, just typing what's in them.

2. **Schema-as-code via a library.** Drizzle, Kysely, sql-template-strings, etc. Generate types from a TS-declared schema; queries become typed at the call site. More invasive — rewrite the store layer — but gives compile-time guarantees on JOIN shapes, WHERE clauses, etc. Probably worth it if forge's store layer is going to grow.

3. **Code generation from CREATE TABLE.** Parse the SQL in src/store/db.ts, emit a TS module with column-name constants and row types. Compile-time hook (or a manual `npm run codegen`). No new runtime dep. Maintenance burden is the parser.

**Why option (1) first.** Lowest blast radius, smallest commit. Wraps the existing SQL in a thin type layer without rewriting any query logic. If #112 (transactional dispatch + gate writes) lands later and demands a heavier abstraction, (2) or (3) can build on top.

**Composite with #112** (transactional dispatch + gate writes — touches the same store layer). If both land in the same window, do (1) first; #112's writes also benefit from the typed column constants.

**Out of scope explicitly.** This isn't a runtime change. No DB migration. No new dependencies (for option 1). The dashboard's queries.ts and forge's store/*.ts get a typing pass; the SQL itself stays.

**Sizing.** Small for option (1) — probably one focused session. Medium-large for (2) or (3).

**Caught:** 2026-05-24 during #140 implementation, when the type-extraction work turned out to be cosmetic (dead exports) rather than functional (row-cast types). Documented in docs/SCHEMA-CONTRACT.md as a future ticket.