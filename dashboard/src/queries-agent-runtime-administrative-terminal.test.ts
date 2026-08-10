// FG-662 verify: layer 2 — HOW a terminal is judged administrative, and what the
// exclusions do to the rest of the payload.
//
// The sibling FG-662 suite seeds one well-formed `task.failed` per failed task,
// with a `failure_kind` that is always a plain lowercase string, and reads the
// result mostly through `roleSummary`. So it cannot answer:
//
//   - a failed row with NO task.failed event, or one whose payload is NULL,
//     truncated, not JSON, or carries a non-string `failure_kind`. Every one of
//     these is a real shape in a store written across forge versions, and the
//     rule must degrade WITHOUT throwing and without silently excluding a row
//     whose kind simply could not be read;
//   - which `task.failed` decides when a task has several — a retried task has
//     one per attempt — and what happens when two share a created_at;
//   - whether `status` really is the discriminator: a row that is not `failed`
//     must never be excluded by a kind sitting on its stream;
//   - whether the exclusions reach the per-role SERIES and the weighted role
//     summary, not just the overall line;
//   - what an emptied bucket reports. A bucket whose only row was excluded must
//     read as a gap (`sampleCount: 0`, `averageMs: null`), never as a zero-
//     duration observation, and must still occupy its slot in the grid;
//   - the derived `all` start, which is taken from completed_at — so a surviving
//     row whose EXIT is weeks older must not stretch the range backwards, and a
//     scope containing nothing but artifacts must have no range at all.
//
// Each case gets an isolated store; nothing is shared but the clock.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBucket, AgentRuntimeWindow, ProjectScope } from "./queries.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-admin-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

const NOW = Date.parse("2026-06-10T14:30:00Z");
const PROJECT = "/proj/admin-terminal";
const DAY = "2026-06-09";
const DAY_BUCKET = "2026-06-09T00:00:00.000Z";
const PREV_DAY = "2026-06-08";
const PREV_BUCKET = "2026-06-08T00:00:00.000Z";
const EMPTY_BUCKET = "2026-06-07T00:00:00.000Z";

const MINUTE = 60_000;
const HOUR = 3_600_000;

type EventRow = { type: string; at: string; payload?: string | null };

type TaskRow = {
  id: string;
  role: string;
  status?: string;
  phase?: string | null;
  started: string;
  completed: string;
  events?: EventRow[];
  project?: string;
};

let storeSeq = 0;

const runIdFor = (project: string) => `r${project.replace(/[^a-z0-9]/gi, "")}`;

