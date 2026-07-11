---
id: FG-534
type: story
status: active
title: "forge-test mirror: mtime skip-predicate is dead code (sub-ms precision) — decide content-hash vs always-copy; naive mtime rounding would reintroduce the FG-520 false-green"
created: 2026-07-11
---

## Problem (two coupled findings from the FG-520 live-smoke verification)

**F1 (perf-only, safe):** docker/forge-test.sh's mirror skips a file when size AND mtimeMs match (~:133). Source mtimes carry sub-ms precision; fs.utimesSync writes a rounded value, so the comparison NEVER matches — every invocation re-copies all ~1500 files ("1478 file(s) updated" on a no-change run). Correctness is fine (always fresh), cost is subsecond. The incremental fast-path is dead code.

**F2 (latent, dangerous):** if F1 is ever "fixed" by rounding both mtimes before comparing, a same-size + same-mtime edit (natural on 1s-granularity filesystems, e.g. some macOS Docker bind mounts) is silently SKIPPED — a green run against stale source, the exact false-green FG-520 killed. F1 and F2 must be resolved together.

A guard test already exists (fg520-forge-test-resync.integration.test.ts, same-size-edit-must-propagate): passes today and under any correct fix; fails if the predicate relaxes to size-only.

## Acceptance Criteria

- A deliberate decision, implemented or documented: (a) content-hash comparison, (b) treat src mtime >= dst mtime as dirty, or (c) keep the unconditional copy and say so in a comment at the predicate (deleting the dead fast-path) — any of the three is acceptable; silent status quo is not.
- The same-size-edit guard test still passes; if (a)/(b), a no-change run provably skips (the "0 file(s) updated" line) without breaking the smoke semantics.

## Notes

Filed 2026-07-11 from the FG-520 test-engineer findings F1+F2 (run-fg-520-forge-test-resync-ffa2df). Low priority — current behavior is safe and fast enough.
