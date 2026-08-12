import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import {
  computeAdjudicationIdentity,
  incidentKindForFailureKind,
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
// A REAL project dir on disk — the project-match guard now canonicalizes through
// the FG-693 filesystem-identity contract (realpath), so the run's project and
// the scoped project must be resolvable paths, not fabricated strings.
let projectDir: string;
const tmpDirs: string[] = [];

function mkTmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  db = makeInMemoryDb();
  // logEvent writes through the global handle; point it at this test DB so the
  // read helper (which we call with `db`) sees the events logEvent inserts.
  prevDb = setDbForTest(db);
  projectDir = mkTmpDir("forge-fg703-project-");
});
afterEach(() => {
  if (prevDb) setDbForTest(prevDb);
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
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

function seedRun(id: string, opts: { status?: string; projectDir?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, "build", "fg703", opts.status ?? "active", "2026-08-12T00:00:00Z", opts.projectDir === undefined ? projectDir : opts.projectDir);
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

/** The canonical incident identity for run1/t1 given its failure kind + evidence
 *  — the CAS token the operator supplies. Defaults to the worktree evidence tuple
 *  the valid-path tests seed. */
function identityFor(opts: { failureKind?: string; evidence?: OrphanEvidence } = {}): string {
  return computeAdjudicationIdentity({
    runId: "run1",
    taskId: "t1",
    failureKind: opts.failureKind ?? "orphaned_work_may_persist",
    evidence: opts.evidence ?? worktreeEvidence(),
  });
}

// --identity is REQUIRED (FG-703 FIX 1): a default matching the seeded worktree
// evidence keeps the valid-path cases green; a case seeding other evidence/kind
// overrides expectedIdentity to match.
function validInput(overrides: Partial<Parameters<typeof performAdjudicate>[1]> = {}): Parameters<typeof performAdjudicate>[1] {
  return { outcome: "no_unique_work", rationale: "operator inspected the worktree; no unique work to salvage", actor: "steve", projectDir, expectedIdentity: identityFor(), ...overrides };
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

test("performAdjudicate: fails closed on a PROJECT MISMATCH (a genuinely different tree), writing no event", () => {
  const otherProject = mkTmpDir("forge-fg703-other-");
  seedRun("run1", { projectDir: otherProject });
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res = performAdjudicate("t1", validInput({ projectDir }));
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /project mismatch/);
  assert.equal(adjudicatedCount("t1"), 0);
});

// FG-703 FIX 3: the project match canonicalizes through the FG-693 filesystem-
// identity contract, so a legitimately-matching project reached via a symlinked
// (or otherwise differently-spelled) path is ACCEPTED — it no longer fails closed
// on raw string inequality — while a genuinely different tree is still refused.
test("performAdjudicate: a matching project reached through a SYMLINKED path is accepted (canonical path identity, not string equality)", () => {
  seedRun("run1", { projectDir }); // the run's project is the real dir
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  // The operator is scoped through a symlink that resolves to the SAME tree.
  const link = join(mkTmpDir("forge-fg703-linkparent-"), "linked-project");
  symlinkSync(projectDir, link);

  const res = performAdjudicate("t1", validInput({ projectDir: link }));
  assert.equal(res.kind, "adjudicated", "a symlinked spelling of the same project must not fail closed");
  assert.equal(adjudicatedCount("t1"), 1);
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

  const identityA = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts"] })));
  const res1 = performAdjudicate("t1", validInput({ expectedIdentity: identityA }));
  assert.equal(res1.kind, "adjudicated");
  assert.deepEqual([...adjudicatedIdentitiesForTask(db, "t1")], [identityA]);

  // The worktree changed-file SET materially changes → a NEW task.failed lands →
  // the incident reappears with a different identity → operator re-adjudicates.
  seedFailed("t1", "run1", { evidence: worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] }) });
  const identityB = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] })));
  assert.notEqual(identityA, identityB);

  const res2 = performAdjudicate("t1", validInput({ expectedIdentity: identityB }));
  assert.equal(res2.kind, "adjudicated");
  assert.equal(adjudicatedCount("t1"), 2, "a second, superseding audit event — the first is never rewritten");
  assert.deepEqual([...adjudicatedIdentitiesForTask(db, "t1")], [identityB], "the current recorded identity is the new one");
});

// ── FG-703 RF-1: a second IDENTICAL adjudication is idempotent (no duplicate row) ─

