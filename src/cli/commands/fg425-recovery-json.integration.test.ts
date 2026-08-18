// FG-425 (AC5) integration test: the `awaiting_recovery` diagnostic exercised
// through the REAL CLI subprocess — commander parsing, the actual `--json`
// branch of `forge show`, a real on-disk sqlite db. The function-level surfaces
// (publicationRecoveryMessage, retry policy, advice) are already covered by
// fg425-lost-window-disposition.worktree.test.ts; what NO test reached was the
// machine path an orchestrator actually consumes. Until this existed, `forge
// show --json` emitted `task.status: awaiting_recovery` and nothing else — a
// consumer could not tell a task whose candidate may ALREADY be on the target
// from a task that merely parked, which is exactly the distinction that decides
// whether a retry double-publishes.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let forgeHome: string;
let db: DatabaseInstance;

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg425-home-"));
  db = new Database(join(forgeHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
});

function runForge(args: string[]) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

const RUN_ID = "run-fg425-json";
const TASK_ID = "t-fg425-json";
const ATTEMPT_ID = "att-fg425-json";
const TARGET = "refs/heads/main";
const CANDIDATE_SHA = "cafebabe1234deadbeef5678cafebabe12340000";

function seedParkedTask(taskStatus: string, attemptState: string): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(RUN_ID, "build", "fg425 recovery json", "active", "2026-07-01T00:00:00Z", null);
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TASK_ID,
    RUN_ID,
    "build",
    "engineer",
    taskStatus,
    JSON.stringify({ taskId: TASK_ID, runId: RUN_ID, phase: "build", role: "engineer", inputs: {}, composedSystemPrompt: "" }),
    "2026-07-01T00:00:01Z",
    "2026-07-01T00:00:02Z",
    null,
  );
  db.prepare(
    `INSERT INTO publication_attempts
       (attempt_id, project_key, canonical_dir, run_id, task_id, target, base_sha, candidate_sha, published_sha, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ATTEMPT_ID,
    "proj-fg425",
    "/tmp/proj-fg425",
    RUN_ID,
    TASK_ID,
    TARGET,
    "0000000000000000000000000000000000000000",
    CANDIDATE_SHA,
    null,
    attemptState,
    "2026-07-01T00:00:03Z",
    "2026-07-01T00:00:04Z",
  );
}

type ShowJson = {
  task: { status: string };
  diagnostic: {
    recoveryPending: {
      attemptId: string;
      target: string;
      candidateSha: string;
      retrySafe: boolean;
      recoverCommand: string;
      convergeCommand: string;
      message: string;
    } | null;
  };
};

function showJson(): ShowJson {
  const result = runForge(["show", TASK_ID, "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return JSON.parse(result.stdout) as ShowJson;
}

test("integ forge show --json: an awaiting_recovery task carries a recoveryPending diagnostic naming the attempt, target, candidate and do-not-retry guidance", () => {
  seedParkedTask("awaiting_recovery", "publishing");

  const out = showJson();

  assert.equal(out.task.status, "awaiting_recovery");

  // The whole point: status alone is NOT the surface. A machine consumer gets the
  // unsettled publication itself.
  const pending = out.diagnostic.recoveryPending;
  assert.notEqual(pending, null, "`forge show --json` must expose the unsettled publication, not just the parked status");
  assert.equal(pending!.attemptId, ATTEMPT_ID);
  assert.equal(pending!.target, TARGET);
  assert.equal(pending!.candidateSha, CANDIDATE_SHA);

  // Retrying is what an operator must NOT do here — the candidate may already be on
  // the target — and the machine path has to say so without parsing prose.
  assert.equal(pending!.retrySafe, false, "a task whose candidate may already be published is never retry-safe");
  assert.equal(pending!.recoverCommand, `forge publish recover ${ATTEMPT_ID}`);
  assert.equal(pending!.convergeCommand, `forge next ${RUN_ID}`);

  // And the prose that IS there must not tell the lie AC5 forbids.
  assert.match(pending!.message, /UNSETTLED/);
  assert.match(pending!.message, /Do NOT retry/);
  assert.doesNotMatch(pending!.message, /[Nn]othing (was |from this task was )published/);
});

test("integ forge show --json: recoveryPending is null for a task with no unsettled publication", () => {
  seedParkedTask("running", "published");

  const out = showJson();

  assert.equal(
    out.diagnostic.recoveryPending,
    null,
    "recoveryPending is the awaiting_recovery signal — it must not fire on a task that is not parked over an unsettled attempt",
  );
});
