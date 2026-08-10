// FG-662 verify: WHICH event becomes the agent-observed end, and what the
// duration derived from it is allowed to do.
//
// The sibling FG-662 suite proves the two layers exist — an attached-exit event
// beats a rewritten completed_at, an administrative terminal without one is
// dropped. Every row it seeds carries at most ONE exit event, at a sane
// timestamp, in the same bucket as its completed_at. So the questions it cannot
// answer are the ones that decide what the derived duration actually means:
//
//   - with SEVERAL attached-exit events on a task (a re-dispatch that logged
//     container.exited twice, an idle_timeout followed by an exited), which one
//     wins — and is the choice a timestamp choice or an insertion-order choice?
//     They differ, and only one of them is defensible;
//   - `container.killed` logged BEFORE a real container.exited: the killed row
//     is lexically earlier, so a selection that did not filter by event type
//     would silently prefer it;
//   - an exit event EARLIER than started_at — the shape a retried task actually
//     has, because markTaskRunning resets started_at while the previous
//     attempt's container.exited stays on the stream. Such an exit belongs to a
//     span the row no longer describes, so it is not the end of the attempt
//     being measured;
//   - an exit event that does not parse sitting next to one that does: the junk
//     row may not mask its valid sibling, because the fall-through is silent;
//   - an exit event in a DIFFERENT bucket than completed_at. Bucket placement
//     stays on completed_at and only the duration moves — the single most
//     confusing consequence of the design, and the one nothing may quietly
//     change later;
//   - an exit event LATER than completed_at, which makes the derived duration
//     exceed the wall-clock span the row itself describes;
//   - an exit timestamp that does not parse, and the fall-through to layer 2
//     that must not throw;
//   - exit events belonging to a DIFFERENT task, or to no task at all.
//
// Every case gets its own isolated store so one fixture's event stream cannot
// satisfy another's assertion.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBucket, AgentRuntimeWindow, ProjectScope } from "./queries.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-agentend-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

// The instant every FG-648/FG-662 suite pins to: a Wednesday, mid-hour.
const NOW = Date.parse("2026-06-10T14:30:00Z");
const PROJECT = "/proj/agent-end";
const DAY = "2026-06-09";
const DAY_BUCKET = "2026-06-09T00:00:00.000Z";
const PRIOR_BUCKET = "2026-06-07T00:00:00.000Z";

const MINUTE = 60_000;

type EventRow = {
  type: string;
  /** written into events.created_at verbatim, including deliberate garbage. */
  at: string;
  payload?: string | null;
  /** overrides the owning task — for the cross-task leakage cases. */
  taskId?: string | null;
};

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
  const home = mkdtempSync(join(tmpdir(), `forge-qruntime-agentend-${storeSeq++}-`));
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
      row.status ?? "complete", null, row.started, row.completed,
    );
    // Insertion order is the events' id order, which is what the "MIN is over
    // created_at, not id" cases turn on.
    for (const event of row.events ?? []) {
      insertEvent.run(
        runId,
        event.taskId === undefined ? row.id : event.taskId,
        event.type,
        event.payload ?? null,
        event.at,
      );
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

const exited = (isoAt: string, type = "container.exited"): EventRow => ({
  type,
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t", exitCode: 0 }),
});

// FG-690: every case below is about WHICH end a genuinely started container is
// measured to, so each fixture that carries an exit also carries the start that
// authorizes it — layer 1 now requires one at or after the attempt's started_at.
// The absence case has its own suite (queries-agent-runtime-start-evidence).
const started = (isoAt: string): EventRow => ({
  type: "container.started",
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t" }),
});

const failedWith = (kind: string, isoAt: string): EventRow => ({
  type: "task.failed",
  at: isoAt,
  payload: JSON.stringify({ failure_kind: kind, error: kind }),
});

// ── which of several attached-exit events wins ──

test("with two container.exited events the EARLIEST supplies the duration", () => {
  // A re-dispatch that logged container.exited twice against the same task row.
  withTasks(
    [
      {
        id: "twice", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          failedWith("cancelled", `${DAY}T12:00:00.000Z`),
          exited(`${DAY}T09:10:00.000Z`),
          exited(`${DAY}T09:40:00.000Z`),
        ],
      },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1);
      assert.equal(day.averageMs, 10 * MINUTE, "MIN(created_at): the first observed exit, not the last");
    },
  );
});

