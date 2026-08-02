// FG-662: agent-runtime trends must not count reconciliation artifacts.
//
// A task's completed_at is written by whatever process moved it off `running`.
// When that was the agent's own supervisor, completed_at − started_at is
// runtime. When it was a `forge cancel`, a `forge gate --reject`, or a reconcile
// sweep, it is wall-clock-until-noticed — on the real host store ten such rows
// (1.7% of observations) moved the 7d average from 11.8min to 202.3min.
//
// The rule under test, in two layers:
//   1. an attached-exit event (container.exited / .idle_timeout /
//      .dependency_provisioning_failed / .git_unavailable) is when the agent
//      stopped, and it wins over a later-rewritten completed_at;
//   2. with no such event, completed_at is the end only when the terminal was
//      not written administratively — otherwise the row contributes nothing.
//
// The anti-regression that matters most lives here too: a genuinely long REAL
// agent run in the same bucket as an excluded artifact still counts in full.
// Nothing in the implementation may key off magnitude.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBucket, AgentRuntimeWindow, ProjectScope } from "./queries.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-recon-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

// The same instant the sibling FG-648 suites pin to.
const NOW = Date.parse("2026-06-10T14:30:00Z");
const PROJECT = "/proj/recon";
const DAY = "2026-06-09";
const DAY_BUCKET = "2026-06-09T00:00:00.000Z";

const MINUTE = 60_000;
const HOUR = 3_600_000;

type TaskRow = {
  id: string;
  role: string;
  status?: string;
  phase?: string | null;
  started: string;
  completed: string;
  /** failure_kind on the task's latest task.failed event, when it has one. */
  failureKind?: string;
  /** an attached-exit event at this timestamp, if the supervisor logged one. */
  exitedAt?: string;
  exitEvent?: string;
  project?: string;
};

let storeSeq = 0;

