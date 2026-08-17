// FG-725: a fanout/coordinator PARENT is not an agent execution.
//
// A workflow fanout parent carries agent_role, started_at and completed_at like
// any leaf, but it never runs an agent container — it coordinates its child
// tasks. It emits no `container.started` and no attached-exit event, so it slips
// past the FG-690 attached-exit layer (attachedExit === 0) and, unless
// administratively reconciled, falls through to layer 2 and returns its
// completed_at. When such a parent waits days at `awaiting_gate` and a gate
// advance finally stamps completed_at, that whole multi-day wait was charted as
// agent runtime.
//
// The demonstrated production shape (reproduced below as a fixture, never read
// from a live DB): task-build-7c4dc7 — a fanout parent with 9 impl children —
// whose children finished ~2026-08-12T23:57Z while the parent gate-advanced
// ~2026-08-16T04:00Z. No container.started/exited on the parent (correct — it
// ran none). It charted 4,611 min and was >92% of that day's plotted duration.
//
// The discriminator under test: a row that HAS at least one child (some task
// sets parent_id to it — schema.ts:138) AND has NO container.started of its own
// is a non-container coordinator and enters NO agent-runtime observation —
// neither a sample nor a duration, overall or per role. This bounds the layer-2
// no-attached-exit fallback, whose purpose is pre-instrumentation LEAF rows: a
// coordinator that has children and never ran a container is not defensible
// legacy agent evidence. A genuine leaf (no children) is untouched by the gate.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentRuntimeBucket, AgentRuntimeWindow, ProjectScope } from "./queries.js";

const tmpHome = mkdtempSync(join(tmpdir(), "forge-qruntime-coord-"));
process.env.FORGE_HOME = tmpHome;

const { agentRuntimeTrends } = await import("./queries.js");

const NOW = Date.parse("2026-08-16T12:00:00Z");
const PROJECT = "/proj/coordinator";

const MINUTE = 60_000;

type EventRow = { type: string; at: string; payload?: string | null };

type TaskRow = {
  id: string;
  role: string;
  status?: string;
  started: string;
  completed: string;
  parentId?: string | null;
  events?: EventRow[];
};

let storeSeq = 0;

const RUN_ID = "r-coordinator";

