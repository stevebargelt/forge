// FG-648: average agent runtime over time, overall and by role.
// Mirrors the queries-ops.test.ts harness: seed a temp forge.db, then exercise
// the read-only query. `nowMs` is injected so bucket boundaries are pinned.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

// A Wednesday, mid-hour: far enough from every boundary that "now" never sits
// exactly on one, so the partial-bucket assertions are about real partiality.
const NOW = Date.parse("2026-06-10T14:30:00Z");

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);

    INSERT INTO runs VALUES ('rA','A','feature','/proj/a','complete','2026-06-08T00:00:00Z');
    INSERT INTO runs VALUES ('rB','B','feature','/proj/b','complete','2026-06-08T00:00:00Z');

    -- 2026-06-09 (a complete day inside 7d/30d, a complete hour outside 1d):
    -- one successful engineer task, 10s.
    INSERT INTO tasks VALUES ('t-ok','rA','implementation','engineer','complete',NULL,'2026-06-09T09:00:00Z','2026-06-09T09:00:10Z');
    -- a FAILED engineer task, 30s — agent time was consumed, so it counts.
    INSERT INTO tasks VALUES ('t-failed','rA','implementation','engineer','failed',NULL,'2026-06-09T10:00:00Z','2026-06-09T10:00:30Z');
    -- a different role on the same day, 100s. It parents t-child below, so under
    -- FG-725 it needs a container.started of its OWN to stay an observation — a
    -- fanout parent that ran a real container, distinct from the non-container
    -- coordinator FG-725 excludes (covered in queries-agent-runtime-coordinator).
    INSERT INTO tasks VALUES ('t-red','rA','review','red-wide','complete',NULL,'2026-06-09T11:00:00Z','2026-06-09T11:01:40Z');
    INSERT INTO events (run_id,task_id,event_type,payload,created_at) VALUES ('rA','t-red','container.started','{}','2026-06-09T11:00:00Z');
    INSERT INTO events (run_id,task_id,event_type,payload,created_at) VALUES ('rA','t-red','container.exited','{}','2026-06-09T11:01:40Z');
    -- a fanout CHILD: a real agent execution (a leaf — no children), not excluded.
    INSERT INTO tasks VALUES ('t-child','rA','review','red-narrow','complete','t-red','2026-06-09T11:00:00Z','2026-06-09T11:00:20Z');

    -- still running: no completed_at.
    INSERT INTO tasks VALUES ('t-active','rA','implementation','engineer','running',NULL,'2026-06-09T12:00:00Z',NULL);
    -- interactive orchestrator session — excluded.
    INSERT INTO tasks VALUES ('t-session','rA','session','orchestrator','complete',NULL,'2026-06-09T08:00:00Z','2026-06-09T20:00:00Z');
    -- a non-session orchestrator task IS an agent execution — 40s, kept.
    INSERT INTO tasks VALUES ('t-orch-task','rA','planning','orchestrator','complete',NULL,'2026-06-09T13:00:00Z','2026-06-09T13:00:40Z');
    -- invalid: completed before started.
    INSERT INTO tasks VALUES ('t-negative','rA','implementation','engineer','complete',NULL,'2026-06-09T14:00:00Z','2026-06-09T13:59:00Z');

    -- today (2026-06-10), inside the partial day AND the partial hour: 20s.
    INSERT INTO tasks VALUES ('t-today','rA','implementation','engineer','complete',NULL,'2026-06-10T14:10:00Z','2026-06-10T14:10:20Z');

    -- other project, for the scope test: 200s on 2026-06-09.
    INSERT INTO tasks VALUES ('t-other','rB','implementation','engineer','complete',NULL,'2026-06-09T09:00:00Z','2026-06-09T09:03:20Z');
  `);
  db.close();
}

const bucket = <T extends { bucketStart: string }>(buckets: readonly T[], iso: string) =>
  buckets.find((b) => b.bucketStart === iso);

test("agentRuntimeTrends: completed SUCCESSFUL agent tasks are included", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const day = bucket(trends.byRole.find((s) => s.role === "red-wide")!.buckets, "2026-06-09T00:00:00.000Z")!;
  assert.equal(day.sampleCount, 1, "the completed red-wide task is an observation");
  assert.equal(day.averageMs, 100_000);
});

test("agentRuntimeTrends: completed FAILED agent tasks are included", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const engineer = trends.roleSummary.find((r) => r.role === "engineer")!;
  // 10s success + 30s failure + 20s today = 3 samples; without the failure it would be 2.
  assert.equal(engineer.sampleCount, 3);
  assert.equal(engineer.averageMs, 20_000);
});

test("agentRuntimeTrends: active/incomplete tasks (null completed_at) are excluded", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const total = trends.roleSummary.reduce((sum, r) => sum + r.sampleCount, 0);
  // engineer 3 + red-wide 1 + red-narrow 1 + orchestrator(planning) 1 = 6.
  // t-active would make 7.
  assert.equal(total, 6);
});

test("agentRuntimeTrends: interactive orchestrator session tasks are excluded", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const orchestrator = trends.roleSummary.find((r) => r.role === "orchestrator")!;
  // Only the planning task. The 12-hour session would swamp the average.
  assert.equal(orchestrator.sampleCount, 1);
  assert.equal(orchestrator.averageMs, 40_000);
});

test("agentRuntimeTrends: invalid negative durations are excluded", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const engineer = trends.roleSummary.find((r) => r.role === "engineer")!;
  assert.equal(engineer.sampleCount, 3, "t-negative must not be an observation");
  assert.ok(trends.overall.every((b) => b.averageMs === null || b.averageMs >= 0));
});

test("agentRuntimeTrends: fanout children are counted — no parent_id filter", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const child = trends.roleSummary.find((r) => r.role === "red-narrow");
  assert.ok(child, "the child task's role must appear");
  assert.equal(child.sampleCount, 1);
  assert.equal(child.averageMs, 20_000);
});

test("agentRuntimeTrends: bucketing is by completed_at, not started_at", () => {
  // A task that starts on 06-08 and finishes on 06-09 belongs to 06-09.
  const spanHome = mkdtempSync(join(tmpdir(), "forge-qruntime-span-"));
  const spanDb = new Database(join(spanHome, "forge.db"));
  spanDb.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
    INSERT INTO runs VALUES ('rS','S','feature','/proj/span','complete','2026-06-08T00:00:00Z');
    INSERT INTO tasks VALUES ('s1','rS','implementation','engineer','complete',NULL,'2026-06-08T23:00:00Z','2026-06-09T01:00:00Z');
  `);
  spanDb.close();

  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = spanHome;
  try {
    const trends = agentRuntimeTrends("7d", "/proj/span", NOW);
    assert.equal(bucket(trends.overall, "2026-06-08T00:00:00.000Z")!.sampleCount, 0, "the start day must be empty");
    const completedDay = bucket(trends.overall, "2026-06-09T00:00:00.000Z")!;
    assert.equal(completedDay.sampleCount, 1);
    assert.equal(completedDay.averageMs, 7_200_000);
  } finally {
    process.env.FORGE_HOME = previous;
  }
});

