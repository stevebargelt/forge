// FG-683: which BUCKET a completed run lands in. A run is placed by its
// completed_at and by nothing else — not by when it started, and not by the
// reader's clock. Separate fixture per case so a boundary is asserted against a
// store containing only the rows that boundary is about.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const bootHome = mkdtempSync(join(tmpdir(), "forge-qcompleted-bounds-"));
process.env.FORGE_HOME = bootHome;

const { completedRunTrends } = await import("./queries.js");

const NOW = Date.parse("2026-06-10T14:30:00Z");

const SCHEMA = `
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT, completed_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
`;

/** A store holding exactly these (id, createdAt, completedAt) runs, all in /proj. */
function storeWith(rows: Array<[string, string, string]>): string {
  const home = mkdtempSync(join(tmpdir(), "forge-qcompleted-case-"));
  const db = new Database(join(home, "forge.db"));
  db.exec(SCHEMA);
  const insert = db.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?,?)");
  for (const [id, createdAt, completedAt] of rows) {
    insert.run(id, id, "feature", "/proj", "complete", createdAt, completedAt);
  }
  db.close();
  return home;
}

function read(home: string, window: "1d" | "7d" | "30d" | "90d" | "all") {
  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    return completedRunTrends(window, "/proj", NOW);
  } finally {
    process.env.FORGE_HOME = previous;
  }
}

const at = (buckets: readonly { bucketStart: string; completedRuns: number }[], iso: string) =>
  buckets.find((b) => b.bucketStart === iso)!.completedRuns;

test("a completion exactly ON a bucket start belongs to the bucket it opens", () => {
  // 09:00:00.000 opens the 09:00 hour. It is the first millisecond of that
  // bucket, not the last of the one before it.
  const home = storeWith([["r-on", "2026-06-10T08:30:00.000Z", "2026-06-10T09:00:00.000Z"]]);
  const hourly = read(home, "1d");
  assert.equal(at(hourly.buckets, "2026-06-10T09:00:00.000Z"), 1);
  assert.equal(at(hourly.buckets, "2026-06-10T08:00:00.000Z"), 0);

  // The same run, on the daily grid: 09:00 UTC opens no day, so it sits inside
  // the 06-10 day either way.
  const daily = read(home, "7d");
  assert.equal(at(daily.buckets, "2026-06-10T00:00:00.000Z"), 1);
  assert.equal(at(daily.buckets, "2026-06-09T00:00:00.000Z"), 0);
});

test("a completion one millisecond BEFORE a bucket start belongs to the previous bucket", () => {
  const home = storeWith([["r-before", "2026-06-10T08:00:00.000Z", "2026-06-10T08:59:59.999Z"]]);
  const hourly = read(home, "1d");
  assert.equal(at(hourly.buckets, "2026-06-10T08:00:00.000Z"), 1);
  assert.equal(at(hourly.buckets, "2026-06-10T09:00:00.000Z"), 0);

  // The day boundary, same rule: 23:59:59.999 on 06-09 is not 06-10.
  const midnight = storeWith([["r-midnight", "2026-06-09T20:00:00.000Z", "2026-06-09T23:59:59.999Z"]]);
  const daily = read(midnight, "7d");
  assert.equal(at(daily.buckets, "2026-06-09T00:00:00.000Z"), 1);
  assert.equal(at(daily.buckets, "2026-06-10T00:00:00.000Z"), 0);
});

test("a run that STARTED in an earlier bucket counts in the bucket it COMPLETED in", () => {
  // Two days of work, finishing this morning. The days it ran through are not
  // days it completed in, and must stay at zero.
  const home = storeWith([["r-long", "2026-06-08T01:00:00.000Z", "2026-06-10T09:00:00.000Z"]]);
  const daily = read(home, "7d");
  assert.equal(at(daily.buckets, "2026-06-10T00:00:00.000Z"), 1);
  assert.equal(at(daily.buckets, "2026-06-09T00:00:00.000Z"), 0, "a day it merely ran through is not a completion");
  assert.equal(at(daily.buckets, "2026-06-08T00:00:00.000Z"), 0, "the start day is not the completion day");
  assert.equal(daily.totalCompletedRuns, 1);

  // ...and on the hourly grid the same run is counted in the hour it finished,
  // even though its start predates the whole 1d window.
  const hourly = read(home, "1d");
  assert.equal(hourly.totalCompletedRuns, 1);
  assert.equal(at(hourly.buckets, "2026-06-10T09:00:00.000Z"), 1);
});

