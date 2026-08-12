// FG-703 integration tests: the `forge ops adjudicate` write verb exercised
// through the REAL CLI subprocess (commander parsing, process.exit codes,
// stdout/stderr rendering, a real on-disk sqlite db) — the tier that catches a
// registered-vs-documented flag gap the function level cannot. The write-path
// unit coverage lives in src/ops/adjudication.test.ts; this proves the wiring
// (option parsing, exit codes, JSON/plain rendering) and the AC7/AC8 shape end
// to end.
//
// Central guarantees enforced here:
//   - a VALID adjudication exits 0, records exactly ONE ops.adjudicated event,
//     and changes NO task status, run status, result column, or task.failed
//     event (append-only audit).
//   - every fail-closed case exits NON-ZERO, names the blocking fact, and writes
//     NO event: unknown incident, unsupported kind, unsupported outcome,
//     missing/empty rationale, project mismatch, and identity drift.
//   - AC7/AC8 proxy: FOUR project_dir_shared failed tasks sharing one dirty
//     checkout (a changed-file count that differs per scan) each adjudicate via
//     the CLI, and each recorded identity is INDEPENDENT of that volatile
//     changed-file count (so the shared checkout's next churn does not invalidate
//     any adjudication), while an unrelated high-severity incident stays visible.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { computeAdjudicationIdentity } from "../../ops/adjudication.js";
import type { OrphanEvidence } from "../../v2/failure-kind.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;
let dbPath: string;
let db: DatabaseInstance;
const tmpDirs: string[] = [];

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg703-home-"));
  dbPath = join(forgeHome, "forge.db");
  db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runForge(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true", ...(opts.env ?? {}) },
  });
}

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg703-project-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  tmpDirs.push(dir);
  return dir;
}