function withTasks<T>(tasks: TaskRow[], fn: () => T): T {
  const home = mkdtempSync(join(tmpdir(), `forge-qruntime-coord-${storeSeq++}-`));
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
    insertTask.run(
      row.id, RUN_ID, "implementation", row.role, row.status ?? "complete",
      row.parentId ?? null, row.started, row.completed,
    );
    for (const event of row.events ?? []) {
      insertEvent.run(RUN_ID, row.id, event.type, event.payload ?? null, event.at);
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

const trends = (window: AgentRuntimeWindow = "30d", nowMs = NOW, scope: ProjectScope = PROJECT) =>
  agentRuntimeTrends(window, scope, nowMs);

const totalSamples = (buckets: readonly AgentRuntimeBucket[]) =>
  buckets.reduce((sum, b) => sum + b.sampleCount, 0);

const roleSeries = (result: ReturnType<typeof trends>, role: string) =>
  result.byRole.find((s) => s.role === role);

const started = (isoAt: string): EventRow => ({
  type: "container.started",
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t", containerId: "abc123" }),
});

const exited = (isoAt: string, type = "container.exited"): EventRow => ({
  type,
  at: isoAt,
  payload: JSON.stringify({ containerName: "forge-t", exitCode: 0 }),
});

const failedWith = (kind: string, isoAt: string): EventRow => ({
  type: "task.failed",
  at: isoAt,
  payload: JSON.stringify({ failure_kind: kind, error: kind }),
});

// ── AC3: the demonstrated production shape, in ONE fixture ──

test("a fanout parent that gate-completes days after its children contributes NEITHER sample NOR duration, while a child keeps its runtime", () => {
  // task-build-7c4dc7's shape: children finish promptly and the parent, having
  // run no container, sits at awaiting_gate for days until a gate advance stamps
  // completed_at. Parent and children share the `engineer` role, so if the
  // parent were charted its multi-day wait would dominate the engineer series.
  withTasks(
    [
      {
        id: "parent", role: "engineer", status: "complete",
        // ran for >3 days by the clock, but ran no agent container.
        started: "2026-08-12T20:00:00.000Z", completed: "2026-08-16T04:00:00.000Z",
        events: [], // no container.started, no attached-exit — a coordinator.
      },
      {
        id: "child-a", role: "engineer", status: "complete", parentId: "parent",
        started: "2026-08-12T23:00:00.000Z", completed: "2026-08-12T23:57:00.000Z",
        events: [started("2026-08-12T23:00:00.000Z"), exited("2026-08-12T23:57:00.000Z")],
      },
      {
        id: "child-b", role: "engineer", status: "complete", parentId: "parent",
        started: "2026-08-12T23:10:00.000Z", completed: "2026-08-12T23:40:00.000Z",
        events: [started("2026-08-12T23:10:00.000Z"), exited("2026-08-12T23:40:00.000Z")],
      },
    ],
    () => {
      const result = trends();
      // Both children measured; the parent excluded entirely.
      assert.equal(totalSamples(result.overall), 2, "only the two children, never the parent");
      assert.deepEqual(
        result.roleSummary,
        [{ role: "engineer", averageMs: Math.round((57 + 30) * MINUTE / 2), sampleCount: 2 }],
        "the engineer series carries the two children and none of the parent's multi-day wait",
      );
      // child-a specifically keeps its full measured runtime.
      const engineer = roleSeries(result, "engineer");
      assert.ok(engineer);
      assert.equal(totalSamples(engineer.buckets), 2, "the per-role series agrees with overall");
    },
  );
});

test("the parent's gate-advance completed_at is never itself an observation, in any window", () => {
  // Guard the specific bug directly: were the parent charted, its ~4,611-minute
  // span (2026-08-12T20:00 → 2026-08-16T04:00) would be the sample.
  withTasks(
    [
      {
        id: "lonely-parent", role: "engineer", status: "complete",
        started: "2026-08-12T20:00:00.000Z", completed: "2026-08-16T04:00:00.000Z",
      },
      {
        id: "sole-child", role: "test-engineer", status: "complete", parentId: "lonely-parent",
        started: "2026-08-12T23:00:00.000Z", completed: "2026-08-12T23:15:00.000Z",
        events: [started("2026-08-12T23:00:00.000Z"), exited("2026-08-12T23:15:00.000Z")],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(
        result.roleSummary,
        [{ role: "test-engineer", averageMs: 15 * MINUTE, sampleCount: 1 }],
        "the child stands alone; engineer has no observation at all",
      );
      assert.equal(totalSamples(result.overall), 1);
    },
  );
});

// ── AC4: a real containerized leaf keeps its behavior; gate time is not added ──

test("a containerized successful leaf keeps its exit-derived duration, gate time after the exit excluded (FG-690/FG-662 still holds)", () => {
  withTasks(
    [
      {
        id: "leaf-ok", role: "engineer", status: "complete",
        started: "2026-08-14T09:00:00.000Z", completed: "2026-08-16T04:00:00.000Z",
        events: [
          started("2026-08-14T09:00:00.000Z"),
          exited("2026-08-14T09:30:00.000Z"),
        ],
      },
    ],
    () => {
      assert.deepEqual(
        trends().roleSummary,
        [{ role: "engineer", averageMs: 30 * MINUTE, sampleCount: 1 }],
        "the agent-observed exit ends it, not the far-later completed_at",
      );
    },
  );
});

test("a containerized FAILED leaf keeps its exit-derived duration too", () => {
  withTasks(
    [
      {
        id: "leaf-failed", role: "engineer", status: "failed",
        started: "2026-08-14T09:00:00.000Z", completed: "2026-08-16T04:00:00.000Z",
        events: [
          started("2026-08-14T09:00:00.000Z"),
          exited("2026-08-14T09:45:00.000Z", "container.idle_timeout"),
          failedWith("idle_timeout", "2026-08-16T04:00:00.000Z"),
        ],
      },
    ],
    () => {
      assert.deepEqual(
        trends().roleSummary,
        [{ role: "engineer", averageMs: 45 * MINUTE, sampleCount: 1 }],
      );
    },
  );
});

// ── AC5: layer 2 is bounded — legacy LEAF kept, modern coordinator excluded ──

test("a pre-instrumentation LEAF (no children, no exit) is still measured, but a coordinator (children, no container.started) is not", () => {
  // The exact boundary AC5 names. Both rows have no attached-exit event and both
  // fall to layer 2; only the coordinator carries children, and that is the whole
  // difference between "legacy agent history worth keeping" and "a parent that
  // never ran a container".
  withTasks(
    [
      {
        id: "legacy-leaf", role: "engineer", status: "complete",
        started: "2026-08-14T09:00:00.000Z", completed: "2026-08-14T09:50:00.000Z",
        events: [], // pre-2026-06 shape: no container.started existed to log.
      },
      {
        id: "coordinator", role: "test-engineer", status: "complete",
        started: "2026-08-12T20:00:00.000Z", completed: "2026-08-16T04:00:00.000Z",
        events: [],
      },
      {
        id: "coordinator-child", role: "red-wide", status: "complete", parentId: "coordinator",
        started: "2026-08-12T23:00:00.000Z", completed: "2026-08-12T23:05:00.000Z",
        events: [started("2026-08-12T23:00:00.000Z"), exited("2026-08-12T23:05:00.000Z")],
      },
    ],
    () => {
      const result = trends();
      assert.deepEqual(
        result.roleSummary,
        [
          { role: "engineer", averageMs: 50 * MINUTE, sampleCount: 1 },
          { role: "red-wide", averageMs: 5 * MINUTE, sampleCount: 1 },
        ].sort((a, b) => b.sampleCount - a.sampleCount || a.role.localeCompare(b.role)),
        "the legacy leaf keeps its completed_at duration; the coordinator (test-engineer) is gone",
      );
      assert.equal(roleSeries(result, "test-engineer"), undefined, "no coordinator observation, no role series");
    },
  );
});

test("a parent that DID run a container of its own is still measured — the gate is children AND no container.started, not children alone", () => {
  // Defensive against over-exclusion: `hasChildren` on its own must not drop a
  // row. A task that has children but genuinely ran a container is measured off
  // its own exit like any leaf.
  withTasks(
    [
      {
        id: "container-parent", role: "engineer", status: "complete",
        started: "2026-08-14T09:00:00.000Z", completed: "2026-08-16T04:00:00.000Z",
        events: [
          started("2026-08-14T09:00:00.000Z"),
          exited("2026-08-14T09:20:00.000Z"),
        ],
      },
      {
        id: "its-child", role: "engineer", status: "complete", parentId: "container-parent",
        started: "2026-08-14T10:00:00.000Z", completed: "2026-08-14T10:10:00.000Z",
        events: [started("2026-08-14T10:00:00.000Z"), exited("2026-08-14T10:10:00.000Z")],
      },
    ],
    () => {
      assert.deepEqual(
        trends().roleSummary,
        [{ role: "engineer", averageMs: Math.round((20 + 10) * MINUTE / 2), sampleCount: 2 }],
        "both the container-running parent and its child count",
      );
    },
  );
});
