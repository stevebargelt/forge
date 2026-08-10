// FG-683: completed forge runs per bucket. Mirrors the queries-agent-runtime
// harness — seed a temp forge.db, then exercise the read-only query with an
// injected `nowMs` so every bucket boundary is pinned rather than observed.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qcompleted-"));
process.env.FORGE_HOME = tmpHome;

const { completedRunTrends } = await import("./queries.js");

// The same Wednesday mid-hour the duration suite pins, so the two metrics'
// bucket grids can be compared directly.
const NOW = Date.parse("2026-06-10T14:30:00Z");

const SCHEMA = `
  CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT, completed_at TEXT);
  CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
  CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  CREATE TABLE gates (id TEXT PRIMARY KEY, task_id TEXT, decision TEXT, rationale TEXT, decided_at TEXT, decided_by TEXT);
  CREATE TABLE host_verifications (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT, project_dir TEXT, commit_sha TEXT, gate_name TEXT, command TEXT, exit_code INTEGER, run_id TEXT, recorded_at TEXT, source TEXT, ci_url TEXT);
`;

{
  const db = new Database(join(tmpHome, "forge.db"));
  db.exec(`
    ${SCHEMA}

    -- 2026-06-09, a whole day inside 7d/30d and outside 1d. Three completions,
    -- across three different non-orchestrator workflows.
    INSERT INTO runs VALUES ('r-feature','Feature','feature','/proj/a','complete','2026-06-08T00:00:00Z','2026-06-09T09:00:00Z');
    INSERT INTO runs VALUES ('r-invoke','Invoke','invoke','/proj/a','complete','2026-06-09T10:00:00Z','2026-06-09T10:30:00Z');
    INSERT INTO runs VALUES ('r-review','Review','review','/proj/a','complete','2026-06-09T11:00:00Z','2026-06-09T11:30:00Z');

    -- Today (2026-06-10), inside the partial day AND the partial hour.
    INSERT INTO runs VALUES ('r-today','Today','feature','/proj/a','complete','2026-06-10T14:00:00Z','2026-06-10T14:10:00Z');

    -- Never counted, one per exclusion:
    INSERT INTO runs VALUES ('r-active','Active','feature','/proj/a','active','2026-06-09T12:00:00Z',NULL);
    INSERT INTO runs VALUES ('r-failed','Failed','feature','/proj/a','failed','2026-06-09T12:00:00Z','2026-06-09T12:30:00Z');
    INSERT INTO runs VALUES ('r-abandoned','Abandoned','feature','/proj/a','abandoned','2026-06-09T12:00:00Z','2026-06-09T12:40:00Z');
    INSERT INTO runs VALUES ('r-awaiting','Awaiting','feature','/proj/a','awaiting_gate','2026-06-09T12:00:00Z','2026-06-09T12:50:00Z');
    INSERT INTO runs VALUES ('r-complete-ish','Completed','feature','/proj/a','completed','2026-06-09T12:00:00Z','2026-06-09T12:55:00Z');
    -- complete, but with no completion timestamp at all, and with an unparseable one.
    INSERT INTO runs VALUES ('r-no-stamp','No stamp','feature','/proj/a','complete','2026-06-09T13:00:00Z',NULL);
    INSERT INTO runs VALUES ('r-bad-stamp','Bad stamp','feature','/proj/a','complete','2026-06-09T13:00:00Z','not-a-timestamp');
    -- the interactive orchestrator's own instrumentation run.
    INSERT INTO runs VALUES ('r-orch','Orchestrator session','orchestrator','/proj/a','complete','2026-06-09T08:00:00Z','2026-06-09T20:00:00Z');

    -- Another project, for the scope tests: one completion on 2026-06-09.
    INSERT INTO runs VALUES ('r-other','Other','feature','/proj/b','complete','2026-06-09T09:00:00Z','2026-06-09T09:30:00Z');
  `);
  db.close();
}

const bucket = (buckets: readonly { bucketStart: string; completedRuns: number }[], iso: string) =>
  buckets.find((b) => b.bucketStart === iso);