function withTasks<T>(tasks: TaskRow[], fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `forge-qruntime-admin-${storeSeq++}-`));
  const database = new Database(join(home, "forge.db"));
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  `);
  const insertRun = database.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)");
  const insertTask = database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  const insertEvent = database.prepare(
    "INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)",
  );

  for (const project of new Set(tasks.map((t) => t.project ?? PROJECT))) {
    insertRun.run(runIdFor(project), project, "feature", project, "complete", "2026-01-01T00:00:00Z");
  }

  for (const row of tasks) {
    const runId = runIdFor(row.project ?? PROJECT);
    insertTask.run(
      row.id, runId, row.phase === undefined ? "implementation" : row.phase, row.role,
      row.status ?? "failed", null, row.started, row.completed,
    );
    // Insertion order is id order, which the same-created_at tie-break turns on.
    for (const event of row.events ?? []) {
      insertEvent.run(runId, row.id, event.type, event.payload ?? null, event.at);
    }
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

const trends = (window: AgentRuntimeWindow = "7d", scope: ProjectScope = PROJECT) =>
  agentRuntimeTrends(window, scope, NOW);

const at = (buckets: readonly AgentRuntimeBucket[], iso: string): AgentRuntimeBucket => {
  const found = buckets.find((b) => b.bucketStart === iso);
  assert.ok(found, `no bucket at ${iso}; got ${buckets.map((b) => b.bucketStart).join(", ")}`);
  return found;
};

const totalSamples = (buckets: readonly AgentRuntimeBucket[]) =>
  buckets.reduce((sum, b) => sum + b.sampleCount, 0);

const failedAt = (isoAt: string, payload: string | null): EventRow => ({ type: "task.failed", at: isoAt, payload });

const kindAt = (kind: string, isoAt: string): EventRow =>
  failedAt(isoAt, JSON.stringify({ failure_kind: kind, error: kind }));

const exitedAt = (isoAt: string): EventRow => ({
  type: "container.exited",
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t", exitCode: 0 }),
});

// FG-690: layer 1 reads an exit only for an attempt that has start evidence, so
// each fixture whose premise is "the supervisor watched a real container stop"
// says so. See queries-agent-runtime-start-evidence for the absence case.
const startedAt = (isoAt: string): EventRow => ({
  type: "container.started",
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t" }),
});

/** `{ started, completed }` for a run of `durationMs` ending at `completedIso`. */
const ending = (completedIso: string, durationMs: number) => ({
  started: new Date(Date.parse(completedIso) - durationMs).toISOString(),
  completed: completedIso,
});

// ── an unreadable kind is not an administrative kind ──

test("a failed row with NO task.failed event at all keeps its completed_at span", () => {
  // reconcile can move a task to `failed` and lose the event write; the row
  // still describes a real supervised span, so it must not vanish from the chart.
  withTasks(
    [{ id: "kindless", role: "engineer", status: "failed", ...ending(`${DAY}T10:00:00.000Z`, 25 * MINUTE) }],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("a task.failed whose payload is missing, malformed or kindless degrades without throwing or excluding", () => {
  const payloads: Array<string | null> = [
    null,
    "",
    "{",
    "{\"failure_kind\": \"cancelled\"",   // truncated mid-object
    "not json at all",
    "{}",
    "{\"error\":\"boom\"}",
    "null",
    "[]",
    "\"cancelled\"",                       // a bare JSON string, not an object
    "[{\"failure_kind\":\"cancelled\"}]",  // the kind is real but nested in an array
  ];
  for (const payload of payloads) {
    withTasks(
      [
        {
          id: "t", role: "engineer", status: "failed",
          ...ending(`${DAY}T10:00:00.000Z`, 25 * MINUTE),
          events: [failedAt(`${DAY}T10:00:00.000Z`, payload)],
        },
      ],
      () => {
        assert.deepEqual(
          trends().roleSummary,
          [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }],
          `payload ${JSON.stringify(payload)} must leave the row counted, not excluded`,
        );
      },
    );
  }
});

test("a failure_kind that is not a string is not a kind", () => {
  for (const value of ["42", "null", "true", "[\"cancelled\"]", "{\"name\":\"cancelled\"}"]) {
    withTasks(
      [
        {
          id: "t", role: "engineer", status: "failed",
          ...ending(`${DAY}T10:00:00.000Z`, 25 * MINUTE),
          events: [failedAt(`${DAY}T10:00:00.000Z`, `{"failure_kind": ${value}}`)],
        },
      ],
      () => {
        assert.deepEqual(
          trends().roleSummary,
          [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }],
          `failure_kind: ${value} is unreadable, so the row keeps its span`,
        );
      },
    );
  }
});

test("kind matching is exact — case and whitespace variants are NOT administrative", () => {
  // Pinned as observed. forge writes these kinds from a union type, so a variant
  // here means data forge did not write; the rule counts it rather than guessing.
  for (const kind of ["Cancelled", "CANCELLED", " cancelled", "cancelled ", "cancelled\n", "gate-rejected"]) {
    withTasks(
      [
        {
          id: "t", role: "engineer", status: "failed",
          ...ending(`${DAY}T10:00:00.000Z`, 25 * MINUTE),
          events: [kindAt(kind, `${DAY}T10:00:00.000Z`)],
        },
      ],
      () => {
        assert.deepEqual(
          trends().roleSummary,
          [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }],
          `${JSON.stringify(kind)} is not one of the administrative kinds`,
        );
      },
    );
  }
});

// ── which task.failed decides ──

test("the LATEST task.failed decides, in both directions", () => {
  // An attempt that was cancelled and then re-dispatched into a real crash keeps
  // its span; one that crashed and was then swept keeps nothing.
  withTasks(
    [
      {
        id: "cancel-then-crash", role: "engineer", status: "failed",
        ...ending(`${DAY}T10:00:00.000Z`, 25 * MINUTE),
        events: [kindAt("cancelled", `${DAY}T09:00:00.000Z`), kindAt("container_crash", `${DAY}T10:00:00.000Z`)],
      },
      {
        id: "crash-then-sweep", role: "tech-lead", status: "failed",
        ...ending(`${DAY}T11:00:00.000Z`, 30 * HOUR),
        events: [kindAt("container_crash", `${DAY}T09:00:00.000Z`), kindAt("orphaned", `${DAY}T11:00:00.000Z`)],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("with two task.failed rows at the SAME instant the last-written one decides", () => {
  const sameInstant = `${DAY}T10:00:00.000Z`;
  withTasks(
    [
      {
        id: "admin-last", role: "engineer", status: "failed",
        ...ending(sameInstant, 20 * HOUR),
        events: [kindAt("container_crash", sameInstant), kindAt("cancelled", sameInstant)],
      },
    ],
    () => assert.deepEqual(trends().roleSummary, [], "the later-written administrative kind wins the tie"),
  );

  withTasks(
    [
      {
        id: "supervised-last", role: "engineer", status: "failed",
        ...ending(sameInstant, 20 * MINUTE),
        events: [kindAt("cancelled", sameInstant), kindAt("container_crash", sameInstant)],
      },
    ],
    () => assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 20 * MINUTE, sampleCount: 1 }]),
  );
});

// ── status is the discriminator ──

test("only status='failed' consults the failure kind", () => {
  // A leftover task.failed from an earlier attempt sits on the stream of a task
  // that reached any other terminal. None of them may be excluded by it.
  for (const status of ["complete", "cancelled", "blocked", "reconciled", "awaiting_gate"]) {
    withTasks(
      [
        {
          id: "t", role: "engineer", status,
          ...ending(`${DAY}T10:00:00.000Z`, 25 * MINUTE),
          events: [kindAt("cancelled", `${DAY}T09:00:00.000Z`)],
        },
      ],
      () => {
        assert.deepEqual(
          trends().roleSummary,
          [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }],
          `status='${status}' is not a failed terminal`,
        );
      },
    );
  }
});

// ── layer 1 over layer 2 ──

test("an attached exit outranks an administrative kind even from an earlier bucket", () => {
  withTasks(
    [
      {
        id: "swept", role: "engineer", status: "failed",
        started: `${PREV_DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
        events: [startedAt(`${PREV_DAY}T09:00:00.000Z`), exitedAt(`${PREV_DAY}T09:35:00.000Z`), kindAt("orphaned_work_may_persist", `${DAY}T12:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.equal(at(result.overall, DAY_BUCKET).sampleCount, 1, "placed by completed_at");
      assert.equal(at(result.overall, DAY_BUCKET).averageMs, 35 * MINUTE, "measured from the exit");
      assert.equal(at(result.overall, PREV_BUCKET).sampleCount, 0);
      assert.deepEqual(result.roleSummary, [{ role: "engineer", averageMs: 35 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("oom_killed counts when the supervisor logged the exit and is dropped when only a sweep saw it", () => {
  // The code's own claim about oom_killed: the attached-exit variety carries an
  // event and never reaches the kind check; reconcile's variety has nothing.
  withTasks(
    [
      {
        id: "oom-attached", role: "engineer", status: "failed",
        ...ending(`${DAY}T10:00:00.000Z`, 18 * MINUTE),
        events: [startedAt(`${DAY}T09:42:00.000Z`), exitedAt(`${DAY}T10:00:00.000Z`), kindAt("oom_killed", `${DAY}T10:00:00.000Z`)],
      },
      {
        id: "oom-swept", role: "tech-lead", status: "failed",
        ...ending(`${DAY}T11:00:00.000Z`, 60 * HOUR),
        events: [kindAt("oom_killed", `${DAY}T11:00:00.000Z`)],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 18 * MINUTE, sampleCount: 1 }]);
    },
  );
});

// ── what the exclusions do to the rest of the payload ──

test("the per-role SERIES and the weighted summary both carry the corrected durations", () => {
  withTasks(
    [
      // 06-08: a cancelled row whose exit says ten minutes.
      {
        id: "e1", role: "engineer", status: "failed",
        started: `${PREV_DAY}T09:00:00.000Z`, completed: `${PREV_DAY}T20:00:00.000Z`,
        events: [startedAt(`${PREV_DAY}T09:00:00.000Z`), exitedAt(`${PREV_DAY}T09:10:00.000Z`), kindAt("cancelled", `${PREV_DAY}T20:00:00.000Z`)],
      },
      // 06-09: two real runs and one artifact that contributes nothing.
      { id: "e2", role: "engineer", status: "complete", ...ending(`${DAY}T10:00:00.000Z`, 20 * MINUTE) },
      {
        id: "e3", role: "engineer", status: "failed",
        ...ending(`${DAY}T10:30:00.000Z`, 100 * HOUR),
        events: [kindAt("cancelled", `${DAY}T10:30:00.000Z`)],
      },
      { id: "e4", role: "engineer", status: "complete", ...ending(`${DAY}T11:00:00.000Z`, 40 * MINUTE) },
      // A role every one of whose rows is an artifact.
      {
        id: "l1", role: "tech-lead", status: "failed",
        ...ending(`${DAY}T12:00:00.000Z`, 200 * HOUR),
        events: [kindAt("gate_rejected", `${DAY}T12:00:00.000Z`)],
      },
      {
        id: "l2", role: "tech-lead", status: "failed",
        ...ending(`${DAY}T13:00:00.000Z`, 300 * HOUR),
        events: [kindAt("fanout_wave_orphaned", `${DAY}T13:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      // 10 + 20 + 40 minutes over three surviving observations.
      assert.deepEqual(result.roleSummary, [{ role: "engineer", averageMs: 1_400_000, sampleCount: 3 }]);
      assert.deepEqual(result.byRole.map((s) => s.role), ["engineer"], "a fully-excluded role has no series at all");

      const engineer = result.byRole[0]!.buckets;
      assert.equal(at(engineer, PREV_BUCKET).sampleCount, 1);
      assert.equal(at(engineer, PREV_BUCKET).averageMs, 10 * MINUTE, "the exit-derived duration, not eleven hours");
      assert.equal(at(engineer, DAY_BUCKET).sampleCount, 2);
      assert.equal(at(engineer, DAY_BUCKET).averageMs, 30 * MINUTE, "the artifact is not in this mean");

      // overall and the role series describe the same observations.
      assert.equal(at(result.overall, DAY_BUCKET).averageMs, 30 * MINUTE);
      assert.equal(totalSamples(result.overall), 3);
      assert.equal(totalSamples(engineer), totalSamples(result.overall));
    },
  );
});

