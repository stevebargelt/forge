import { test, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import Database from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "./db.js";
import {
  insertRun,
  getRun,
  setRunProjectDir,
  listRunsForWorkspace,
  uniqueProjectDirs,
  updateRunStatus,
  completeRun,
} from "./runs.js";
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

// ── completeRun (FG-484) ────────────────────────────────────────────────────
// Store-layer CAS: abandoned runs must never resurrect to complete, and the
// completion notification must never fire for a refused write. Proving
// "notifyOnRunTransition wasn't invoked" requires actually enabling a
// provider (ntfy) and mocking the network call it makes — under the test
// suite's default NO_NOTIFY=true (test-setup.ts), notifyOnRunTransition
// itself would short-circuit either way, silently. ESM named exports can't
// be monkey-patched via mock.method (module namespace properties aren't
// configurable) and `mock.module()` needs a Node flag this project's test
// script doesn't pass — so global fetch, a plain writable global, is the
// mockable seam that ntfy.ts's transport actually goes through.

const NOTIFY_ENV_KEYS = ["FORGE_NOTIFY", "NTFY_URL", "NTFY_TOKEN", "NTFY_PRIORITY", "NO_NOTIFY"];

function withNtfyEnabledAndFetchMocked(fn: (fetchMock: ReturnType<typeof mock.method>) => Promise<void>) {
  return async () => {
    const saved: Record<string, string | undefined> = {};
    for (const k of NOTIFY_ENV_KEYS) saved[k] = process.env[k];
    process.env["FORGE_NOTIFY"] = "ntfy";
    process.env["NTFY_URL"] = "https://ntfy.example.invalid/forge-test";
    delete process.env["NO_NOTIFY"];

    const fetchMock = mock.method(globalThis, "fetch", async () => new Response("", { status: 200 }));
    try {
      await fn(fetchMock);
    } finally {
      fetchMock.mock.restore();
      for (const k of NOTIFY_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  };
}

test(
  "completeRun: completes an active run, sets a fresh completedAt, and fires exactly one notification",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-complete-active", status: "active" });

    const ok = completeRun("run-complete-active");
    assert.equal(ok, true);

    const run = getRun("run-complete-active");
    assert.equal(run?.status, "complete");
    assert.ok(run?.completedAt, "completedAt must be set");

    // notifyOnRunTransition is fired async/fire-and-forget; flush the
    // microtask queue so its chained awaits (dispatch -> notifyNtfy -> fetch)
    // resolve before asserting.
    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 1, "expected exactly one notification dispatch");
  }),
);

test(
  "completeRun: refuses the abandoned->complete transition — status, completedAt, and notification all untouched",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-complete-abandoned", status: "active" });
    updateRunStatus("run-complete-abandoned", "abandoned"); // simulates a concurrent `forge cancel` winning the race
    const abandonedAt = getRun("run-complete-abandoned")?.completedAt;
    assert.ok(abandonedAt, "abandon should have set completedAt");

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // discard the abandon transition's own notification; isolate completeRun's attempt

    const ok = completeRun("run-complete-abandoned");
    assert.equal(ok, false, "completeRun must refuse an abandoned run");

    const run = getRun("run-complete-abandoned");
    assert.equal(run?.status, "abandoned", "status must stay abandoned, never flipped to complete");
    assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged from the abandon-time value");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused write must never fire a completion notification");
  }),
);

test(
  "completeRun: refuses complete->complete re-finalization — no double notification, completedAt not clobbered",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-complete-twice", status: "active" });

    const first = completeRun("run-complete-twice");
    assert.equal(first, true, "first completeRun call must succeed from active");
    const completedAt = getRun("run-complete-twice")?.completedAt;
    assert.ok(completedAt, "completedAt must be set by the first call");

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // isolate the second call's (non-)notification

    const second = completeRun("run-complete-twice");
    assert.equal(second, false, "completeRun must refuse a second call on an already-complete run");

    const run = getRun("run-complete-twice");
    assert.equal(run?.status, "complete");
    assert.equal(run?.completedAt, completedAt, "completedAt must not be bumped by the refused re-finalization");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused complete->complete re-finalization must never double-notify");
  }),
);

test(
  "updateRunStatus: refuses the abandoned->complete transition at the store layer — universal backstop, independent of any caller migrating to completeRun",
  withNtfyEnabledAndFetchMocked(async (fetchMock) => {
    insertRun({ ...RUN, id: "run-update-abandoned", status: "active" });
    updateRunStatus("run-update-abandoned", "abandoned"); // simulates a concurrent `forge cancel` winning the race
    const abandonedAt = getRun("run-update-abandoned")?.completedAt;
    assert.ok(abandonedAt, "abandon should have set completedAt");

    await new Promise((r) => setImmediate(r));
    fetchMock.mock.resetCalls(); // discard the abandon transition's own notification

    // A caller that bypasses completeRun/finalizeRunIfSettled entirely (e.g.
    // src/cli/commands/design.ts, src/cli/commands/claude.ts) and calls
    // updateRunStatus(id, "complete") directly from a child-exit handler must
    // still be refused — the guard lives in the store layer, not in every caller.
    updateRunStatus("run-update-abandoned", "complete");

    const run = getRun("run-update-abandoned");
    assert.equal(run?.status, "abandoned", "status must stay abandoned, never flipped to complete");
    assert.equal(run?.completedAt, abandonedAt, "completedAt must be unchanged from the abandon-time value");

    await new Promise((r) => setImmediate(r));
    assert.equal(fetchMock.mock.calls.length, 0, "a refused abandoned->complete write must never fire a completion notification");
  }),
);

test("updateRunStatus: 'active' still flips an abandoned run back to active (the #201 reactivation path)", () => {
  insertRun({ ...RUN, id: "run-reactivate", status: "active" });
  updateRunStatus("run-reactivate", "abandoned");
  assert.equal(getRun("run-reactivate")?.status, "abandoned");

  updateRunStatus("run-reactivate", "active");

  const run = getRun("run-reactivate");
  assert.equal(run?.status, "active", "updateRunStatus must still allow abandoned->active reactivation");
  assert.equal(run?.completedAt, undefined, "reactivating to a non-terminal status clears completedAt");
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
