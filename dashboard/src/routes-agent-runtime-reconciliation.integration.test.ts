// FG-662 verify: the agent-observed-end rule over the WIRE, against the
// production SCHEMA_SQL tables.
//
// Everything else that covers FG-662 calls agentRuntimeTrends() directly against
// a hand-rolled five-column `events` table. That leaves the part that actually
// ships unproven:
//
//   - the two correlated subqueries the rule added (MIN over the attached-exit
//     types, and the payload of the latest task.failed) resolving against the
//     real events table forge writes — the one with NOT NULL columns and the
//     idx_events_task / idx_events_type_created indexes over it;
//   - the corrected durations, the excluded rows and the roles that disappear
//     with them surviving JSON serialization out of /api/agent-runtime;
//   - an emptied bucket keeping an explicit `"averageMs": null` on the wire
//     rather than vanishing as an undefined;
//   - the derived `all` start over HTTP being the oldest SURVIVING observation's
//     week, with a much older artifact in the same scope.
//
// FG-690 adds the start-evidence half to the same fixture: an EXISTS over
// `container.started`, bounded at started_at, against the real events table. The
// failed-Docker-start row below is seeded INSIDE the window and among the real
// rows precisely so that it must change none of the assertions above.
//
// Mirrors routes-agent-runtime-edges.integration.test.ts: real server, real
// schema, one clock reading for the whole fixture.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18795;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-runtime-recon-route-"));
const forgeHome = join(testHome, ".forge");
const scanRoots = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoots, { recursive: true });

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

const PROJECT = "/proj/recon";

// One clock reading for the whole fixture: two rows written "3 days ago" must be
// the SAME instant, or a bucket assertion can straddle a midnight and flake.
const SEEDED_AT = Date.now();
const ago = (ms: number) => new Date(SEEDED_AT - ms).toISOString();
const dayBucket = (ms: number) => new Date(Math.floor(ms / DAY) * DAY).toISOString();

// The oldest observation that survives the rule: the gate-rejected row that
// finished 3 days ago. The 40-day-old artifact must not open the range.
const OLDEST_SURVIVING_MS = SEEDED_AT - 3 * DAY;