test("agentRuntimeTrends: role grouping is by agent_role, not workflow and not phase", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  assert.deepEqual(
    [...trends.roleSummary.map((r) => r.role)].sort(),
    ["engineer", "orchestrator", "red-narrow", "red-wide"],
  );
  // 'implementation'/'review'/'planning' are phases and 'feature' is the workflow —
  // neither may leak into the role dimension.
  const roles = new Set(trends.roleSummary.map((r) => r.role));
  for (const notARole of ["implementation", "review", "planning", "feature"]) {
    assert.equal(roles.has(notARole), false, `${notARole} is not an agent_role`);
  }
  assert.deepEqual(trends.byRole.map((s) => s.role), trends.roleSummary.map((r) => r.role));
});

test("agentRuntimeTrends: project scope filtering through runs.project_dir is applied", () => {
  const scoped = agentRuntimeTrends("7d", "/proj/b", NOW);
  assert.deepEqual(scoped.roleSummary, [{ role: "engineer", averageMs: 200_000, sampleCount: 1 }]);

  const canonical = agentRuntimeTrends("7d", ["/proj/a", "/proj/b"], NOW);
  assert.equal(canonical.roleSummary.reduce((sum, r) => sum + r.sampleCount, 0), 7);

  const unscoped = agentRuntimeTrends("7d", undefined, NOW);
  assert.equal(unscoped.roleSummary.reduce((sum, r) => sum + r.sampleCount, 0), 7);

  const empty = agentRuntimeTrends("7d", [], NOW);
  assert.deepEqual(empty.roleSummary, []);
});

test("agentRuntimeTrends: bucket resolution is hourly for 1d", () => {
  const trends = agentRuntimeTrends("1d", "/proj/a", NOW);
  assert.equal(trends.resolution, "hour");
  assert.equal(trends.bucketMs, 3_600_000);
  assert.equal(trends.rangeStart, "2026-06-09T14:00:00.000Z");
  assert.equal(trends.overall.length, 25);
  // Only t-today is inside the last 24h.
  const inWindow = trends.overall.filter((b) => b.sampleCount > 0);
  assert.deepEqual(inWindow.map((b) => b.bucketStart), ["2026-06-10T14:00:00.000Z"]);
  assert.equal(inWindow[0]!.averageMs, 20_000);
});

test("agentRuntimeTrends: bucket resolution is daily for 7d", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  assert.equal(trends.resolution, "day");
  assert.equal(trends.bucketMs, 86_400_000);
  assert.equal(trends.rangeStart, "2026-06-03T00:00:00.000Z");
  assert.equal(trends.overall.length, 8);
});

