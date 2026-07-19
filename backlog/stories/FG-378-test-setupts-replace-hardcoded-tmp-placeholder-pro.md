---
id: FG-378
type: story
status: deferred
title: "test-setup.ts: replace hardcoded /tmp placeholder project dirs with per-test mkdtemp"
created: 2026-06-23
---

**Priority: low — test-infra hygiene.**

## Problem

`src/test-setup.ts` was given a HARDCODED list of `/tmp/<name>` placeholder project dirs that it `mkdirSync`'s before the suite runs (added during the FG-374 follow-up so the new `preflightProjectMount` existence check wouldn't fail on integration tests that pass non-existent fake projectDir strings):

```
/tmp/test-project, /tmp/x, /tmp/proj, /tmp/some-project,
/tmp/integ-manifest-project, /tmp/fg364-test-project,
/tmp/fg368-test-project, /tmp/fg371-test-project, /tmp/fg371-retry-once-test
```

This couples the global test-setup to specific fixture path strings used by individual integration tests. It is brittle: a new integration test that uses a different `/tmp/<name>` placeholder will fail the preflight unless its path is also added to this list, and the coupling is non-obvious (the failure surfaces far from test-setup.ts).

## Fix sketch

Make the integration tests that need a project dir create a REAL temp dir with `mkdtempSync(join(tmpdir(), ...))` and pass that as `projectDir`, instead of hardcoded `/tmp/<name>` strings. Then remove the hardcoded `mkdirSync` block from `src/test-setup.ts`. (Alternatively, if a shared placeholder is genuinely wanted, expose one helper that returns a real temp project dir rather than a static path list.)

## Acceptance Criteria

- `src/test-setup.ts` no longer hardcodes a list of specific `/tmp/<name>` project dirs.
- Integration tests that need a projectDir use real per-test temp dirs (mkdtemp) that exist before the preflight runs.
- Full `npm test` stays green.

## Notes

- Surfaced during the FG-374 follow-up (2026-06-23). Functional and green today — purely a brittleness/maintainability cleanup. Relates to FG-374 (preflightProjectMount) and FG-354 (persistence/temp-dir conventions).

## Disposition — 2026-07-19

Deferred. The brittleness remains, but converting the large set of existing fixtures provides no current product benefit and should not compete with operator-facing or correctness work.
