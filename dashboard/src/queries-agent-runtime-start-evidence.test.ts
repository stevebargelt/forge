// FG-690: an exit event is not evidence that an agent ever ran.
//
// `runContainer` emits `container.exited` from the caller side, so a `docker run`
// that never produced a container still logs one. On the live host that turned a
// 5h21m unresolved Docker connect into a 321.4-minute "agent runtime" sample, and
// four of them — one per FG-654 review lens — moved a single day's `red-wide`
// average to 1.79 hours against a real execution of about 1.4 minutes.
//
// The rule under test: layer 1 reads an attached-exit event only for an attempt
// that ALSO carries a `container.started` at or after its own `started_at`.
// Without one the row is dropped outright rather than falling through to layer 2,
// which would hand back the very same pre-container interval.
//
// The rule deliberately stops at layer 1, and the boundary is asserted here as
// hard as the fix itself: `container.started` only reached ~98% coverage from
// 2026-06 on, so a row with NO exit event at all is still measured off its
// completed_at under the existing administrative guards. Requiring start evidence
// there would delete ~346 rows of real pre-instrumentation history from `all` —
// a worse defect than the one being corrected.
//
// The absence of start evidence is the only thing asserted here; WHICH exit wins
// once a container did start is the sibling agent-end suite's subject.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBucket, AgentRuntimeWindow, ProjectScope } from "./queries.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-startev-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

const NOW = Date.parse("2026-06-10T14:30:00Z");
const PROJECT = "/proj/start-evidence";
const DAY = "2026-06-09";
const DAY_BUCKET = "2026-06-09T00:00:00.000Z";

const MINUTE = 60_000;

type EventRow = {
  type: string;
  at: string;
  payload?: string | null;
  /** overrides the owning task — for the cross-task leakage case. */
  taskId?: string | null;
};

type TaskRow = {
  id: string;
  role: string;
  status?: string;
  started: string;
  completed: string;
  events?: EventRow[];
};

let storeSeq = 0;

const RUN_ID = "r-start-evidence";