{
  const database = new Database(join(forgeHome, "forge.db"));
  database.exec(SCHEMA_SQL);
  const insertRun = database.prepare(
    "INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?,?,?,?,?,?)",
  );
  const insertTask = database.prepare(`
    INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?)
  `);
  const insertEvent = database.prepare(
    "INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)",
  );

  insertRun.run("r-recon", "feature", "Recon", "complete", ago(60 * DAY), PROJECT);
  insertRun.run("r-other", "feature", "Other", "complete", ago(2 * DAY), "/proj/other");

  /** A task ending `completedMsAgo` ago after `spanMs` of wall clock. */
  const task = (
    id: string, runId: string, role: string, status: string, completedMsAgo: number, spanMs: number,
  ) => {
    insertTask.run(
      id, runId, "implementation", role, status, "{}",
      ago(60 * DAY), ago(completedMsAgo + spanMs), ago(completedMsAgo),
    );
  };
  const failedEvent = (runId: string, taskId: string, kind: string, msAgo: number) =>
    insertEvent.run(runId, taskId, "task.failed", JSON.stringify({ failure_kind: kind, error: kind }), ago(msAgo));

  // Real supervised runs — the baseline the corrected chart is supposed to show.
  // FG-690: each carries the container.started that authorizes reading its exit.
  task("t-real", "r-recon", "engineer", "complete", 2 * HOUR, 10 * MINUTE);
  insertEvent.run("r-recon", "t-real", "container.started", JSON.stringify({ containerName: "forge-t-real" }), ago(2 * HOUR + 10 * MINUTE));
  insertEvent.run("r-recon", "t-real", "container.exited", JSON.stringify({ exitCode: 0 }), ago(2 * HOUR));
  task("t-crash", "r-recon", "engineer", "failed", 4 * HOUR, 5 * MINUTE);
  insertEvent.run("r-recon", "t-crash", "container.started", JSON.stringify({ containerName: "forge-t-crash" }), ago(4 * HOUR + 5 * MINUTE));
  insertEvent.run("r-recon", "t-crash", "container.exited", JSON.stringify({ exitCode: 1 }), ago(4 * HOUR));
  failedEvent("r-recon", "t-crash", "container_crash", 4 * HOUR);

  // Cancelled 30 days after it started, with no container event anywhere: no
  // defensible end, so the 30-day span never reaches the average.
  task("t-abandoned", "r-recon", "engineer", "failed", 3 * HOUR, 30 * DAY);
  failedEvent("r-recon", "t-abandoned", "cancelled", 3 * HOUR);

  // Ran 20 minutes 5 days ago; the gate rejection rewrote completed_at two days
  // later. Counts, at 20 minutes, in the bucket its completed_at falls in.
  task("t-late-reject", "r-recon", "tech-lead", "failed", 3 * DAY, 2 * DAY);
  insertEvent.run("r-recon", "t-late-reject", "container.started", JSON.stringify({ containerName: "forge-t-late-reject" }), ago(5 * DAY));
  insertEvent.run("r-recon", "t-late-reject", "container.exited", JSON.stringify({ exitCode: 0 }), ago(5 * DAY - 20 * MINUTE));
  failedEvent("r-recon", "t-late-reject", "gate_rejected", 3 * DAY);

  // FG-690: `docker run` never produced a container, but runContainer still logged
  // container.exited after 5h21m of an unresolved Docker connect. No
  // container.started, so nothing here is agent runtime — and, its terminal being
  // a SUPERVISED kind, layer 2 would return the same interval if the row fell
  // through to it rather than being dropped.
  task("t-phantom", "r-recon", "red-narrow", "failed", 90 * MINUTE, 5 * HOUR + 21 * MINUTE);
  insertEvent.run("r-recon", "t-phantom", "container.exited", JSON.stringify({ exitCode: 1 }), ago(90 * MINUTE));
  failedEvent("r-recon", "t-phantom", "container_crash", 90 * MINUTE);

  // `forge cancel` logs container.killed around a blind docker kill. It is not
  // agent-observed evidence, so this row — and its whole role — must be gone.
  task("t-killed", "r-recon", "red-wide", "failed", 5 * HOUR, 100 * HOUR);
  insertEvent.run("r-recon", "t-killed", "container.killed", JSON.stringify({ via: "forge cancel" }), ago(5 * HOUR));
  failedEvent("r-recon", "t-killed", "cancelled", 5 * HOUR);

  // Far older than everything real, and excluded — it must not open `all`.
  task("t-ancient", "r-recon", "engineer", "failed", 40 * DAY, 300 * HOUR);
  failedEvent("r-recon", "t-ancient", "orphaned", 40 * DAY);

  // A second project, so nothing above can be satisfied by an unscoped read.
  task("o-real", "r-other", "engineer", "complete", 6 * HOUR, 30 * MINUTE);
  database.close();
}

process.env.HOME = testHome;
process.env.FORGE_HOME = forgeHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = scanRoots;
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
  throw new Error("agent-runtime reconciliation test server did not start");
}

await waitForServer();

const get = async (query: string): Promise<{ status: number; body: Trends }> => {
  const response = await fetch(`${BASE}/api/agent-runtime${query}`);
  return { status: response.status, body: await response.json() as Trends };
};

const totalSamples = (buckets: readonly Bucket[]) => buckets.reduce((sum, point) => sum + point.sampleCount, 0);
const at = (buckets: readonly Bucket[], iso: string): Bucket => {
  const found = buckets.find((point) => point.bucketStart === iso);
  assert.ok(found, `no bucket at ${iso}; got ${buckets.map((b) => b.bucketStart).join(", ")}`);
  return found;
};

