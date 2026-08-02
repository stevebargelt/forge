// FG-648 verify: the boundary, window-edge, derivation and averaging invariants
// that queries-agent-runtime.test.ts states but does not pin.
//
// The sibling suite seeds ONE store whose rows all sit comfortably inside their
// buckets, so the questions it cannot answer are exactly the ones that decide
// whether a trend line is honest:
//
//   - a row landing exactly ON a bucket start, and one 1ms before it;
//   - a task whose completion is in a DIFFERENT bucket than its start (the
//     single invariant the whole chart rests on) at hour, day and week;
//   - a task that STARTED before the window cutoff and completed inside it —
//     the filter is on completed_at alone, so it must count in full;
//   - each window's cutoff itself: in at the cutoff, out one millisecond earlier;
//   - "all" derived past EXCLUDED rows that are far older than any included one
//     (the sibling's orchestrator session completes LATER than the earliest
//     included row, so it could not have moved the start either way);
//   - scope isolation of the "all" start and the role dimension, not just of the
//     overall bucket counts;
//   - averaging: a real mean over the bucket's rows, sample-weighted across
//     roles rather than a mean of role means, and its rounding;
//   - a genuine ZERO-duration observation, which must read as a sample of 0 and
//     not as the null of an empty bucket.
//
// Every case gets its own isolated store so one fixture's edge row cannot
// silently satisfy another's assertion.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBucket, AgentRuntimeWindow, ProjectScope } from "./queries.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-edges-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

// The same instant the sibling suite pins to: a Wednesday, mid-hour, so "now"
// never coincides with an hour, day or week boundary.
const NOW = Date.parse("2026-06-10T14:30:00Z");

const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

// Each window's ALIGNED cutoff at NOW — the aligned start of the bucket that the
// raw `now - window` cutoff falls in. Written out as literals rather than
// recomputed from the implementation's own floor helper, so a change to that
// helper has to be re-justified here instead of being mirrored automatically.
const CUTOFF: Record<Exclude<AgentRuntimeWindow, "all">, string> = {
  "1d": "2026-06-09T14:00:00.000Z", // now - 24h = 06-09T14:30 → the 14:00 hour
  "7d": "2026-06-03T00:00:00.000Z", // now - 7d  = 06-03T14:30 → the 06-03 day
  "30d": "2026-05-11T00:00:00.000Z", // now - 30d = 05-11T14:30 → the 05-11 day
  "90d": "2026-03-09T00:00:00.000Z", // now - 90d = 03-12T14:30 (a Thursday) → Monday 03-09
};

const PROJECT = "/proj/edge";

type TaskRow = {
  id: string;
  run: string;
  role: string | null;
  phase?: string | null;
  status?: string;
  started: string | null;
  completed: string | null;
};

let storeSeq = 0;

/** Seeds an isolated forge.db and runs `fn` against it. The dashboard's handle is
 *  keyed on the resolved path, so pointing FORGE_HOME at a fresh directory swaps
 *  the store rather than serving the previous fixture's rows. */