function withTasks<T>(tasks: TaskRow[], fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `forge-qruntime-startev-${storeSeq++}-`));
  const database = new Database(join(home, "forge.db"));
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  `);
  const insertTask = database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  const insertEvent = database.prepare(
    "INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)",
  );
  database.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)")
    .run(RUN_ID, PROJECT, "feature", PROJECT, "complete", "2026-01-01T00:00:00Z");

  for (const row of tasks) {
    insertTask.run(row.id, RUN_ID, "implementation", row.role, row.status ?? "complete", null, row.started, row.completed);
    for (const event of row.events ?? []) {
      insertEvent.run(RUN_ID, event.taskId === undefined ? row.id : event.taskId, event.type, event.payload ?? null, event.at);
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

const trends = (window: AgentRuntimeWindow = "7d", nowMs = NOW, scope: ProjectScope = PROJECT) =>
  agentRuntimeTrends(window, scope, nowMs);

const at = (buckets: readonly AgentRuntimeBucket[], iso: string): AgentRuntimeBucket => {
  const found = buckets.find((b) => b.bucketStart === iso);
  assert.ok(found, `no bucket at ${iso}; got ${buckets.map((b) => b.bucketStart).join(", ")}`);
  return found;
};

const totalSamples = (buckets: readonly AgentRuntimeBucket[]) =>
  buckets.reduce((sum, b) => sum + b.sampleCount, 0);

const started = (isoAt: string): EventRow => ({
  type: "container.started",
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t", containerId: "abc123" }),
});

const exited = (isoAt: string, type = "container.exited"): EventRow => ({
  type,
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t", exitCode: 1 }),
});

const failedWith = (kind: string, isoAt: string): EventRow => ({
  type: "task.failed",
  at: isoAt,
  payload: JSON.stringify({ failure_kind: kind, error: kind }),
});

// ── the rule itself ──

test("an exit with no container.started is excluded, not measured off completed_at instead", () => {
  // The defect's minimal shape. `container_crash` is a SUPERVISED kind, so layer 2
  // would happily return the same interval — dropping the row is the only answer
  // that removes it, which is why the start check returns rather than falls through.
  withTasks(
    [
      {
        id: "no-start", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T14:21:24.000Z`,
        events: [exited(`${DAY}T14:21:24.000Z`), failedWith("container_crash", `${DAY}T14:21:24.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(result.roleSummary, [], "no observation at all");
      assert.equal(totalSamples(result.overall), 0);
      assert.equal(at(result.overall, DAY_BUCKET).averageMs, null, "an empty bucket, not a zero-duration one");
    },
  );
});

test("a real container.started → container.exited pair keeps exactly today's duration and bucket", () => {
  withTasks(
    [
      {
        id: "genuine", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
        events: [
          started(`${DAY}T09:02:00.000Z`),
          exited(`${DAY}T09:25:00.000Z`),
          failedWith("cancelled", `${DAY}T12:00:00.000Z`),
        ],
      },
    ],
    () => {
      const result = trends();
      const day = at(result.overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1);
      assert.equal(day.averageMs, 25 * MINUTE, "still exit − started_at; the start event only authorizes, it never measures");
      assert.deepEqual(result.roleSummary, [{ role: "engineer", averageMs: 25 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("a start stamped exactly at started_at is evidence; one a second earlier is not", () => {
  // The boundary of the `>= started_at` bound, in both directions. The early row
  // is the clock-skew/prior-attempt shape — its start describes a span this row
  // no longer covers.
  withTasks(
    [
      {
        id: "exact", role: "engineer",
        started: `${DAY}T10:00:00.000Z`, completed: `${DAY}T10:20:00.000Z`,
        events: [started(`${DAY}T10:00:00.000Z`), exited(`${DAY}T10:20:00.000Z`)],
      },
      {
        id: "a-second-early", role: "tech-lead", status: "failed",
        started: `${DAY}T10:00:00.000Z`, completed: `${DAY}T10:20:00.000Z`,
        events: [started(`${DAY}T09:59:59.000Z`), exited(`${DAY}T10:20:00.000Z`), failedWith("container_crash", `${DAY}T10:20:00.000Z`)],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 20 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("start evidence must be the task's OWN — a sibling's or an unattached one authorizes nothing", () => {
  withTasks(
    [
      {
        id: "borrower", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [
          { ...started(`${DAY}T09:00:00.000Z`), taskId: "ghost" },
          { ...started(`${DAY}T09:00:00.000Z`), taskId: null },
          exited(`${DAY}T13:00:00.000Z`),
          failedWith("container_crash", `${DAY}T13:00:00.000Z`),
        ],
      },
      {
        id: "owner", role: "tech-lead",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:15:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), exited(`${DAY}T09:15:00.000Z`)],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "tech-lead", averageMs: 15 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("an unparseable container.started created_at is not start evidence", () => {
  // julianday() of junk is NULL, so the bound is never true — the same guard the
  // exit and task.failed subqueries already carry, and the reason ordering is on
  // julianday rather than raw TEXT throughout.
  withTasks(
    [
      {
        id: "junk-start", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [started("not-a-timestamp"), exited(`${DAY}T13:00:00.000Z`), failedWith("container_crash", `${DAY}T13:00:00.000Z`)],
      },
    ],
    () => assert.deepEqual(trends().roleSummary, []),
  );
});

// ── every attached-exit type, and the pre-container producer among them ──

test("each attached-exit type needs start evidence, and gains nothing from its absence", () => {
  for (const type of [
    "container.exited",
    "container.idle_timeout",
    "container.dependency_provisioning_failed",
    "container.git_unavailable",
  ]) {
    withTasks(
      [
        {
          id: "without", role: "engineer", status: "failed",
          started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
          events: [exited(`${DAY}T12:00:00.000Z`, type), failedWith("container_crash", `${DAY}T12:00:00.000Z`)],
        },
      ],
      () => assert.deepEqual(trends().roleSummary, [], `${type} without a start must not count`),
    );
    withTasks(
      [
        {
          id: "with", role: "engineer", status: "failed",
          started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T12:00:00.000Z`,
          events: [started(`${DAY}T09:00:00.000Z`), exited(`${DAY}T09:40:00.000Z`, type), failedWith("container_crash", `${DAY}T12:00:00.000Z`)],
        },
      ],
      () => assert.deepEqual(
        trends().roleSummary,
        [{ role: "engineer", averageMs: 40 * MINUTE, sampleCount: 1 }],
        `${type} with a start still ends the attempt`,
      ),
    );
  }
});