test("a bucket emptied by exclusion reads as a gap, never as a zero-duration sample", () => {
  withTasks(
    [
      // 06-07's ONLY row is an artifact.
      {
        id: "only-artifact", role: "engineer", status: "failed",
        ...ending("2026-06-07T12:00:00.000Z", 400 * HOUR),
        events: [kindAt("verification_environment_unavailable", "2026-06-07T12:00:00.000Z")],
      },
      { id: "real", role: "engineer", status: "complete", ...ending(`${PREV_DAY}T12:00:00.000Z`, 15 * MINUTE) },
    ],
    () => {
      const result = trends();
      const emptied = at(result.overall, EMPTY_BUCKET);
      assert.equal(emptied.sampleCount, 0);
      assert.equal(emptied.averageMs, null, "an emptied bucket is null, exactly like a bucket that never had a row");
      assert.equal(emptied.partial, false);
      assert.equal(result.overall.length, 8, "the grid keeps its slot");
      assert.equal(at(result.overall, PREV_BUCKET).sampleCount, 1, "the neighbouring real bucket is untouched");
      assert.equal(at(result.overall, PREV_BUCKET).averageMs, 15 * MINUTE);
      for (const b of result.overall) {
        assert.equal(b.sampleCount === 0, b.averageMs === null, `${b.bucketStart}: null average iff no samples`);
      }
    },
  );
});

