// FG-734: the CLI must carry the operator-wait projection produced from real
// persisted state.  Unlike the derivation unit suite, these cases spawn `forge
// status --json` against SQLite and let the production workflow loader resolve the
// human gate from the run's project override.

import { after, before, beforeEach, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const CLI = join(REPO, "src", "cli", "index.ts");
const NOW = "2026-08-19T12:00:00.000Z";

let home = "";
let dbPath = "";
let project = "";

type OperatorWait = {
  kind: string;
  source: string;
  runId: string | null;
  taskId: string | null;
  ticketId: string | null;
  blockerKind: string | null;
  reason: string;
  requestedAction: string;
  startedAt: string | null;
};

function forgeStatus(): { status: number | null; stderr: string; currentActivity: { agents: Array<{ taskId: string }>; operatorWaits: OperatorWait[] } } {
  const result = spawnSync(process.execPath, ["--import", "tsx", CLI, "status", "--all", "--read-only", "--json"], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: dbPath, NO_NOTIFY: "true" },
  });
  return {
    status: result.status,
    stderr: result.stderr ?? "",
    currentActivity: (JSON.parse(result.stdout ?? "{}") as { currentActivity: { agents: Array<{ taskId: string }>; operatorWaits: OperatorWait[] } }).currentActivity,
  };
}

function db(): DatabaseInstance {
  return new Database(dbPath);
}

