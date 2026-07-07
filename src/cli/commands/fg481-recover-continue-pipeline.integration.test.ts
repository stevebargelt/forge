// FG-481 integration tests: `forge recover --continue` on a PIPELINE-run task
// must be refused end to end through the REAL CLI subprocess (commander
// parsing, JSON/plain rendering, process.exit code), not just at the
// performContinue() function level (already covered by recover.test.ts).
// Proves the full path — real subprocess, real on-disk sqlite db — so a
// regression in registerRecover's action wiring (e.g. --json/--force plumbed
// past the refusal, or the wrong exit code) would be caught here even if the
// underlying function-level unit tests stayed green.
//
// Also covers the adjacent guidance-threading fix in show.ts/status.ts: since
// recover.ts's --continue now refuses a pipeline-run task unconditionally,
// `forge show`/`forge status` must not steer an operator toward a command
// that will be refused — verified here through the real CLI, not just at the
// orphanRecoveryMessage() function level (already unit-tested in show.test.ts).
//
// Covers:
//   - a pipeline-run task in each CONTINUABLE_KIND is refused by the real CLI
//     for --continue and --continue --force, with no db mutation
//   - the plain (non-JSON) stderr rendering also names the refusal
//   - an invoke-run task's --continue still adopts and completes end to end
//     through the real CLI (today's behavior unchanged)
//   - `forge recover <runId>` and `forge recover <taskId>` still surface a
//     pipeline task in a CONTINUABLE_KIND (FG-479 behavior unchanged)
//   - `forge show <taskId> --json` and `forge status <runId> --json` on a
//     pipeline-run task never suggest --continue in their recovery guidance

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;
let dbPath: string;
let db: DatabaseInstance;
const tmpDirs: string[] = [];

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg481-home-"));
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

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

function insertRunRow(o: { id: string; workflow: string; title: string; status?: string; createdAt?: string }): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(o.id, o.workflow, o.title, o.status ?? "active", o.createdAt ?? "2026-07-01T00:00:00Z");
}

function insertTaskRow(o: {
  id: string;
  runId: string;
  phase?: string;
  agentRole?: string;
  status?: string;
  worktreePath?: string | null;
  createdAt?: string;
  startedAt?: string | null;
}): void {
  const taskPackage = {
    taskId: o.id,
    runId: o.runId,
    phase: o.phase ?? "build",
    role: o.agentRole ?? "engineer",
    inputs: {},
    composedSystemPrompt: "",
  };
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, worktree_path)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.runId,
    o.phase ?? "build",
    o.agentRole ?? "engineer",
    o.status ?? "failed",
    JSON.stringify(taskPackage),
    o.createdAt ?? "2026-07-01T00:00:01Z",
    o.startedAt ?? "2026-07-01T00:00:02Z",
    o.worktreePath ?? null,
  );
}

function insertFailedEvent(o: { runId: string; taskId: string; failureKind: string; error?: string; evidence?: Record<string, unknown> }): void {
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    o.runId,
    o.taskId,
    "task.failed",
    JSON.stringify({ failure_kind: o.failureKind, error: o.error ?? "boom", ...(o.evidence ? { evidence: o.evidence } : {}) }),
    "2026-07-01T00:00:03Z",
  );
}

function getTaskRow(taskId: string): { status: string; result: string | null } {
  return db.prepare(`SELECT status, result FROM tasks WHERE id = ?`).get(taskId) as { status: string; result: string | null };
}

function eventCount(taskId: string): number {
  return (db.prepare(`SELECT COUNT(*) as n FROM events WHERE task_id = ?`).get(taskId) as { n: number }).n;
}

function makeDirtyGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg481-worktree-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "changed-file.txt"), "uncommitted work\n");
  tmpDirs.push(dir);
  return dir;
}

// ── pipeline-run task: --continue always refused via the real CLI ──────────

