// FG-648: GET /api/agent-runtime — response shape for overall + per-role +
// summary, across every supported window. Boots the real server against a
// seeded temp store, exactly like the other routes-*.integration tests.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18791;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tmpHome = mkdtempSync(join(tmpdir(), "forge-runtime-route-"));

const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  `);
  const insertRun = db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)");
  const insertTask = db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  insertRun.run("r-main", "Main", "feature", "/proj/main", "complete", iso(80 * DAY));
  insertRun.run("r-other", "Other", "feature", "/proj/other", "complete", iso(2 * DAY));

  // Inside every window, including 1d.
  insertTask.run("t-eng-recent", "r-main", "implementation", "engineer", "complete", null, iso(2 * HOUR + 60_000), iso(2 * HOUR));
  // Inside 7d/30d/90d/all but outside 1d.
  insertTask.run("t-eng-3d", "r-main", "implementation", "engineer", "failed", null, iso(3 * DAY + 30_000), iso(3 * DAY));
  insertTask.run("t-red-3d", "r-main", "review", "red-wide", "complete", null, iso(3 * DAY + 120_000), iso(3 * DAY));
  // Inside 90d/all only.
  insertTask.run("t-eng-60d", "r-main", "implementation", "engineer", "complete", null, iso(60 * DAY + 600_000), iso(60 * DAY));
  // Never included: an interactive orchestrator session, an active task, a negative duration.
  insertTask.run("t-session", "r-main", "session", "orchestrator", "complete", null, iso(3 * DAY + 6 * HOUR), iso(3 * DAY));
  insertTask.run("t-active", "r-main", "implementation", "engineer", "running", null, iso(HOUR), null);
  insertTask.run("t-negative", "r-main", "implementation", "engineer", "complete", null, iso(2 * DAY), iso(2 * DAY + 60_000));
  // A different project, for the scope check.
  insertTask.run("t-other", "r-other", "implementation", "test-engineer", "complete", null, iso(DAY + 900_000), iso(DAY));
  db.close();
}

process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { server } = await import("./server.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
});

type Bucket = { bucketStart: string; averageMs: number | null; sampleCount: number; partial: boolean };
type Trends = {
  window: string;
  resolution: string;
  bucketMs: number;
  rangeStart: string | null;
  rangeEnd: string;
  overall: Bucket[];
  byRole: Array<{ role: string; buckets: Bucket[] }>;
  roleSummary: Array<{ role: string; averageMs: number; sampleCount: number }>;
};

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/agent-runtime?window=7d`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("agent-runtime test server did not start");
}

await waitForServer();

const get = async (query: string): Promise<{ status: number; body: Trends }> => {
  const response = await fetch(`${BASE}/api/agent-runtime${query}`);
  return { status: response.status, body: await response.json() as Trends };
};

test("GET /api/agent-runtime returns overall buckets, per-role buckets, and a per-role summary", async () => {
  const { status, body } = await get("?window=7d&projectDir=/proj/main");
  assert.equal(status, 200);
  assert.equal(body.window, "7d");
  assert.equal(body.resolution, "day");
  assert.equal(body.bucketMs, 86_400_000);
  assert.ok(body.rangeStart && Number.isFinite(Date.parse(body.rangeStart)));
  assert.ok(Number.isFinite(Date.parse(body.rangeEnd)));

  for (const point of body.overall) {
    assert.equal(typeof point.bucketStart, "string");
    assert.equal(typeof point.sampleCount, "number");
    assert.equal(typeof point.partial, "boolean");
    assert.equal(point.sampleCount === 0 ? point.averageMs : typeof point.averageMs, point.sampleCount === 0 ? null : "number");
  }
  const starts = body.overall.map((point) => Date.parse(point.bucketStart));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.deepEqual(body.overall.filter((point) => point.partial).length, 1);
  assert.equal(body.overall.at(-1)!.partial, true);

  // Every role observed in the window has a series over the SAME bucket grid.
  assert.deepEqual(body.roleSummary.map((row) => row.role), ["engineer", "red-wide"]);
  assert.deepEqual(body.byRole.map((series) => series.role), body.roleSummary.map((row) => row.role));
  for (const series of body.byRole) {
    assert.deepEqual(series.buckets.map((point) => point.bucketStart), body.overall.map((point) => point.bucketStart));
  }

  const engineer = body.roleSummary.find((row) => row.role === "engineer")!;
  assert.equal(engineer.sampleCount, 2, "one successful + one failed engineer task");
  assert.equal(engineer.averageMs, 45_000);
  assert.deepEqual(body.roleSummary.find((row) => row.role === "red-wide"), { role: "red-wide", averageMs: 120_000, sampleCount: 1 });
  assert.equal(body.roleSummary.some((row) => row.role === "orchestrator"), false, "interactive sessions are excluded");

  const overallSamples = body.overall.reduce((sum, point) => sum + point.sampleCount, 0);
  assert.equal(overallSamples, 3, "overall is every included role combined");
});

test("GET /api/agent-runtime resolves each supported window at its documented resolution", async () => {
  const expected = [
    { window: "1d", resolution: "hour", bucketMs: 3_600_000, samples: 1 },
    { window: "7d", resolution: "day", bucketMs: 86_400_000, samples: 3 },
    { window: "30d", resolution: "day", bucketMs: 86_400_000, samples: 3 },
    { window: "90d", resolution: "week", bucketMs: 604_800_000, samples: 4 },
    { window: "all", resolution: "week", bucketMs: 604_800_000, samples: 4 },
  ];
  for (const { window, resolution, bucketMs, samples } of expected) {
    const { status, body } = await get(`?window=${window}&projectDir=/proj/main`);
    assert.equal(status, 200, window);
    assert.equal(body.window, window);
    assert.equal(body.resolution, resolution, window);
    assert.equal(body.bucketMs, bucketMs, window);
    assert.ok(body.overall.length > 0, `${window} must produce buckets`);
    assert.equal(body.overall.reduce((sum, point) => sum + point.sampleCount, 0), samples, window);
    const starts = body.overall.map((point) => Date.parse(point.bucketStart));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${window} must ascend`);
    for (let i = 1; i < starts.length; i += 1) {
      assert.equal(starts[i]! - starts[i - 1]!, bucketMs, `${window} buckets must be contiguous`);
    }
    assert.ok(body.overall.every((point) => point.sampleCount > 0 || point.averageMs === null), `${window} must not invent zero durations`);
  }
});

test("GET /api/agent-runtime defaults to 7d and rejects an unknown window", async () => {
  const { body } = await get("?projectDir=/proj/main");
  assert.equal(body.window, "7d");

  const response = await fetch(`${BASE}/api/agent-runtime?window=nonsense`);
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /invalid window/);
});

test("GET /api/agent-runtime honours the project scope filter", async () => {
  const scoped = await get("?window=30d&projectDir=/proj/other");
  assert.deepEqual(scoped.body.roleSummary.map((row) => row.role), ["test-engineer"]);

  const unscoped = await get("?window=30d");
  assert.deepEqual(unscoped.body.roleSummary.map((row) => row.role).sort(), ["engineer", "red-wide", "test-engineer"]);

  const missing = await get("?window=all&projectDir=/proj/does-not-exist");
  assert.equal(missing.body.rangeStart, null);
  assert.deepEqual(missing.body.overall, []);
  assert.deepEqual(missing.body.byRole, []);
  assert.deepEqual(missing.body.roleSummary, []);
});