test("the window's leading edge is the aligned bucket start, and a completion before it is out", () => {
  // The 1d window's grid opens at 2026-06-09T14:00Z (the aligned hour of NOW-1d).
  const home = storeWith([
    ["r-in", "2026-06-09T13:00:00.000Z", "2026-06-09T14:00:00.000Z"],
    ["r-out", "2026-06-09T13:00:00.000Z", "2026-06-09T13:59:59.999Z"],
  ]);
  const hourly = read(home, "1d");
  assert.equal(hourly.rangeStart, "2026-06-09T14:00:00.000Z");
  assert.equal(hourly.totalCompletedRuns, 1, "only the completion at or after the grid start is in the window");
  assert.equal(at(hourly.buckets, "2026-06-09T14:00:00.000Z"), 1);
});

test("a completion in the future is outside every window, and cannot stretch the grid", () => {
  const home = storeWith([
    ["r-now", "2026-06-10T14:00:00.000Z", "2026-06-10T14:20:00.000Z"],
    ["r-skewed", "2026-06-10T14:00:00.000Z", "2026-07-01T00:00:00.000Z"],
  ]);
  for (const window of ["1d", "7d", "30d", "90d", "all"] as const) {
    const trends = read(home, window);
    assert.equal(trends.totalCompletedRuns, 1, window);
    assert.equal(trends.buckets.at(-1)!.partial, true, window);
    assert.ok(Date.parse(trends.buckets.at(-1)!.bucketStart) <= NOW, `${window} must not grid past now`);
  }
});

test("the partial bucket is the one containing now, and it is the only partial one", () => {
  const home = storeWith([["r-today", "2026-06-10T14:00:00.000Z", "2026-06-10T14:29:59.999Z"]]);
  const hourly = read(home, "1d");
  assert.deepEqual(hourly.buckets.filter((b) => b.partial).map((b) => b.bucketStart), ["2026-06-10T14:00:00.000Z"]);
  assert.equal(at(hourly.buckets, "2026-06-10T14:00:00.000Z"), 1);
  assert.equal(hourly.totalCompletedRuns, 1, "the partial bucket's count is in the total");

  const daily = read(home, "30d");
  assert.deepEqual(daily.buckets.filter((b) => b.partial).map((b) => b.bucketStart), ["2026-06-10T00:00:00.000Z"]);

  // The weekly grid: NOW is a Wednesday, so the current bucket is that Monday's week.
  const weekly = read(home, "90d");
  assert.deepEqual(weekly.buckets.filter((b) => b.partial).map((b) => b.bucketStart), ["2026-06-08T00:00:00.000Z"]);
});

test("weekly buckets stay Monday-aligned in UTC whatever the completion's own weekday", () => {
  const home = storeWith([
    ["r-sun", "2026-06-07T00:00:00.000Z", "2026-06-07T23:00:00.000Z"], // Sunday — the week OPENING 2026-06-01
    ["r-mon", "2026-06-08T00:00:00.000Z", "2026-06-08T00:00:00.000Z"], // Monday 00:00 — opens 2026-06-08
  ]);
  const weekly = read(home, "90d");
  assert.equal(at(weekly.buckets, "2026-06-01T00:00:00.000Z"), 1);
  assert.equal(at(weekly.buckets, "2026-06-08T00:00:00.000Z"), 1);
  assert.equal(weekly.totalCompletedRuns, 2);
  for (const b of weekly.buckets) {
    assert.equal(new Date(b.bucketStart).getUTCDay(), 1, `${b.bucketStart} must be a UTC Monday`);
    assert.equal(new Date(b.bucketStart).toISOString().slice(11), "00:00:00.000Z");
  }
});
