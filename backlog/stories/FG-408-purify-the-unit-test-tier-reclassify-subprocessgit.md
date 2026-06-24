---
id: FG-408
type: story
status: active
title: "Purify the unit test tier: reclassify subprocess/git/sleep tests out of test:unit + add a content guard (completes FG-406 unit-purity AC, blocks FG-407)"
created: 2026-06-24
---

## Problem

FG-406 split the suite by filename suffix and added a partition-proof test, but the partition proof only checks suffix disjointness/union — NOT semantic purity. Several pre-existing plain `*.test.ts` files that now sit in the UNIT tier actually do subprocess/git/sleep work, violating FG-406's own acceptance ("test:unit excludes subprocess-heavy, git/worktree, and long-running tests") and docs/how-to-testing.md's unit-tier rule. This must be fixed BEFORE FG-407 routes agents to the unit tier as their fast loop — otherwise agents iterate on a "unit" tier that runs git/subprocess/sleep.

This completes the unit-tier-purity acceptance criterion that FG-406 did not fully meet (the suffix mechanism shipped; the existing-file audit did not).

## Confirmed violators (audited 2026-06-24) — reclassify out of the unit tier
- src/util/sso-watchdog.test.ts — spawns `sleep 30`, real detached child processes, timed waits.
- src/v2/forge-test-detect-runner.test.ts — `spawnSync` of a real extractor.
- src/cli/commands/init.test.ts — `execSync("git init")` and `npm run forge -- init` subprocess.
- src/cli/commands/upgrade.test.ts — `execSync` git init/commit/etc.

## Confirmed NON-violators (verify, then LEAVE in unit) — do not move on a false positive
- src/v2/docker-exec.test.ts — the child_process reference is a TYPE annotation for a MOCKED execFile; no real spawn.
- src/v2/project-auth.test.ts — `npm run e2e:auth` is a config STRING under test, not an invocation.
- src/store/runs.test.ts, src/store/tasks.test.ts, src/store/usage-capture-schema.test.ts — `db.exec(...)`/`legacy.exec(...)` is better-sqlite3 SQL execution, not child_process. Confirm the DB is in-memory or a cheap temp file (not slow); if genuinely slow on-disk, reclassify, otherwise leave.

## What to build
For each confirmed violator, choose per file:
- If the file is predominantly subprocess/git/sleep: `git mv` the whole file to `*.integration.test.ts`.
- If the file has a substantial body of genuinely-pure tests worth keeping in the fast loop (e.g. init.test.ts's block-merge/hook-planning tests): SPLIT — keep the pure tests in a `*.test.ts` unit file and move the subprocess/git cases into a sibling `*.integration.test.ts`. Prefer the simpler whole-file rename unless the pure majority clearly justifies a split.
- Audit the FULL plain-suffix unit set, not only the four above — confirm no other unit-tier file spawns processes, runs git, or sleeps.

Strengthen enforcement so this cannot silently regress: extend the tier guard (or add a sibling to src/test-tiers.test.ts) to scan unit-tier file CONTENTS and fail if a unit-tier file imports node:child_process AND makes a real spawn/exec/execSync/spawnSync call, or spawns `sleep`. Be conservative about false positives (a mocked execFile type annotation, a config string, or better-sqlite3 `.exec` must NOT trip it); if perfectly-precise static detection is impractical, implement the best conservative heuristic and document its limits in a comment.

## Acceptance Criteria
- No unit-tier (`*.test.ts`, non-integration, non-worktree) file spawns a subprocess, runs git, or sleeps.
- `npm run test:unit` is verifiably fast and pure; report its wall-clock before/after.
- Reclassified tests still run and pass in their new tier; the aggregate (`npm test`) test COUNT is unchanged (no tests lost — only relocated).
- The partition-proof still holds; the new purity guard fails if a future unit-tier file reintroduces subprocess/git/sleep work.
- docs/how-to-testing.md remains accurate (update only if a convention detail changed).

## Non-Goals
- Agent default tier selection (FG-407).
- Coverage reporting (FG-405).
- Re-tiering integration/worktree files (FG-406 already did those).