test("the earliest wins ACROSS exit event types — an idle_timeout before a later exited", () => {
  withTasks(
    [
      {
        id: "idle-then-exit", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          failedWith("idle_timeout", `${DAY}T12:00:00.000Z`),
          exited(`${DAY}T09:45:00.000Z`, "container.idle_timeout"),
          exited(`${DAY}T10:30:00.000Z`),
        ],
      },
    ],
    () => {
      assert.equal(at(trends().overall, DAY_BUCKET).averageMs, 45 * MINUTE, "the watchdog saw it stop first");
    },
  );
});

test("the choice is by TIMESTAMP, not by insertion order — the later event written first", () => {
  // Same two exits as the first case, inserted in the opposite order so the
  // earlier timestamp carries the HIGHER events.id. A `LIMIT 1` over id order
  // would answer 40 minutes here and 10 above; MIN answers 10 in both.
  withTasks(
    [
      {
        id: "out-of-order", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          exited(`${DAY}T09:40:00.000Z`),
          exited(`${DAY}T09:10:00.000Z`),
          failedWith("cancelled", `${DAY}T12:00:00.000Z`),
        ],
      },
    ],
    () => {
      assert.equal(at(trends().overall, DAY_BUCKET).averageMs, 10 * MINUTE, "id order must not decide the end");
    },
  );
});

test("a container.killed logged BEFORE a real exit does not pull the end earlier", () => {
  // `forge cancel` kills first and the supervisor logs its exit afterwards, so
  // the killed row is genuinely the lexically-earlier one. It is not in the
  // event-type filter, so the MIN never sees it.
  withTasks(
    [
      {
        id: "killed-then-exited", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          { type: "container.killed", at: `${DAY}T09:05:00.000Z`, payload: JSON.stringify({ via: "forge cancel" }) },
          exited(`${DAY}T09:20:00.000Z`),
          failedWith("cancelled", `${DAY}T13:00:00.000Z`),
        ],
      },
    ],
    () => {
      assert.equal(at(trends().overall, DAY_BUCKET).averageMs, 20 * MINUTE, "container.killed is not an end");
    },
  );
});

test("no other container event is an agent-observed end", () => {
  // Only the four attached-exit types count. Anything else leaves an
  // administrative terminal with no defensible end, so the row is dropped.
  for (const eventType of ["container.started", "container.killed", "container.reaped", "task.completed", "task.reconciled"]) {
    withTasks(
      [
        {
          id: "t", role: "engineer", status: "failed",
          started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
          events: [exited(`${DAY}T09:20:00.000Z`, eventType), failedWith("cancelled", `${DAY}T13:00:00.000Z`)],
        },
      ],
      () => {
        assert.deepEqual(trends().roleSummary, [], `${eventType} must not rescue an administrative terminal`);
      },
    );
  }
});

