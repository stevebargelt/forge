import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  computeAdjudicationIdentity,
  adjudicatedIdentitiesForTask,
  performAdjudicate,
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

// ── performAdjudicate (the FG-703 write verb) ─────────────────────────────────
//
// These run against the same setDbForTest in-memory handle (installed in the
// beforeEach above) so getTask/getRun/logEvent and the correlated latest-failed
// read all resolve to it.

const PROJECT = "/tmp/forge-fg703-project";

function seedRun(id: string, opts: { status?: string; projectDir?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, "build", "fg703", opts.status ?? "active", "2026-08-12T00:00:00Z", opts.projectDir === undefined ? PROJECT : opts.projectDir);
}

function seedTask(id: string, runId: string, opts: { status?: string; result?: unknown } = {}): void {
  const pkg = JSON.stringify({ taskId: id, runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" });
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, runId, "build", "engineer", opts.status ?? "failed", pkg, opts.result === undefined ? null : JSON.stringify(opts.result), "2026-08-12T00:00:01Z", "2026-08-12T00:00:02Z");
}

/** Record a task.failed carrying an OrphanEvidence tuple, exactly as failTask does. */
function seedFailed(taskId: string, runId: string, opts: { failureKind?: string; evidence?: OrphanEvidence } = {}): void {
  logEvent("task.failed", {
    runId,
    taskId,
    payload: {
      failure_kind: opts.failureKind ?? "orphaned_work_may_persist",
      error: "container gone; worktree dirty",
      ...(opts.evidence ? { evidence: opts.evidence } : {}),
    },
  });
}

function adjudicatedCount(taskId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS c FROM events WHERE event_type = 'ops.adjudicated' AND task_id = ?`).get(taskId) as { c: number }).c;
}

function validInput(overrides: Partial<Parameters<typeof performAdjudicate>[1]> = {}): Parameters<typeof performAdjudicate>[1] {
  return { outcome: "no_unique_work", rationale: "operator inspected the worktree; no unique work to salvage", actor: "steve", projectDir: PROJECT, ...overrides };
}

test("performAdjudicate: a valid adjudication writes exactly ONE ops.adjudicated event with the audit record + current identity", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput());
  assert.equal(res.kind, "adjudicated");
  assert.equal(adjudicatedCount("t1"), 1, "exactly one audit event");

  const expectedIdentity = computeAdjudicationIdentity(baseInput(worktreeEvidence()));
  const row = db.prepare(`SELECT run_id, task_id, payload FROM events WHERE event_type = 'ops.adjudicated' AND task_id = 't1'`).get() as { run_id: string; task_id: string; payload: string };
  const payload = JSON.parse(row.payload) as Record<string, unknown>;
  assert.equal(row.run_id, "run1");
  assert.equal(row.task_id, "t1");
  assert.equal(payload["kind"], "orphaned_work_may_persist");
  assert.equal(payload["outcome"], "no_unique_work");
  assert.equal(payload["rationale"], "operator inspected the worktree; no unique work to salvage");
  assert.equal(payload["actor"], "steve");
  assert.equal(payload["identity"], expectedIdentity);
  assert.equal(typeof payload["at"], "string");
  // The recorded identity is exactly what the detect side recomputes and suppresses
  // on (step 3): adjudicatedIdentitiesForTask returns it.
  assert.ok(adjudicatedIdentitiesForTask(db, "t1").has(expectedIdentity));
});

test("performAdjudicate: a valid adjudication makes ZERO change to task status, run status, result column, or the task.failed event", () => {
  seedRun("run1", { status: "active" });
  seedTask("t1", "run1", { status: "failed" });
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const failedBefore = db.prepare(`SELECT payload FROM events WHERE event_type = 'task.failed' AND task_id = 't1'`).all() as { payload: string }[];

  const res = performAdjudicate("t1", validInput());
  assert.equal(res.kind, "adjudicated");

  const task = db.prepare(`SELECT status, result FROM tasks WHERE id = 't1'`).get() as { status: string; result: string | null };
  assert.equal(task.status, "failed", "failed stays failed");
  assert.equal(task.result, null, "result column untouched");
  const run = db.prepare(`SELECT status FROM runs WHERE id = 'run1'`).get() as { status: string };
  assert.equal(run.status, "active", "run status untouched (never converted to abandoned)");
  const failedAfter = db.prepare(`SELECT payload FROM events WHERE event_type = 'task.failed' AND task_id = 't1'`).all() as { payload: string }[];
  assert.deepEqual(failedAfter, failedBefore, "the original task.failed evidence is byte-for-byte unchanged");
});

test("performAdjudicate: fails closed on an UNKNOWN incident (no such task), writing no event", () => {
  const res = performAdjudicate("nope", validInput());
  assert.equal(res.kind, "unknown");
  assert.equal(adjudicatedCount("nope"), 0);
});

test("performAdjudicate: fails closed on a task that is not failed (recovered) — no live incident", () => {
  seedRun("run1");
  seedTask("t1", "run1", { status: "complete" });
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput());
  assert.equal(res.kind, "unknown", "a complete task has no live orphaned_work_may_persist incident");
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: fails closed on an UNSUPPORTED KIND, naming the kind, writing no event", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { failureKind: "oom_killed", evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput());
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /unsupported incident kind/);
  assert.match((res as { reason: string }).reason, /oom_killed/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: fails closed on an UNSUPPORTED OUTCOME, writing no event", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput({ outcome: "salvage_it" }));
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /unsupported outcome/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: fails closed on a MISSING/empty rationale, writing no event", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput({ rationale: "   " }));
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /missing rationale/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: fails closed on a PROJECT MISMATCH, writing no event", () => {
  seedRun("run1", { projectDir: "/some/other/project" });
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput({ projectDir: PROJECT }));
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /project mismatch/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: fails closed on IDENTITY DRIFT (supplied identity != current), naming both, writing no event", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const staleIdentity = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/OLD.ts"] })));
  const currentIdentity = computeAdjudicationIdentity(baseInput(worktreeEvidence()));
  assert.notEqual(staleIdentity, currentIdentity);

  const res = performAdjudicate("t1", validInput({ expectedIdentity: staleIdentity }));
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /identity drift/);
  assert.match((res as { reason: string }).reason, new RegExp(currentIdentity));
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: a matching supplied identity is accepted (the TOCTOU CAS passes when nothing changed)", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const inspected = computeAdjudicationIdentity(baseInput(worktreeEvidence()));
  const res = performAdjudicate("t1", validInput({ expectedIdentity: inspected }));
  assert.equal(res.kind, "adjudicated");
  assert.equal(adjudicatedCount("t1"), 1);
});

test("performAdjudicate: after the work materially changes, a RE-adjudication records the NEW identity and supersedes the old", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence({ changedFiles: ["src/a.ts"] }) });

  const res1 = performAdjudicate("t1", validInput());
  assert.equal(res1.kind, "adjudicated");
  const identityA = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts"] })));
  assert.deepEqual([...adjudicatedIdentitiesForTask(db, "t1")], [identityA]);

  // The worktree changed-file SET materially changes → a NEW task.failed lands →
  // the incident reappears with a different identity → operator re-adjudicates.
  seedFailed("t1", "run1", { evidence: worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] }) });
  const identityB = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] })));
  assert.notEqual(identityA, identityB);

  const res2 = performAdjudicate("t1", validInput());
  assert.equal(res2.kind, "adjudicated");
  assert.equal(adjudicatedCount("t1"), 2, "a second, superseding audit event — the first is never rewritten");
  assert.deepEqual([...adjudicatedIdentitiesForTask(db, "t1")], [identityB], "the current recorded identity is the new one");
});