test("completedRunTrends: one observation per completed non-orchestrator run", () => {
  const trends = completedRunTrends("7d", "/proj/a", NOW);
  const day = bucket(trends.buckets, "2026-06-09T00:00:00.000Z")!;
  assert.equal(day.completedRuns, 3, "feature + invoke + review all count");
  assert.equal(bucket(trends.buckets, "2026-06-10T00:00:00.000Z")!.completedRuns, 1);
  assert.equal(trends.totalCompletedRuns, 4);
});

test("completedRunTrends: every non-complete status contributes zero", () => {
  const trends = completedRunTrends("7d", "/proj/a", NOW);
  // active, failed, abandoned, awaiting_gate and the near-miss 'completed' all
  // carry a 2026-06-09 completion stamp; only the three real ones may count.
  assert.equal(bucket(trends.buckets, "2026-06-09T00:00:00.000Z")!.completedRuns, 3);
  assert.equal(trends.totalCompletedRuns, 4);
});

test("completedRunTrends: an absent or unparseable completed_at contributes zero", () => {
  const trends = completedRunTrends("all", "/proj/a", NOW);
  // Both rows are status=complete. Neither may place a run in any bucket, and
  // neither may drag the derived range start back to its created_at.
  assert.equal(trends.totalCompletedRuns, 4);
  assert.equal(trends.rangeStart, "2026-06-08T00:00:00.000Z");
});

test("completedRunTrends: orchestrator-workflow runs contribute zero", () => {
  const trends = completedRunTrends("7d", "/proj/a", NOW);
  assert.equal(bucket(trends.buckets, "2026-06-09T00:00:00.000Z")!.completedRuns, 3,
    "the orchestrator session completes on 06-09 and must not be the fourth");
});

test("completedRunTrends: a run with a NULL workflow is not read as an orchestrator run", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-qcompleted-null-wf-"));
  const db = new Database(join(home, "forge.db"));
  db.exec(`
    ${SCHEMA}
    INSERT INTO runs VALUES ('r-null-wf','Legacy',NULL,'/proj/null','complete','2026-06-09T09:00:00Z','2026-06-09T09:30:00Z');
  `);
  db.close();

  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    // `workflow != 'orchestrator'` is NULL for a NULL workflow, which silently
    // drops the row; the null-safe form keeps it.
    assert.equal(completedRunTrends("7d", "/proj/null", NOW).totalCompletedRuns, 1);
  } finally {
    process.env.FORGE_HOME = previous;
  }
});