function withStore<T>(runs: Array<{ id: string; projectDir: string }>, tasks: TaskRow[], fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `forge-qruntime-edge-${storeSeq++}-`));
  const database = new Database(join(home, "forge.db"));
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
  `);
  const insertRun = database.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)");
  const insertTask = database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  for (const run of runs) insertRun.run(run.id, run.id, "feature", run.projectDir, "complete", "2026-01-01T00:00:00Z");
  for (const row of tasks) {
    insertTask.run(
      row.id, row.run, row.phase === undefined ? "implementation" : row.phase, row.role,
      row.status ?? "complete", null, row.started, row.completed,
    );
  }
  database.close();

  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    return fn();
  } finally {
    process.env.FORGE_HOME = previous;
  }
}

/** A single-project store: every task belongs to run `r1` in `/proj/edge`. */
function withProject<T>(tasks: Array<Omit<TaskRow, "run">>, fn: () => T): T {
  return withStore([{ id: "r1", projectDir: PROJECT }], tasks.map((row) => ({ ...row, run: "r1" })), fn);
}

const trends = (window: AgentRuntimeWindow, scope: ProjectScope = PROJECT) => agentRuntimeTrends(window, scope, NOW);
const at = (buckets: readonly AgentRuntimeBucket[], iso: string): AgentRuntimeBucket => {
  const found = buckets.find((b) => b.bucketStart === iso);
  assert.ok(found, `no bucket at ${iso}; got ${buckets.map((b) => b.bucketStart).join(", ")}`);
  return found;
};
const totalSamples = (buckets: readonly AgentRuntimeBucket[]) => buckets.reduce((sum, b) => sum + b.sampleCount, 0);

/** `{ started, completed }` for a task of `durationMs` ending at `completedIso`. */
const ending = (completedIso: string, durationMs: number) => ({
  started: new Date(Date.parse(completedIso) - durationMs).toISOString(),
  completed: completedIso,
});

test("a task completing exactly ON a daily bucket start belongs to that bucket, not the previous one", () => {
  withProject(
    [
      { id: "on", role: "engineer", ...ending("2026-06-09T00:00:00.000Z", 1_000) },
      { id: "before", role: "engineer", ...ending("2026-06-08T23:59:59.999Z", 5_000) },
    ],
    () => {
      const daily = trends("7d");
      const boundaryDay = at(daily.overall, "2026-06-09T00:00:00.000Z");
      const previousDay = at(daily.overall, "2026-06-08T00:00:00.000Z");

      assert.equal(boundaryDay.sampleCount, 1, "midnight belongs to the day it opens");
      assert.equal(boundaryDay.averageMs, 1_000);
      assert.equal(previousDay.sampleCount, 1, "one millisecond earlier is the day before");
      assert.equal(previousDay.averageMs, 5_000);
      assert.equal(totalSamples(daily.overall), 2, "neither row may be counted twice or dropped");
    },
  );
});

test("a task completing exactly ON an hourly bucket start belongs to that hour, not the previous one", () => {
  withProject(
    [
      { id: "on", role: "engineer", ...ending("2026-06-10T13:00:00.000Z", 2_000) },
      { id: "before", role: "engineer", ...ending("2026-06-10T12:59:59.999Z", 8_000) },
    ],
    () => {
      const hourly = trends("1d");
      assert.equal(hourly.resolution, "hour");
      assert.equal(at(hourly.overall, "2026-06-10T13:00:00.000Z").sampleCount, 1);
      assert.equal(at(hourly.overall, "2026-06-10T13:00:00.000Z").averageMs, 2_000);
      assert.equal(at(hourly.overall, "2026-06-10T12:00:00.000Z").sampleCount, 1);
      assert.equal(at(hourly.overall, "2026-06-10T12:00:00.000Z").averageMs, 8_000);
      assert.equal(totalSamples(hourly.overall), 2);
    },
  );
});

test("a long-running task lands in the bucket of its COMPLETION at every resolution, and its start bucket stays empty", () => {
  // 22h10m of agent time, opened on 06-09 and closed on 06-10. Reported against
  // started_at it would land a day and 22 hours earlier and drag the wrong
  // bucket's average up with it.
  const started = "2026-06-09T15:10:00.000Z";
  const completed = "2026-06-10T13:20:00.000Z";
  const durationMs = Date.parse(completed) - Date.parse(started);
  assert.equal(durationMs, 79_800_000, "fixture sanity: the task spans an hour, a day and 22 hours of them");

  withProject([{ id: "long", role: "engineer", started, completed }], () => {
    const hourly = trends("1d");
    assert.equal(at(hourly.overall, "2026-06-09T15:00:00.000Z").sampleCount, 0, "the START hour must stay empty");
    assert.equal(at(hourly.overall, "2026-06-09T15:00:00.000Z").averageMs, null);
    assert.equal(at(hourly.overall, "2026-06-10T13:00:00.000Z").sampleCount, 1, "the COMPLETION hour owns the sample");
    assert.equal(at(hourly.overall, "2026-06-10T13:00:00.000Z").averageMs, durationMs);
    assert.equal(totalSamples(hourly.overall), 1, "one task is one observation, in one bucket");

    const daily = trends("7d");
    assert.equal(at(daily.overall, "2026-06-09T00:00:00.000Z").sampleCount, 0, "the START day must stay empty");
    assert.equal(at(daily.overall, "2026-06-10T00:00:00.000Z").sampleCount, 1);
    assert.equal(at(daily.overall, "2026-06-10T00:00:00.000Z").averageMs, durationMs);
    assert.equal(totalSamples(daily.overall), 1);

    // The role series must tell the same story as the overall series.
    const engineer = daily.byRole.find((series) => series.role === "engineer");
    assert.ok(engineer);
    assert.equal(at(engineer.buckets, "2026-06-09T00:00:00.000Z").sampleCount, 0);
    assert.equal(at(engineer.buckets, "2026-06-10T00:00:00.000Z").sampleCount, 1);
  });
});

test("weekly buckets align to Monday UTC, and a Sunday→Monday task lands in the COMPLETION week", () => {
  // 2026-06-07 is a Sunday, 2026-06-08 the Monday that opens the next week.
  withProject(
    [
      { id: "sunday", role: "engineer", ...ending("2026-06-07T23:59:59.999Z", 3_000) },
      { id: "spanning", role: "engineer", started: "2026-06-07T20:00:00.000Z", completed: "2026-06-08T04:00:00.000Z" },
    ],
    () => {
      const weekly = trends("all");
      assert.equal(weekly.resolution, "week");
      assert.equal(weekly.bucketMs, WEEK);
      assert.equal(weekly.rangeStart, "2026-06-01T00:00:00.000Z", "the earliest week opens on a Monday");
      assert.deepEqual(weekly.overall.map((b) => b.bucketStart), [
        "2026-06-01T00:00:00.000Z",
        "2026-06-08T00:00:00.000Z",
      ]);
      assert.equal(at(weekly.overall, "2026-06-01T00:00:00.000Z").sampleCount, 1, "the Sunday row closes the earlier week");
      assert.equal(at(weekly.overall, "2026-06-01T00:00:00.000Z").averageMs, 3_000);
      // The spanning task STARTS in the 06-01 week and finishes in the 06-08 one.
      assert.equal(at(weekly.overall, "2026-06-08T00:00:00.000Z").sampleCount, 1);
      assert.equal(at(weekly.overall, "2026-06-08T00:00:00.000Z").averageMs, 8 * HOUR);
    },
  );
});

test("a task that STARTED before the window cutoff but completed inside it counts in full", () => {
  // The 1d cutoff is 06-09T14:00. This task was already running four hours before
  // that and closed four hours after it: the row is in the window because its
  // COMPLETION is, and the reported duration is the whole nine hours of agent time.
  withProject(
    [{ id: "straddle", role: "engineer", started: "2026-06-09T09:00:00.000Z", completed: "2026-06-09T18:00:00.000Z" }],
    () => {
      const hourly = trends("1d");
      assert.equal(hourly.rangeStart, CUTOFF["1d"]);
      assert.equal(totalSamples(hourly.overall), 1, "a start before the cutoff must not exclude the row");
      assert.equal(at(hourly.overall, "2026-06-09T18:00:00.000Z").sampleCount, 1);
      assert.equal(at(hourly.overall, "2026-06-09T18:00:00.000Z").averageMs, 9 * HOUR, "the duration is not clipped to the window");
      assert.deepEqual(hourly.roleSummary, [{ role: "engineer", averageMs: 9 * HOUR, sampleCount: 1 }]);
    },
  );
});

test("each window's cutoff includes a row landing exactly on it and excludes one a millisecond earlier", () => {
  for (const window of ["1d", "7d", "30d", "90d"] as const) {
    const cutoff = CUTOFF[window];
    const justOutside = new Date(Date.parse(cutoff) - 1).toISOString();

    withProject(
      [
        { id: "in", role: "engineer", ...ending(cutoff, 1_000) },
        { id: "out", role: "engineer", ...ending(justOutside, 9_000) },
      ],
      () => {
        const inWindow = trends(window);
        assert.equal(inWindow.rangeStart, cutoff, `${window} must open on its aligned cutoff`);
        assert.equal(totalSamples(inWindow.overall), 1, `${window}: only the row at the cutoff is in the window`);
        assert.equal(inWindow.overall[0]!.sampleCount, 1, `${window}: the cutoff row is in the FIRST bucket`);
        assert.equal(inWindow.overall[0]!.averageMs, 1_000, `${window}: the excluded row must not reach the average`);
        assert.deepEqual(inWindow.roleSummary, [{ role: "engineer", averageMs: 1_000, sampleCount: 1 }], window);

        // Neither row is malformed — "all" has no cutoff and sees both, so the
        // exclusion above is the window doing its job, not the row being dropped.
        const everything = trends("all");
        assert.equal(totalSamples(everything.overall), 2, `${window}: both rows are valid observations`);
        assert.equal(everything.roleSummary[0]!.sampleCount, 2, window);
      },
    );
  }
});

test("7d and 30d share the daily resolution but differ in bucket COUNT; 90d and all are weekly", () => {
  withProject([{ id: "one", role: "engineer", ...ending("2026-06-10T10:00:00.000Z", 5_000) }], () => {
    const hourly = trends("1d");
    const week = trends("7d");
    const month = trends("30d");
    const quarter = trends("90d");
    const everything = trends("all");

    assert.equal(hourly.resolution, "hour");
    assert.equal(hourly.bucketMs, HOUR);
    assert.equal(hourly.overall.length, 25, "24 hours of grid plus the current partial hour");

    assert.equal(week.resolution, "day");
    assert.equal(month.resolution, "day");
    assert.equal(week.bucketMs, DAY);
    assert.equal(month.bucketMs, DAY);
    assert.equal(week.overall.length, 8);
    assert.equal(month.overall.length, 31);
    assert.notEqual(
      week.overall.length, month.overall.length,
      "a shared resolution is not a shared window — 7d and 30d must cover different spans",
    );

    assert.equal(quarter.resolution, "week");
    assert.equal(everything.resolution, "week");
    assert.equal(quarter.bucketMs, WEEK);
    assert.equal(everything.bucketMs, WEEK);
    assert.equal(quarter.overall.length, 14, "2026-03-09 through the 2026-06-08 week, inclusive");

    // One observation, visible exactly once through every window.
    for (const [name, result] of [["1d", hourly], ["7d", week], ["30d", month], ["90d", quarter], ["all", everything]] as const) {
      assert.equal(totalSamples(result.overall), 1, `${name} must see the single observation exactly once`);
    }
  });
});

test("'all' derives its start from the earliest INCLUDED observation — far older excluded rows cannot move it", () => {
  withProject(
    [
      // An interactive orchestrator session in January: twelve hours long and five
      // months older than any real observation. If it reached the derivation it
      // would stretch "all" across ~22 empty weeks and skew every average it touched.
      { id: "session", role: "orchestrator", phase: "session", started: "2026-01-05T00:00:00.000Z", completed: "2026-01-05T12:00:00.000Z" },
      // Still running since February.
      { id: "active", role: "engineer", status: "running", started: "2026-02-01T00:00:00.000Z", completed: null },
      // A March row whose clock ran backwards.
      { id: "negative", role: "engineer", started: "2026-03-10T05:00:00.000Z", completed: "2026-03-10T04:00:00.000Z" },
      // Never started, but carries a completion timestamp in April.
      { id: "unstarted", role: "engineer", started: null, completed: "2026-04-02T00:00:00.000Z" },
      // The one real observation.
      { id: "real", role: "engineer", ...ending("2026-06-09T09:00:30.000Z", 30_000) },
    ],
    () => {
      const everything = trends("all");
      assert.equal(everything.rangeStart, "2026-06-08T00:00:00.000Z", "the Monday of the only included observation");
      assert.equal(everything.overall.length, 1, "one week of grid, not five months of it");
      assert.equal(totalSamples(everything.overall), 1);
      assert.deepEqual(everything.roleSummary, [{ role: "engineer", averageMs: 30_000, sampleCount: 1 }]);
      assert.equal(everything.roleSummary.some((row) => row.role === "orchestrator"), false);
      assert.ok(
        Date.parse(everything.rangeStart!) > Date.parse("2026-04-02T00:00:00.000Z"),
        `an excluded row moved the 'all' start back to ${everything.rangeStart}`,
      );
    },
  );
});

test("scope isolation covers the role dimension and the 'all' range start, not just the overall buckets", () => {
  withStore(
    [{ id: "rx", projectDir: "/proj/x" }, { id: "ry", projectDir: "/proj/y" }],
    [
      // /proj/y's work is four months older and carries a role /proj/x never ran.
      { id: "y1", run: "ry", role: "red-wide", ...ending("2026-02-04T10:00:00.000Z", 60_000) },
      { id: "x1", run: "rx", role: "engineer", ...ending("2026-06-09T09:00:30.000Z", 30_000) },
    ],
    () => {
      const x = agentRuntimeTrends("all", "/proj/x", NOW);
      assert.equal(x.rangeStart, "2026-06-08T00:00:00.000Z", "another project's older row must not move this scope's start");
      assert.equal(x.overall.length, 1);
      assert.equal(totalSamples(x.overall), 1);
      assert.deepEqual(x.roleSummary.map((row) => row.role), ["engineer"], "red-wide is not a role /proj/x ran");
      assert.deepEqual(x.byRole.map((series) => series.role), ["engineer"]);

      const y = agentRuntimeTrends("all", "/proj/y", NOW);
      assert.equal(y.rangeStart, "2026-02-02T00:00:00.000Z", "the Monday of /proj/y's own earliest observation");
      assert.deepEqual(y.roleSummary, [{ role: "red-wide", averageMs: 60_000, sampleCount: 1 }]);
      assert.equal(totalSamples(y.overall), 1);

      // Unscoped and multi-checkout scopes see both — so the isolation above is
      // the scope filter working, not the fixture being empty.
      const unscoped = agentRuntimeTrends("all", undefined, NOW);
      assert.equal(unscoped.rangeStart, "2026-02-02T00:00:00.000Z");
      assert.equal(totalSamples(unscoped.overall), 2);
      assert.deepEqual(unscoped.roleSummary.map((row) => row.role).sort(), ["engineer", "red-wide"]);
      assert.ok(unscoped.overall.length > x.overall.length, "the unscoped range spans both projects' history");

      const canonical = agentRuntimeTrends("all", ["/proj/x", "/proj/y"], NOW);
      assert.equal(canonical.rangeStart, unscoped.rangeStart);
      assert.equal(totalSamples(canonical.overall), 2);

      const nowhere = agentRuntimeTrends("all", "/proj/z", NOW);
      assert.equal(nowhere.rangeStart, null);
      assert.deepEqual(nowhere.overall, []);
    },
  );
});

test("averageMs is a real mean over the bucket's observations, and sampleCount is the number of rows averaged", () => {
  withProject(
    [
      // 1000 and 3000 → 2000 over 2 samples. Not the max, not the last, not the median.
      { id: "a1", role: "engineer", ...ending("2026-06-05T01:00:00.000Z", 1_000) },
      { id: "a2", role: "engineer", ...ending("2026-06-05T02:00:00.000Z", 3_000) },
      // 1000 and 1001 → 1000.5, reported as an integer millisecond.
      { id: "b1", role: "engineer", ...ending("2026-06-06T01:00:00.000Z", 1_000) },
      { id: "b2", role: "engineer", ...ending("2026-06-06T02:00:00.000Z", 1_001) },
      // 1000, 1000, 1001 → 1000.33.
      { id: "c1", role: "engineer", ...ending("2026-06-07T01:00:00.000Z", 1_000) },
      { id: "c2", role: "engineer", ...ending("2026-06-07T02:00:00.000Z", 1_000) },
      { id: "c3", role: "engineer", ...ending("2026-06-07T03:00:00.000Z", 1_001) },
    ],
    () => {
      const daily = trends("7d");
      const first = at(daily.overall, "2026-06-05T00:00:00.000Z");
      assert.equal(first.sampleCount, 2);
      assert.equal(first.averageMs, 2_000);

      const second = at(daily.overall, "2026-06-06T00:00:00.000Z");
      assert.equal(second.sampleCount, 2);
      assert.equal(second.averageMs, 1_001, "1000.5 ms is reported as an integer millisecond");

      const third = at(daily.overall, "2026-06-07T00:00:00.000Z");
      assert.equal(third.sampleCount, 3);
      assert.equal(third.averageMs, 1_000);

      // The summary is the mean over the whole window, not a mean of bucket means.
      assert.deepEqual(daily.roleSummary, [{ role: "engineer", averageMs: 1_286, sampleCount: 7 }]);
      assert.equal(Math.round(9_002 / 7), 1_286, "fixture sanity: 9002ms over 7 observations");
    },
  );
});

test("the overall series is the sample-weighted mean across roles, never a mean of role means", () => {
  withProject(
    [
      { id: "s1", role: "solo", ...ending("2026-06-09T01:00:00.000Z", 3_000) },
      { id: "c1", role: "crowd", ...ending("2026-06-09T02:00:00.000Z", 1_000) },
      { id: "c2", role: "crowd", ...ending("2026-06-09T03:00:00.000Z", 1_000) },
      { id: "c3", role: "crowd", ...ending("2026-06-09T04:00:00.000Z", 1_000) },
    ],
    () => {
      const daily = trends("7d");
      const day = at(daily.overall, "2026-06-09T00:00:00.000Z");
      assert.equal(day.sampleCount, 4);
      assert.equal(day.averageMs, 1_500, "6000ms over 4 observations — a mean of role means would read 2000");

      assert.deepEqual(daily.roleSummary, [
        { role: "crowd", averageMs: 1_000, sampleCount: 3 },
        { role: "solo", averageMs: 3_000, sampleCount: 1 },
      ]);
    },
  );
});

test("role series are ordered by sample count descending, ties broken alphabetically", () => {
  withProject(
    [
      // Inside every window including 1d, so the ordering can be checked against
      // all five grids from one fixture.
      { id: "z1", role: "zeta", ...ending("2026-06-10T01:00:00.000Z", 1_000) },
      { id: "z2", role: "zeta", ...ending("2026-06-10T02:00:00.000Z", 1_000) },
      { id: "a1", role: "alpha", ...ending("2026-06-10T03:00:00.000Z", 1_000) },
      { id: "a2", role: "alpha", ...ending("2026-06-10T04:00:00.000Z", 1_000) },
      { id: "b1", role: "beta", ...ending("2026-06-10T05:00:00.000Z", 1_000) },
      { id: "b2", role: "beta", ...ending("2026-06-10T06:00:00.000Z", 1_000) },
      { id: "b3", role: "beta", ...ending("2026-06-10T07:00:00.000Z", 1_000) },
    ],
    () => {
      const daily = trends("7d");
      assert.deepEqual(daily.roleSummary.map((row) => row.role), ["beta", "alpha", "zeta"]);
      assert.deepEqual(daily.byRole.map((series) => series.role), ["beta", "alpha", "zeta"]);
      // Deterministic across windows too — the order is a property of the data,
      // not of the grid it is projected onto.
      for (const window of ["1d", "30d", "90d", "all"] as const) {
        assert.deepEqual(trends(window).roleSummary.map((row) => row.role), ["beta", "alpha", "zeta"], window);
      }
    },
  );
});

test("only an orchestrator's interactive SESSION is excluded — not every session phase, and not a phase-less orchestrator", () => {
  // The current SCHEMA_SQL declares tasks.phase NOT NULL, so the phase-less
  // orchestrator is the legacy/foreign-store shape the read path handles
  // defensively: with plain `=` instead of the null-safe `IS`, NOT(...) is NULL
  // for that row and SQLite drops it — a real agent execution silently missing.
  withProject(
    [
      { id: "iactive", role: "orchestrator", phase: "session", started: "2026-06-09T02:00:00.000Z", completed: "2026-06-09T08:00:00.000Z" },
      { id: "nophase", role: "orchestrator", phase: null, ...ending("2026-06-09T09:00:00.000Z", 10_000) },
      { id: "planning", role: "orchestrator", phase: "planning", ...ending("2026-06-09T10:00:00.000Z", 20_000) },
      // A non-orchestrator role in a session phase is still an agent execution.
      { id: "engsess", role: "engineer", phase: "session", ...ending("2026-06-09T11:00:00.000Z", 40_000) },
    ],
    () => {
      const daily = trends("7d");
      assert.deepEqual(daily.roleSummary, [
        { role: "orchestrator", averageMs: 15_000, sampleCount: 2 },
        { role: "engineer", averageMs: 40_000, sampleCount: 1 },
      ]);
      assert.equal(totalSamples(daily.overall), 3, "exactly one of the four rows is excluded");
      const day = at(daily.overall, "2026-06-09T00:00:00.000Z");
      assert.equal(day.averageMs, 23_333, "70s over 3 observations — the 6h session would read 1.6M");
    },
  );
});

test("a genuine zero-duration observation is a sample of 0ms, and an empty bucket stays null", () => {
  withProject(
    [
      { id: "instant", role: "engineer", started: "2026-06-09T09:00:00.000Z", completed: "2026-06-09T09:00:00.000Z" },
      { id: "later", role: "engineer", ...ending("2026-06-10T09:00:00.000Z", 4_000) },
    ],
    () => {
      const daily = trends("7d");
      const zero = at(daily.overall, "2026-06-09T00:00:00.000Z");
      assert.equal(zero.sampleCount, 1, "a 0ms task is an observation, not a gap");
      assert.strictEqual(zero.averageMs, 0);
      assert.notEqual(zero.averageMs, null, "an observed zero must not be reported as 'no runs'");

      const gap = at(daily.overall, "2026-06-08T00:00:00.000Z");
      assert.equal(gap.sampleCount, 0);
      assert.strictEqual(gap.averageMs, null, "a gap must not be reported as an observed zero");

      assert.deepEqual(daily.roleSummary, [{ role: "engineer", averageMs: 2_000, sampleCount: 2 }]);
    },
  );
});

test("every role series shares the overall grid and partitions its counts, in every window", () => {
  withProject(
    [
      { id: "e1", role: "engineer", ...ending("2026-06-05T09:00:00.000Z", 1_000) },
      { id: "e2", role: "engineer", ...ending("2026-06-09T09:00:00.000Z", 3_000) },
      { id: "e3", role: "engineer", ...ending("2026-06-10T09:00:00.000Z", 5_000) },
      { id: "r1", role: "red-wide", ...ending("2026-06-09T10:00:00.000Z", 7_000) },
      { id: "t1", role: "test-engineer", ...ending("2026-05-20T10:00:00.000Z", 9_000) },
    ],
    () => {
      for (const window of ["1d", "7d", "30d", "90d", "all"] as const) {
        const result = trends(window);
        const grid = result.overall.map((b) => b.bucketStart);
        const partials = result.overall.map((b) => b.partial);

        assert.deepEqual(
          result.byRole.map((series) => series.role),
          result.roleSummary.map((row) => row.role),
          `${window}: the series list and the summary must describe the same roles`,
        );

        for (const series of result.byRole) {
          assert.deepEqual(series.buckets.map((b) => b.bucketStart), grid,
            `${window}/${series.role}: switching roles must not shift the x-axis`);
          assert.deepEqual(series.buckets.map((b) => b.partial), partials,
            `${window}/${series.role}: the partial flag must sit on the same bucket in every series`);
          for (const point of series.buckets) {
            assert.equal(point.sampleCount === 0, point.averageMs === null,
              `${window}/${series.role}: a role with no runs in a bucket reports null, never 0`);
          }
        }

        for (let index = 0; index < result.overall.length; index += 1) {
          const perRole = result.byRole.reduce((sum, series) => sum + series.buckets[index]!.sampleCount, 0);
          assert.equal(perRole, result.overall[index]!.sampleCount,
            `${window}: bucket ${grid[index]} — the role series must partition the overall count exactly`);
        }

        for (const row of result.roleSummary) {
          const series = result.byRole.find((candidate) => candidate.role === row.role)!;
          assert.equal(totalSamples(series.buckets), row.sampleCount,
            `${window}/${row.role}: the summary and the plotted series must describe the same observations`);
        }
      }
    },
  );
});

test("exactly one bucket — the aligned bucket containing now, always the last — is flagged partial in every window", () => {
  const expected: Record<AgentRuntimeWindow, string> = {
    "1d": "2026-06-10T14:00:00.000Z",
    "7d": "2026-06-10T00:00:00.000Z",
    "30d": "2026-06-10T00:00:00.000Z",
    "90d": "2026-06-08T00:00:00.000Z",
    all: "2026-06-08T00:00:00.000Z",
  };

  withProject([{ id: "e1", role: "engineer", ...ending("2026-06-09T09:00:00.000Z", 1_000) }], () => {
    for (const window of ["1d", "7d", "30d", "90d", "all"] as const) {
      const result = trends(window);
      assert.deepEqual(
        result.overall.filter((b) => b.partial).map((b) => b.bucketStart),
        [expected[window]],
        `${window}: the in-progress bucket must be flagged, and only it`,
      );
      assert.equal(result.overall.at(-1)!.partial, true, `${window}: the partial bucket is the trailing one`);
      for (const series of result.byRole) {
        assert.deepEqual(series.buckets.filter((b) => b.partial).map((b) => b.bucketStart), [expected[window]], `${window}/${series.role}`);
      }
    }
  });
});
