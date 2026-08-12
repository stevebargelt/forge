import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  computeAdjudicationIdentity,
  adjudicatedIdentitiesForTask,
  type AdjudicationIdentityInput,
} from "./adjudication.js";
import type { OrphanEvidence } from "../v2/failure-kind.js";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { logEvent } from "../store/events.js";

// A representative orphaned_work_may_persist evidence tuple: a worktree-sourced
// diff with the full FG-492 terminal-cause fields recorded.
function worktreeEvidence(overrides: Partial<OrphanEvidence> = {}): OrphanEvidence {
  return {
    containerName: "forge-t1",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/home/agent/.forge/work/run1/t1",
    changedFiles: ["src/a.ts", "src/b.ts"],
    source: "worktree",
    containerExitedEventObserved: true,
    exitCode: 1,
    oomKilled: false,
    signal: undefined,
    ...overrides,
  };
}

// The four live production incidents share a dirty project_dir_shared checkout —
// the changed-file count/paths are volatile and must NOT bind identity.
function sharedEvidence(overrides: Partial<OrphanEvidence> = {}): OrphanEvidence {
  return {
    containerName: "forge-t1",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: null,
    changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    source: "project_dir_shared",
    containerExitedEventObserved: true,
    exitCode: 1,
    oomKilled: false,
    ...overrides,
  };
}

function baseInput(evidence?: OrphanEvidence): AdjudicationIdentityInput {
  return { runId: "run1", taskId: "t1", failureKind: "orphaned_work_may_persist", evidence };
}

// ── IDENTICAL across volatile churn ──────────────────────────────────────────

test("identity is stable across shared-checkout changedFiles count/contents churn", () => {
  const a = computeAdjudicationIdentity(baseInput(sharedEvidence({ changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] })));
  const b = computeAdjudicationIdentity(baseInput(sharedEvidence({ changedFiles: ["src/x.ts"] })));
  const c = computeAdjudicationIdentity(baseInput(sharedEvidence({ changedFiles: [] })));
  assert.equal(a, b, "shared-checkout changed-file contents must not invalidate an adjudication");
  assert.equal(a, c, "shared-checkout changed-file count (incl. zero) must not invalidate an adjudication");
});

test("identity ignores worktreePathChecked and other absolute paths", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ worktreePathChecked: "/home/agent/.forge/work/run1/t1" })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ worktreePathChecked: "/some/other/abs/path" })));
  const c = computeAdjudicationIdentity(baseInput(worktreeEvidence({ worktreePathChecked: null })));
  assert.equal(a, b);
  assert.equal(a, c);
});

test("identity ignores all timestamps (startedAt / finishedAt)", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ startedAt: "2026-01-01T00:00:00Z", finishedAt: "2026-01-01T00:05:00Z" })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ startedAt: "2026-08-12T09:00:00Z", finishedAt: "2026-08-12T09:30:00Z" })));
  assert.equal(a, b);
});

test("identity ignores rendered/prose diagnostics (error, dockerStateError, resultWriteFailed)", () => {
  const withProse: AdjudicationIdentityInput = {
    ...baseInput(worktreeEvidence({ dockerStateError: "some docker error", resultWriteFailed: true })),
  };
  const withoutProse = baseInput(worktreeEvidence({ dockerStateError: undefined, resultWriteFailed: undefined }));
  assert.equal(computeAdjudicationIdentity(withProse), computeAdjudicationIdentity(withoutProse));
});

test("identity ignores worktree changed-file ORDER (it is a set, not a list)", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/b.ts", "src/a.ts"] })));
  const dup = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts", "src/a.ts"] })));
  assert.equal(a, b, "changed-file order must not affect identity");
  assert.equal(a, dup, "duplicate changed-file entries must not affect identity");
});

// ── DIFFERENT when a material WORK fact changes ──────────────────────────────

test("identity changes when resultState changes", () => {
  const absent = computeAdjudicationIdentity(baseInput(worktreeEvidence({ resultState: "absent" })));
  const valid = computeAdjudicationIdentity(baseInput(worktreeEvidence({ resultState: "valid" })));
  assert.notEqual(absent, valid);
});

test("identity changes when recoverableStdoutResult changes", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ recoverableStdoutResult: false })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ recoverableStdoutResult: true })));
  assert.notEqual(a, b);
});

test("identity changes when evidence source changes", () => {
  const worktree = computeAdjudicationIdentity(baseInput(worktreeEvidence({ source: "worktree" })));
  const shared = computeAdjudicationIdentity(baseInput(worktreeEvidence({ source: "project_dir_shared" })));
  assert.notEqual(worktree, shared);
});

test("identity changes when failure_kind changes", () => {
  const a = computeAdjudicationIdentity({ ...baseInput(worktreeEvidence()), failureKind: "orphaned_work_may_persist" });
  const b = computeAdjudicationIdentity({ ...baseInput(worktreeEvidence()), failureKind: "oom_killed" });
  assert.notEqual(a, b);
});