function insertRunRow(o: { id: string; status?: string; projectDir?: string }): void {
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`).run(
    o.id, "build", "fg703", o.status ?? "active", "2026-08-12T00:00:00Z", o.projectDir ?? null,
  );
}

function insertTaskRow(o: { id: string; runId: string; status?: string }): void {
  const pkg = JSON.stringify({ taskId: o.id, runId: o.runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" });
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.runId, "build", "engineer", o.status ?? "failed", pkg, "2026-08-12T00:00:01Z", "2026-08-12T00:00:02Z");
}

function insertEvent(o: { runId: string; taskId: string; eventType: string; payload: Record<string, unknown>; createdAt?: string }): void {
  db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    o.runId, o.taskId, o.eventType, JSON.stringify(o.payload), o.createdAt ?? "2026-08-12T00:00:03Z",
  );
}

/** A dedicated-worktree orphaned_work_may_persist evidence tuple. */
function worktreeEvidence(overrides: Partial<OrphanEvidence> = {}): OrphanEvidence {
  return {
    containerName: "forge-t",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/home/agent/.forge/work/run/t",
    changedFiles: ["src/a.ts", "src/b.ts"],
    source: "worktree",
    containerExitedEventObserved: true,
    exitCode: 1,
    oomKilled: false,
    ...overrides,
  };
}

/** The four live incidents share a dirty project_dir_shared checkout; its
 *  changed-file count differs on every re-scan and must not bind identity. */
function sharedEvidence(overrides: Partial<OrphanEvidence> = {}): OrphanEvidence {
  return {
    containerName: "forge-t",
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

function seedOrphanIncident(o: { runId: string; taskId: string; projectDir: string; runStatus?: string; evidence: OrphanEvidence; failureKind?: string }): void {
  insertRunRow({ id: o.runId, status: o.runStatus ?? "active", projectDir: o.projectDir });
  insertTaskRow({ id: o.taskId, runId: o.runId, status: "failed" });
  insertEvent({
    runId: o.runId,
    taskId: o.taskId,
    eventType: "task.failed",
    payload: { failure_kind: o.failureKind ?? "orphaned_work_may_persist", error: "container gone; worktree dirty", evidence: o.evidence },
  });
}

/** A fresh WAL-aware read connection — the CLI subprocess switches the store to
 *  WAL, so verification reads open a new connection rather than reuse the
 *  setup handle. */
function readDb<T>(fn: (rdb: DatabaseInstance) => T): T {
  const rdb = new Database(dbPath, { readonly: true });
  try {
    return fn(rdb);
  } finally {
    rdb.close();
  }
}

function adjudicatedCount(taskId: string): number {
  return readDb((rdb) => (rdb.prepare(`SELECT COUNT(*) AS c FROM events WHERE event_type = 'ops.adjudicated' AND task_id = ?`).get(taskId) as { c: number }).c);
}

/** The canonical identity for an incident — the REQUIRED --identity token. */
function identityOf(o: { runId: string; taskId: string; evidence: OrphanEvidence; failureKind?: string }): string {
  return computeAdjudicationIdentity({ runId: o.runId, taskId: o.taskId, failureKind: o.failureKind ?? "orphaned_work_may_persist", evidence: o.evidence });
}

// A well-formed but wrong identity — enough to satisfy the CLI's requiredOption on
// the fail-closed cases that refuse BEFORE the identity gate is ever reached.
const DUMMY_IDENTITY = "0".repeat(64);

// ── valid adjudication, end to end ────────────────────────────────────────────

test("integ forge ops adjudicate: a valid adjudication exits 0, records exactly ONE ops.adjudicated event, and changes no task/run/result/task.failed state", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1", worktreePathChecked: `${projectDir}/.wt/t1` });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  const failedBefore = readDb((rdb) => rdb.prepare(`SELECT payload FROM events WHERE event_type = 'task.failed' AND task_id = 't1'`).all());

  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "inspected the diff; no unique work", "--outcome", "no_unique_work", "--identity", identityOf({ runId: "run1", taskId: "t1", evidence }), "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { kind: string; taskId: string; runId: string; identity: string; outcome: string; actor: string; at: string };
  assert.equal(parsed.kind, "adjudicated");
  assert.equal(parsed.taskId, "t1");
  assert.equal(parsed.outcome, "no_unique_work");

  const expectedIdentity = computeAdjudicationIdentity({ runId: "run1", taskId: "t1", failureKind: "orphaned_work_may_persist", evidence });
  assert.equal(parsed.identity, expectedIdentity, "the recorded identity is the canonical function over the current task.failed");

  assert.equal(adjudicatedCount("t1"), 1, "exactly one durable audit event");
  readDb((rdb) => {
    const task = rdb.prepare(`SELECT status, result FROM tasks WHERE id = 't1'`).get() as { status: string; result: string | null };
    assert.equal(task.status, "failed", "failed stays failed");
    assert.equal(task.result, null, "result column untouched");
    const run = rdb.prepare(`SELECT status FROM runs WHERE id = 'run1'`).get() as { status: string };
    assert.equal(run.status, "active", "run status untouched — never converted to abandoned");
    const failedAfter = rdb.prepare(`SELECT payload FROM events WHERE event_type = 'task.failed' AND task_id = 't1'`).all();
    assert.deepEqual(failedAfter, failedBefore, "the original task.failed evidence is byte-for-byte unchanged");
  });
});

test("integ forge ops adjudicate (plain): a valid adjudication prints the audit summary and the audit-only disclaimer", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1" });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "no unique work", "--actor", "steve@bargelt.com", "--identity", identityOf({ runId: "run1", taskId: "t1", evidence })]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /Adjudicated orphaned_work_may_persist incident for task t1 \(no_unique_work\)/);
  assert.match(result.stdout, /actor: steve@bargelt\.com/);
  assert.match(result.stdout, /left untouched \(audit-only\)/);
});

// ── fail-closed cases (exit non-zero, refuse by name, write no event) ─────────

test("integ forge ops adjudicate: UNKNOWN incident exits 1, names it, writes no event", () => {
  const projectDir = makeProjectDir();
  const result = runForge(["ops", "adjudicate", "ghost", "--project", projectDir, "--rationale", "x", "--identity", DUMMY_IDENTITY]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown incident/);
  assert.equal(adjudicatedCount("ghost"), 0);
});

test("integ forge ops adjudicate: UNSUPPORTED KIND (oom_killed) exits 1, names the kind, writes no event", () => {
  const projectDir = makeProjectDir();
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, failureKind: "oom_killed", evidence: worktreeEvidence({ containerName: "forge-t1", oomKilled: true }) });

  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "x", "--identity", DUMMY_IDENTITY]);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /refused/);
  assert.match(result.stderr, /unsupported incident kind/);
  assert.match(result.stderr, /oom_killed/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("integ forge ops adjudicate: UNSUPPORTED OUTCOME exits 1, writes no event", () => {
  const projectDir = makeProjectDir();
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence: worktreeEvidence({ containerName: "forge-t1" }) });

  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "x", "--outcome", "salvage_it", "--identity", DUMMY_IDENTITY]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unsupported outcome/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("integ forge ops adjudicate: MISSING/empty rationale exits 1, writes no event", () => {
  const projectDir = makeProjectDir();
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence: worktreeEvidence({ containerName: "forge-t1" }) });

  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "", "--identity", DUMMY_IDENTITY]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /missing rationale/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("integ forge ops adjudicate: PROJECT MISMATCH exits 1, writes no event", () => {
  const projectDir = makeProjectDir();
  const otherProject = makeProjectDir();
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence: worktreeEvidence({ containerName: "forge-t1" }) });

  // Adjudicate while scoped to a DIFFERENT project than the incident's run.
  const result = runForge(["ops", "adjudicate", "t1", "--project", otherProject, "--rationale", "x", "--identity", DUMMY_IDENTITY]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /project mismatch/);
  assert.equal(adjudicatedCount("t1"), 0);
});

test("integ forge ops adjudicate: IDENTITY DRIFT (stale --identity) exits 1, names both, writes no event", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1" });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  const stale = computeAdjudicationIdentity({ runId: "run1", taskId: "t1", failureKind: "orphaned_work_may_persist", evidence: worktreeEvidence({ containerName: "forge-t1", changedFiles: ["src/DIFFERENT.ts"] }) });
  const current = computeAdjudicationIdentity({ runId: "run1", taskId: "t1", failureKind: "orphaned_work_may_persist", evidence });
  assert.notEqual(stale, current, "sanity: a different worktree changed-file SET is a different identity");

  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "x", "--identity", stale]);
  assert.equal(result.status, 1, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /identity drift/);
  assert.ok(result.stderr.includes(current), "the refusal names the current identity");
  assert.equal(adjudicatedCount("t1"), 0);
});

test("integ forge ops adjudicate: a MATCHING --identity is accepted (TOCTOU CAS passes when nothing changed)", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1" });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  const inspected = computeAdjudicationIdentity({ runId: "run1", taskId: "t1", failureKind: "orphaned_work_may_persist", evidence });
  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "x", "--identity", inspected, "--json"]);
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(adjudicatedCount("t1"), 1);
});

// ── FG-703 FIX 1: --identity is a requiredOption — omitting it is refused ──────

test("integ forge ops adjudicate: WITHOUT --identity the CLI refuses (requiredOption), exits non-zero, and writes NO event", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1" });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  // A fully valid invocation EXCEPT the mandatory inspected identity is omitted.
  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "no unique work"]);
  assert.notEqual(result.status, 0, `expected non-zero\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /--identity/, "the refusal names the missing required option");
  assert.equal(adjudicatedCount("t1"), 0, "nothing was written on the missing-identity refusal");
});

