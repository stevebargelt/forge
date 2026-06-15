---
id: FG-112
type: story
status: active
title: "Transactional dispatch + gate writes (reconcile-half landed as #109)"
---

**Why:** Caught 2026-05-12 alongside #109. The reconcile-half of "wrap multi-write per-task sequences in a transaction" shipped on `951824e` (3 writes per task, fault-injection tests, full rollback semantics). The same shape exists in:

- **`src/spine/dispatch.ts:107-128`** — the happy-path tail after the agent container exits. Two writes (setTaskStatus + logEvent), or four if reds get spawned. Trickier than reconcile because the writes flank an async `spawnRed()` call; the transaction boundary has to wrap **only** the writes, not the docker work. Possible split: pre-spawn writes in one txn, post-spawn writes in another.
- **`src/spine/gate.ts:96-122` + `:166-178`** — advance + reject paths. `gate.ts:96-122` performs `insertGate` + `setTaskStatus` + `createPhaseTasks` (which calls insertTask N times) + maybe `updateRunStatus` for terminal phases. All synchronous, all should be one transaction so an advance that fails to create downstream tasks rolls back the gate decision too.

**Why this didn't ship with #109:** scope. #109 as originally filed listed three paths; the right thing in practice was to focus the fault-injection harness on the orphan-recovery path (where the failure mode is most visible — `reconcile` is what re-runs after a crash, so any non-atomicity there gets stuck on retry). Dispatch + gate are less commonly the recovery point: if dispatch fails mid-writes, the next `forge next` re-dispatches; if gate fails mid-writes, the human re-clicks. But the cleanliness argument still stands — these should be wrapped.

**Approach (mirrors #109):**
- Use `getDb().transaction(() => { ... })()` around each multi-write sequence.
- Sprinkle a `_fault(at)` test hook at named points so tests can inject failures without monkey-patching the store.
- Tests: fault-injection rollback + retry-pin (next call after a transient fault recovers cleanly).

**Acceptance:**
- Dispatch's post-spawn write block + (if applicable) its red-spawn-followup writes are each transactional.
- Gate's advance + reject paths are each one transaction covering all writes including createPhaseTasks.
- Each path has at least one fault-injection test asserting rollback + one retry test asserting subsequent recovery.

**Out of scope:**
- Wrapping the async spawn/spawnRed calls themselves (they take minutes; a sync better-sqlite3 transaction would hold the DB lock the whole time).
- Cross-task transactions (one big txn spanning many tasks). Per-task boundaries are the right granularity.

**Caught:** 2026-05-12 — scope-split from #109 at land-time.