test("completedRunTrends: one run counts once however many rows hang off it", () => {
  const home = mkdtempSync(join(tmpdir(), "forge-qcompleted-dedupe-"));
  const db = new Database(join(home, "forge.db"));
  db.exec(`
    ${SCHEMA}
    INSERT INTO runs VALUES ('r-fat','Fat run','feature','/proj/fat','complete','2026-06-09T08:00:00Z','2026-06-09T09:00:00Z');

    -- Four primary tasks, one of them retried in place, plus two fanout children.
    INSERT INTO tasks VALUES ('k1','r-fat','planning','tech-lead','complete',NULL,'2026-06-09T08:00:00Z','2026-06-09T08:10:00Z');
    INSERT INTO tasks VALUES ('k2','r-fat','implementation','engineer','complete',NULL,'2026-06-09T08:10:00Z','2026-06-09T08:30:00Z');
    INSERT INTO tasks VALUES ('k3','r-fat','verify','test-engineer','complete',NULL,'2026-06-09T08:30:00Z','2026-06-09T08:45:00Z');
    INSERT INTO tasks VALUES ('k4','r-fat','review','red-wide','complete',NULL,'2026-06-09T08:45:00Z','2026-06-09T09:00:00Z');
    INSERT INTO tasks VALUES ('k5','r-fat','review','red-narrow','complete','k4','2026-06-09T08:45:00Z','2026-06-09T08:50:00Z');
    INSERT INTO tasks VALUES ('k6','r-fat','review','red-security','complete','k4','2026-06-09T08:45:00Z','2026-06-09T08:52:00Z');

    -- Retry / lifecycle events, three gate decisions, and two host-verification rows.
    INSERT INTO events (run_id,task_id,event_type,payload,created_at) VALUES ('r-fat','k2','task.retried','{}','2026-06-09T08:20:00Z');
    INSERT INTO events (run_id,task_id,event_type,payload,created_at) VALUES ('r-fat','k2','container.exited','{}','2026-06-09T08:30:00Z');
    INSERT INTO events (run_id,task_id,event_type,payload,created_at) VALUES ('r-fat',NULL,'run.completed','{}','2026-06-09T09:00:00Z');
    INSERT INTO gates VALUES ('g1','k2','approve',NULL,'2026-06-09T08:31:00Z','operator');
    INSERT INTO gates VALUES ('g2','k3','approve',NULL,'2026-06-09T08:46:00Z','operator');
    INSERT INTO gates VALUES ('g3','k4','approve',NULL,'2026-06-09T09:00:00Z','operator');
    INSERT INTO host_verifications (ticket_id,project_dir,commit_sha,gate_name,command,exit_code,run_id,recorded_at,source)
      VALUES ('FG-1','/proj/fat','abc','tests','npm test',0,'r-fat','2026-06-09T08:55:00Z','host');
    INSERT INTO host_verifications (ticket_id,project_dir,commit_sha,gate_name,command,exit_code,run_id,recorded_at,source)
      VALUES ('FG-1','/proj/fat','abc','typecheck','tsc',0,'r-fat','2026-06-09T08:56:00Z','host');
  `);
  db.close();

  const previous = process.env.FORGE_HOME;
  process.env.FORGE_HOME = home;
  try {
    const trends = completedRunTrends("7d", "/proj/fat", NOW);
    assert.equal(trends.totalCompletedRuns, 1, "6 tasks + a retry + 3 gates + 2 verifications is still ONE run");
    assert.equal(bucket(trends.buckets, "2026-06-09T00:00:00.000Z")!.completedRuns, 1);
  } finally {
    process.env.FORGE_HOME = previous;
  }
});

test("completedRunTrends: project scope is applied through runs.project_dir", () => {
  assert.equal(completedRunTrends("7d", "/proj/b", NOW).totalCompletedRuns, 1);
  // The canonical-repository form: every observed checkout of one repository.
  assert.equal(completedRunTrends("7d", ["/proj/a", "/proj/b"], NOW).totalCompletedRuns, 5);
  assert.equal(completedRunTrends("7d", undefined, NOW).totalCompletedRuns, 5);
  assert.equal(completedRunTrends("7d", [], NOW).totalCompletedRuns, 0);

  // A scoped chart's derived range cannot be moved by another project either:
  // /proj/b's only completion is on 06-09, so 'all' starts in that Monday's week.
  const scoped = completedRunTrends("all", "/proj/b", NOW);
  assert.equal(scoped.rangeStart, "2026-06-08T00:00:00.000Z");
  assert.equal(scoped.totalCompletedRuns, 1);
});

