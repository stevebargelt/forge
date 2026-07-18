// FG-585 CLI-surface integration test: a feature-shaped run that settles to the
// `failed` terminal state — a `verify` step that FAILED and a `docs` step
// (depends_on: [verify], gate: auto) that therefore could never dispatch — must
// read the SAME way across all three operator surfaces. The unit tier already
// covers the classifier (ready-queue.ts's classifyRunTerminalState) and the
// finalize sites; what had no direct coverage before this file is the operator
// output itself: that `forge show`, `forge status --json`, and `forge status`
// (human) each name BOTH the failed phase (verify) AND the undispatched,
// unreachable phase (docs), and agree with one another.
//
// Driven through the REAL CLI subprocess (commander parsing, real on-disk
// sqlite, real workflow load off disk) — the same harness technique
// fg492-container-evidence-cli.integration.test.ts uses — not the function
// level. The run is composed from real run/task rows plus a real feature-shaped
// workflow the classifier loads from the project's .forge/workflows override,
// so `classifyRunTerminalState(loadWorkflow(...), tasks)` runs for real.
//
// Mutation-sensitive: the failed + unreachable phases are surfaced ONLY because
// the classifier returns status "failed" for this shape (the FG-585 change). If
// it were reverted to the pre-FG-585 "complete", runFailure stays null on every
// surface — no `failure:`/`Failure:` line, `runFailure: null` in JSON — and
// every assertion below goes red.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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

// A minimal feature-shaped workflow: the build → verify → docs tail of the real
// `feature` workflow, which is exactly where the FG-585 terminal shape lives
// (docs depends_on: [verify], gate: auto). Self-contained so the fixture reads
// at a glance and doesn't couple this test to the seed workflow's full shape.
const WORKFLOW_NAME = "fg585-terminal-feature";
const WORKFLOW_YAML = `name: ${WORKFLOW_NAME}
description: FG-585 fixture — feature-shaped build/verify/docs tail.
inputs:
  - name: brief
    required: true
    type: text
steps:
  - id: build
    agent: engineer
    activity: default
    gate: auto
  - id: verify
    agent: test-engineer
    activity: default
    depends_on: [build]
    gate: human
  - id: docs
    agent: documentation-maintainer
    activity: default
    depends_on: [verify]
    gate: auto
`;

let forgeHome: string;
let projectDir: string;
let db: DatabaseInstance;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg585-home-"));
  db = new Database(join(forgeHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);

  // The classifier loads run.workflow from run.projectDir/.forge/workflows.
  projectDir = mkdtempSync(join(tmpdir(), "forge-fg585-project-"));
  const wfDir = join(projectDir, ".forge", "workflows");
  mkdirSync(wfDir, { recursive: true });
  writeFileSync(join(wfDir, `${WORKFLOW_NAME}.yml`), WORKFLOW_YAML);
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

function insertRunRow(o: { id: string; workflow: string; status: string; projectDir: string }): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.workflow, "fg585 terminal shape", o.status, "2026-07-01T00:00:00Z", "2026-07-01T00:05:00Z", o.projectDir);
}

function insertTaskRow(o: { id: string; runId: string; phase: string; agentRole: string; status: string }): void {
  const taskPackage = { taskId: o.id, runId: o.runId, phase: o.phase, role: o.agentRole, inputs: {}, composedSystemPrompt: "" };
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.runId, o.phase, o.agentRole, o.status, JSON.stringify(taskPackage), "2026-07-01T00:00:01Z", "2026-07-01T00:00:02Z", "2026-07-01T00:04:00Z");
}

// Compose the terminal shape once: build complete, verify failed, docs never
// dispatched (no task row). build → complete, verify → failed (its own primary
// failed, deps complete), docs → unreachable (its dep verify is blocked). The
// run itself is the durable `failed` FG-585 finalizers now settle it to.
function seedFailedRun(runId: string): void {
  insertRunRow({ id: runId, workflow: WORKFLOW_NAME, status: "failed", projectDir });
  insertTaskRow({ id: `${runId}-build`, runId, phase: "build", agentRole: "engineer", status: "complete" });
  insertTaskRow({ id: `${runId}-verify`, runId, phase: "verify", agentRole: "test-engineer", status: "failed" });
  // Deliberately NO docs task row — it could never dispatch behind a failed verify.
}

test("integ FG-585: forge show (human) names BOTH the failed phase (verify) and the undispatched phase (docs)", () => {
  const runId = "run-fg585-show-human";
  seedFailedRun(runId);

  const result = runForge(["show", runId]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  // The run-level `failure:` line, sourced from formatRunFailure(runFailure).
  assert.match(result.stdout, /failure:.*verify failed.*docs never ran/, "show must name verify (failed) AND docs (never ran) on the failure line");
});

test("integ FG-585: forge status --json runFailure names both the failed (verify) and unreachable (docs) phases", () => {
  const runId = "run-fg585-status-json";
  seedFailedRun(runId);

  const result = runForge(["status", runId, "--json", "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  const parsed = JSON.parse(result.stdout) as {
    run: { status: string };
    runFailure: { status: string; failedPhases: string[]; unreachablePhases: string[] } | null;
  };
  assert.equal(parsed.run.status, "failed");
  assert.ok(parsed.runFailure, "runFailure must be populated for a run that settled to failed");
  assert.equal(parsed.runFailure!.status, "failed");
  assert.deepEqual(parsed.runFailure!.failedPhases, ["verify"], "verify is the phase whose own primary failed");
  assert.deepEqual(parsed.runFailure!.unreachablePhases, ["docs"], "docs could never dispatch behind the failed verify");
});

test("integ FG-585: forge status (human) prints a Failure: line naming both verify and docs", () => {
  const runId = "run-fg585-status-human";
  seedFailedRun(runId);

  const result = runForge(["status", runId, "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);

  assert.match(result.stdout, /^Failure: verify failed; docs never ran$/m, "status must print a Failure: line naming verify (failed) AND docs (never ran)");
});

test("integ FG-585: all three surfaces AGREE on the same failed + unreachable phases", () => {
  const runId = "run-fg585-agree";
  seedFailedRun(runId);

  const showHuman = runForge(["show", runId]);
  const statusJson = runForge(["status", runId, "--json", "--read-only"]);
  const statusHuman = runForge(["status", runId, "--read-only"]);
  for (const r of [showHuman, statusJson, statusHuman]) {
    assert.equal(r.status, 0, `expected exit 0\nstdout: ${r.stdout}\nstderr: ${r.stderr}`);
  }

  const parsed = JSON.parse(statusJson.stdout) as { runFailure: { failedPhases: string[]; unreachablePhases: string[] } };
  const failed = parsed.runFailure.failedPhases;
  const unreachable = parsed.runFailure.unreachablePhases;
  assert.deepEqual(failed, ["verify"]);
  assert.deepEqual(unreachable, ["docs"]);

  // Every surface names both phases the JSON classifier reports — no surface
  // omits or disagrees with the failed/unreachable split.
  for (const phase of [...failed, ...unreachable]) {
    assert.ok(showHuman.stdout.includes(phase), `forge show must name '${phase}'`);
    assert.ok(statusHuman.stdout.includes(phase), `forge status (human) must name '${phase}'`);
  }
});