function withTasks<T>(tasks: TaskRow[], fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `forge-qruntime-recon-${storeSeq++}-`));
  const database = new Database(join(home, "forge.db"));
  database.exec(`
    CREATE TABLE runs (id TEXT PRIMARY KEY, title TEXT, workflow TEXT, project_dir TEXT, status TEXT, created_at TEXT);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT, phase TEXT, agent_role TEXT, status TEXT, parent_id TEXT, started_at TEXT, completed_at TEXT);
    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT, task_id TEXT, event_type TEXT, payload TEXT, created_at TEXT);
  `);
  const insertRun = database.prepare("INSERT INTO runs VALUES (?,?,?,?,?,?)");
  const insertTask = database.prepare("INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?)");
  const insertEvent = database.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)");

  const projects = new Set(tasks.map((t) => t.project ?? PROJECT));
  for (const project of projects) insertRun.run(runIdFor(project), project, "feature", project, "complete", "2026-01-01T00:00:00Z");

  for (const row of tasks) {
    const runId = runIdFor(row.project ?? PROJECT);
    const status = row.status ?? (row.failureKind ? "failed" : "complete");
    insertTask.run(row.id, runId, row.phase === undefined ? "implementation" : row.phase, row.role, status, null, row.started, row.completed);
    if (row.exitedAt) {
      insertEvent.run(runId, row.id, row.exitEvent ?? "container.exited", JSON.stringify({ containerName: `forge-${row.id}`, exitCode: 0 }), row.exitedAt);
    }
    if (row.failureKind) {
      insertEvent.run(runId, row.id, "task.failed", JSON.stringify({ failure_kind: row.failureKind, error: row.failureKind }), row.completed);
    } else if (status === "complete") {
      insertEvent.run(runId, row.id, "task.completed", null, row.completed);
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

const runIdFor = (project: string) => `r${project.replace(/[^a-z0-9]/gi, "")}`;

const trends = (window: AgentRuntimeWindow = "7d", scope: ProjectScope = PROJECT) => agentRuntimeTrends(window, scope, NOW);

const at = (buckets: readonly AgentRuntimeBucket[], iso: string): AgentRuntimeBucket => {
  const found = buckets.find((b) => b.bucketStart === iso);
  assert.ok(found, `no bucket at ${iso}; got ${buckets.map((b) => b.bucketStart).join(", ")}`);
  return found;
};

/** `{ started, completed }` for a run of `durationMs` ending at `completedIso`. */
const ending = (completedIso: string, durationMs: number) => ({
  started: new Date(Date.parse(completedIso) - durationMs).toISOString(),
  completed: completedIso,
});

const totalSamples = (buckets: readonly AgentRuntimeBucket[]) => buckets.reduce((sum, b) => sum + b.sampleCount, 0);

// ── layer 2: an administrative terminal with no agent-observed end at all ──

test("a cancelled task with NO container exit event does not contribute its abandonment span", () => {
  // task-build-2ea3ee's shape: 1614.9h between started_at and a completed_at a
  // sweep wrote, and zero container.exited events. The agent did not run for
  // 67 days; nothing on the record says when it stopped.
  withTasks(
    [
      { id: "abandoned", role: "engineer", failureKind: "cancelled", ...ending(`${DAY}T12:00:00.000Z`, 1614.9 * HOUR) },
      { id: "real", role: "engineer", ...ending(`${DAY}T13:00:00.000Z`, 10 * MINUTE) },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "the abandoned row is not an observation");
      assert.equal(day.averageMs, 10 * MINUTE, "the surviving average is the real run alone");

      const engineer = trends().roleSummary.find((r) => r.role === "engineer");
      assert.deepEqual(engineer, { role: "engineer", averageMs: 10 * MINUTE, sampleCount: 1 });
    },
  );
});

test("every administrative failure kind with no exit event is excluded; every other kind still counts", () => {
  const administrative = [
    "cancelled",
    "gate_rejected",
    "orphaned",
    "orphaned_work_may_persist",
    "orphaned_needs_finalize",
    "fanout_wave_orphaned",
    "oom_killed",
    "pre_container_crash",
    "verification_environment_unavailable",
  ];
  // Classified by the supervising process at the agent's own exit — real time.
  const supervised = [
    "idle_timeout",
    "container_crash",
    "result_missing",
    "result_malformed",
    "work_not_persisted",
    "model_error",
    "merge_conflict",
    "integration_failed",
    "red_blocked",
    "unknown",
  ];

  withTasks(
    [
      ...administrative.map((kind, i) => ({
        id: `adm-${i}`, role: "engineer", failureKind: kind, ...ending(`${DAY}T0${i % 10}:00:00.000Z`, 40 * HOUR),
      })),
      ...supervised.map((kind, i) => ({
        id: `sup-${i}`, role: "tech-lead", failureKind: kind, ...ending(`${DAY}T1${i % 10}:00:00.000Z`, 5 * MINUTE),
      })),
    ],
    () => {
      const summary = trends().roleSummary;
      assert.equal(summary.find((r) => r.role === "engineer"), undefined, "no administrative row survives");
      assert.deepEqual(
        summary.find((r) => r.role === "tech-lead"),
        { role: "tech-lead", averageMs: 5 * MINUTE, sampleCount: supervised.length },
      );
    },
  );
});

test("an idle_timeout failure counts in full — a killed-while-running agent consumed that time", () => {
  // 3.5 hours of a wedged agent is real consumed time and exactly the signal
  // this chart exists to surface; the idle watchdog's own event is the end.
  withTasks(
    [
      { id: "idle", role: "engineer", failureKind: "idle_timeout", exitEvent: "container.idle_timeout", exitedAt: `${DAY}T11:30:00.000Z`, ...ending(`${DAY}T11:30:00.000Z`, 3.5 * HOUR) },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1);
      assert.equal(day.averageMs, 3.5 * HOUR, "the whole idle span counts");
    },
  );
});

test("an idle_timeout with no recorded exit event still counts off completed_at", () => {
  withTasks(
    [{ id: "idle", role: "engineer", failureKind: "idle_timeout", ...ending(`${DAY}T11:30:00.000Z`, 45 * MINUTE) }],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "idle_timeout is never administrative");
      assert.equal(day.averageMs, 45 * MINUTE);
    },
  );
});

