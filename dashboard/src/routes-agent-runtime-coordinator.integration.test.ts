// FG-725: prove the coordinator-parent eligibility rule through the dashboard
// HTTP route and the production SQLite schema. A fanout parent can have a real
// agent role and a late gate completion without ever owning an agent container;
// it must not become a multi-day runtime sample in any serialized projection.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const PORT = 18806;
const BASE = `http://127.0.0.1:${PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-runtime-coordinator-route-"));
const forgeHome = join(testHome, ".forge");
const scanRoots = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoots, { recursive: true });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const PROJECT = "/proj/fg-725";
// Keep the fixture's completion days stable even when the suite starts near a
// UTC boundary; the route reads this test-only clock too.
const realDateNow = Date.now;
const NOW = Date.parse("2026-08-16T12:00:00.000Z");
Date.now = () => NOW;
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const dayBucket = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString();

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const run = database.prepare(
    "INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)",
  );
  const task = database.prepare(`
    INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, status, task_package, created_at, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `);
  const event = database.prepare(
    "INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)",
  );
  const addTask = (
    id: string, role: string, completedAgo: number, duration: number, parentId: string | null = null,
    status = "complete",
  ) => task.run(
    id, "r-coordinator", parentId, "implementation", role, status, "{}",
    ago(30 * DAY), ago(completedAgo + duration), ago(completedAgo),
  );
  const container = (taskId: string, startedAgo: number, exitedAgo: number) => {
    event.run("r-coordinator", taskId, "container.started", JSON.stringify({ containerName: taskId }), ago(startedAgo));
    event.run("r-coordinator", taskId, "container.exited", JSON.stringify({ exitCode: 0 }), ago(exitedAgo));
  };

  run.run("r-coordinator", "feature", "FG-725 fanout", "complete", ago(30 * DAY), PROJECT);

  // The observed production shape: the coordinator dispatched several children,
  // then remained awaiting a human gate for days. Its terminal task row looks
  // like a normal agent row, but it never owned a container of its own.
  addTask("fanout-parent", "build-coordinator", 1 * DAY, 4 * DAY + 3 * HOUR);
  event.run("r-coordinator", "fanout-parent", "task.awaiting_gate", JSON.stringify({ gate: "human" }), ago(4 * DAY));
  event.run("r-coordinator", "fanout-parent", "task.completed", JSON.stringify({ advancedBy: "gate" }), ago(1 * DAY));

  // The children are the only executions attributable to this fanout. They
  // intentionally share a role and completion day so their count and mean are
  // directly visible in both the aggregate and role chart series.
  addTask("fanout-child-a", "engineer", 2 * DAY, 10 * MINUTE, "fanout-parent");
  container("fanout-child-a", 2 * DAY + 10 * MINUTE, 2 * DAY);
  addTask("fanout-child-b", "engineer", 2 * DAY + 2 * HOUR, 15 * MINUTE, "fanout-parent");
  container("fanout-child-b", 2 * DAY + 2 * HOUR + 15 * MINUTE, 2 * DAY + 2 * HOUR);
  addTask("fanout-child-c", "engineer", 2 * DAY + 4 * HOUR, 20 * MINUTE, "fanout-parent");
  container("fanout-child-c", 2 * DAY + 4 * HOUR + 20 * MINUTE, 2 * DAY + 4 * HOUR);

  // Layer 2 remains intentional for genuine historical leaf data: no child,
  // no attached exit, and a non-administrative terminal failure still uses its
  // completed_at duration.
  addTask("legacy-leaf", "legacy-agent", 3 * DAY, 25 * MINUTE, null, "failed");
  event.run("r-coordinator", "legacy-leaf", "task.failed", JSON.stringify({ failure_kind: "container_crash" }), ago(3 * DAY));
  database.close();
}

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoots;
process.env.PORT = String(PORT);
process.env.HOST = "127.0.0.1";

const { server } = await import("./server.js");
after(() => { server.closeAllConnections?.(); server.close(); Date.now = realDateNow; });

type Bucket = { bucketStart: string; averageMs: number | null; sampleCount: number; partial: boolean };
type Trends = {
  overall: Bucket[];
  byRole: Array<{ role: string; buckets: Bucket[] }>;
  roleSummary: Array<{ role: string; averageMs: number; sampleCount: number }>;
};
const total = (buckets: readonly Bucket[]) => buckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0);
const at = (buckets: readonly Bucket[], bucketStart: string) => {
  const bucket = buckets.find((candidate) => candidate.bucketStart === bucketStart);
  assert.ok(bucket, `missing bucket ${bucketStart}`);
  return bucket;
};
async function get(): Promise<Trends> {
  const response = await fetch(`${BASE}/api/agent-runtime?window=7d&projectDir=${PROJECT}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<Trends>;
}
async function waitForServer(): Promise<void> {
  for (let i = 0; i < 75; i += 1) {
    try { await get(); return; } catch { await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  throw new Error("agent-runtime coordinator route server did not start");
}
await waitForServer();

test("a non-container fanout coordinator is absent from every route projection while its children retain their runtimes", async () => {
  const body = await get();

  // The late parent would be a 99-hour sample on its own completion day. Its
  // role must disappear completely, while the three short children and one
  // legacy leaf are the only samples that reach the aggregate wire payload.
  assert.deepEqual(body.roleSummary, [
    { role: "engineer", averageMs: 15 * MINUTE, sampleCount: 3 },
    { role: "legacy-agent", averageMs: 25 * MINUTE, sampleCount: 1 },
  ]);
  assert.equal(total(body.overall), 4, "overall counts children plus the genuine legacy leaf, never the parent");
  assert.equal(body.roleSummary.some((row) => row.role === "build-coordinator"), false);

  // The chart's text-equivalent summary and its role series agree exactly; no
  // hidden role series can carry the coordinator's duration or sample count.
  assert.deepEqual(body.byRole.map((series) => series.role), ["engineer", "legacy-agent"]);
  for (const summary of body.roleSummary) {
    const series = body.byRole.find((candidate) => candidate.role === summary.role);
    assert.ok(series, `${summary.role} must have a chart series`);
    assert.equal(total(series.buckets), summary.sampleCount, `${summary.role} samples survive identically in chart and summary`);
  }

  const childDay = at(body.overall, dayBucket(NOW - (2 * DAY + 4 * HOUR)));
  assert.deepEqual(
    { averageMs: childDay.averageMs, sampleCount: childDay.sampleCount },
    { averageMs: 15 * MINUTE, sampleCount: 3 },
    "the children retain their short measured durations in the overall chart",
  );
  const engineer = body.byRole.find((series) => series.role === "engineer")!;
  assert.deepEqual(
    (() => { const bucket = at(engineer.buckets, childDay.bucketStart); return { averageMs: bucket.averageMs, sampleCount: bucket.sampleCount }; })(),
    { averageMs: 15 * MINUTE, sampleCount: 3 },
    "the same child-only sample count and mean reach the per-role chart",
  );

  const parentDay = at(body.overall, dayBucket(NOW - DAY));
  assert.equal(parentDay.sampleCount, 0, "the parent's late gate completion adds no overall sample");
  assert.equal(parentDay.averageMs, null, "the parent's 99-hour wait adds no overall duration");
  assert.equal(total(body.byRole.find((series) => series.role === "legacy-agent")!.buckets), 1, "the no-child legacy leaf still reaches layer 2");
});