test("completedRunTrends: the window choices and their resolutions are the runtime chart's", () => {
  const expected = [
    { window: "1d", resolution: "hour", bucketMs: 3_600_000, rangeStart: "2026-06-09T14:00:00.000Z", length: 25 },
    { window: "7d", resolution: "day", bucketMs: 86_400_000, rangeStart: "2026-06-03T00:00:00.000Z", length: 8 },
    { window: "30d", resolution: "day", bucketMs: 86_400_000, rangeStart: "2026-05-11T00:00:00.000Z", length: 31 },
    { window: "90d", resolution: "week", bucketMs: 604_800_000, rangeStart: "2026-03-09T00:00:00.000Z", length: null },
    { window: "all", resolution: "week", bucketMs: 604_800_000, rangeStart: "2026-06-08T00:00:00.000Z", length: 1 },
  ] as const;
  for (const spec of expected) {
    const trends = completedRunTrends(spec.window, "/proj/a", NOW);
    assert.equal(trends.window, spec.window);
    assert.equal(trends.resolution, spec.resolution, spec.window);
    assert.equal(trends.bucketMs, spec.bucketMs, spec.window);
    assert.equal(trends.rangeStart, spec.rangeStart, spec.window);
    assert.equal(trends.rangeEnd, new Date(NOW).toISOString());
    if (spec.length !== null) assert.equal(trends.buckets.length, spec.length, spec.window);

    const starts = trends.buckets.map((b) => Date.parse(b.bucketStart));
    assert.deepEqual(starts, [...starts].sort((a, b) => a - b), `${spec.window} must ascend`);
    for (let i = 1; i < starts.length; i += 1) {
      assert.equal(starts[i]! - starts[i - 1]!, spec.bucketMs, `${spec.window} buckets must be contiguous`);
    }
    // UTC alignment: every bucket start is a whole multiple of the bucket size
    // off the same UTC-aligned origin.
    for (const start of starts) {
      assert.equal((start - Date.parse(spec.rangeStart)) % spec.bucketMs, 0, `${spec.window} must stay UTC-aligned`);
    }
    assert.equal(trends.buckets.filter((b) => b.partial).length, 1, spec.window);
    assert.equal(trends.buckets.at(-1)!.partial, true, spec.window);
  }
});

test("completedRunTrends: an empty bucket is zero, never a missing sample", () => {
  const trends = completedRunTrends("7d", "/proj/a", NOW);
  const empties = trends.buckets.filter((b) => b.completedRuns === 0);
  assert.ok(empties.length > 0, "the fixture has days with no completions");
  for (const b of trends.buckets) {
    assert.equal(typeof b.completedRuns, "number");
    assert.notEqual(b.completedRuns, null);
  }
  assert.deepEqual(trends.buckets.map((b) => b.completedRuns), [0, 0, 0, 0, 0, 0, 3, 1]);
});

test("completedRunTrends: the range total is the sum of its buckets, partial included", () => {
  for (const window of ["1d", "7d", "30d", "90d", "all"] as const) {
    const trends = completedRunTrends(window, "/proj/a", NOW);
    const summed = trends.buckets.reduce((total, b) => total + b.completedRuns, 0);
    assert.equal(trends.totalCompletedRuns, summed, window);
    const partial = trends.buckets.find((b) => b.partial);
    assert.ok(partial, `${window} must have a current bucket`);
    assert.ok(partial.completedRuns > 0, `${window}'s partial bucket carries r-today, and the total must include it`);
  }
  assert.equal(completedRunTrends("1d", "/proj/a", NOW).totalCompletedRuns, 1);
});

test("completedRunTrends: nothing in scope means no range and no buckets", () => {
  const trends = completedRunTrends("all", "/proj/nothing", NOW);
  assert.equal(trends.rangeStart, null);
  assert.deepEqual(trends.buckets, []);
  assert.equal(trends.totalCompletedRuns, 0);
  assert.equal(trends.rangeEnd, new Date(NOW).toISOString());
});

// The presentation timezone is a CLIENT concern; the query is the thing that
// decides bucket membership, and it must be blind to the reader's clock. The
// browser tier proves the toggle only moves labels — this proves there is
// nothing underneath it that could move.
test("completedRunTrends: the reader's timezone changes nothing about counts, buckets, range or total", () => {
  const previous = process.env.TZ;
  const readIn = (tz: string) => {
    process.env.TZ = tz;
    return completedRunTrends("7d", "/proj/a", NOW);
  };
  try {
    const utc = readIn("UTC");
    for (const tz of ["America/Los_Angeles", "Asia/Kolkata", "Pacific/Kiritimati"]) {
      assert.deepEqual(readIn(tz), utc, `${tz} must read exactly what UTC reads`);
    }
    // ...and the process clock really did move, or the three reads above compared
    // UTC with itself three times and proved nothing.
    process.env.TZ = "Asia/Kolkata";
    assert.equal(new Date(NOW).getHours(), 20, "14:30 UTC is 20:00 in Asia/Kolkata");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
