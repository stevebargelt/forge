---
id: FG-557
type: story
status: done
title: fg520-forge-test-resync.integration.test.ts 'no-change re-sync should be fast' is a wall-clock threshold that fails under host load (17s vs sub-second unloaded) — make it load-insensitive
created: 2026-07-14
closed: 2026-07-29
closed_commit: 9623a704
---

## Acceptance Evidence

Shipped in `9623a704` (PR #176). The wall-clock threshold is gone: the test now asserts the no-change re-sync MECHANISM (fast-path taken / zero files copied) — load-insensitive by construction, no seconds budget remains in the assertion. Executed lanes: in-container integration (fg520 suite 21/21 from a dirty tree), CI integration @ 6ada5898 green, and bounded review (Q4) verified the original intent is preserved rather than merely passing.

| AC | Evidence | Verdict |
|----|----------|---------|
| 'no-change re-sync should be fast' no longer fails under host load | Mechanism/work-count assertion replaces elapsed-time comparison; no wall-clock term left to be load-sensitive; executed 21/21 in-container and green in CI @ 6ada5898 | met |
