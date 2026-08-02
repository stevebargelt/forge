// FG-648 verify: the API-layer edges that routes-agent-runtime.integration.test.ts
// leaves open, exercised against the REAL production schema rather than a
// hand-rolled minimal one.
//
// The sibling suite seeds a four-column runs table and an eight-column tasks
// table written by hand. That is enough to prove the shape of a populated
// response, and it is the only fixture the query has ever been read through — so
// it cannot answer:
//
//   - does the query still resolve against SCHEMA_SQL, the table forge actually
//     writes (NOT NULL phase/agent_role, twenty-odd extra columns)?
//   - a FIXED window with zero observations: the sibling only covers `all` with
//     nothing in scope, which returns a null range and no grid. A dated window
//     with no rows must instead return its FULL grid of empty buckets — a very
//     different payload, and the one an idle project sees every day;
//   - `averageMs: null` surviving serialization as a present JSON key rather
//     than an absent one (an undefined would vanish silently through
//     JSON.stringify and read as "field missing" on the client);
//   - the rejected-window contract beyond one nonsense string: an empty value, a
//     case variant, a plausible-but-unsupported window;
//   - `projectKey`, the OTHER scope parameter, and the precedence between the
//     two. An unknown key must match NOTHING, never fall back to an unscoped
//     cross-project read;
//   - scope isolation of the derived `all` range start over the wire — another
//     project's much older row must not stretch a scoped range;
//   - the role-series/overall grid alignment surviving JSON, in every window.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";

const TEST_PORT = 18793;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const testHome = mkdtempSync(join(tmpdir(), "forge-runtime-edges-"));
const forgeHome = join(testHome, ".forge");
const scanRoots = join(testHome, "checkouts");
mkdirSync(forgeHome, { recursive: true });
mkdirSync(scanRoots, { recursive: true });

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

// One clock reading for the whole fixture: two rows written "3 days ago" must be
// the SAME instant, or a bucket assertion can straddle a midnight and flake.
const SEEDED_AT = Date.now();
const ago = (ms: number) => new Date(SEEDED_AT - ms).toISOString();

const MAIN_EARLIEST_MS = SEEDED_AT - 10 * DAY;
const OTHER_EARLIEST_MS = SEEDED_AT - 200 * DAY;

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
  const task = (
    id: string, runId: string, phase: string, role: string, status: string,
    completedMsAgo: number | null, durationMs: number,
  ) => {
    const completed = completedMsAgo === null ? null : ago(completedMsAgo);
    const started = completedMsAgo === null ? ago(HOUR) : ago(completedMsAgo + durationMs);
    insertTask.run(id, runId, phase, role, status, "{}", ago(30 * DAY), started, completed);
  };

  insertRun.run("r-main", "feature", "Main", "complete", ago(30 * DAY), "/proj/main");
  insertRun.run("r-other", "feature", "Other", "complete", ago(201 * DAY), "/proj/other");

  // /proj/main — inside 1d, inside 7d, and one row 10 days back.
  task("m-recent", "r-main", "implementation", "engineer", "complete", 2 * HOUR, 60_000);
  task("m-3d-fail", "r-main", "implementation", "engineer", "failed", 3 * DAY, 30_000);
  task("m-3d-red", "r-main", "review", "red-wide", "complete", 3 * DAY, 120_000);
  task("m-10d", "r-main", "verify", "test-engineer", "complete", 10 * DAY, 15_000);
  // Never observations: an interactive orchestrator session, active work, a
  // backwards clock. All three carry timestamps OLDER than any real row, so if
  // any of them leaked it would move the derived `all` range start.
  task("m-session", "r-main", "session", "orchestrator", "complete", 40 * DAY, 6 * HOUR);
  task("m-active", "r-main", "implementation", "engineer", "running", null, 0);
  task("m-negative", "r-main", "implementation", "engineer", "complete", 45 * DAY, -60_000);

  // /proj/other — a role /proj/main never ran, and history 200 days deep.
  task("o-recent", "r-other", "documentation", "documentation-maintainer", "complete", 36 * HOUR, 90_000);
  task("o-ancient", "r-other", "documentation", "documentation-maintainer", "complete", 200 * DAY, 45_000);
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
  throw new Error("agent-runtime edge test server did not start");
}

await waitForServer();

const get = async (query: string): Promise<{ status: number; body: Trends }> => {
  const response = await fetch(`${BASE}/api/agent-runtime${query}`);
  return { status: response.status, body: await response.json() as Trends };
};
const roles = (body: Trends) => body.roleSummary.map((row) => row.role);
const totalSamples = (buckets: readonly Bucket[]) => buckets.reduce((sum, point) => sum + point.sampleCount, 0);

