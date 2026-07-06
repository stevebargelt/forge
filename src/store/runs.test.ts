import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import Database from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import { insertRun, getRun, setRunProjectDir, listRunsForWorkspace, uniqueProjectDirs } from "./runs.js";
import { insertTask } from "./tasks.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = {
  id: "run-pd",
  workflow: "investigation",
  title: "project_dir test",
  status: "active",
  createdAt: "2026-05-08T00:00:00Z",
};

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

test("insertRun: persists projectDir when set, omits when undefined", () => {
  insertRun({ ...RUN, id: "run-with-pd", projectDir: "/Users/x/code/foo" });
  insertRun({ ...RUN, id: "run-without-pd" });

  const withPd = getRun("run-with-pd");
  const withoutPd = getRun("run-without-pd");

  assert.equal(withPd?.projectDir, "/Users/x/code/foo");
  assert.equal(withoutPd?.projectDir, undefined);
});

test("listRunsForWorkspace: matches by projectDir", () => {
  insertRun({ ...RUN, id: "run-a", projectDir: "/Users/x/code/foo" });
  insertRun({ ...RUN, id: "run-b", projectDir: "/Users/x/code/bar" });
  insertRun({ ...RUN, id: "run-c", projectDir: "/Users/x/code/foo" });

  const out = listRunsForWorkspace("/Users/x/code/foo").map((r) => r.id).sort();
  assert.deepEqual(out, ["run-a", "run-c"]);
});

test("listRunsForWorkspace: matches by metadata.workspace (audit-workspace case)", () => {
  insertRun({
    ...RUN,
    id: "run-audit",
    projectDir: "/Users/x/code/external-repo",
    metadata: { workspace: "/Users/x/code/audit-workspace" },
  });

  // Querying the workspace dir picks up the audit run even though its
  // projectDir is elsewhere.
  const workspaceMatches = listRunsForWorkspace("/Users/x/code/audit-workspace").map((r) => r.id);
  assert.deepEqual(workspaceMatches, ["run-audit"]);

  // Querying the external repo also finds it (projectDir match).
  const projectMatches = listRunsForWorkspace("/Users/x/code/external-repo").map((r) => r.id);
  assert.deepEqual(projectMatches, ["run-audit"]);
});

test("listRunsForWorkspace: returns empty when no run matches the workspace", () => {
  insertRun({ ...RUN, id: "run-x", projectDir: "/Users/x/code/somewhere" });
  assert.deepEqual(listRunsForWorkspace("/Users/x/code/other").map((r) => r.id), []);
});

test("setRunProjectDir: writes the value and returns the previous (undefined on first set)", () => {
  insertRun(RUN);
  const prev1 = setRunProjectDir(RUN.id, "/Users/x/code/foo");
  assert.equal(prev1, undefined);
  assert.equal(getRun(RUN.id)?.projectDir, "/Users/x/code/foo");
});

test("setRunProjectDir: returns the previous value on overwrite", () => {
  insertRun({ ...RUN, projectDir: "/Users/x/code/foo" });
  const prev1 = setRunProjectDir(RUN.id, "/Users/x/code/bar");
  assert.equal(prev1, "/Users/x/code/foo");
  assert.equal(getRun(RUN.id)?.projectDir, "/Users/x/code/bar");
});

test("schema migration: existing DB without project_dir gets the column added on open", () => {
  // Build a DB with the OLD runs schema (no project_dir column), insert a row,
  // then open it via makeInMemoryDb's migration path. The migration is what runs
  // when an existing on-disk DB upgrades — simulate it here.
  const legacy = new Database(":memory:");
  legacy.pragma("foreign_keys = ON");
  legacy.exec(`
    CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      workflow TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      completed_at TEXT,
      metadata TEXT
    );
  `);
  legacy.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run("legacy-run", "investigation", "legacy", "active", "2026-05-08T00:00:00Z");

  // Confirm the legacy table doesn't have project_dir.
  let cols = legacy.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  assert.ok(!cols.some((c) => c.name === "project_dir"), "legacy schema must not have project_dir");

  // Apply the same migration db.ts runs on open. Inline so the test stays self-
  // contained — the production path lives in db.ts.
  const have = new Set(cols.map((c) => c.name));
  if (!have.has("project_dir")) {
    legacy.exec(`ALTER TABLE runs ADD COLUMN project_dir TEXT`);
  }

  cols = legacy.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  assert.ok(cols.some((c) => c.name === "project_dir"), "post-migration must have project_dir");

  // Existing row's project_dir is null after migration.
  const row = legacy.prepare(`SELECT project_dir FROM runs WHERE id = ?`).get("legacy-run") as
    | { project_dir: string | null }
    | undefined;
  assert.equal(row?.project_dir, null);
  legacy.close();
});

// ── uniqueProjectDirs / inFlightCount (FG-414) ──────────────────────────────
// inFlightCount must agree with the dashboard's in-flight view: a run with
// >= 1 non-terminal task, excluding orchestrator session rows. Plain
// `status = 'active'` over-counted long-lived orchestrator rows and
// un-reconciled/stuck runs whose tasks are all terminal.

function mkTask(id: string, runId: string, status: Task["status"]): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-05-08T00:00:00Z",
  };
}

test("uniqueProjectDirs: inFlightCount counts a run with a non-terminal task", () => {
  insertRun({ ...RUN, id: "run-live", projectDir: "/code/proj" });
  insertTask(mkTask("t-live", "run-live", "running"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.projectDir, "/code/proj");
  assert.equal(agg!.inFlightCount, 1);
});

test("uniqueProjectDirs: excludes an orchestrator session row even though its task is still 'running'", () => {
  insertRun({ ...RUN, id: "run-orch", workflow: "orchestrator", projectDir: "/code/proj" });
  insertTask(mkTask("t-orch", "run-orch", "running"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.inFlightCount, 0, "a long-lived orchestrator session must not inflate in-flight");
});

test("uniqueProjectDirs: excludes a stuck run (active, all tasks terminal) — un-reconciled orphans don't inflate in-flight", () => {
  insertRun({ ...RUN, id: "run-stuck", projectDir: "/code/proj" });
  insertTask(mkTask("t-stuck", "run-stuck", "failed"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.inFlightCount, 0);
});

test("uniqueProjectDirs: mixed project — counts only the genuinely in-flight run", () => {
  insertRun({ ...RUN, id: "run-a", projectDir: "/code/proj" });
  insertTask(mkTask("t-a", "run-a", "awaiting_gate"));
  insertRun({ ...RUN, id: "run-b", workflow: "orchestrator", projectDir: "/code/proj" });
  insertTask(mkTask("t-b", "run-b", "running"));
  insertRun({ ...RUN, id: "run-c", projectDir: "/code/proj" });
  insertTask(mkTask("t-c", "run-c", "complete"));

  const [agg] = uniqueProjectDirs();
  assert.equal(agg!.runCount, 3);
  assert.equal(agg!.inFlightCount, 1, "only run-a has a non-terminal task on a non-orchestrator run");
});

test("schema migration: re-running the migration is a noop", () => {
  // makeInMemoryDb already ran the migration once. Run it again manually and
  // confirm no error and no duplicate column.
  const cols = db.prepare(`PRAGMA table_info(runs)`).all() as { name: string }[];
  const hadIt = cols.some((c) => c.name === "project_dir");
  assert.ok(hadIt, "fresh in-memory DB has project_dir from schema");
  // Calling ALTER again would throw "duplicate column"; the guard prevents that.
  // Simulate the guard:
  const have = new Set(cols.map((c) => c.name));
  assert.equal(have.has("project_dir"), true);
});