function seed(): void {
  const store = db();
  store.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT, project_dir TEXT, review_mode TEXT NOT NULL DEFAULT 'legacy_verdict');
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, parent_id TEXT, phase TEXT NOT NULL, agent_role TEXT NOT NULL, agent_alias TEXT, agent_model TEXT, status TEXT NOT NULL, task_package TEXT NOT NULL, result TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT, error TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT NOT NULL, payload TEXT, created_at TEXT NOT NULL);
    CREATE TABLE campaigns (id TEXT PRIMARY KEY, status TEXT NOT NULL, source_kind TEXT NOT NULL, source_input TEXT NOT NULL, mode TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, project_dir TEXT);
    CREATE TABLE campaign_items (id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL, item_order INTEGER NOT NULL, ticket_id TEXT NOT NULL, run_id TEXT, lifecycle_status TEXT NOT NULL, blocker_kind TEXT, reason TEXT, requested_human_action TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  `);
  store.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, metadata, project_dir) VALUES (?, 'fg734-human', ?, 'active', ?, ?, ?)`)
    .run("run-human", "human gate", NOW, JSON.stringify({ ticketId: "FG-734" }), project);
  store.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, result, created_at, started_at) VALUES (?, ?, ?, ?, ?, '{}', ?, ?, ?)`)
    .run("task-human", "run-human", "approve", "tech-lead", "awaiting_gate", JSON.stringify({ note: "I need your decision" }), NOW, "2026-08-19T11:45:00.000Z");
  store.close();
}

function waitBySource(activity: ReturnType<typeof forgeStatus>["currentActivity"], source: string): OperatorWait {
  const row = activity.operatorWaits.find((wait) => wait.source === source);
  assert.ok(row, `expected a ${source} operator wait`);
  return row;
}

before(() => {
  home = mkdtempSync(join(tmpdir(), "fg734-status-home-"));
  project = mkdtempSync(join(tmpdir(), "fg734-status-project-"));
  mkdirSync(join(project, ".forge", "workflows"), { recursive: true });
  writeFileSync(join(project, ".forge", "workflows", "fg734-human.yml"), `name: fg734-human\ndescription: FG-734 human gate fixture\ninputs: []\nsteps:\n  - id: approve\n    agent: tech-lead\n    gate: human\n`);
});

beforeEach(() => {
  dbPath = join(home, `forge-${Math.random().toString(16).slice(2)}.db`);
  seed();
});

after(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  if (project) rmSync(project, { recursive: true, force: true });
});

describe("FG-734 — `forge status --json` carries durable operator waits", () => {
  test("a real human workflow gate carries ticket/run/task identity, age source, reason, and action", () => {
    const status = forgeStatus();
    assert.equal(status.status, 0, status.stderr);
    const wait = waitBySource(status.currentActivity, "human_gate");
    assert.equal(wait.kind, "waiting_on_operator");
    assert.equal(wait.ticketId, "FG-734");
    assert.equal(wait.runId, "run-human");
    assert.equal(wait.taskId, "task-human");
    assert.equal(wait.startedAt, "2026-08-19T11:45:00.000Z");
    assert.match(wait.reason, /approve.*tech-lead.*fg734-human/);
    assert.equal(wait.requestedAction, "advance or reject the gate");
  });

  test("an autonomous campaign hard stop carries its category and named operator action", () => {
    const store = db();
    store.prepare(`INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir) VALUES ('campaign-1', 'running', 'list', '{}', 'sequential', ?, ?, ?)`).run(NOW, NOW, project);
    store.prepare(`INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, blocker_kind, reason, requested_human_action, created_at, updated_at) VALUES ('item-stop', 'campaign-1', 1, 'FG-735', 'run-campaign', 'blocked_by_red', 'authority_required', 'reviewer requires an operator decision', 'accept the risk or cancel the campaign', ?, ?)`)
      .run(NOW, "2026-08-19T11:50:00.000Z");
    store.close();

    const status = forgeStatus();
    assert.equal(status.status, 0, status.stderr);
    const wait = waitBySource(status.currentActivity, "campaign_hard_stop");
    assert.equal(wait.kind, "waiting_on_operator");
    assert.equal(wait.ticketId, "FG-735");
    assert.equal(wait.blockerKind, "authority_required");
    assert.equal(wait.reason, "reviewer requires an operator decision");
    assert.equal(wait.requestedAction, "accept the risk or cancel the campaign");
  });

  test("running work and a human gate are both visible, never flattened to idle", () => {
    const store = db();
    store.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-running', 'fg734-human', 'live implementation', 'active', ?, ?)`).run(NOW, project);
    store.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES ('task-running', 'run-running', 'build', 'engineer', 'running', '{}', ?, ?)`).run(NOW, NOW);
    store.close();

    const status = forgeStatus();
    assert.equal(status.status, 0, status.stderr);
    assert.ok(status.currentActivity.agents.some((agent) => agent.taskId === "task-running"));
    assert.equal(waitBySource(status.currentActivity, "human_gate").taskId, "task-human");
  });

  test("a resolved gate and terminal campaign item clear from the next live status read", () => {
    assert.equal(forgeStatus().currentActivity.operatorWaits.length, 1);
    const store = db();
    store.prepare(`INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir) VALUES ('campaign-clear', 'running', 'list', '{}', 'sequential', ?, ?, ?)`).run(NOW, NOW, project);
    store.prepare(`INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, run_id, lifecycle_status, blocker_kind, reason, requested_human_action, created_at, updated_at) VALUES ('item-clear', 'campaign-clear', 1, 'FG-736', NULL, 'awaiting_gate', 'human_decision', 'needs a choice', 'make the choice', ?, ?)`).run(NOW, NOW);
    store.close();
    assert.equal(forgeStatus().currentActivity.operatorWaits.length, 2);

    const resolved = db();
    resolved.prepare(`UPDATE tasks SET status = 'complete', completed_at = ? WHERE id = 'task-human'`).run(NOW);
    resolved.prepare(`UPDATE campaign_items SET lifecycle_status = 'complete', requested_human_action = NULL WHERE id = 'item-clear'`).run();
    resolved.close();
    assert.deepEqual(forgeStatus().currentActivity.operatorWaits, [], "no stale wait survives resolution");
  });

  test("free-form request prose without a durable gate or hard-stop never becomes an operator wait", () => {
    const store = db();
    store.prepare(`UPDATE tasks SET status = 'running', result = ? WHERE id = 'task-human'`).run(JSON.stringify({ message: "I need your decision before continuing" }));
    store.close();
    const status = forgeStatus();
    assert.equal(status.status, 0, status.stderr);
    assert.deepEqual(status.currentActivity.operatorWaits, []);
  });
});