test("each task reads only its OWN exit events; unattached ones reach nobody", () => {
  withTasks(
    [
      {
        id: "mine", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          exited(`${DAY}T09:30:00.000Z`),
          // An exit for a task row that does not exist, and a run-scoped one
          // attached to no task at all. Both are earlier than every real exit
          // here, so either would shorten a duration if the correlation leaked.
          { ...exited(`${DAY}T09:01:00.000Z`), taskId: "ghost" },
          { ...exited(`${DAY}T09:02:00.000Z`), taskId: null },
          failedWith("cancelled", `${DAY}T13:00:00.000Z`),
        ],
      },
      // A second cancelled row whose own exit is much earlier: its duration must
      // come from ITS event, not from the other task's.
      {
        id: "sibling", role: "tech-lead", status: "failed",
        started: `${DAY}T08:00:00.000Z`, completed: `${DAY}T14:00:00.000Z`,
        events: [started(`${DAY}T08:00:00.000Z`), exited(`${DAY}T08:05:00.000Z`), failedWith("cancelled", `${DAY}T14:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.equal(at(result.overall, DAY_BUCKET).sampleCount, 2, "two rows, and no observation for the ghost event");
      assert.deepEqual(result.roleSummary, [
        { role: "engineer", averageMs: 30 * MINUTE, sampleCount: 1 },
        { role: "tech-lead", averageMs: 5 * MINUTE, sampleCount: 1 },
      ]);
    },
  );
});

// ── an exit that predates started_at: the re-dispatched task ──

test("a retried task is measured from the exit of the attempt it describes, not the prior attempt's", () => {
  // markTaskRunning re-dispatches in place: started_at moves to the second
  // attempt while the first attempt's container.exited stays on the stream. The
  // stale exit belongs to a span this row no longer describes, so the earliest
  // exit AT OR AFTER started_at supplies the duration — the second attempt's
  // real 30 minutes, which nothing else records.
  withTasks(
    [
      {
        id: "retried", role: "engineer",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T11:30:00.000Z`,
        events: [started(`${DAY}T11:00:00.000Z`), exited(`${DAY}T09:10:00.000Z`), exited(`${DAY}T11:30:00.000Z`)],
      },
      { id: "control", role: "tech-lead", started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T11:30:00.000Z` },
    ],
    () => {
      const result = trends();
      const day = at(result.overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 2, "the retried row counts alongside the control");
      assert.equal(day.averageMs, 30 * MINUTE);
      assert.deepEqual(result.roleSummary, [
        { role: "engineer", averageMs: 30 * MINUTE, sampleCount: 1 },
        { role: "tech-lead", averageMs: 30 * MINUTE, sampleCount: 1 },
      ]);
    },
  );
});

test("with a stale exit AND several of its own, a retried task takes the earliest at or after started_at", () => {
  // Two attempts' worth of exits on one stream. The prior attempt's is ignored
  // outright; among the second attempt's own, the earliest still wins.
  withTasks(
    [
      {
        id: "retried-many", role: "engineer", status: "failed",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [
          started(`${DAY}T11:00:00.000Z`),
          exited(`${DAY}T09:10:00.000Z`),
          exited(`${DAY}T11:50:00.000Z`),
          exited(`${DAY}T11:20:00.000Z`, "container.idle_timeout"),
          failedWith("cancelled", `${DAY}T13:00:00.000Z`),
        ],
      },
    ],
    () => {
      assert.equal(at(trends().overall, DAY_BUCKET).averageMs, 20 * MINUTE, "the first observed stop of THIS attempt");
    },
  );
});

test("a prior-attempt exit with no exit of its own leaves the row on layer 2", () => {
  // The second attempt died without the supervisor logging an exit. There is no
  // agent-observed end for the attempt being measured, so the row is treated as
  // having none at all: a supervised terminal still counts at its completed_at
  // span, an administrative one still contributes nothing.
  withTasks(
    [
      {
        id: "stale-supervised", role: "engineer", status: "failed",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T11:40:00.000Z`,
        events: [exited(`${DAY}T09:10:00.000Z`), failedWith("container_crash", `${DAY}T11:40:00.000Z`)],
      },
      {
        id: "stale-administrative", role: "tech-lead", status: "failed",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [exited(`${DAY}T09:10:00.000Z`), failedWith("cancelled", `${DAY}T13:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(result.roleSummary, [{ role: "engineer", averageMs: 40 * MINUTE, sampleCount: 1 }]);
      assert.equal(totalSamples(result.overall), 1, "the administrative row still has no defensible end");
    },
  );
});

// ── which task.failed classifies the attempt being measured ──

test("a prior attempt's task.failed does not classify the attempt being measured", () => {
  // `forge retry --force` moves started_at forward and leaves the stream intact.
  // Attempt 1 was cancelled; attempt 2 crashed without its own task.failed being
  // written (forge died between the paired writes). Attempt 2 is a real
  // supervised span, and reading attempt 1's `cancelled` would silently drop it.
  withTasks(
    [
      {
        id: "retried-cancel", role: "engineer", status: "failed",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T11:40:00.000Z`,
        events: [failedWith("cancelled", `${DAY}T09:30:00.000Z`)],
      },
    ],
    () => assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 40 * MINUTE, sampleCount: 1 }]),
  );
});