for (const failureKind of ["orphaned", "orphaned_work_may_persist", "oom_killed"]) {
  test(`integ forge recover --continue --json: refuses a pipeline-run task in CONTINUABLE_KIND '${failureKind}' — no db mutation`, () => {
    const runId = `run-fg481-pipeline-${failureKind}`;
    const taskId = `t-fg481-pipeline-${failureKind}`;
    insertRunRow({ id: runId, workflow: "build", title: "pipeline recover integ test" });
    insertTaskRow({ id: taskId, runId, worktreePath: makeDirtyGitRepo() });
    insertFailedEvent({ runId, taskId, failureKind });

    const before = getTaskRow(taskId);
    const eventsBefore = eventCount(taskId);

    const result = runForge(["recover", taskId, "--continue", "--json"]);
    assert.equal(result.status, 1, `expected exit 1\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
    const outcome = JSON.parse(result.stdout) as { kind: string; reason: string };
    assert.equal(outcome.kind, "continue-refused");
    assert.match(outcome.reason, /pipeline/i);
    assert.match(outcome.reason, /finalize|merge|integration gate|reds|gates/i);
    assert.match(outcome.reason, /forge retry/);
    assert.match(outcome.reason, /--force/);

    assert.deepEqual(getTaskRow(taskId), before, "no write on refusal");
    assert.equal(eventCount(taskId), eventsBefore, "no event logged on refusal");

    // --force must not override the pipeline refusal, end to end.
    const forced = runForge(["recover", taskId, "--continue", "--force", "--json"]);
    assert.equal(forced.status, 1, `expected exit 1 even with --force\nstdout: ${forced.stdout}\nstderr: ${forced.stderr}`);
    const forcedOutcome = JSON.parse(forced.stdout) as { kind: string; reason: string };
    assert.equal(forcedOutcome.kind, "continue-refused");
    assert.deepEqual(getTaskRow(taskId), before, "no write on refusal even with --force");
    assert.equal(eventCount(taskId), eventsBefore, "no event logged on refusal even with --force");
  });
}

test("integ forge recover --continue (plain, non-JSON): stderr names the pipeline refusal and exits 1", () => {
  const runId = "run-fg481-plain";
  const taskId = "t-fg481-plain";
  insertRunRow({ id: runId, workflow: "build", title: "pipeline recover integ test" });
  insertTaskRow({ id: taskId, runId, worktreePath: makeDirtyGitRepo() });
  insertFailedEvent({ runId, taskId, failureKind: "oom_killed" });

  const result = runForge(["recover", taskId, "--continue"]);
  assert.equal(result.status, 1, `expected exit 1\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /forge recover --continue: refused/);
  assert.match(result.stderr, /pipeline/i);
  assert.match(result.stderr, /forge retry .*--force/);
  assert.equal(getTaskRow(taskId).status, "failed", "no mutation on refusal");
});

// ── invoke-run task: --continue still adopts and completes, real CLI end to end ──

test("integ forge recover --continue --json: an invoke-run task in a CONTINUABLE_KIND still adopts the diff and completes (unchanged)", () => {
  const runId = "run-fg481-invoke";
  const taskId = "t-fg481-invoke";
  insertRunRow({ id: runId, workflow: "invoke", title: "invoke recover integ test" });
  const gitDir = makeDirtyGitRepo();
  insertTaskRow({ id: taskId, runId, worktreePath: gitDir, status: "failed" });
  insertFailedEvent({ runId, taskId, failureKind: "orphaned_work_may_persist" });

  const result = runForge(["recover", taskId, "--continue", "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { kind: string; adoptedFrom: string };
  assert.equal(outcome.kind, "continued");
  assert.equal(outcome.adoptedFrom, "diff_adopted");

  const row = getTaskRow(taskId);
  assert.equal(row.status, "complete");
  const adopted = JSON.parse(row.result ?? "null") as Record<string, unknown>;
  assert.equal(adopted.contract, "adopted_diff");
  assert.deepEqual(adopted.changedFiles, ["?? changed-file.txt"]);
});

// ── FG-479 surfacing unchanged: run-level and single-task views still list ──
// a pipeline task in a CONTINUABLE_KIND; only --continue adoption is refused ──

test("integ forge recover <runId> --json: still surfaces a pipeline task in a CONTINUABLE_KIND (read-only listing unaffected)", () => {
  const runId = "run-fg481-surface";
  const taskId = "t-fg481-surface";
  insertRunRow({ id: runId, workflow: "build", title: "pipeline surfacing integ test" });
  insertTaskRow({ id: taskId, runId, worktreePath: makeDirtyGitRepo() });
  insertFailedEvent({ runId, taskId, failureKind: "oom_killed" });

  const runView = runForge(["recover", runId, "--json"]);
  assert.equal(runView.status, 0, `expected exit 0\nstdout: ${runView.stdout}\nstderr: ${runView.stderr}`);
  const runOutcome = JSON.parse(runView.stdout) as { kind: string; tasks: { taskId: string; recommendation: string }[] };
  assert.equal(runOutcome.kind, "inspect-run");
  const surfaced = runOutcome.tasks.find((t) => t.taskId === taskId);
  assert.ok(surfaced, "pipeline task must still be listed at the run level");
  assert.doesNotMatch(surfaced!.recommendation, /^forge recover \S+ --continue/, "must not recommend a command performContinue now refuses");
  assert.match(surfaced!.recommendation, /^forge retry \S+ --force/);

  const taskView = runForge(["recover", taskId, "--json"]);
  assert.equal(taskView.status, 0);
  const taskOutcome = JSON.parse(taskView.stdout) as { kind: string; task: { taskId: string; recommendation: string } };
  assert.equal(taskOutcome.kind, "inspect-task");
  assert.equal(taskOutcome.task.taskId, taskId, "single-task view still surfaces the pipeline task");
  assert.match(taskOutcome.task.recommendation, /^forge retry \S+ --force/);
});

// ── FG-481 guidance threading: forge show / forge status must not steer an ──
// operator toward a --continue that recover.ts now refuses for a pipeline run

const ORPHAN_EVIDENCE = {
  containerName: "forge-fg481-guidance",
  containerLiveness: "gone" as const,
  resultState: "absent" as const,
  recoverableStdoutResult: false,
  worktreePathChecked: "/tmp/some/worktree",
  changedFiles: ["?? new.txt"],
};

test("integ forge show <taskId> --json: a pipeline-run task's recovery guidance never suggests --continue", () => {
  const runId = "run-fg481-show-pipeline";
  const taskId = "t-fg481-show-pipeline";
  insertRunRow({ id: runId, workflow: "build", title: "pipeline show guidance integ test" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertFailedEvent({ runId, taskId, failureKind: "oom_killed", evidence: ORPHAN_EVIDENCE });

  const result = runForge(["show", taskId, "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { diagnostic: { orphanRecovery: { message: string } | null } };
  const message = output.diagnostic.orphanRecovery?.message;
  assert.ok(message, "orphanRecovery must be present for a failed task with recorded evidence");
  assert.doesNotMatch(message!, /--continue/, "forge show must not suggest --continue for a pipeline-run task");
  assert.match(message!, new RegExp(`forge retry ${taskId} --force`));
});

test("integ forge show <taskId> --json: an invoke-run task's recovery guidance still suggests continue-or-retry (unchanged)", () => {
  const runId = "run-fg481-show-invoke";
  const taskId = "t-fg481-show-invoke";
  insertRunRow({ id: runId, workflow: "invoke", title: "invoke show guidance integ test" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertFailedEvent({ runId, taskId, failureKind: "oom_killed", evidence: ORPHAN_EVIDENCE });

  const result = runForge(["show", taskId, "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { diagnostic: { orphanRecovery: { message: string } | null } };
  const message = output.diagnostic.orphanRecovery?.message;
  assert.ok(message);
  assert.match(message!, /continue from it or retry with --force/);
});

test("integ forge status <runId> --json: a pipeline-run task's recovery guidance never suggests --continue", () => {
  const runId = "run-fg481-status-pipeline";
  const taskId = "t-fg481-status-pipeline";
  insertRunRow({ id: runId, workflow: "build", title: "pipeline status guidance integ test" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertFailedEvent({ runId, taskId, failureKind: "oom_killed", evidence: ORPHAN_EVIDENCE });

  const result = runForge(["status", runId, "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const output = JSON.parse(result.stdout) as { tasks: { id: string; orphanRecovery: { message: string } | null }[] };
  const task = output.tasks.find((t) => t.id === taskId);
  assert.ok(task?.orphanRecovery, "orphanRecovery must be present for a failed task with recorded evidence");
  assert.doesNotMatch(task!.orphanRecovery!.message, /--continue/, "forge status must not suggest --continue for a pipeline-run task");
  assert.match(task!.orphanRecovery!.message, new RegExp(`forge retry ${taskId} --force`));
});