// ── layer 1: the exit event beats a later-rewritten completed_at ──

test("where a container.exited event exists the duration derives from it, not from a rewritten completed_at", () => {
  // task-plan-07398d's shape: 98.6h of wall clock, one container.exited. The
  // agent ran 22 minutes and the cancel noticed four days later.
  withTasks(
    [
      {
        id: "cancelled-late", role: "tech-lead", failureKind: "cancelled",
        exitedAt: "2026-06-05T09:22:00.000Z",
        started: "2026-06-05T09:00:00.000Z", completed: `${DAY}T11:00:00.000Z`,
      },
    ],
    () => {
      const result = trends();
      const day = at(result.overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "a row with an agent-observed end is a real observation");
      assert.equal(day.averageMs, 22 * MINUTE, "22 minutes of agent time, not 98 hours of wall clock");
      assert.deepEqual(result.roleSummary, [{ role: "tech-lead", averageMs: 22 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("each attached-exit event type is an agent-observed end", () => {
  for (const eventType of [
    "container.exited",
    "container.idle_timeout",
    "container.dependency_provisioning_failed",
    "container.git_unavailable",
  ]) {
    withTasks(
      [
        {
          id: "t", role: "engineer", failureKind: "cancelled", exitEvent: eventType,
          exitedAt: "2026-06-08T10:15:00.000Z",
          started: "2026-06-08T10:00:00.000Z", completed: `${DAY}T12:00:00.000Z`,
        },
      ],
      () => {
        const day = at(trends().overall, DAY_BUCKET);
        assert.equal(day.sampleCount, 1, `${eventType} must be read as an agent-observed end`);
        assert.equal(day.averageMs, 15 * MINUTE, `${eventType} must supply the duration`);
      },
    );
  }
});

test("container.killed is NOT an agent-observed end — forge cancel logs it around a blind docker kill", () => {
  // cancel.ts logs container.killed unconditionally, whether or not anything was
  // still alive to kill. Treating it as evidence would readmit the whole
  // abandonment span under a different name.
  withTasks(
    [
      {
        id: "killed", role: "engineer", failureKind: "cancelled", exitEvent: "container.killed",
        exitedAt: `${DAY}T12:00:00.000Z`,
        ...ending(`${DAY}T12:00:00.000Z`, 300 * HOUR),
      },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [], "container.killed cannot rescue an administrative terminal");
    },
  );
});

// ── gate_rejected, in both of its shapes ──

test("a gate_rejected row whose agent genuinely ran counts, at its real duration", () => {
  withTasks(
    [
      {
        id: "rejected-promptly", role: "tech-lead", failureKind: "gate_rejected",
        exitedAt: `${DAY}T09:14:00.000Z`,
        started: `${DAY}T09:00:00.000Z`, completed: `${DAY}T09:20:00.000Z`,
      },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "a real reviewed run is not an artifact");
      assert.equal(day.averageMs, 14 * MINUTE);
    },
  );
});

test("a gate_rejected row whose completed_at was rewritten long after the agent stopped does not contribute that span", () => {
  // task-plan-b676db's shape: 29.8h under a kind that averages 0.85h. Same kind,
  // opposite truth — which is why a failure_kind allowlist alone cannot decide it.
  withTasks(
    [
      {
        id: "rejected-late", role: "tech-lead", failureKind: "gate_rejected",
        exitedAt: "2026-06-08T06:18:00.000Z",
        started: "2026-06-08T06:00:00.000Z", completed: `${DAY}T11:48:00.000Z`,
      },
      {
        id: "rejected-lost", role: "red-wide", failureKind: "gate_rejected",
        ...ending(`${DAY}T11:48:00.000Z`, 29.8 * HOUR),
      },
    ],
    () => {
      const result = trends();
      const day = at(result.overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 1, "only the row with an agent-observed end survives");
      assert.equal(day.averageMs, 18 * MINUTE, "18 minutes of agent time, not 29.8 hours");
      assert.equal(result.roleSummary.find((r) => r.role === "red-wide"), undefined);
    },
  );
});

// ── the anti-regression: this is not an outlier filter ──

test("a genuinely long REAL agent run in the SAME bucket as an excluded artifact still counts IN FULL", () => {
  const LONG = 9 * HOUR;
  withTasks(
    [
      { id: "artifact", role: "engineer", failureKind: "cancelled", ...ending(`${DAY}T12:00:00.000Z`, 1614.9 * HOUR) },
      // A real, supervised, nine-hour agent run — an order of magnitude above
      // everything else in the bucket. Any magnitude-based rule loses it.
      { id: "slow", role: "engineer", exitedAt: `${DAY}T18:00:00.000Z`, ...ending(`${DAY}T18:00:00.000Z`, LONG) },
      { id: "quick-a", role: "engineer", ...ending(`${DAY}T19:00:00.000Z`, 4 * MINUTE) },
      { id: "quick-b", role: "engineer", ...ending(`${DAY}T20:00:00.000Z`, 6 * MINUTE) },
    ],
    () => {
      const day = at(trends().overall, DAY_BUCKET);
      assert.equal(day.sampleCount, 3, "the slow run is an observation, not an outlier to discard");
      assert.equal(day.averageMs, Math.round((LONG + 10 * MINUTE) / 3));
      assert.ok(day.averageMs! > 3 * HOUR, "a nine-hour run must still visibly dominate its bucket");
    },
  );
});

test("a genuinely long run that FAILED under a supervised kind also counts in full", () => {
  const LONG = 6 * HOUR;
  withTasks(
    [
      { id: "slow-crash", role: "engineer", failureKind: "container_crash", exitedAt: `${DAY}T18:00:00.000Z`, ...ending(`${DAY}T18:00:00.000Z`, LONG) },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: LONG, sampleCount: 1 }]);
    },
  );
});

// ── successful tasks and the FG-648 invariants ──

test("successful completed tasks are unaffected, with or without an exit event", () => {
  withTasks(
    [
      { id: "ok-evented", role: "engineer", exitedAt: `${DAY}T09:00:10.000Z`, ...ending(`${DAY}T09:00:10.000Z`, 10_000) },
      { id: "ok-bare", role: "engineer", ...ending(`${DAY}T10:00:30.000Z`, 30_000) },
      { id: "ok-red", role: "red-wide", ...ending(`${DAY}T11:01:40.000Z`, 100_000) },
    ],
    () => {
      const result = trends();
      assert.equal(at(result.overall, DAY_BUCKET).sampleCount, 3);
      assert.equal(at(result.overall, DAY_BUCKET).averageMs, Math.round(140_000 / 3));
      assert.deepEqual(result.roleSummary, [
        { role: "engineer", averageMs: 20_000, sampleCount: 2 },
        { role: "red-wide", averageMs: 100_000, sampleCount: 1 },
      ]);
    },
  );
});

test("a stale task.failed on a task that later COMPLETED does not exclude it", () => {
  // A retried task keeps the earlier task.failed on its stream; status is the
  // discriminator, so a `complete` task is never read as administratively ended.
  withTasks(
    [{ id: "retried", role: "engineer", status: "complete", failureKind: "cancelled", ...ending(`${DAY}T09:30:00.000Z`, 12 * MINUTE) }],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "engineer", averageMs: 12 * MINUTE, sampleCount: 1 }]);
    },
  );
});