test("the route resolves against the production SCHEMA_SQL tables, not just a hand-rolled fixture", async () => {
  const { status, body } = await get("?window=7d&projectDir=/proj/main");
  assert.equal(status, 200);
  assert.equal(body.resolution, "day");
  assert.equal(body.bucketMs, DAY);

  // A completed success and a completed failure average together; the session,
  // the active task and the backwards clock are all absent.
  assert.deepEqual(body.roleSummary, [
    { role: "engineer", averageMs: 45_000, sampleCount: 2 },
    { role: "red-wide", averageMs: 120_000, sampleCount: 1 },
  ]);
  assert.equal(totalSamples(body.overall), 3);

  // The 3-day-old bucket holds 30s and 120s: a real mean of 75s over 2 rows.
  const observed = body.overall.filter((point) => point.sampleCount > 0);
  assert.deepEqual(
    observed.map((point) => ({ sampleCount: point.sampleCount, averageMs: point.averageMs })),
    [{ sampleCount: 2, averageMs: 75_000 }, { sampleCount: 1, averageMs: 60_000 }],
    "buckets ascend, and each average is the mean of exactly the rows counted in it",
  );
});

test("a dated window with no observations returns its FULL empty grid, not the null range 'all' returns", async () => {
  // /proj/other's most recent run closed 36 hours ago: inside 7d, outside 1d.
  const { status, body } = await get("?window=1d&projectDir=/proj/other");
  assert.equal(status, 200);
  assert.ok(body.rangeStart, "a dated window has a range even with nothing in it");
  const span = Date.parse(body.rangeEnd) - Date.parse(body.rangeStart!);
  assert.ok(span >= DAY && span < DAY + HOUR, `1d must still span a day of grid, got ${span}ms`);
  assert.equal(body.overall.length, 25, "24 whole hours plus the current partial one");
  assert.equal(totalSamples(body.overall), 0);
  assert.deepEqual(body.byRole, [], "no observations means no role series");
  assert.deepEqual(body.roleSummary, []);
  assert.equal(body.overall.filter((point) => point.partial).length, 1);
  assert.equal(body.overall.at(-1)!.partial, true);

  for (const point of body.overall) {
    assert.equal(point.sampleCount, 0);
    assert.ok(Object.hasOwn(point, "averageMs"), "averageMs must serialize as an explicit JSON null, not vanish");
    assert.strictEqual(point.averageMs, null, "an idle hour is a gap, never a zero-duration observation");
  }

  // The same project over `all` is NOT empty — the emptiness above is the window.
  const everything = await get("?window=all&projectDir=/proj/other");
  assert.ok(everything.body.overall.length > 0);
  assert.equal(totalSamples(everything.body.overall), 2);

  // And a scope with no rows at all is a third shape again: no range, no grid.
  const nowhere = await get("?window=all&projectDir=/proj/does-not-exist");
  assert.equal(nowhere.body.rangeStart, null);
  assert.deepEqual(nowhere.body.overall, []);
});

test("every unsupported window value is rejected with 400 and an error naming the supported set", async () => {
  const rejected = ["", "7D", "ALL", "1w", "2d", "0d", "7", "week", " 7d", "7d ", "1d;drop"];
  for (const value of rejected) {
    const response = await fetch(`${BASE}/api/agent-runtime?window=${encodeURIComponent(value)}`);
    assert.equal(response.status, 400, `window=${JSON.stringify(value)} must be rejected`);
    const body = await response.json() as { error?: string; overall?: unknown };
    assert.match(body.error ?? "", /invalid window/, JSON.stringify(value));
    for (const window of ["1d", "7d", "30d", "90d", "all"]) {
      assert.ok(body.error!.includes(window), `the error must name ${window}: ${body.error}`);
    }
    assert.equal(body.overall, undefined, "a rejected window must not also return a trend payload");
  }

  // Only the omitted parameter falls back — an empty one does not.
  const defaulted = await get("?projectDir=/proj/main");
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.body.window, "7d");
});

