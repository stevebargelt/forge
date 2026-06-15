---
id: FG-199
type: story
status: done
title: forge-test drops --import ./src/test-setup.ts for file-specific args → false SQLITE_ERROR + bypasses test DB/notify isolation
---

**Closed:** 2026-05-30. Commit `419825c`.

The forge-test wrapper (what agents use to self-validate) omits `--import ./src/test-setup.ts` when invoked with specific file arguments, whereas `npm test` always includes it. test-setup.ts is load-bearing: it sets up the in-memory test DB schema (#170 isolation) AND clears FORGE_NOTIFY so the suite doesn't fire real notifications (#175).

Consequences when an agent/human runs `forge-test <specific-file>`:
- runNext / DB-touching tests fail with SQLITE_ERROR ('no such table/column') because the schema setup never ran — a FALSE failure that makes self-validation untrustworthy (agents have flagged this twice: #194 backfill, and the earlier runNext isolation confusion).
- Potentially worse: without the import, a specific-file run could touch the real ~/.forge/forge.db and/or fire real notifications (the two things test-setup.ts exists to prevent). Needs confirming whether the file-specific path actually reaches a live DB/provider in practice.

Fix: make forge-test ALWAYS pass `--import ./src/test-setup.ts` regardless of whether file args are present. Relates to #178 (forge-test node:test vs Jest) — same wrapper.