// FG-690 integration coverage: assert the route's complete serialized contract,
// rather than calling agentRuntimeTrends() directly.  A failed Docker start must
// be absent from every derived view (overall, role series, and summary), while
// legacy no-exit observations retain their deliberate completed_at fallback.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const PORT = 18802;
const BASE = `http://127.0.0.1:${PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-runtime-start-route-"));
const forgeHome = join(testHome, ".forge");
const scanRoots = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoots, { recursive: true });

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const PROJECT = "/proj/fg-690";
const OTHER_PROJECT = "/proj/other";
// FG-709: accept a test-only clock position so this HTTP integration flow can
// be proven at every UTC hour without changing the production route's clock.
// The oldest relative fixture (the run/task created_at) sits 50 days back; a
// configured clock earlier than that pushes fixtures before the epoch. Refuse
// such a clock loudly (RF-1) rather than fall back or produce a misleading red
// — Number("") is 0, so an empty-string value is refused too.
const OLDEST_FIXTURE_AGO = 50 * DAY;
const realDateNow = Date.now;
const rawConfiguredNow = process.env.FG_709_TEST_NOW;
let NOW = realDateNow();
if (rawConfiguredNow !== undefined) {
  const configuredNow = Number(rawConfiguredNow);
  if (!Number.isFinite(configuredNow) || configuredNow < OLDEST_FIXTURE_AGO) {
    throw new Error(
      `FG_709_TEST_NOW must be a finite epoch-ms instant at least ${OLDEST_FIXTURE_AGO} ms ` +
        `after the epoch (${OLDEST_FIXTURE_AGO / DAY} days, this file's oldest fixture); ` +
        `got ${JSON.stringify(rawConfiguredNow)}`,
    );
  }
  NOW = configuredNow;
  Date.now = () => NOW;
}
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const day = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString();
const TODAY_START = Math.floor(NOW / DAY) * DAY;
// Current-day fixtures must not be future-dated at the route's clock.  The
// route can read its clock after this module does in normal runs, so clamping
// against this earlier reading keeps the completion in today's bucket and at
// or before the route's now even at UTC midnight.
const completedToday = (msBeforeNow: number) => new Date(Math.max(TODAY_START, NOW - msBeforeNow)).toISOString();

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const run = database.prepare(
    "INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)",
  );
  const task = database.prepare(`
    INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  const event = database.prepare(
    "INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)",
  );
  const addTask = (id: string, role: string, completedAgo: number, duration: number, status = "complete") =>
    task.run(id, "r-main", "implementation", role, status, "{}", ago(50 * DAY), ago(completedAgo + duration), ago(completedAgo));
  const addTaskAt = (id: string, role: string, completedAt: string, duration: number, status = "complete") =>
    task.run(id, "r-main", "implementation", role, status, "{}", ago(50 * DAY), new Date(Date.parse(completedAt) - duration).toISOString(), completedAt);
  const started = (id: string, atAgo: number) =>
    event.run("r-main", id, "container.started", JSON.stringify({ containerName: id }), ago(atAgo));
  const exited = (id: string, atAgo: number, type = "container.exited") =>
    event.run("r-main", id, type, JSON.stringify({ exitCode: 1 }), ago(atAgo));
  const failed = (id: string, atAgo: number, kind: string) =>
    event.run("r-main", id, "task.failed", JSON.stringify({ failure_kind: kind }), ago(atAgo));

  run.run("r-main", "feature", "FG-690", "complete", ago(50 * DAY), PROJECT);
  run.run("r-other", "feature", "Other", "complete", ago(50 * DAY), OTHER_PROJECT);

  // Same UTC-day bucket and role: only this one genuinely executed. Clamp the
  // completion into today's elapsed portion; its start may precede midnight.
  const realRedCompletedAt = completedToday(1);
  addTaskAt("real-red", "red-wide", realRedCompletedAt, 84_000);
  event.run("r-main", "real-red", "container.started", JSON.stringify({ containerName: "real-red" }), new Date(Date.parse(realRedCompletedAt) - 84_000).toISOString());
  event.run("r-main", "real-red", "container.exited", JSON.stringify({ exitCode: 1 }), realRedCompletedAt);
  addTask("phantom-red", "red-wide", 90 * MINUTE, 5 * HOUR + 21 * MINUTE, "failed");
  exited("phantom-red", 90 * MINUTE);
  failed("phantom-red", 90 * MINUTE, "container_crash");
  addTask("real-engineer", "engineer", 2 * DAY, 10 * MINUTE);
  started("real-engineer", 2 * DAY + 10 * MINUTE);
  exited("real-engineer", 2 * DAY);
  // The oldest surviving observation determines the scoped `all` start; the
  // older failed start must not stretch it.
  addTask("old-real", "engineer", 10 * DAY, 15 * MINUTE);
  started("old-real", 10 * DAY + 15 * MINUTE);
  exited("old-real", 10 * DAY);
  addTask("ancient-phantom", "red-narrow", 40 * DAY, 5 * HOUR, "failed");
  exited("ancient-phantom", 40 * DAY);
  failed("ancient-phantom", 40 * DAY, "container_crash");

  // No exit is historical fallback territory: start evidence is intentionally
  // irrelevant, while the established administrative guards still apply.
  addTask("legacy-fallback", "tech-lead", 3 * DAY, 40 * MINUTE, "failed");
  failed("legacy-fallback", 3 * DAY, "container_crash");
  addTask("legacy-admin", "red-backend", 3 * DAY, 4 * HOUR, "failed");
  failed("legacy-admin", 3 * DAY, "pre_container_crash");
  addTask("legacy-reconciled", "red-security", 3 * DAY, 4 * HOUR);
  event.run("r-main", "legacy-reconciled", "task.reconciled", JSON.stringify({ from: "running", to: "complete" }), ago(3 * DAY));

  // A retry keeps the old stream but moves started_at. This current attempt
  // failed before Docker created a container and must disappear.
  addTask("retry-no-start", "documentation-maintainer", 4 * DAY, 5 * HOUR, "failed");
  started("retry-no-start", 8 * DAY);
  exited("retry-no-start", 8 * DAY - 10 * MINUTE);
  exited("retry-no-start", 4 * DAY);
  failed("retry-no-start", 4 * DAY, "container_crash");
  addTask("retry-real", "test-engineer", 4 * DAY, 45 * MINUTE);
  started("retry-real", 8 * DAY);
  exited("retry-real", 8 * DAY - 10 * MINUTE);
  started("retry-real", 4 * DAY + 45 * MINUTE);
  exited("retry-real", 4 * DAY);

  // The other re-dispatch race: the PRIOR attempt's container tears down inside
  // the new attempt's window, so its exit lands after the moved started_at while
  // this attempt's own container starts later still. The stale exit must neither
  // end the attempt nor be authorized by a start that follows it — and where the
  // attempt then really runs, its own exit still supplies the duration.
  addTask("stale-exit-late-start", "backend-specialist", 6 * DAY, 2 * HOUR, "failed");
  started("stale-exit-late-start", 6 * DAY + 3 * HOUR);
  exited("stale-exit-late-start", 6 * DAY + 2 * HOUR - 5 * MINUTE);
  started("stale-exit-late-start", 6 * DAY + 2 * HOUR - 10 * MINUTE);
  failed("stale-exit-late-start", 6 * DAY, "container_crash");
  addTask("stale-exit-then-real", "frontend-specialist", 6 * DAY, 40 * MINUTE);
  started("stale-exit-then-real", 6 * DAY + 90 * MINUTE);
  exited("stale-exit-then-real", 6 * DAY + 40 * MINUTE - 5 * MINUTE);
  started("stale-exit-then-real", 6 * DAY + 40 * MINUTE - 10 * MINUTE);
  exited("stale-exit-then-real", 6 * DAY);

  // Four FG-654 lens failures share a Docker outage, alongside a genuine run.
  for (const role of ["red-wide", "red-narrow", "red-backend", "red-security"]) {
    addTask(`wave-${role}`, role, 5 * DAY, 5 * HOUR + 21 * MINUTE, "failed");
    exited(`wave-${role}`, 5 * DAY);
    failed(`wave-${role}`, 5 * DAY, "container_crash");
  }
  addTask("wave-real", "engineer", 5 * DAY, 2 * MINUTE);
  started("wave-real", 5 * DAY + 2 * MINUTE);
  exited("wave-real", 5 * DAY);

  task.run("other-real", "r-other", "implementation", "other-role", "complete", "{}", ago(50 * DAY), ago(30 * DAY + MINUTE), ago(30 * DAY));
  event.run("r-other", "other-real", "container.started", "{}", ago(30 * DAY + MINUTE));
  event.run("r-other", "other-real", "container.exited", "{}", ago(30 * DAY));
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
  rangeStart: string | null; rangeEnd: string; overall: Bucket[];
  byRole: Array<{ role: string; buckets: Bucket[] }>;
  roleSummary: Array<{ role: string; averageMs: number; sampleCount: number }>;
};
const total = (buckets: readonly Bucket[]) => buckets.reduce((sum, bucket) => sum + bucket.sampleCount, 0);
const bucketAt = (buckets: readonly Bucket[], bucketStart: string) => {
  const found = buckets.find((bucket) => bucket.bucketStart === bucketStart);
  assert.ok(found, `missing bucket ${bucketStart}`);
  return found;
};
async function get(query: string): Promise<Trends> {
  const response = await fetch(`${BASE}/api/agent-runtime${query}`);
  assert.equal(response.status, 200);
  return response.json() as Promise<Trends>;
}
async function waitForServer(): Promise<void> {
  for (let i = 0; i < 75; i += 1) {
    try { await get("?window=7d"); return; } catch { await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  throw new Error("agent-runtime start-evidence route server did not start");
}
await waitForServer();

test("failed starts vanish consistently from every served aggregate while a same-role execution remains", async () => {
  const body = await get(`?window=7d&projectDir=${PROJECT}`);
  assert.deepEqual(body.roleSummary, [
    { role: "engineer", averageMs: 6 * MINUTE, sampleCount: 2 },
    { role: "frontend-specialist", averageMs: 40 * MINUTE, sampleCount: 1 },
    { role: "red-wide", averageMs: 84_000, sampleCount: 1 },
    { role: "tech-lead", averageMs: 40 * MINUTE, sampleCount: 1 },
    { role: "test-engineer", averageMs: 45 * MINUTE, sampleCount: 1 },
  ]);
  assert.deepEqual(body.byRole.map((series) => series.role), body.roleSummary.map((row) => row.role));
  assert.equal(total(body.overall), 6, "no phantom survives in the overall series");
  for (const summary of body.roleSummary) {
    const series = body.byRole.find((candidate) => candidate.role === summary.role)!;
    assert.equal(total(series.buckets), summary.sampleCount, `${summary.role} series and summary agree`);
  }
  const sameDay = day(TODAY_START);
  assert.deepEqual(bucketAt(body.overall, sameDay), {
    bucketStart: sameDay, averageMs: 84_000, sampleCount: 1, partial: bucketAt(body.overall, sameDay).partial,
  });
  assert.equal(bucketAt(body.byRole.find((series) => series.role === "red-wide")!.buckets, sameDay).averageMs, 84_000);
});

test("excluding failed starts leaves the surviving grid, partial marker, all range, and project scope intact", async () => {
  const scoped = await get(`?window=all&projectDir=${PROJECT}`);
  assert.ok(scoped.rangeStart);
  const oldestDay = Math.floor((NOW - 10 * DAY) / DAY);
  const expectedStart = (oldestDay - ((oldestDay + 3) % 7)) * DAY;
  assert.equal(Date.parse(scoped.rangeStart!), expectedStart, "an ancient phantom cannot open all history");
  assert.equal(scoped.overall.at(-1)!.partial, true);
  assert.equal(scoped.overall.filter((bucket) => bucket.partial).length, 1);
  for (const series of scoped.byRole) assert.deepEqual(series.buckets.map((bucket) => bucket.bucketStart), scoped.overall.map((bucket) => bucket.bucketStart));
  assert.ok(!scoped.roleSummary.some((row) => row.role === "other-role"));

  const unscoped = await get("?window=all");
  assert.ok(unscoped.roleSummary.some((row) => row.role === "other-role"), "unscoped keeps another project's real execution");
  assert.ok(Date.parse(unscoped.rangeStart!) < Date.parse(scoped.rangeStart!), "scope still controls canonical aggregate history");
});

test("no-exit historical fallback and its administrative guards survive the route boundary", async () => {
  const body = await get(`?window=7d&projectDir=${PROJECT}`);
  assert.deepEqual(body.roleSummary.find((row) => row.role === "tech-lead"), { role: "tech-lead", averageMs: 40 * MINUTE, sampleCount: 1 });
  assert.equal(body.roleSummary.some((row) => row.role === "red-backend"), false);
  assert.equal(body.roleSummary.some((row) => row.role === "red-security"), false);
});

test("retries and the four-lens Docker outage cannot inflate the route, but genuine attempts still count", async () => {
  const body = await get(`?window=7d&projectDir=${PROJECT}`);
  assert.equal(body.roleSummary.some((row) => row.role === "documentation-maintainer"), false, "prior attempt start cannot authorize retry exit");
  assert.deepEqual(body.roleSummary.find((row) => row.role === "test-engineer"), { role: "test-engineer", averageMs: 45 * MINUTE, sampleCount: 1 });
  const outageDay = day(NOW - 5 * DAY);
  assert.deepEqual(bucketAt(body.overall, outageDay), {
    bucketStart: outageDay, averageMs: 2 * MINUTE, sampleCount: 1, partial: false,
  }, "only the genuine execution in the FG-654 bucket remains");
});

test("a stale exit inside the new attempt's window is never its end, whether or not the attempt then runs", async () => {
  const body = await get(`?window=7d&projectDir=${PROJECT}`);
  assert.equal(
    body.roleSummary.some((row) => row.role === "backend-specialist"), false,
    "a start recorded after the exit does not authorize it, and the row does not fall back to completed_at",
  );
  assert.deepEqual(
    body.roleSummary.find((row) => row.role === "frontend-specialist"),
    { role: "frontend-specialist", averageMs: 40 * MINUTE, sampleCount: 1 },
    "and the attempt's own exit still supplies its duration — not the 35 minutes the stale one would have",
  );
  const raceDay = day(NOW - 6 * DAY);
  assert.deepEqual(bucketAt(body.overall, raceDay), {
    bucketStart: raceDay, averageMs: 40 * MINUTE, sampleCount: 1, partial: false,
  }, "one observation in that bucket, at the real duration");
});