test("both scope parameters reach the query, and an unknown projectKey matches nothing rather than everything", async () => {
  const main = await get("?window=30d&projectDir=/proj/main");
  assert.deepEqual(roles(main.body), ["engineer", "red-wide", "test-engineer"]);

  const other = await get("?window=30d&projectDir=/proj/other");
  assert.deepEqual(roles(other.body), ["documentation-maintainer"]);
  assert.equal(totalSamples(other.body.overall), 1, "only the 36-hour-old run is inside 30d");

  const unscoped = await get("?window=30d");
  assert.deepEqual(roles(unscoped.body).sort(), ["documentation-maintainer", "engineer", "red-wide", "test-engineer"]);

  // An unknown key resolves to the empty scope. The grid still exists (the window
  // is dated), but nothing is in it — a fallback to unscoped would leak every
  // project's runtime under a project selection that matched no project.
  const unknownKey = await get("?window=30d&projectKey=not-a-real-project");
  assert.equal(unknownKey.status, 200);
  assert.deepEqual(unknownKey.body.roleSummary, []);
  assert.deepEqual(unknownKey.body.byRole, []);
  assert.equal(totalSamples(unknownKey.body.overall), 0);
  assert.equal(unknownKey.body.overall.length, unscoped.body.overall.length, "same window, same grid");

  // projectDir is the exact-checkout selection and outranks the key.
  const both = await get("?window=30d&projectDir=/proj/main&projectKey=not-a-real-project");
  assert.deepEqual(roles(both.body), roles(main.body));
  assert.equal(totalSamples(both.body.overall), totalSamples(main.body.overall));
});

test("another project's older history cannot stretch a scoped 'all' range", async () => {
  const scoped = await get("?window=all&projectDir=/proj/main");
  const unscoped = await get("?window=all");
  assert.ok(scoped.body.rangeStart && unscoped.body.rangeStart);

  const scopedStart = Date.parse(scoped.body.rangeStart!);
  const unscopedStart = Date.parse(unscoped.body.rangeStart!);

  // /proj/main's own earliest INCLUDED observation is 10 days old — its week, not
  // the 200-day-old row in /proj/other, and not the 45-day-old excluded rows.
  assert.ok(scopedStart <= MAIN_EARLIEST_MS, "the scoped range must reach its own earliest observation");
  assert.ok(
    scopedStart > MAIN_EARLIEST_MS - WEEK,
    `the scoped 'all' start (${scoped.body.rangeStart}) must be the week of /proj/main's earliest row, not older`,
  );
  assert.ok(scopedStart > unscopedStart, "scoping to /proj/main must shorten the range, not inherit /proj/other's");
  assert.ok(scoped.body.overall.length < unscoped.body.overall.length);
  assert.equal(roles(scoped.body).includes("documentation-maintainer"), false, "another project's role must not appear");

  // Unscoped, the 200-day-old row IS the start.
  assert.ok(unscopedStart <= OTHER_EARLIEST_MS && unscopedStart > OTHER_EARLIEST_MS - WEEK);
  assert.equal(totalSamples(unscoped.body.overall), 6, "every included observation across both projects");
});

test("the role series and the overall series stay aligned through JSON, in every window", async () => {
  for (const query of ["?projectDir=/proj/main", ""] as const) {
    for (const window of ["1d", "7d", "30d", "90d", "all"] as const) {
      const label = `${window}${query}`;
      const { status, body } = await get(`?window=${window}${query ? `&${query.slice(1)}` : ""}`);
      assert.equal(status, 200, label);

      const grid = body.overall.map((point) => point.bucketStart);
      const partials = body.overall.map((point) => point.partial);
      assert.deepEqual(body.byRole.map((series) => series.role), roles(body), `${label}: series and summary roles`);

      for (const series of body.byRole) {
        assert.deepEqual(series.buckets.map((point) => point.bucketStart), grid,
          `${label}/${series.role}: a role series must not shift the x-axis`);
        assert.deepEqual(series.buckets.map((point) => point.partial), partials, `${label}/${series.role}: partial flags`);
        for (const point of series.buckets) {
          assert.equal(point.sampleCount === 0, point.averageMs === null, `${label}/${series.role}: null iff empty`);
        }
      }

      for (let index = 0; index < body.overall.length; index += 1) {
        const perRole = body.byRole.reduce((sum, series) => sum + series.buckets[index]!.sampleCount, 0);
        assert.equal(perRole, body.overall[index]!.sampleCount,
          `${label}: bucket ${grid[index]} — the role series must partition the overall count`);
      }

      for (const row of body.roleSummary) {
        const series = body.byRole.find((candidate) => candidate.role === row.role)!;
        assert.equal(totalSamples(series.buckets), row.sampleCount,
          `${label}/${row.role}: the summary and the plotted series must describe the same observations`);
      }
    }
  }
});