test("an unparseable task.failed created_at cannot outsort a valid sibling", () => {
  // As raw TEXT any leading letter sorts above '2', so a MAX over the column would
  // let a junk row decide. Both directions of that mistake are pinned: it must
  // neither re-admit an administrative row nor exclude a supervised one.
  withTasks(
    [
      {
        id: "junk-supervised", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [failedWith("cancelled", `${DAY}T13:00:00.000Z`), failedWith("container_crash", "not-a-timestamp")],
      },
      {
        id: "junk-administrative", role: "tech-lead", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:30:00.000Z`,
        events: [failedWith("container_crash", `${DAY}T09:30:00.000Z`), failedWith("cancelled", "not-a-timestamp")],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(result.roleSummary, [{ role: "tech-lead", averageMs: 30 * MINUTE, sampleCount: 1 }]);
      assert.equal(totalSamples(result.overall), 1, "the junk row decides neither way");
    },
  );
});

test("a clock-skewed exit with no later sibling falls through to layer 2 instead of going negative", () => {
  // Clock skew on the container host: the only exit is stamped a second before
  // the start. It cannot describe this attempt, so the row is measured exactly
  // as one carrying no exit at all — completed_at when the terminal was
  // supervised, nothing when it was administrative. A negative duration is never
  // produced, and 0 is never substituted for one.
  withTasks(
    [
      {
        id: "skewed", role: "engineer",
        started: `${DAY}T10:00:00.000Z`, completed: `${DAY}T10:20:00.000Z`,
        events: [exited(`${DAY}T09:59:59.000Z`)],
      },
      {
        id: "skewed-administrative", role: "tech-lead", status: "failed",
        started: `${DAY}T10:00:00.000Z`, completed: `${DAY}T14:00:00.000Z`,
        events: [exited(`${DAY}T09:59:59.000Z`), failedWith("cancelled", `${DAY}T14:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      const day = at(result.overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "not clamped to a zero-duration sample, and the administrative row is still dropped");
      assert.equal(day.averageMs, 20 * MINUTE, "the supervised row reads its own completed_at span");
      assert.deepEqual(result.roleSummary, [{ role: "engineer", averageMs: 20 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("an exit stamped exactly at started_at is a real zero-duration sample, not an empty bucket", () => {
  withTasks(
    [
      {
        id: "instant", role: "engineer",
        started: `${DAY}T10:00:00.000Z`, completed: `${DAY}T10:20:00.000Z`,
        events: [started(`${DAY}T10:00:00.000Z`), exited(`${DAY}T10:00:00.000Z`)],
      },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "zero is an observation");
      assert.equal(day.averageMs, 0, "and reads as 0, which an empty bucket never does");
    },
  );
});

// ── bucket placement stays on completed_at; only the duration moves ──

test("the observation sits in the completed_at bucket while its DURATION comes off an exit two days earlier", () => {
  // The design's most confusing consequence, stated as an assertion so that
  // moving placement onto the exit has to break this test to happen.
  withTasks(
    [
      {
        id: "crossing", role: "engineer", status: "failed",
        started: `2026-06-07T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
        events: [started("2026-06-07T09:00:00.000Z"), exited("2026-06-07T09:25:00.000Z"), failedWith("cancelled", `${DAY}T12:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.equal(at(result.overall, DAY_BUCKET).sampleCount, 1, "placed by completed_at");
      assert.equal(at(result.overall, DAY_BUCKET).averageMs, 25 * MINUTE, "measured from the exit");
      assert.equal(at(result.overall, PRIOR_BUCKET).sampleCount, 0, "the exit's own day gains nothing");
      assert.equal(at(result.overall, PRIOR_BUCKET).averageMs, null);
      assert.equal(totalSamples(result.overall), 1, "one row, counted once");
      const engineer = result.byRole.find((s) => s.role === "engineer");
      assert.ok(engineer);
      assert.equal(at(engineer.buckets, DAY_BUCKET).averageMs, 25 * MINUTE, "the role series agrees with overall");
      assert.equal(at(engineer.buckets, PRIOR_BUCKET).sampleCount, 0);
    },
  );
});

test("the same split holds at hourly resolution", () => {
  withTasks(
    [
      {
        id: "hourly", role: "engineer", status: "failed",
        started: "2026-06-10T12:05:00.000Z", completed: "2026-06-10T14:10:00.000Z",
        events: [started("2026-06-10T12:05:00.000Z"), exited("2026-06-10T12:20:00.000Z"), failedWith("gate_rejected", "2026-06-10T14:10:00.000Z")],
      },
    ],
    () => {
      const result = trends("1d");
      assert.equal(result.resolution, "hour");
      const completedHour = at(result.overall, "2026-06-10T14:00:00.000Z");
      assert.equal(completedHour.sampleCount, 1);
      assert.equal(completedHour.averageMs, 15 * MINUTE);
      assert.equal(completedHour.partial, true, "the current hour is still the partial one");
      assert.equal(at(result.overall, "2026-06-10T12:00:00.000Z").sampleCount, 0, "the exit hour stays empty");
      assert.equal(at(result.overall, "2026-06-10T12:00:00.000Z").averageMs, null);
    },
  );
});

test("an exit LATER than completed_at yields a duration longer than the row's own wall-clock span", () => {
  // The supervisor writes the terminal first and logs container.exited a moment
  // later. The exit still wins, so the derived duration exceeds
  // completed_at − started_at rather than being capped by it.
  withTasks(
    [
      {
        id: "late-exit", role: "engineer",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:20:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), exited(`${DAY}T09:26:00.000Z`)],
      },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1);
      assert.equal(day.averageMs, 26 * MINUTE, "the exit is the end even when it postdates completed_at");
    },
  );
});

test("a SUCCESSFUL task's exit event also overrides completed_at — the rule is not failure-only", () => {
  // A clean agent whose completion write landed 25 minutes after the container
  // stopped contributes the 5 minutes it ran, not the 30 it was on the books.
  withTasks(
    [
      {
        id: "clean", role: "engineer", status: "complete",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:30:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), exited(`${DAY}T09:05:00.000Z`), { type: "task.completed", at: `${DAY}T09:30:00.000Z` }],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 5 * MINUTE, sampleCount: 1 }]);
    },
  );
});

// ── unparseable exit timestamps degrade to layer 2 without throwing ──

test("an exit timestamp that does not parse falls through to layer 2 rather than throwing", () => {
  withTasks(
    [
      // Administrative terminal, garbage exit → no defensible end → dropped.
      {
        id: "garbage-admin", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [exited("not-a-timestamp"), failedWith("cancelled", `${DAY}T13:00:00.000Z`)],
      },
      // Supervised terminal, garbage exit → completed_at is still the end.
      {
        id: "garbage-supervised", role: "tech-lead", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:40:00.000Z`,
        events: [exited("not-a-timestamp"), failedWith("container_crash", `${DAY}T09:40:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(result.roleSummary, [{ role: "tech-lead", averageMs: 40 * MINUTE, sampleCount: 1 }]);
      assert.equal(totalSamples(result.overall), 1);
    },
  );
});

test("an unparseable exit timestamp cannot mask a valid sibling", () => {
  // An empty created_at sorts below every ISO string, and a junk one can sort
  // anywhere; neither may be selected in preference to a real exit on the same
  // task, because the fall-through it would cause is silent — the row would be
  // measured off completed_at (below, an hour instead of 20 minutes) or dropped
  // outright with agent-observed evidence sitting right next to it.
  withTasks(
    [
      {
        id: "blank", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T10:00:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), { type: "container.exited", at: "", payload: null }, exited(`${DAY}T09:20:00.000Z`), failedWith("container_crash", `${DAY}T10:00:00.000Z`)],
      },
      {
        id: "junk", role: "tech-lead", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), exited("not-a-timestamp"), exited(`${DAY}T09:30:00.000Z`), failedWith("cancelled", `${DAY}T13:00:00.000Z`)],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [
        { role: "engineer", averageMs: 20 * MINUTE, sampleCount: 1 },
        { role: "tech-lead", averageMs: 30 * MINUTE, sampleCount: 1 },
      ]);
    },
  );
});
