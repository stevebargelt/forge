// FG-676 regression proof at the operator boundary. This uses the real CLI
// subprocess and a disk-backed SQLite store: an already-resurrected gate
// rejection is detected, dry-run remains read-only, the live repair restores
// its terminal audit row, and a later check no longer reports a phantom.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { applyMigrations } from "../../store/db.js";
import { SCHEMA_SQL } from "../../store/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;
let projectDir: string;
let db: DatabaseInstance;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg676-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg676-project-"));
  execFileSync("git", ["init", "-q"], { cwd: projectDir });
  db = new Database(join(forgeHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

function seedResurrectedGateDecision(runId: string, taskId: string, rejectedArtifact: unknown): void {
  db.prepare(
    "INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, 'active', ?, ?)",
  ).run(runId, "feature", "FG-676 operator repair", "2026-08-05T00:00:00Z", projectDir);
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at)
     VALUES (?, ?, 'build', 'engineer', 'awaiting_gate', ?, ?, ?)`,
  ).run(
    taskId,
    runId,
    JSON.stringify({ taskId, runId, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" }),
    JSON.stringify(rejectedArtifact),
    "2026-08-05T00:00:01Z",
  );
  // Production ordering: the human decision and terminal failure existed first;
  // a later publication reconcile wrote awaiting_gate and cleared the row error.
  for (const [eventType, payload, createdAt] of [
    ["gate.decided", { decision: "request-changes", rationale: "request-changes; superseded" }, "2026-08-05T00:00:02Z"],
    ["task.failed", { failure_kind: "gate_rejected", error: "request-changes; superseded" }, "2026-08-05T00:00:03Z"],
    ["task.awaiting_gate", {}, "2026-08-05T00:00:04Z"],
  ] as const) {
    db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(runId, taskId, eventType, JSON.stringify(payload), createdAt);
  }
}

test("integ forge ops check → repair → check restores a resurrected request-changes task without altering its rejected artifact or run", () => {
  const runId = "run-fg676-cli";
  const taskId = "task-fg676-cli";
  const artifact = { status: "complete", diff_summary: "rejected replacement candidate", files_modified: ["src/a.ts"] };
  seedResurrectedGateDecision(runId, taskId, artifact);
  const rawArtifact = (db.prepare("SELECT result FROM tasks WHERE id = ?").get(taskId) as { result: string }).result;

  const before = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(before.status, 0, `check failed\nstdout: ${before.stdout}\nstderr: ${before.stderr}`);
  const incidents = JSON.parse(before.stdout) as Array<{ kind: string; taskId: string | null; recommendedAction: { command: string | null } }>;
  assert.ok(incidents.some((i) => i.kind === "resurrected_gate_decision" && i.taskId === taskId && i.recommendedAction.command === `forge ops repair ${taskId}`));

  const dryRun = runForge(["ops", "repair", taskId, "--dry-run"]);
  assert.equal(dryRun.status, 0, `dry-run failed\nstdout: ${dryRun.stdout}\nstderr: ${dryRun.stderr}`);
  assert.match(dryRun.stdout, /would restore task .*resurrected_gate_decision/i);
  assert.equal((db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string }).status, "awaiting_gate", "dry-run must not repair the row");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(taskId) as { n: number }).n, 3, "dry-run appends no audit event");

  const repaired = runForge(["ops", "repair", taskId]);
  assert.equal(repaired.status, 0, `repair failed\nstdout: ${repaired.stdout}\nstderr: ${repaired.stderr}`);
  assert.match(repaired.stdout, /Restored task .* to failed .*gate decision reinstated/i);

  const task = db.prepare("SELECT status, error, result FROM tasks WHERE id = ?").get(taskId) as { status: string; error: string | null; result: string | null };
  assert.deepEqual(task, { status: "failed", error: "request-changes; superseded", result: rawArtifact }, "repair reinstates audit history byte-for-byte");
  assert.equal((db.prepare("SELECT status FROM runs WHERE id = ?").get(runId) as { status: string }).status, "active", "repair never changes the run disposition");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'task.failed'").get(taskId) as { n: number }).n, 1, "repair never fabricates a second terminal failure");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND event_type = 'task.reconciled'").get(taskId) as { n: number }).n, 1, "repair appends exactly one reconciliation audit event");

  const after = runForge(["ops", "check", "--project", projectDir, "--json"]);
  assert.equal(after.status, 0, `post-repair check failed\nstdout: ${after.stdout}\nstderr: ${after.stderr}`);
  const afterIncidents = JSON.parse(after.stdout) as Array<{ kind: string; taskId: string | null }>;
  assert.ok(!afterIncidents.some((i) => i.kind === "resurrected_gate_decision" && i.taskId === taskId), "a restored terminal task must stop being a phantom incident");
});