test("the exclusion is bucket placement by completed_at, the grid, and the partial flag unchanged", () => {
  withTasks(
    [
      { id: "artifact", role: "engineer", failureKind: "cancelled", ...ending(`${DAY}T12:00:00.000Z`, 900 * HOUR) },
      // Started 06-08, finished 06-09: still bucketed by completed_at.
      { id: "spanning", role: "engineer", started: "2026-06-08T23:00:00.000Z", completed: `${DAY}T01:00:00.000Z` },
      { id: "today", role: "engineer", ...ending("2026-06-10T14:10:20.000Z", 20_000) },
    ],
    () => {
      const result = trends();
      assert.equal(result.resolution, "day");
      assert.equal(result.bucketMs, 86_400_000);
      assert.equal(result.rangeStart, "2026-06-03T00:00:00.000Z");
      assert.equal(result.overall.length, 8);
      assert.equal(at(result.overall, "2026-06-08T00:00:00.000Z").sampleCount, 0, "the start day stays empty");
      assert.equal(at(result.overall, "2026-06-08T00:00:00.000Z").averageMs, null, "an empty bucket is null, never 0");
      assert.equal(at(result.overall, DAY_BUCKET).sampleCount, 1);
      assert.equal(at(result.overall, DAY_BUCKET).averageMs, 2 * HOUR);
      assert.deepEqual(result.overall.filter((b) => b.partial).map((b) => b.bucketStart), ["2026-06-10T00:00:00.000Z"]);
      assert.equal(totalSamples(result.overall), 2);
      for (const series of result.byRole) {
        assert.deepEqual(series.buckets.map((b) => b.bucketStart), result.overall.map((b) => b.bucketStart));
      }
    },
  );
});