// ── FG-703 FIX 2: a container_crash incident presents as orphaned_work_may_persist
//    and IS adjudicable end to end (the four production incidents are container_crash). ─

test("integ forge ops adjudicate: a container_crash task (presenting as orphaned_work_may_persist) IS adjudicable via the CLI", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1", exitCode: 139 });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, failureKind: "container_crash", evidence });

  const identity = identityOf({ runId: "run1", taskId: "t1", evidence, failureKind: "container_crash" });
  const result = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "crashed; no unique work", "--identity", identity, "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { kind: string; identity: string };
  assert.equal(parsed.kind, "adjudicated");
  assert.equal(parsed.identity, identity);
  assert.equal(adjudicatedCount("t1"), 1);
  // The durable record's incident kind is the collapsed INCIDENT kind, not the raw failure_kind.
  readDb((rdb) => {
    const payload = JSON.parse((rdb.prepare(`SELECT payload FROM events WHERE event_type = 'ops.adjudicated' AND task_id = 't1'`).get() as { payload: string }).payload) as Record<string, unknown>;
    assert.equal(payload["kind"], "orphaned_work_may_persist");
  });
});

// ── AC7/AC8 proxy: four shared-checkout incidents, adjudicated via the CLI ─────

test("integ forge ops adjudicate (AC7/AC8): FOUR project_dir_shared failed tasks each adjudicate via the CLI; every recorded identity is independent of the shared checkout's volatile changed-file count, and an unrelated high-severity incident stays visible", () => {
  const projectDir = makeProjectDir();

  // ONE active run, four failed orphaned_work_may_persist tasks that all read the
  // SAME dirty project_dir_shared checkout — each scan saw a DIFFERENT changed-file
  // count (1, 2, 3, 4 files). A running task keeps the run from being a stuck_run.
  insertRunRow({ id: "run-shared", status: "active", projectDir });
  insertTaskRow({ id: "keep-alive", runId: "run-shared", status: "running" });
  const changedCounts = [1, 2, 3, 4];
  const taskIds = changedCounts.map((_, i) => `shared-${i + 1}`);
  for (let i = 0; i < taskIds.length; i++) {
    const files = Array.from({ length: changedCounts[i]! }, (_, k) => `src/file${k}.ts`);
    insertTaskRow({ id: taskIds[i]!, runId: "run-shared", status: "failed" });
    insertEvent({
      runId: "run-shared",
      taskId: taskIds[i]!,
      eventType: "task.failed",
      payload: { failure_kind: "orphaned_work_may_persist", error: "container gone; shared checkout dirty", evidence: sharedEvidence({ containerName: `forge-${taskIds[i]!}`, changedFiles: files }) },
    });
  }

  // An UNRELATED high-severity incident in the same project: a pending task under a
  // terminal (complete) run — a retry_orphan. It must remain visible throughout.
  insertRunRow({ id: "run-orphan", status: "complete", projectDir });
  insertTaskRow({ id: "orphan-task", runId: "run-orphan", status: "pending" });

  // Before: all four orphaned_work_may_persist incidents AND the retry_orphan are live.
  const before = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(before.status, 0, `stdout: ${before.stdout}\nstderr: ${before.stderr}`);
  const beforeIncidents = JSON.parse(before.stdout) as Array<{ kind: string; taskId: string | null }>;
  assert.equal(beforeIncidents.filter((i) => i.kind === "orphaned_work_may_persist").length, 4, "sanity: four live orphaned-work incidents before adjudication");
  assert.ok(beforeIncidents.some((i) => i.kind === "retry_orphan" && i.taskId === "orphan-task"), "the unrelated retry_orphan is visible before");

  // Adjudicate each of the four via the CLI. Every one succeeds and records its identity.
  for (let i = 0; i < taskIds.length; i++) {
    // The inspected identity ignores the shared checkout's volatile changed-file
    // count, so it is computed from the same project_dir_shared shape.
    const inspected = identityOf({ runId: "run-shared", taskId: taskIds[i]!, evidence: sharedEvidence({ containerName: `forge-${taskIds[i]!}` }) });
    const res = runForge(["ops", "adjudicate", taskIds[i]!, "--project", projectDir, "--rationale", "shared checkout; this task produced no unique work", "--identity", inspected, "--json"]);
    assert.equal(res.status, 0, `adjudicate ${taskIds[i]} expected exit 0\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
    const parsed = JSON.parse(res.stdout) as { kind: string; identity: string };
    assert.equal(parsed.kind, "adjudicated");

    // The recorded identity IGNORES the volatile shared-checkout changed-file count:
    // recomputing it with a WILDLY different count yields the SAME identity, so the
    // next `forge ops check` re-scan (a different count) will not invalidate it.
    const identityWithADifferentCount = computeAdjudicationIdentity({
      runId: "run-shared",
      taskId: taskIds[i]!,
      failureKind: "orphaned_work_may_persist",
      evidence: sharedEvidence({ containerName: `forge-${taskIds[i]!}`, changedFiles: ["src/rescanned-a.ts", "src/rescanned-b.ts", "src/rescanned-c.ts", "src/rescanned-d.ts", "src/rescanned-e.ts"] }),
    });
    assert.equal(parsed.identity, identityWithADifferentCount, `task ${taskIds[i]}'s adjudication identity must not depend on the shared checkout's changed-file count`);
    assert.equal(adjudicatedCount(taskIds[i]!), 1, `exactly one adjudication event for ${taskIds[i]}`);
  }

  // Each recorded identity equals the SUPPRESSION predicate step 3 tests: the identity
  // recomputed from the CURRENT task.failed. Proven directly against the durable rows,
  // so the write side's contribution to AC7/AC8 is validated even though the detector
  // suppression (step 3, detect.ts) is a sibling step. NOTE: the end-to-end "forge ops
  // check reports ZERO unresolved orphaned-work incidents" assertion belongs to step 3.
  readDb((rdb) => {
    for (const taskId of taskIds) {
      const row = rdb.prepare(`SELECT json_extract(payload, '$.identity') AS identity FROM events WHERE event_type = 'ops.adjudicated' AND task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as { identity: string };
      const currentFailed = JSON.parse((rdb.prepare(`SELECT payload FROM events WHERE event_type = 'task.failed' AND task_id = ? ORDER BY id DESC LIMIT 1`).get(taskId) as { payload: string }).payload) as Record<string, unknown>;
      const currentIdentity = computeAdjudicationIdentity({ runId: "run-shared", taskId, failureKind: "orphaned_work_may_persist", evidence: currentFailed["evidence"] as OrphanEvidence });
      assert.equal(row.identity, currentIdentity, `recorded identity for ${taskId} equals the current recomputed identity (the exact suppression key)`);
    }
  });

  // After adjudication, the UNRELATED retry_orphan incident is still visible — a
  // narrow adjudication of the orphaned-work incidents must not hide anything else.
  const after = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(after.status, 0, `stdout: ${after.stdout}\nstderr: ${after.stderr}`);
  const afterIncidents = JSON.parse(after.stdout) as Array<{ kind: string; taskId: string | null }>;
  assert.ok(afterIncidents.some((i) => i.kind === "retry_orphan" && i.taskId === "orphan-task"), "the unrelated retry_orphan must remain visible after adjudication");
});
