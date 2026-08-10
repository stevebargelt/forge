// FG-683: GET /api/completed-runs — the throughput sibling of /api/agent-runtime.
// Boots the real server against a seeded temp store, exactly like the other
// routes-*.integration tests, and pins that the two routes answer the SAME store
// with two different things: a count of RUNS and a mean of agent-TASK durations.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TEST_PORT = 18792;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const tmpHome = mkdtempSync(join(tmpdir(), "forge-completed-runs-route-"));

// One clock reading for the whole fixture — see routes-agent-runtime's note.
const SEEDED_AT = Date.now();
const iso = (msAgo: number) => new Date(SEEDED_AT - msAgo).toISOString();
const HOUR = 3_600_000;
const DAY = 86_400_000;

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT, completed_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  `);
  const insertRun = db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?)");
  const insertTask = db.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");

  // Counted. Two inside 1d, one more inside 7d, one only inside 90d/all.
  insertRun.run("r-1", "One", "feature", "/proj/main", "complete", iso(3 * HOUR), iso(2 * HOUR));
  insertRun.run("r-2", "Two", "invoke", "/proj/main", "complete", iso(2 * HOUR), iso(HOUR));
  insertRun.run("r-3", "Three", "review", "/proj/main", "complete", iso(4 * DAY), iso(3 * DAY));
  insertRun.run("r-4", "Four", "feature", "/proj/main", "complete", iso(61 * DAY), iso(60 * DAY));

  // Never counted: not complete, no completion stamp, and an orchestrator session.
  insertRun.run("r-active", "Active", "feature", "/proj/main", "active", iso(HOUR), null);
  insertRun.run("r-failed", "Failed", "feature", "/proj/main", "failed", iso(2 * DAY), iso(2 * DAY));
  insertRun.run("r-abandoned", "Abandoned", "feature", "/proj/main", "abandoned", iso(2 * DAY), iso(2 * DAY));
  insertRun.run("r-nostamp", "No stamp", "feature", "/proj/main", "complete", iso(2 * DAY), null);
  insertRun.run("r-orch", "Session", "orchestrator", "/proj/main", "complete", iso(2 * DAY), iso(DAY));

  // A different project, for the scope check.
  insertRun.run("r-other", "Other", "feature", "/proj/other", "complete", iso(2 * DAY), iso(DAY));

  // Six agent tasks under ONE counted run: the duration metric sees six samples
  // where this metric sees one completion. Both readings are correct, and the
  // route responses must not be confusable for one another.
  for (let i = 0; i < 6; i += 1) {
    insertTask.run(`t-${i}`, "r-1", "implementation", "engineer", "complete", null, iso(2 * HOUR + 60_000), iso(2 * HOUR));
  }
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

type CountBucket = { bucketStart: string; completedRuns: number; partial: boolean };
type CompletedRuns = {
  window: string;
  resolution: string;
  bucketMs: number;
  rangeStart: string | null;
  rangeEnd: string;
  buckets: CountBucket[];
  totalCompletedRuns: number;
};

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await fetch(`${BASE}/api/completed-runs?window=7d`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
  }
  throw new Error("completed-runs test server did not start");
}

await waitForServer();

const get = async (query: string): Promise<{ status: number; body: CompletedRuns }> => {
  const response = await fetch(`${BASE}/api/completed-runs${query}`);
  return { status: response.status, body: await response.json() as CompletedRuns };
};

test("GET /api/completed-runs returns integer per-bucket counts and a range total", async () => {
  const { status, body } = await get("?window=7d&projectDir=/proj/main");
  assert.equal(status, 200);
  assert.equal(body.window, "7d");
  assert.equal(body.resolution, "day");
  assert.equal(body.bucketMs, 86_400_000);
  assert.ok(body.rangeStart && Number.isFinite(Date.parse(body.rangeStart)));
  assert.ok(Number.isFinite(Date.parse(body.rangeEnd)));

  for (const point of body.buckets) {
    assert.equal(typeof point.bucketStart, "string");
    assert.equal(typeof point.completedRuns, "number");
    assert.equal(Number.isInteger(point.completedRuns), true, "a count is a whole number of runs");
    assert.notEqual(point.completedRuns, null, "an empty bucket is a zero, not a missing sample");
    assert.equal(typeof point.partial, "boolean");
  }
  const starts = body.buckets.map((point) => Date.parse(point.bucketStart));
  assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
  assert.equal(body.buckets.filter((point) => point.partial).length, 1);
  assert.equal(body.buckets.at(-1)!.partial, true);

  // r-1, r-2 (today, partial bucket) + r-3 (three days ago). r-4 is outside 7d.
  assert.equal(body.totalCompletedRuns, 3);
  assert.equal(body.buckets.at(-1)!.completedRuns, 2, "the partial bucket carries today's two completions");
  assert.equal(
    body.buckets.reduce((sum, point) => sum + point.completedRuns, 0),
    body.totalCompletedRuns,
    "the stated total is the sum of the plotted buckets, partial included",
  );
  assert.ok(body.buckets.some((point) => point.completedRuns === 0), "a day with no completions is present, at zero");
});

test("GET /api/completed-runs represents counts explicitly — never as a duration", async () => {
  const { body } = await get("?window=7d&projectDir=/proj/main");
  const point = body.buckets.at(-1)!;
  assert.deepEqual(Object.keys(point).sort(), ["bucketStart", "completedRuns", "partial"]);
  assert.equal("averageMs" in point, false, "a count may not ride on the duration field");
  assert.equal("sampleCount" in point, false, "the agent-task sample count is not this metric");
  assert.equal("byRole" in body, false);
  assert.equal("roleSummary" in body, false);
});

test("GET /api/completed-runs resolves each supported window at the runtime chart's resolution", async () => {
  const expected = [
    { window: "1d", resolution: "hour", bucketMs: 3_600_000, total: 2 },
    { window: "7d", resolution: "day", bucketMs: 86_400_000, total: 3 },
    { window: "30d", resolution: "day", bucketMs: 86_400_000, total: 3 },
    { window: "90d", resolution: "week", bucketMs: 604_800_000, total: 4 },
    { window: "all", resolution: "week", bucketMs: 604_800_000, total: 4 },
  ];
  for (const { window, resolution, bucketMs, total } of expected) {
    const { status, body } = await get(`?window=${window}&projectDir=/proj/main`);
    assert.equal(status, 200, window);
    assert.equal(body.window, window);
    assert.equal(body.resolution, resolution, window);
    assert.equal(body.bucketMs, bucketMs, window);
    assert.ok(body.buckets.length > 0, `${window} must produce buckets`);
    assert.equal(body.totalCompletedRuns, total, window);
    assert.equal(body.buckets.reduce((sum, point) => sum + point.completedRuns, 0), total, window);
    const starts = body.buckets.map((point) => Date.parse(point.bucketStart));
    for (let i = 1; i < starts.length; i += 1) {
      assert.equal(starts[i]! - starts[i - 1]!, bucketMs, `${window} buckets must be contiguous`);
    }
  }
});

test("GET /api/completed-runs defaults to 7d and rejects an unknown window", async () => {
  const { body } = await get("?projectDir=/proj/main");
  assert.equal(body.window, "7d");

  const response = await fetch(`${BASE}/api/completed-runs?window=nonsense`);
  assert.equal(response.status, 400);
  assert.match((await response.json() as { error: string }).error, /invalid window/);
});

test("GET /api/completed-runs honours the project scope filter", async () => {
  const scoped = await get("?window=30d&projectDir=/proj/other");
  assert.equal(scoped.body.totalCompletedRuns, 1);

  const main = await get("?window=30d&projectDir=/proj/main");
  assert.equal(main.body.totalCompletedRuns, 3, "another project's completions cannot move this one's total");

  const unscoped = await get("?window=30d");
  assert.equal(unscoped.body.totalCompletedRuns, 4);

  const missing = await get("?window=all&projectDir=/proj/does-not-exist");
  assert.equal(missing.body.rangeStart, null);
  assert.deepEqual(missing.body.buckets, []);
  assert.equal(missing.body.totalCompletedRuns, 0);
});

test("GET /api/agent-runtime is unchanged by the new metric — it still answers task durations", async () => {
  const response = await fetch(`${BASE}/api/agent-runtime?window=7d&projectDir=/proj/main`);
  assert.equal(response.status, 200);
  const body = await response.json() as {
    overall: Array<{ averageMs: number | null; sampleCount: number }>;
    roleSummary: Array<{ role: string; averageMs: number; sampleCount: number }>;
    totalCompletedRuns?: number;
  };
  // Six agent tasks under one run: the duration metric reports 6 samples where
  // /api/completed-runs reports 1 completion. Neither number is the other's.
  assert.deepEqual(body.roleSummary, [{ role: "engineer", averageMs: 60_000, sampleCount: 6 }]);
  assert.equal(body.overall.reduce((sum, point) => sum + point.sampleCount, 0), 6);
  assert.ok(body.overall.some((point) => point.sampleCount === 0 && point.averageMs === null),
    "the duration metric still reports an empty bucket as a missing sample");
  assert.equal(body.totalCompletedRuns, undefined, "the duration response gains no count field");
});