test("identity changes when containerExitedEventObserved changes", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ containerExitedEventObserved: true })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ containerExitedEventObserved: false })));
  assert.notEqual(a, b);
});

test("identity changes when exitCode changes", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ exitCode: 1 })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ exitCode: 137 })));
  assert.notEqual(a, b);
});

test("identity changes when oomKilled changes", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ oomKilled: false })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ oomKilled: true })));
  assert.notEqual(a, b);
});

test("identity changes when signal changes", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ signal: undefined })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ signal: "SIGKILL" })));
  assert.notEqual(a, b);
});

test("identity changes when the worktree changedFiles SET changes", () => {
  const a = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] })));
  const b = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] })));
  assert.notEqual(a, b, "a genuinely different set of touched files in a dedicated worktree is materially changed work");
});

test("identity changes when the anchor (runId / taskId) changes", () => {
  const base = baseInput(worktreeEvidence());
  const diffRun = computeAdjudicationIdentity({ ...base, runId: "run2" });
  const diffTask = computeAdjudicationIdentity({ ...base, taskId: "t2" });
  assert.notEqual(computeAdjudicationIdentity(base), diffRun);
  assert.notEqual(computeAdjudicationIdentity(base), diffTask);
});

// ── Determinism + shape ──────────────────────────────────────────────────────

test("identity is deterministic (same input → same string) and a 64-hex sha256", () => {
  const input = baseInput(worktreeEvidence());
  const a = computeAdjudicationIdentity(input);
  const b = computeAdjudicationIdentity(input);
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("identity is defined even when no evidence is present, and differs from evidence-bearing", () => {
  const noEvidence = computeAdjudicationIdentity(baseInput(undefined));
  assert.match(noEvidence, /^[0-9a-f]{64}$/);
  assert.notEqual(noEvidence, computeAdjudicationIdentity(baseInput(worktreeEvidence())));
});

// ── adjudicatedIdentitiesForTask (detection-side read path) ───────────────────

let db: DatabaseInstance;
let prevDb: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  // logEvent writes through the global handle; point it at this test DB so the
  // read helper (which we call with `db`) sees the events logEvent inserts.
  prevDb = setDbForTest(db);
});
afterEach(() => {
  if (prevDb) setDbForTest(prevDb);
});

// Record an ops.adjudicated event exactly the way performAdjudicate (step 4) will:
// task_id set on the row, and `identity` in the payload.
function recordAdjudication(taskId: string, identity: string): void {
  logEvent("ops.adjudicated", {
    runId: "run1",
    taskId,
    payload: {
      incidentId: `inc-${taskId}`,
      kind: "orphaned_work_may_persist",
      outcome: "no_unique_work",
      rationale: "operator inspected; no unique work",
      actor: "steve@bargelt.com",
      identity,
      at: "2026-08-12T00:00:00Z",
    },
  });
}

test("adjudicatedIdentitiesForTask: one recorded event yields exactly that event's identity key", () => {
  const identity = computeAdjudicationIdentity(baseInput(worktreeEvidence()));
  recordAdjudication("t1", identity);

  const ids = adjudicatedIdentitiesForTask(db, "t1");
  assert.deepEqual([...ids], [identity]);
  assert.ok(ids.has(identity));
});

test("adjudicatedIdentitiesForTask: a task with no adjudication yields an empty set", () => {
  // A different task carries an adjudication; the queried task has none.
  recordAdjudication("t-other", computeAdjudicationIdentity(baseInput(worktreeEvidence())));

  const ids = adjudicatedIdentitiesForTask(db, "t1");
  assert.equal(ids.size, 0);
});

test("adjudicatedIdentitiesForTask: a superseded-then-re-adjudicated task yields the CURRENT recorded identity only", () => {
  // First adjudication at identity A (the original work).
  const identityA = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts"] })));
  recordAdjudication("t1", identityA);
  // Work materially changed (a different worktree changed-file set) → incident
  // reappeared → operator re-adjudicated at identity B. This later event supersedes A.
  const identityB = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] })));
  recordAdjudication("t1", identityB);
  assert.notEqual(identityA, identityB);

  const ids = adjudicatedIdentitiesForTask(db, "t1");
  assert.deepEqual([...ids], [identityB], "only the latest adjudication's identity is current");
  assert.ok(!ids.has(identityA), "a superseded identity must not keep suppressing");
});

test("adjudicatedIdentitiesForTask: a malformed/identity-less payload records no usable identity (fail-closed)", () => {
  // A hand-edited or pre-identity row with no `identity` field must not suppress
  // anything — json_extract($.identity) is null and the set stays empty.
  logEvent("ops.adjudicated", {
    taskId: "t1",
    payload: { kind: "orphaned_work_may_persist", outcome: "no_unique_work" },
  });

  const ids = adjudicatedIdentitiesForTask(db, "t1");
  assert.equal(ids.size, 0);
});