test("an excluded artifact cannot set the derived 'all' range start", () => {
  withTasks(
    [
      // Completes weeks before anything real, and would otherwise open the grid.
      { id: "artifact", role: "engineer", failureKind: "orphaned", ...ending("2026-05-05T12:00:00.000Z", 200 * HOUR) },
      { id: "real", role: "engineer", ...ending(`${DAY}T09:00:00.000Z`, 8 * MINUTE) },
    ],
    () => {
      const result = trends("all");
      // 2026-06-09 is a Tuesday; its week opens Monday 2026-06-08.
      assert.equal(result.rangeStart, "2026-06-08T00:00:00.000Z");
      assert.equal(result.overall.length, 1);
      assert.equal(result.overall[0]!.sampleCount, 1);
      assert.equal(result.overall[0]!.averageMs, 8 * MINUTE);
    },
  );
});

test("the interactive-orchestrator-session exclusion and project scope still hold alongside the new rule", () => {
  withTasks(
    [
      { id: "mine", role: "engineer", ...ending(`${DAY}T09:00:00.000Z`, 7 * MINUTE) },
      { id: "mine-artifact", role: "engineer", failureKind: "cancelled", ...ending(`${DAY}T10:00:00.000Z`, 500 * HOUR) },
      { id: "theirs", role: "engineer", project: "/proj/other", ...ending(`${DAY}T09:00:00.000Z`, 99 * MINUTE) },
    ],
    () => {
      assert.deepEqual(trends("7d", PROJECT).roleSummary, [{ role: "engineer", averageMs: 7 * MINUTE, sampleCount: 1 }]);
      assert.deepEqual(trends("7d", "/proj/other").roleSummary, [{ role: "engineer", averageMs: 99 * MINUTE, sampleCount: 1 }]);
      assert.equal(trends("7d", []).roleSummary.length, 0);
      assert.equal(
        agentRuntimeTrends("7d", undefined, NOW).roleSummary.reduce((sum, r) => sum + r.sampleCount, 0),
        2,
        "unscoped sees both projects' real rows and neither artifact",
      );
    },
  );
});

test("an orchestrator SESSION is still excluded even when it carries a clean exit event", () => {
  // The new rule reads the event stream, so a session row now has an
  // agent-observed end available to it. It must still never reach the metric.
  withTasks(
    [
      { id: "session", role: "orchestrator", phase: "session", exitedAt: `${DAY}T20:00:00.000Z`, started: `${DAY}T08:00:00.000Z`, completed: `${DAY}T20:00:00.000Z` },
      { id: "planning", role: "orchestrator", phase: "planning", ...ending(`${DAY}T13:00:40.000Z`, 40_000) },
      { id: "nullphase", role: "orchestrator", phase: null, ...ending(`${DAY}T15:00:20.000Z`, 20_000) },
    ],
    () => {
      assert.deepEqual(trends().roleSummary, [{ role: "orchestrator", averageMs: 30_000, sampleCount: 2 }]);
    },
  );
});