test("performAdjudicate: re-adjudicating the SAME identity is idempotent — no duplicate audit row is appended", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  const res1 = performAdjudicate("t1", validInput());
  assert.equal(res1.kind, "adjudicated");
  assert.equal(adjudicatedCount("t1"), 1);

  // A second identical invocation (e.g. a retry after an ambiguous client/process
  // failure): same task, same current identity, same evidence. It must NOT append a
  // second row — the AC4 read surface would then be ambiguous about which record is
  // the decision. It returns success (idempotent) reporting the EXISTING record.
  const res2 = performAdjudicate("t1", validInput());
  assert.equal(res2.kind, "adjudicated", "an identical retry succeeds idempotently, not refuses");
  assert.equal(adjudicatedCount("t1"), 1, "still exactly one audit event — no duplicate appended");

  // The returned record is the ORIGINAL decision, not a fresh stamp.
  assert.ok(res1.kind === "adjudicated" && res2.kind === "adjudicated");
  assert.equal(res2.identity, res1.identity);
  assert.equal(res2.at, res1.at, "the record of decision keeps the ORIGINAL timestamp");
  assert.equal(res2.actor, res1.actor);
});

test("performAdjudicate: idempotency is bound to the current-latest identity — a re-adjudication of a SUPERSEDED identity still appends", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence({ changedFiles: ["src/a.ts"] }) });

  const identityA = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts"] })));
  performAdjudicate("t1", validInput({ expectedIdentity: identityA }));
  assert.equal(adjudicatedCount("t1"), 1);

  // Work changes → new task.failed → operator re-adjudicates identity B. Latest is B.
  seedFailed("t1", "run1", { evidence: worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] }) });
  const identityB = computeAdjudicationIdentity(baseInput(worktreeEvidence({ changedFiles: ["src/a.ts", "src/b.ts"] })));
  performAdjudicate("t1", validInput({ expectedIdentity: identityB }));
  assert.equal(adjudicatedCount("t1"), 2);

  // Work reverts to the identity-A facts → the incident reappears as identity A. Since
  // the current-latest record is B (not A), adjudicating A is a genuine, non-idempotent
  // re-decision that must append and become the new latest.
  seedFailed("t1", "run1", { evidence: worktreeEvidence({ changedFiles: ["src/a.ts"] }) });
  const res = performAdjudicate("t1", validInput({ expectedIdentity: identityA }));
  assert.equal(res.kind, "adjudicated");
  assert.equal(adjudicatedCount("t1"), 3, "re-adjudicating a superseded identity is a new decision, not a no-op");
  assert.deepEqual([...adjudicatedIdentitiesForTask(db, "t1")], [identityA], "the current recorded identity is A again");
});

// ── FG-703 FIX 1: --identity is REQUIRED — a missing token cannot fall open ────

test("performAdjudicate: fails closed when NO expectedIdentity matches (an unmatched token can never adjudicate)", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  seedFailed("t1", "run1", { evidence: worktreeEvidence() });

  // An empty/absent inspected identity is not a bypass: it simply does not equal
  // the current identity, so the drift guard refuses and nothing is written.
  const res = performAdjudicate("t1", validInput({ expectedIdentity: "" }));
  assert.equal(res.kind, "refused");
  assert.match((res as { reason: string }).reason, /identity drift/);
  assert.equal(adjudicatedCount("t1"), 0, "no ops.adjudicated event was appended");
});

// ── FG-703 FIX 2: scope on the INCIDENT kind the detector emits, via the shared
//    mapping — not the raw failure_kind. The four kinds that collapse to an
//    orphaned_work_may_persist incident are adjudicable; kinds that map to another
//    incident are refused by name; and the mapping cannot silently narrow. ──

test("incidentKindForFailureKind: the shared mapping collapses every non-(oom_killed|orphaned_needs_finalize) kind to orphaned_work_may_persist", () => {
  assert.equal(incidentKindForFailureKind("oom_killed"), "oom_killed");
  assert.equal(incidentKindForFailureKind("orphaned_needs_finalize"), "orphaned_needs_finalize");
  for (const collapsed of ["container_crash", "idle_timeout", "result_missing", "fanout_wave_orphaned", "some_future_kind"]) {
    assert.equal(incidentKindForFailureKind(collapsed), "orphaned_work_may_persist", `${collapsed} must present as an orphaned_work_may_persist incident`);
  }
});

for (const collapsedKind of ["container_crash", "idle_timeout", "result_missing", "fanout_wave_orphaned"]) {
  test(`performAdjudicate: a ${collapsedKind} task presenting as an orphaned_work_may_persist incident IS adjudicable`, () => {
    seedRun("run1");
    seedTask("t1", "run1");
    seedFailed("t1", "run1", { failureKind: collapsedKind, evidence: worktreeEvidence() });

    const res = performAdjudicate("t1", validInput({ expectedIdentity: identityFor({ failureKind: collapsedKind }) }));
    assert.equal(res.kind, "adjudicated", `${collapsedKind} collapses to orphaned_work_may_persist and must adjudicate`);
    assert.equal(adjudicatedCount("t1"), 1);
    // The recorded incident kind is the collapsed INCIDENT kind, not the raw failure_kind.
    const payload = JSON.parse((db.prepare(`SELECT payload FROM events WHERE event_type = 'ops.adjudicated' AND task_id = 't1'`).get() as { payload: string }).payload) as Record<string, unknown>;
    assert.equal(payload["kind"], "orphaned_work_may_persist");
  });
}