// ── the derived 'all' range ──

test("'all' starts at the surviving row's completed_at bucket, not at its much older exit", () => {
  withTasks(
    [
      {
        id: "long-abandoned-container", role: "engineer", status: "failed",
        started: "2026-05-20T09:00:00.000Z", completed: `${DAY}T09:00:00.000Z`,
        events: [startedAt("2026-05-20T09:00:00.000Z"), exitedAt("2026-05-20T09:12:00.000Z"), kindAt("cancelled", `${DAY}T09:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends("all");
      // 2026-06-09 is a Tuesday; its week opens Monday 2026-06-08. The exit's own
      // week (2026-05-18) would have opened the grid three weeks earlier.
      assert.equal(result.rangeStart, "2026-06-08T00:00:00.000Z");
      assert.equal(result.overall.length, 1);
      assert.equal(result.overall[0]!.sampleCount, 1);
      assert.equal(result.overall[0]!.averageMs, 12 * MINUTE);
    },
  );
});

test("'all' over a scope containing nothing but artifacts has no range and no grid", () => {
  withTasks(
    [
      {
        id: "a1", role: "engineer", status: "failed",
        ...ending(`${DAY}T09:00:00.000Z`, 500 * HOUR),
        events: [kindAt("cancelled", `${DAY}T09:00:00.000Z`)],
      },
      {
        id: "a2", role: "tech-lead", status: "failed",
        ...ending(`${DAY}T10:00:00.000Z`, 600 * HOUR),
        events: [kindAt("pre_container_crash", `${DAY}T10:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends("all");
      assert.equal(result.rangeStart, null, "no observation means no derived range");
      assert.deepEqual(result.overall, []);
      assert.deepEqual(result.byRole, []);
      assert.deepEqual(result.roleSummary, []);
      assert.equal(result.rangeEnd, new Date(NOW).toISOString());
    },
  );
});

test("a fixed window with nothing but artifacts still returns its full grid of gaps", () => {
  withTasks(
    [
      {
        id: "a1", role: "engineer", status: "failed",
        ...ending(`${DAY}T09:00:00.000Z`, 500 * HOUR),
        events: [kindAt("orphaned_needs_finalize", `${DAY}T09:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends("7d");
      assert.equal(result.rangeStart, "2026-06-03T00:00:00.000Z");
      assert.equal(result.overall.length, 8, "a fixed window's grid does not depend on having observations");
      assert.equal(totalSamples(result.overall), 0);
      assert.ok(result.overall.every((b) => b.averageMs === null));
      assert.deepEqual(result.byRole, []);
      assert.deepEqual(result.roleSummary, []);
    },
  );
});