test("an idle timeout counts only for a container that started", () => {
  // The watchdog kill is the case the rule most has to preserve: a killed-while-
  // running agent consumed that time and must keep counting in full. The row
  // beside it is the same event with no container behind it.
  withTasks(
    [
      {
        id: "idle-real", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), exited(`${DAY}T11:00:00.000Z`, "container.idle_timeout"), failedWith("idle_timeout", `${DAY}T13:00:00.000Z`)],
      },
      {
        id: "idle-phantom", role: "tech-lead", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [exited(`${DAY}T11:00:00.000Z`, "container.idle_timeout"), failedWith("idle_timeout", `${DAY}T13:00:00.000Z`)],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 120 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("an FG-664 gate refusal is excluded by the missing start, with no rule of its own", () => {
  // `container.dependency_provisioning_failed` with `stage: environment_resolution`
  // is emitted before any container exists, so the general rule already covers it
  // — nothing keys off the payload. Its in-container sibling, the install failure
  // that carries no `stage` and happens AFTER the start, keeps counting.
  withTasks(
    [
      {
        id: "gate-refusal", role: "red-wide", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:06:00.000Z`,
        events: [
          {
            type: "container.dependency_provisioning_failed",
            at: `${DAY}T09:06:00.000Z`,
            payload: JSON.stringify({ stage: "environment_resolution", reason: "lockfile_absent", projectDir: PROJECT }),
          },
          failedWith("verification_environment_unavailable", `${DAY}T09:06:00.000Z`),
        ],
      },
      {
        id: "install-failure", role: "engineer", status: "failed",
        started: `${DAY}T10:00:00.000Z`, completed: `${DAY}T10:30:00.000Z`,
        events: [
          started(`${DAY}T10:00:00.000Z`),
          {
            type: "container.dependency_provisioning_failed",
            at: `${DAY}T10:08:00.000Z`,
            payload: JSON.stringify({ containerName: "forge-t", exitCode: 1 }),
          },
          failedWith("container_crash", `${DAY}T10:30:00.000Z`),
        ],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 8 * MINUTE, sampleCount: 1 }]);
    },
  );
});

// ── re-dispatch: neither half of a prior attempt reaches this one ──

test("a prior attempt's container.started cannot authorize the current attempt's exit", () => {
  // markTaskRunning re-dispatches in place: started_at moves to attempt 2 while
  // attempt 1's start AND exit stay on the stream. Attempt 2's docker run failed,
  // so it has an exit and no start of its own — the row must drop even though the
  // task row demonstrably ran a container once.
  withTasks(
    [
      {
        id: "redispatched", role: "engineer", status: "failed",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T16:21:24.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          exited(`${DAY}T09:12:00.000Z`),
          exited(`${DAY}T16:21:24.000Z`),
          failedWith("container_crash", `${DAY}T16:21:24.000Z`),
        ],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(result.roleSummary, [], "attempt 1's start does not vouch for attempt 2");
      assert.equal(totalSamples(result.overall), 0, "and attempt 1's exit does not end it either");
    },
  );
});

test("the retry that DOES start a container is measured from its own attempt", () => {
  withTasks(
    [
      {
        id: "redispatched-ok", role: "engineer",
        started: `${DAY}T11:00:00.000Z`, completed: `${DAY}T11:45:00.000Z`,
        events: [
          started(`${DAY}T09:00:00.000Z`),
          exited(`${DAY}T09:12:00.000Z`),
          started(`${DAY}T11:00:00.000Z`),
          exited(`${DAY}T11:45:00.000Z`),
        ],
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 45 * MINUTE, sampleCount: 1 }]);
    },
  );
});

// ── the boundary: layer 2 is untouched ──

test("a row with NO exit event still reads its completed_at, start evidence or not", () => {
  // The pre-instrumentation history. `container.started` was ~8% covered in
  // 2026-05 and ~98% from 2026-06, so a missing start on a row that logged no
  // exit is instrumentation AGE, not proof that nothing ran. Extending the
  // requirement here would silently delete ~346 real rows from the `all` window.
  withTasks(
    [
      {
        id: "old-supervised", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:50:00.000Z`,
        events: [failedWith("container_crash", `${DAY}T09:50:00.000Z`)],
      },
      { id: "old-clean", role: "tech-lead", started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:30:00.000Z` },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [
        { role: "engineer", averageMs: 50 * MINUTE, sampleCount: 1 },
        { role: "tech-lead", averageMs: 30 * MINUTE, sampleCount: 1 },
      ]);
    },
  );
});

test("layer 2's administrative guards keep deciding rows with no exit event", () => {
  // The other half of the boundary: nothing about start evidence may re-admit a
  // row the FG-662 guards drop, or drop one they admit.
  withTasks(
    [
      {
        id: "administrative", role: "engineer", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [started(`${DAY}T09:00:00.000Z`), failedWith("cancelled", `${DAY}T13:00:00.000Z`)],
      },
      {
        id: "administrative-no-start", role: "tech-lead", status: "failed",
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T13:00:00.000Z`,
        events: [failedWith("pre_container_crash", `${DAY}T13:00:00.000Z`)],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(result.roleSummary, [], "a start event is not an end, and never rescues layer 2");
      assert.equal(totalSamples(result.overall), 0);
    },
  );
});

// ── the recorded live-host shapes ──

// The FG-654 wave and the 7/31 PDT bucket it poisoned. The UTC day beginning
// 2026-08-01T00:00Z, read from the following midday.
const AUG_NOW = Date.parse("2026-08-02T12:00:00Z");
const AUG_BUCKET = "2026-08-01T00:00:00.000Z";

/** The failed-Docker-start shape: a long wait, an exit, a crash, and no start. */
const failedDockerStart = (id: string, role: string, startedIso: string, completedIso: string): TaskRow => ({
  id, role, status: "failed", started: startedIso, completed: completedIso,
  events: [exited(completedIso), failedWith("container_crash", completedIso)],
});

test("FG-654: four lens tasks wait on a failed Docker start and none contributes its interval", () => {
  // `docker: error during connect: … EOF` left the client hanging 5h21m24s for
  // each of the four review lenses, which then failed together. Empty results, no
  // stdout, no container — and, before this rule, four 321.4-minute samples.
  const WAIT_START = "2026-08-01T14:15:36.000Z";
  const WAIT_END = "2026-08-01T19:37:00.000Z";
  withTasks(
    ["red-wide", "red-narrow", "red-backend", "red-security"].map((role) =>
      failedDockerStart(`task-${role}-b637ed`, role, WAIT_START, WAIT_END),
    ),
    () => {
      const result = trends("7d", AUG_NOW);
      assert.deepEqual(result.roleSummary, [], "all four lenses, gone");
      assert.equal(totalSamples(result.overall), 0);
      assert.equal(at(result.overall, AUG_BUCKET).averageMs, null);
    },
  );
});

test("the live-host red-wide 7/31 PDT bucket reports its genuine 1.4 minutes, not 1.79 hours", () => {
  // The three rows the ticket recorded, reproduced as a fixture rather than read
  // from the operator's database: 321.4 min and 0.1 min with no container.started,
  // and the one real 1.4-minute execution. Their mean was 107.6 min — 1.79 hours.
  withTasks(
    [
      failedDockerStart("task-red-wide-b637ed", "red-wide", "2026-08-01T14:15:36.000Z", "2026-08-01T19:37:00.000Z"),
      failedDockerStart("task-red-wide-7c0abd", "red-wide", "2026-08-01T19:51:54.000Z", "2026-08-01T19:52:00.000Z"),
      {
        id: "task-red-wide-33fbb9", role: "red-wide", status: "complete",
        started: "2026-08-01T18:00:00.000Z", completed: "2026-08-01T18:01:24.000Z",
        events: [started("2026-08-01T18:00:00.000Z"), exited("2026-08-01T18:01:24.000Z")],
      },
    ],
    () => {
      const result = trends("7d", AUG_NOW);
      const bucket = at(result.overall, AUG_BUCKET);
      assert.equal(bucket.sampleCount, 1, "only the execution that actually happened");
      assert.equal(bucket.averageMs, 84_000, "1.4 minutes");
      assert.notEqual(bucket.averageMs, 6_457_800, "and specifically not the 1.79-hour mean of all three");
      assert.deepEqual(result.roleSummary, [{ role: "red-wide", averageMs: 84_000, sampleCount: 1 }]);
      const redWide = result.byRole.find((s) => s.role === "red-wide");
      assert.ok(redWide);
      assert.equal(at(redWide.buckets, AUG_BUCKET).averageMs, 84_000, "the role series agrees with overall");
    },
  );
});