test("agentRuntimeTrends: bucket resolution is daily for 30d", () => {
  const trends = agentRuntimeTrends("30d", "/proj/a", NOW);
  assert.equal(trends.resolution, "day");
  assert.equal(trends.bucketMs, 86_400_000);
  assert.equal(trends.rangeStart, "2026-05-11T00:00:00.000Z");
  assert.equal(trends.overall.length, 31);
});

test("agentRuntimeTrends: bucket resolution is weekly for 90d", () => {
  const trends = agentRuntimeTrends("90d", "/proj/a", NOW);
  assert.equal(trends.resolution, "week");
  assert.equal(trends.bucketMs, 604_800_000);
  // 2026-03-12 is a Thursday; its week starts Monday 2026-03-09.
  assert.equal(trends.rangeStart, "2026-03-09T00:00:00.000Z");
  assert.ok(trends.overall.every((b) => Date.parse(b.bucketStart) % 604_800_000 === Date.parse(trends.rangeStart!) % 604_800_000));
});

test("agentRuntimeTrends: bucket resolution is weekly for all", () => {
  const trends = agentRuntimeTrends("all", "/proj/a", NOW);
  assert.equal(trends.resolution, "week");
  assert.equal(trends.bucketMs, 604_800_000);
});

test("agentRuntimeTrends: 'all' starts at the earliest included observation in scope", () => {
  const trends = agentRuntimeTrends("all", "/proj/a", NOW);
  // Earliest included observation completes 2026-06-09T09:00:10Z (a Tuesday);
  // its week starts Monday 2026-06-08. The 12-hour orchestrator SESSION completes
  // later the same day and is excluded, so it cannot move the start either way.
  assert.equal(trends.rangeStart, "2026-06-08T00:00:00.000Z");
  assert.equal(trends.overall.length, 1);
  assert.equal(trends.overall[0]!.sampleCount, 6);
});

test("agentRuntimeTrends: 'all' with nothing in scope has no range and no buckets", () => {
  const trends = agentRuntimeTrends("all", "/proj/nothing", NOW);
  assert.equal(trends.rangeStart, null);
  assert.deepEqual(trends.overall, []);
  assert.deepEqual(trends.byRole, []);
  assert.deepEqual(trends.roleSummary, []);
  assert.equal(trends.rangeEnd, new Date(NOW).toISOString());
});

test("agentRuntimeTrends: buckets are deterministically ordered ascending by bucket start", () => {
  for (const window of ["1d", "7d", "30d", "90d", "all"] as const) {
    const trends = agentRuntimeTrends(window, "/proj/a", NOW);
    const starts = trends.overall.map((b) => Date.parse(b.bucketStart));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${window} overall must ascend`);
    for (let i = 1; i < starts.length; i += 1) {
      assert.equal(starts[i]! - starts[i - 1]!, trends.bucketMs, `${window} buckets must be contiguous`);
    }
    for (const roleSeries of trends.byRole) {
      assert.deepEqual(roleSeries.buckets.map((b) => b.bucketStart), trends.overall.map((b) => b.bucketStart));
    }
  }
});

test("agentRuntimeTrends: an empty bucket is not emitted as a zero-duration observation", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const empties = trends.overall.filter((b) => b.sampleCount === 0);
  assert.ok(empties.length > 0, "the fixture has days with no agent runs");
  for (const empty of empties) {
    assert.equal(empty.averageMs, null, "an empty bucket reports a null average, never 0");
  }
  for (const filled of trends.overall.filter((b) => b.sampleCount > 0)) {
    assert.ok(typeof filled.averageMs === "number");
  }
});

test("agentRuntimeTrends: the current partial bucket is flagged, and only that one", () => {
  const daily = agentRuntimeTrends("7d", "/proj/a", NOW);
  assert.deepEqual(
    daily.overall.filter((b) => b.partial).map((b) => b.bucketStart),
    ["2026-06-10T00:00:00.000Z"],
  );
  assert.equal(daily.overall.at(-1)!.partial, true);
  for (const roleSeries of daily.byRole) {
    assert.deepEqual(roleSeries.buckets.filter((b) => b.partial).map((b) => b.bucketStart), ["2026-06-10T00:00:00.000Z"]);
  }

  const hourly = agentRuntimeTrends("1d", "/proj/a", NOW);
  assert.deepEqual(hourly.overall.filter((b) => b.partial).map((b) => b.bucketStart), ["2026-06-10T14:00:00.000Z"]);
});

test("agentRuntimeTrends: overall combines every included role", () => {
  const trends = agentRuntimeTrends("7d", "/proj/a", NOW);
  const day = bucket(trends.overall, "2026-06-09T00:00:00.000Z")!;
  // 10s + 30s + 100s + 20s (child) + 40s (orchestrator planning) = 200s over 5 samples.
  assert.equal(day.sampleCount, 5);
  assert.equal(day.averageMs, 40_000);

  const perRoleOnThatDay = trends.byRole
    .map((s) => bucket(s.buckets, "2026-06-09T00:00:00.000Z")!.sampleCount)
    .reduce((sum, n) => sum + n, 0);
  assert.equal(perRoleOnThatDay, day.sampleCount);
});