test("the correlated exit/failure subqueries resolve against the production schema and reach the wire", async () => {
  const { status, body } = await get(`?window=7d&projectDir=${PROJECT}`);
  assert.equal(status, 200);
  assert.equal(body.resolution, "day");

  // engineer: 10min + 5min over two rows — the 30-day cancellation is not in it.
  // tech-lead: the 20 minutes its container ran, not the 2 days on its books.
  // red-wide: container.killed is not an end, so the role has no observations
  // at all and disappears from the payload rather than reporting a 100h average.
  assert.deepEqual(body.roleSummary, [
    { role: "engineer", averageMs: 7.5 * MINUTE, sampleCount: 2 },
    { role: "tech-lead", averageMs: 20 * MINUTE, sampleCount: 1 },
  ]);
  assert.deepEqual(body.byRole.map((series) => series.role), ["engineer", "tech-lead"]);
  assert.equal(totalSamples(body.overall), 3, "three observations survive; three rows contributed nothing");
});

test("a failed Docker start reaches the wire as no observation at all", async () => {
  const { body } = await get(`?window=7d&projectDir=${PROJECT}`);
  assert.ok(
    !body.byRole.some((series) => series.role === "red-narrow"),
    "the phantom's role has no observations, so it is absent from the payload entirely",
  );
  assert.ok(!body.roleSummary.some((entry) => entry.role === "red-narrow"));

  // Its own bucket holds only the genuine engineer run that finished 2 hours ago.
  const today = at(body.overall, dayBucket(SEEDED_AT - 90 * MINUTE));
  assert.ok(today.sampleCount <= 2, "the 5h21m wait is not among the day's samples");
  assert.ok((today.averageMs ?? 0) <= 10 * MINUTE, `a pre-container wait cannot inflate the average: ${today.averageMs}`);
});

test("the exit-derived duration lands in the completed_at bucket and leaves the exit's own day empty", async () => {
  const { body } = await get(`?window=7d&projectDir=${PROJECT}`);

  const completedDay = at(body.overall, dayBucket(SEEDED_AT - 3 * DAY));
  assert.equal(completedDay.sampleCount, 1, "placed by completed_at");
  assert.equal(completedDay.averageMs, 20 * MINUTE, "measured from the container.exited event");

  const exitDay = at(body.overall, dayBucket(SEEDED_AT - 5 * DAY));
  assert.equal(exitDay.sampleCount, 0, "the day the agent actually ran gains no observation");
  assert.ok(Object.hasOwn(exitDay, "averageMs"), "averageMs must serialize as an explicit JSON null");
  assert.strictEqual(exitDay.averageMs, null, "and read as a gap, never as a zero-duration sample");

  // The whole grid stays internally consistent under the exclusions.
  for (const point of body.overall) {
    assert.equal(point.sampleCount === 0, point.averageMs === null, `${point.bucketStart}: null average iff no samples`);
  }
  for (let index = 0; index < body.overall.length; index += 1) {
    const perRole = body.byRole.reduce((sum, series) => sum + series.buckets[index]!.sampleCount, 0);
    assert.equal(perRole, body.overall[index]!.sampleCount, `bucket ${body.overall[index]!.bucketStart} partitions`);
  }
});

test("an excluded artifact cannot open the derived 'all' range over HTTP", async () => {
  const { body } = await get(`?window=all&projectDir=${PROJECT}`);
  assert.ok(body.rangeStart);
  const start = Date.parse(body.rangeStart!);

  assert.ok(start <= OLDEST_SURVIVING_MS, "the range must reach the oldest surviving observation");
  assert.ok(
    start > OLDEST_SURVIVING_MS - WEEK,
    `'all' must start in that observation's week, got ${body.rangeStart}`,
  );
  assert.ok(start > SEEDED_AT - 40 * DAY, "the 40-day-old artifact must not stretch the range");
  assert.equal(totalSamples(body.overall), 3, "and must not appear as an observation either");
});

test("the rule is scoped: another project's rows are neither corrected into nor excluded from this one", async () => {
  const other = await get("?window=7d&projectDir=/proj/other");
  assert.deepEqual(other.body.roleSummary, [{ role: "engineer", averageMs: 30 * MINUTE, sampleCount: 1 }]);

  const unscoped = await get("?window=7d");
  assert.equal(totalSamples(unscoped.body.overall), 4, "both projects' surviving rows, and no artifact from either");
});
