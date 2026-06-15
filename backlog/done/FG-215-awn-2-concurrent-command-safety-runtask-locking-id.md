---
id: FG-215
type: story
status: done
title: "AWN-2 concurrent-command-safety: run/task locking + idempotency under racing commands"
---

**Closed:** 2026-05-30. Commit `1207822`.

docs/agentic-workflow-next-steps.md §2. Prevent two forge commands advancing/mutating the same run conflictingly.

Strong overlap with #112 (transactional dispatch + gate writes — the write-transaction half). AWN-2 adds the race-guard half.

Scope:
- Audit transitions for continue/next, cancel, retry, invoke --run, gate commands.
- Lightweight run/task locking or transactional guards where needed.
- Make cancel/retry/continue idempotent under races.
- Read-only commands (status/show/dashboard) tolerate in-progress transitions.

Acceptance:
- Two simultaneous advancement commands cannot dispatch the same task twice.
- cancel racing with normal completion → one coherent terminal state.
- retry cannot attach to stale/half-finalized task state.
- Tests exercise >=1 command-race path with controlled interleaving.

Builds on #112. Second of the lifecycle-foundation trio.