// FG-521 (d): `inFlight` used to select a phantom status — one that is not in
// TaskStatus and that nothing ever writes. Dropping it must be a no-op: the
// in-flight set is exactly {running, awaiting_gate, awaiting_red,
// blocked_by_red}, and every terminal/pending status stays out.
//
// This pins the whole partition (not just the removed value) against a fixture
// carrying EVERY real TaskStatus, so a future edit to the status list in
// queries.ts can't quietly widen or narrow the dashboard's in-flight view. It
// also pins the shell's badge CSS to that same set — the phantom's badge rule
// was removed alongside it, so every badge rule must now name a real status,
// and any status inFlight CAN return must still have one to render.
//
// The phantom's name is deliberately absent from this file: acceptance (d)
// requires it to appear nowhere under dashboard/src. The guard that it never
// comes back by name lives in src/dashboard-phantom-status.test.ts.
//
// Same temp-forge.db harness as queries-ops.test.ts / queries-reconcile.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskStatus } from "@forge/types";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qinflight-"));
process.env.FORGE_HOME = tmpHome;

const { inFlight } = await import("./queries.js");
const { renderShell } = await import("./shell.js");

/** Every real TaskStatus, split by whether the dashboard should show it as
 *  in-flight. Typed as a total map over TaskStatus: adding a status to the type
 *  without deciding its in-flight-ness fails the typecheck, not just the test. */
const EXPECTED_IN_FLIGHT: Record<TaskStatus, boolean> = {
  pending: false,
  running: true,
  awaiting_gate: true,
  awaiting_red: true,
  blocked_by_red: true,
  complete: false,
  failed: false,
};

const ALL_STATUSES = Object.keys(EXPECTED_IN_FLIGHT) as TaskStatus[];
const IN_FLIGHT_STATUSES = ALL_STATUSES.filter((s) => EXPECTED_IN_FLIGHT[s]);

/** Stands in for the dropped phantom: any status string that TaskStatus does
 *  not contain. inFlight must not return it, whatever it happens to be named. */
const UNKNOWN_STATUS = "not_a_task_status";

/** Badge tokens in the shell CSS that are legitimately NOT TaskStatus values:
 *  verdict badges (pass/fail) and the derived reconcile-candidate marker. Every
 *  other `.badge.status-X` rule must name a real status — that is what keeps a
 *  phantom's CSS from creeping back in. */
const NON_STATUS_BADGES = new Set(["pass", "fail", "reconcile_candidate"]);

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, agent_model TEXT, status TEXT, started_at TEXT, created_at TEXT, parent_id TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    INSERT INTO runs VALUES ('run-active','Active run','feature','/proj/a','active', datetime('now','-2 hours'));
    -- An inactive run: even an in-flight-status task under it must stay hidden.
    INSERT INTO runs VALUES ('run-done','Complete run','feature','/proj/a','complete', datetime('now','-3 hours'));
  `);

  const insert = db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,NULL)");
  for (const status of ALL_STATUSES) {
    insert.run(`task-${status}`, "run-active", "engineer", "engineer", "sonnet", status, null, "2026-07-11T10:00:00Z");
  }
  // A row carrying a status outside TaskStatus — the shape the dropped phantom
  // would have had. Nothing writes such a row, but if a legacy one existed it is
  // NOT something the dashboard knows how to render, so it must stay out.
  insert.run(`task-${UNKNOWN_STATUS}`, "run-active", "engineer", "engineer", "sonnet", UNKNOWN_STATUS, null, "2026-07-11T10:00:00Z");
  // A running task on a non-active run — excluded by the run-status join.
  insert.run("task-on-complete-run", "run-done", "engineer", "engineer", "sonnet", "running", null, "2026-07-11T09:00:00Z");
  db.close();
}

// No container.started events in the fixture, so no task is docker-probed; the
// probe is injected anyway so the test can never depend on a live docker.
const probe = () => "alive" as const;

test("inFlight: returns exactly the in-flight statuses — running, awaiting_gate, awaiting_red, blocked_by_red", () => {
  const rows = inFlight(undefined, probe);
  const returned = [...new Set(rows.map((r) => r.status))].sort();

  assert.deepEqual(returned, [...IN_FLIGHT_STATUSES].sort());
  assert.deepEqual(returned, ["awaiting_gate", "awaiting_red", "blocked_by_red", "running"]);
});

test("inFlight: every non-in-flight TaskStatus is excluded — pending and terminal rows never appear", () => {
  const ids = new Set(inFlight(undefined, probe).map((r) => r.taskId));

  for (const status of ALL_STATUSES) {
    const shouldAppear = EXPECTED_IN_FLIGHT[status];
    assert.equal(
      ids.has(`task-${status}`),
      shouldAppear,
      `task with status '${status}' should ${shouldAppear ? "" : "NOT "}be in flight`,
    );
  }
});

test("inFlight: a row whose status is not a TaskStatus is not returned — dropping the phantom from the query changed nothing", () => {
  const ids = new Set(inFlight(undefined, probe).map((r) => r.taskId));
  assert.equal(ids.has(`task-${UNKNOWN_STATUS}`), false);

  // And the row is still there — the read is a filter, not a cleanup.
  const db = new Database(join(tmpHome, "forge.db"), { readonly: true });
  const row = db.prepare("SELECT status FROM tasks WHERE id = ?").get(`task-${UNKNOWN_STATUS}`) as { status: string };
  db.close();
  assert.equal(row.status, UNKNOWN_STATUS);
});

test("inFlight: an in-flight-status task under a non-active run stays out (the run-status join still holds)", () => {
  const ids = new Set(inFlight(undefined, probe).map((r) => r.taskId));
  assert.equal(ids.has("task-on-complete-run"), false);
});

test("inFlight: projectDir filter narrows without changing the status partition", () => {
  const scoped = inFlight("/proj/a", probe);
  assert.deepEqual([...new Set(scoped.map((r) => r.status))].sort(), ["awaiting_gate", "awaiting_red", "blocked_by_red", "running"]);
  assert.deepEqual(inFlight("/proj/nonexistent", probe), []);
});

test("shell: every status inFlight can return still has a badge rule", () => {
  const shell = renderShell();

  for (const status of IN_FLIGHT_STATUSES) {
    assert.match(
      shell,
      new RegExp(`\\.badge\\.status-${status}\\b`),
      `'${status}' is renderable by inFlight but has no .badge.status-${status} CSS rule`,
    );
  }
});

test("shell: no badge rule names a status outside TaskStatus — the phantom's rule is gone and can't return", () => {
  const shell = renderShell();
  const known = new Set<string>([...ALL_STATUSES, ...NON_STATUS_BADGES]);

  const badged = [...shell.matchAll(/\.badge\.status-([a-z_]+)\b/g)].map((m) => m[1]!);
  assert.ok(badged.length > 0, "found no .badge.status-* rules at all — the regex or the shell CSS changed");

  const phantoms = [...new Set(badged)].filter((s) => !known.has(s));
  assert.deepEqual(phantoms, [], `badge CSS rules for statuses that are not in TaskStatus: ${phantoms.join(", ")}`);
});
