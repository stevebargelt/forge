// FG-703 step 5 integration tests: the operator READ surface for adjudicated
// incidents — `forge ops check --include-adjudicated` — exercised through the
// REAL CLI subprocess (commander parsing, exit codes, the HUMAN render, and the
// --json shape, over a real on-disk sqlite db).
//
// The write verb (`forge ops adjudicate`) and the detector suppression are proven
// in their own tiers (fg703-ops-adjudicate.integration.test.ts, detect.test.ts).
// This file proves the read surface end to end:
//   - `--include-adjudicated` surfaces a previously-adjudicated incident in the
//     HUMAN output WITH its ORIGINAL detector evidence AND its audit record
//     (outcome, rationale, actor, timestamp).
//   - the same `forge ops check` WITHOUT the flag does NOT list that incident
//     (default suppression intact — byte-for-byte unchanged).
//   - the --json list carries the annotated record ONLY under the flag; the
//     default --json list stays suppressed and read-only (writes nothing).
//   - a materially-changed incident reappears as a genuinely NEW, unresolved
//     incident with NO annotation even under the flag.

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
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let forgeHome: string;
let dbPath: string;
let db: DatabaseInstance;
const tmpDirs: string[] = [];

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg703r-home-"));
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
  const dir = mkdtempSync(join(tmpdir(), "forge-fg703r-project-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  tmpDirs.push(dir);
  return dir;
}

function insertRunRow(o: { id: string; status?: string; projectDir?: string }): void {
  db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`).run(
    o.id, "build", "fg703r", o.status ?? "active", "2026-08-12T00:00:00Z", o.projectDir ?? null,
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

/** Seed a live orphaned_work_may_persist incident AND a keep-alive running task
 *  under the same active run, so the run is not itself flagged as a stuck_run
 *  (all-terminal-tasks) — keeps the assertions scoped to the orphaned-work
 *  incident alone. */
function seedOrphanIncident(o: { runId: string; taskId: string; projectDir: string; evidence: OrphanEvidence }): void {
  insertRunRow({ id: o.runId, status: "active", projectDir: o.projectDir });
  insertTaskRow({ id: `${o.taskId}-keepalive`, runId: o.runId, status: "running" });
  insertTaskRow({ id: o.taskId, runId: o.runId, status: "failed" });
  insertEvent({
    runId: o.runId,
    taskId: o.taskId,
    eventType: "task.failed",
    payload: { failure_kind: "orphaned_work_may_persist", error: "container gone; worktree dirty", evidence: o.evidence },
  });
}

/** A fresh WAL-aware read connection — the CLI subprocess switches the store to
 *  WAL, so verification reads open a new connection rather than reuse setup. */
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

/** The REQUIRED --identity token for an orphaned_work_may_persist incident. */
function identityOf(runId: string, taskId: string, evidence: OrphanEvidence): string {
  return computeAdjudicationIdentity({ runId, taskId, failureKind: "orphaned_work_may_persist", evidence });
}

// ── FG-703: the identity a check REPORTS is the token adjudicate ACCEPTS ──────
//
// The whole point of the fix: `ops check` must report the exact `--identity`
// token the write path demands, so an operator can copy it straight into
// `forge ops adjudicate`. Exercised end to end on the PRODUCTION incident shape
// (a container_crash failed task under a FAILED parent run, source
// project_dir_shared): check reports an identity, adjudicating with that exact
// value succeeds, and a subsequent check no longer lists the incident.

/** The production incident shape: a container_crash failure with a shared
 *  project-dir checkout, seeded under a FAILED parent run. */
function seedProductionCrashIncident(o: { runId: string; taskId: string; projectDir: string }): void {
  insertRunRow({ id: o.runId, status: "failed", projectDir: o.projectDir });
  insertTaskRow({ id: o.taskId, runId: o.runId, status: "failed" });
  insertEvent({
    runId: o.runId,
    taskId: o.taskId,
    eventType: "task.failed",
    payload: {
      failure_kind: "container_crash",
      error: "container crashed; shared checkout dirty",
      evidence: {
        containerName: `forge-${o.taskId}`,
        containerLiveness: "gone",
        resultState: "absent",
        recoverableStdoutResult: false,
        worktreePathChecked: o.projectDir,
        changedFiles: ["M src/a.ts", "M src/b.ts"],
        source: "project_dir_shared",
        containerExitedEventObserved: true,
        exitCode: 1,
        oomKilled: false,
      },
    },
  });
}

test("integ FG-703 round trip: check REPORTS an identity → adjudicate with THAT identity succeeds → a later check no longer lists the incident (production container_crash / project_dir_shared shape)", () => {
  const projectDir = makeProjectDir();
  seedProductionCrashIncident({ runId: "runp", taskId: "tp", projectDir });

  // 1. check --json reports the incident WITH a copyable identity.
  const checkJson = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(checkJson.status, 0, `stdout: ${checkJson.stdout}\nstderr: ${checkJson.stderr}`);
  const reported = (JSON.parse(checkJson.stdout) as Array<{ kind: string; taskId: string | null; identity?: string }>).find(
    (i) => i.kind === "orphaned_work_may_persist" && i.taskId === "tp",
  );
  assert.ok(reported, "the container_crash incident presents as orphaned_work_may_persist and is listed");
  assert.ok(reported!.identity && /^[0-9a-f]{64}$/.test(reported!.identity), "the incident carries a non-empty sha256 identity in --json");

  // 2. the HUMAN render shows the same identity, copyable.
  const checkHuman = runForge(["ops", "check", "--project", projectDir]);
  assert.equal(checkHuman.status, 0, `stdout: ${checkHuman.stdout}\nstderr: ${checkHuman.stderr}`);
  assert.ok(checkHuman.stdout.includes(`identity: ${reported!.identity}`), "the human render prints the exact identity");
  assert.ok(checkHuman.stdout.includes(`--identity ${reported!.identity}`), "the human render spells out the copyable --identity argument");

  // 3. adjudicate using the EXACTLY-REPORTED identity — must be accepted, not
  //    refused as drift. This is the byte-for-byte contract the whole fix exists for.
  const adj = runForge(["ops", "adjudicate", "tp", "--project", projectDir, "--rationale", "inspected the shared checkout; no unique work", "--identity", reported!.identity!]);
  assert.equal(adj.status, 0, `adjudicate must accept the reported identity\nstdout: ${adj.stdout}\nstderr: ${adj.stderr}`);
  assert.equal(adjudicatedCount("tp"), 1, "exactly one adjudication event recorded");

  // 4. a subsequent check no longer lists the incident (default suppression).
  const after = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(after.status, 0, `stdout: ${after.stdout}\nstderr: ${after.stderr}`);
  assert.ok(
    !(JSON.parse(after.stdout) as Array<{ kind: string; taskId: string | null }>).some((i) => i.kind === "orphaned_work_may_persist" && i.taskId === "tp"),
    "after adjudicating with the reported identity, the incident is retired from the default report",
  );
});

// ── the HUMAN read surface ────────────────────────────────────────────────────

test("integ forge ops check --include-adjudicated (human): surfaces an adjudicated incident WITH its original evidence + audit record; the default check omits it", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1", worktreePathChecked: `${projectDir}/.wt/t1`, changedFiles: ["src/a.ts", "src/b.ts"] });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  // Live before adjudication — the incident is visible in the default human report.
  const before = runForge(["ops", "check", "--project", projectDir]);
  assert.equal(before.status, 0, `stdout: ${before.stdout}\nstderr: ${before.stderr}`);
  assert.match(before.stdout, /orphaned_work_may_persist/, "precondition: the incident is live before adjudication");

  // Adjudicate it through the real CLI (records one ops.adjudicated event).
  const adj = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "inspected the diff; no unique work here", "--actor", "steve@bargelt.com", "--identity", identityOf("run1", "t1", evidence)]);
  assert.equal(adj.status, 0, `adjudicate expected exit 0\nstdout: ${adj.stdout}\nstderr: ${adj.stderr}`);
  assert.equal(adjudicatedCount("t1"), 1);

  // Default human check: the adjudicated incident is SUPPRESSED (not listed).
  const def = runForge(["ops", "check", "--project", projectDir]);
  assert.equal(def.status, 0, `stdout: ${def.stdout}\nstderr: ${def.stderr}`);
  assert.doesNotMatch(def.stdout, /orphaned_work_may_persist/, "default check omits the adjudicated incident (suppression intact)");
  assert.match(def.stdout, /No ops incidents\./, "with the only incident adjudicated, the default report is empty");

  // --include-adjudicated human check: the incident REAPPEARS, WITH its ORIGINAL
  // detector evidence AND the full audit record.
  const inc = runForge(["ops", "check", "--project", projectDir, "--include-adjudicated"]);
  assert.equal(inc.status, 0, `stdout: ${inc.stdout}\nstderr: ${inc.stderr}`);
  assert.match(inc.stdout, /orphaned_work_may_persist/, "shown under the flag");
  // ORIGINAL detector evidence (the worktree changed-file line renders unchanged).
  assert.match(inc.stdout, /2 changed file\(s\) found at/, "the ORIGINAL detector evidence is rendered together with the incident");
  assert.match(inc.stdout, /container exit was directly observed/, "the original container-evidence line is rendered too");
  // The audit record: outcome, actor, timestamp, rationale, identity.
  assert.match(inc.stdout, /adjudicated: no_unique_work/, "the audit outcome is shown");
  assert.match(inc.stdout, /by steve@bargelt\.com/, "the actor is shown");
  assert.match(inc.stdout, /at 20\d\d-\d\d-\d\dT[0-9:.]+Z/, "the ISO timestamp is shown");
  assert.match(inc.stdout, /rationale: inspected the diff; no unique work here/, "the rationale is shown");
  assert.match(inc.stdout, /identity:\s+[0-9a-f]{64}/, "the canonical identity is shown");

  // The read surface is read-only: no new adjudication event was written by the checks.
  assert.equal(adjudicatedCount("t1"), 1, "check --include-adjudicated wrote nothing");
});

// ── the --json read surface ───────────────────────────────────────────────────

test("integ forge ops check --json --include-adjudicated: the annotated record is present ONLY under the flag; the default --json list stays suppressed and read-only", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1" });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  const adj = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "no unique work", "--actor", "steve@bargelt.com", "--identity", identityOf("run1", "t1", evidence)]);
  assert.equal(adj.status, 0, `stdout: ${adj.stdout}\nstderr: ${adj.stderr}`);

  // Default --json: the adjudicated incident is suppressed, and NO incident carries
  // an `adjudication` annotation.
  const defJson = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(defJson.status, 0, `stdout: ${defJson.stdout}\nstderr: ${defJson.stderr}`);
  const defIncidents = JSON.parse(defJson.stdout) as Array<{ kind: string; taskId: string | null; adjudication?: unknown }>;
  assert.ok(!defIncidents.some((i) => i.kind === "orphaned_work_may_persist"), "default --json suppresses the adjudicated incident");
  assert.ok(defIncidents.every((i) => i.adjudication === undefined), "no incident in the default list carries an adjudication annotation");

  // --json --include-adjudicated: the incident is present WITH its full annotation.
  const incJson = runForge(["ops", "check", "--project", projectDir, "--json", "--include-adjudicated"]);
  assert.equal(incJson.status, 0, `stdout: ${incJson.stdout}\nstderr: ${incJson.stderr}`);
  const incIncidents = JSON.parse(incJson.stdout) as Array<{ kind: string; taskId: string | null; adjudication?: { outcome: string; rationale: string; actor: string; at: string; identity: string } }>;
  const found = incIncidents.find((i) => i.kind === "orphaned_work_may_persist" && i.taskId === "t1");
  assert.ok(found, "the adjudicated incident is present under the flag");
  assert.ok(found!.adjudication, "it carries an adjudication annotation");
  assert.equal(found!.adjudication!.outcome, "no_unique_work");
  assert.equal(found!.adjudication!.actor, "steve@bargelt.com");
  assert.equal(found!.adjudication!.rationale, "no unique work");
  assert.match(found!.adjudication!.identity, /^[0-9a-f]{64}$/, "the canonical sha256 identity is carried");
  assert.match(found!.adjudication!.at, /^20\d\d-\d\d-\d\dT/, "the ISO timestamp is carried");

  // Read-only: neither --json check wrote anything.
  assert.equal(adjudicatedCount("t1"), 1, "the --json read paths wrote no event");
});

// ── an unrelated incident stays visible; the default set is unchanged ─────────

test("integ forge ops check: adjudicating one incident hides ONLY it — an unrelated high-severity incident stays visible in BOTH default and --include-adjudicated views", () => {
  const projectDir = makeProjectDir();
  const evidence = worktreeEvidence({ containerName: "forge-t1" });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence });

  // An UNRELATED high-severity incident: a pending task under a terminal (complete)
  // run — a retry_orphan. It must stay visible throughout.
  insertRunRow({ id: "run-orphan", status: "complete", projectDir });
  insertTaskRow({ id: "orphan-task", runId: "run-orphan", status: "pending" });

  const adj = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "no unique work", "--identity", identityOf("run1", "t1", evidence)]);
  assert.equal(adj.status, 0, `stdout: ${adj.stdout}\nstderr: ${adj.stderr}`);

  // Default view: the orphaned-work incident is gone, the retry_orphan remains.
  const def = runForge(["ops", "check", "--project", projectDir, "--json"]);
  const defIncidents = JSON.parse(def.stdout) as Array<{ kind: string; taskId: string | null }>;
  assert.ok(!defIncidents.some((i) => i.kind === "orphaned_work_may_persist"), "the adjudicated incident is hidden by default");
  assert.ok(defIncidents.some((i) => i.kind === "retry_orphan" && i.taskId === "orphan-task"), "the unrelated retry_orphan remains visible by default");

  // Include view: BOTH are present.
  const inc = runForge(["ops", "check", "--project", projectDir, "--json", "--include-adjudicated"]);
  const incIncidents = JSON.parse(inc.stdout) as Array<{ kind: string; taskId: string | null; adjudication?: unknown }>;
  assert.ok(incIncidents.some((i) => i.kind === "orphaned_work_may_persist" && i.taskId === "t1" && i.adjudication), "the adjudicated incident reappears annotated under the flag");
  assert.ok(incIncidents.some((i) => i.kind === "retry_orphan" && i.taskId === "orphan-task" && !i.adjudication), "the unrelated retry_orphan stays present and is NOT annotated");
});

// ── a materially-changed incident reappears as NEW/unresolved (no annotation) ─

test("integ forge ops check --include-adjudicated: a materially-changed incident reappears as a genuinely NEW unresolved incident with NO annotation", () => {
  const projectDir = makeProjectDir();
  const ev1 = worktreeEvidence({ containerName: "forge-t1", changedFiles: ["src/a.ts"] });
  seedOrphanIncident({ runId: "run1", taskId: "t1", projectDir, evidence: ev1 });

  const adj = runForge(["ops", "adjudicate", "t1", "--project", projectDir, "--rationale", "no unique work", "--identity", identityOf("run1", "t1", ev1)]);
  assert.equal(adj.status, 0, `stdout: ${adj.stdout}\nstderr: ${adj.stderr}`);

  // Suppressed at the adjudicated identity.
  const suppressed = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.ok(!(JSON.parse(suppressed.stdout) as Array<{ kind: string }>).some((i) => i.kind === "orphaned_work_may_persist"), "suppressed against the adjudicated identity");

  // The WORK materially changes — a fresh task.failed with a different worktree
  // changed-file SET (identity-bearing when source is worktree).
  insertEvent({
    runId: "run1",
    taskId: "t1",
    eventType: "task.failed",
    createdAt: "2026-08-12T01:00:00Z",
    payload: { failure_kind: "orphaned_work_may_persist", error: "second", evidence: worktreeEvidence({ containerName: "forge-t1", changedFiles: ["src/DIFFERENT.ts", "src/OTHER.ts"] }) },
  });

  // Default view: it REAPPEARS (the recorded identity no longer matches) as an
  // unresolved incident, no annotation.
  const def = runForge(["ops", "check", "--project", projectDir, "--json"]);
  const defIncidents = JSON.parse(def.stdout) as Array<{ kind: string; taskId: string | null; adjudication?: unknown }>;
  const defHit = defIncidents.find((i) => i.kind === "orphaned_work_may_persist" && i.taskId === "t1");
  assert.ok(defHit, "materially-changed work reappears in the DEFAULT view as unresolved");
  assert.equal(defHit!.adjudication, undefined, "a reappeared incident is unadjudicated — no stale annotation");

  // Include view: same — present, unresolved, still no annotation (the stale
  // record names a different identity).
  const inc = runForge(["ops", "check", "--project", projectDir, "--json", "--include-adjudicated"]);
  const incHit = (JSON.parse(inc.stdout) as Array<{ kind: string; taskId: string | null; adjudication?: unknown }>).find((i) => i.kind === "orphaned_work_may_persist" && i.taskId === "t1");
  assert.ok(incHit, "still present under the flag");
  assert.equal(incHit!.adjudication, undefined, "the stale adjudication (different identity) is not annotated onto the new incident");
});