for (const otherKind of ["oom_killed", "orphaned_needs_finalize"]) {
  test(`performAdjudicate: a ${otherKind} task is refused by name (maps to a DIFFERENT incident kind)`, () => {
    seedRun("run1");
    seedTask("t1", "run1");
    seedFailed("t1", "run1", { failureKind: otherKind, evidence: worktreeEvidence() });

    const res = performAdjudicate("t1", validInput({ expectedIdentity: identityFor({ failureKind: otherKind }) }));
    assert.equal(res.kind, "refused");
    assert.match((res as { reason: string }).reason, /unsupported incident kind/);
    assert.match((res as { reason: string }).reason, new RegExp(otherKind));
    assert.equal(adjudicatedCount("t1"), 0);
  });
}

// ── RF-1: the write path must accept PRECISELY the set the detector emits ──────
//
// incidentKindForFailureKind is a TOTAL mapping — every kind that is not
// oom_killed / orphaned_needs_finalize collapses to orphaned_work_may_persist.
// But detectOrphanedWorkMayPersist gates candidates on a membership set (+ two
// evidence rules) BEFORE that mapping, so a failure kind OUTSIDE the set never
// surfaces as a live incident. Scoping the write on the mapping alone fails OPEN
// on those kinds — it retires an incident that never existed. The fix shares the
// detector's OWN candidate predicate, so the writer refuses every kind the
// detector would never present, by name, writing no audit row.

for (const unpresentedKind of ["orphaned", "result_malformed", "merge_conflict", "gate_rejected", "some_future_kind"]) {
  test(`performAdjudicate: a ${unpresentedKind} task (outside the detector's candidate set) is refused, writing no event`, () => {
    seedRun("run1");
    seedTask("t1", "run1");
    seedFailed("t1", "run1", { failureKind: unpresentedKind, evidence: worktreeEvidence() });

    // The mapping would collapse this to orphaned_work_may_persist, but the
    // detector never emits an incident for it — so the write must refuse.
    assert.equal(incidentKindForFailureKind(unpresentedKind), "orphaned_work_may_persist", "precondition: the total mapping still collapses it");
    const res = performAdjudicate("t1", validInput({ expectedIdentity: identityFor({ failureKind: unpresentedKind }) }));
    assert.equal(res.kind, "refused", `${unpresentedKind} is not a live orphaned_work_may_persist incident and must not be adjudicable`);
    assert.match((res as { reason: string }).reason, /unsupported incident kind/);
    assert.match((res as { reason: string }).reason, new RegExp(unpresentedKind));
    assert.equal(adjudicatedCount("t1"), 0, "no audit row appended for a phantom incident");
  });
}

test("performAdjudicate: an attached-exit container_crash with NO evidence is refused (the detector never emits it)", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  // container_crash is in the membership set but only rises to an incident once
  // evidence was recorded — an evidence-less one is skipped by the detector, so
  // the writer must refuse it too rather than fall open.
  seedFailed("t1", "run1", { failureKind: "container_crash" }); // no evidence

  const res = performAdjudicate("t1", validInput({ expectedIdentity: identityFor({ failureKind: "container_crash", evidence: undefined }) }));
  assert.equal(res.kind, "refused", "an evidence-less container_crash raises no incident and is not adjudicable");
  assert.match((res as { reason: string }).reason, /unsupported incident kind/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("performAdjudicate: a container_crash whose worktree is CLEAN is refused (the detector skips a clean worktree)", () => {
  seedRun("run1");
  seedTask("t1", "run1");
  // changedFiles empty → no persisted work at risk → the detector skips it, so
  // the write path must refuse it as well.
  seedFailed("t1", "run1", { failureKind: "container_crash", evidence: worktreeEvidence({ changedFiles: [] }) });

  const res = performAdjudicate("t1", validInput({ expectedIdentity: identityFor({ failureKind: "container_crash", evidence: worktreeEvidence({ changedFiles: [] }) }) }));
  assert.equal(res.kind, "refused", "a clean-worktree container_crash raises no incident and is not adjudicable");
  assert.match((res as { reason: string }).reason, /unsupported incident kind/);
  assert.equal(adjudicatedCount("t1"), 0);
});
