// FG-836: /api/agent-runtime and /api/ops must answer inside 500 ms (p95 over 20
// requests) on a store the size of the operator's aged host store — measured there
// at 6,974 tasks / 63,605 events, where the pre-FG-836 queries took 4–64 s per
// request because each window task ran correlated subqueries into events (and one
// scanned the whole tasks table per row). The budget is only half the contract; the
// other half is the SHAPE that makes it hold as the store keeps growing, so every
// statement either endpoint executes is also held to EXPLAIN QUERY PLAN: no events
// access is a full scan, and nothing is a correlated subquery re-run per row.
//
// The store is the FG-742 aged-store fixture's shape (real SCHEMA_SQL +
// applyMigrations, historical runs with tasks and their event streams, run-level
// review-loop noise) scaled to the operator's volume and given the event mix the
// runtime derivation actually distinguishes: retries with prior-attempt events,
// no-exit orphans, pre-instrumentation rows, reconcile audits, fanout parents.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations } from "../../src/store/db.js";

const TEST_PORT = 18836;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
const BUDGET_MS = 500;
const SAMPLES = 20;

const tmpHome = mkdtempSync(join(tmpdir(), "fg836-home-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const DB_PATH = join(tmpHome, "forge.db");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

const TARGET_TASKS = 7_000;
const TARGET_EVENTS = 65_000;

const seeded = (() => {
  const db = new Database(DB_PATH);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  const insRun = db.prepare(
    "INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?,?,?,?,?,?,?)",
  );
  const insTask = db.prepare(
    `INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, agent_model, status, task_package, created_at, started_at, completed_at)
     VALUES (?,?,?,?,?,?,?,'{}',?,?,?)`,
  );
  const insEvent = db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)");

  let seed = 6974;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]!;
  const roles = ["engineer", "engineer", "tech-lead", "red-wide", "red-narrow", "test-engineer", "documentation-maintainer"];
  const phases = ["plan", "build", "review", "verify", "docs"];
  const projects = ["/home/op/code/forge", "/home/op/code/app", "/home/op/code/site"];
  const failKinds = ["agent_error", "idle_timeout", "cancelled", "orphaned", "gate_rejected", "oom_killed"];
  const payload = (o: object) => JSON.stringify(o);
  let tasks = 0;
  let events = 0;
  const ev = (run: string, task: string | null, type: string, body: string, ms: number) => {
    insEvent.run(run, task, type, body, iso(ms));
    events++;
  };

  // One agent attempt's event stream, shaped like spawn.ts writes it.
  const attempt = (run: string, id: string, start: number, end: number, outcome: "ok" | "fail" | "orphan" | "legacy") => {
    ev(run, id, "task.dispatched", payload({ role: "engineer" }), start - 2_000);
    if (outcome === "legacy") return;
    ev(run, id, "container.started", payload({ containerName: `forge-${id}`, containerId: "abc" }), start + 1_000);
    const chatter = 2 + Math.floor(rand() * 3);
    for (let i = 0; i < chatter; i++) ev(run, id, "agent.progress", payload({ message: "working", percent: i * 25 }), start + (i + 1) * ((end - start) / (chatter + 2)));
    if (outcome === "orphan") return;
    ev(run, id, pick(["container.exited", "container.exited", "container.exited", "container.idle_timeout"]), payload({ exitCode: 0 }), end - 5_000);
    if (outcome === "fail") ev(run, id, "task.failed", payload({ failure_kind: pick(failKinds), error: "x" }), end);
    else ev(run, id, "task.completed", "{}", end);
  };

  db.transaction(() => {
    for (let r = 0; tasks < TARGET_TASKS; r++) {
      const runId = `run-aged-${r}`;
      const age = rand();
      // Half the runs in the last 30 days, 30% in 30–90, the rest out to 240.
      const created = now - Math.floor((age < 0.5 ? age * 60 : age < 0.8 ? 30 + (age - 0.5) * 200 : 90 + (age - 0.8) * 750) * DAY);
      const runStatus = created > now - HOUR ? "active" : pick(["complete", "complete", "complete", "failed", "abandoned"]);
      insRun.run(runId, pick(["feature", "feature", "invoke", "review"]), `aged run ${r}`, runStatus, iso(created), iso(created + 3 * HOUR), pick(projects));
      ev(runId, null, "run.created", "{}", created);
      ev(runId, null, "review_loop.ci_observed", payload({ outcome: "passed", contexts: [] }), created + 2 * HOUR);
      if (rand() < 0.2) ev(runId, null, pick(["task.cancelled", "run.cancelled", "task.retried", "task.blocked_by_red"]), "{}", created + HOUR);

      const width = 3 + Math.floor(rand() * 3);
      let clock = created;
      for (let k = 0; k < width; k++) {
        const id = `task-aged-${r}-${k}`;
        const duration = 2 * MIN + Math.floor(rand() * 40 * MIN);
        const shape = rand();
        const outcome = shape < 0.08 ? "legacy" : shape < 0.13 ? "orphan" : shape < 0.3 ? "fail" : "ok";
        let start = clock;
        if (rand() < 0.08) {
          // Retried in place: the prior attempt's stream stays behind started_at.
          attempt(runId, id, start, start + duration, "fail");
          start += duration + 5 * MIN;
        }
        const end = start + duration;
        const status = outcome === "ok" || outcome === "legacy" ? "complete" : "failed";
        insTask.run(id, runId, null, pick(phases), pick(roles), "sonnet", status, iso(start), iso(start), iso(end));
        tasks++;
        attempt(runId, id, start, end, outcome);
        if (outcome === "orphan") ev(runId, id, "task.failed", payload({ failure_kind: "orphaned" }), end);
        if (rand() < 0.03) ev(runId, id, "task.reconciled", payload({ from: "running", to: "complete" }), end + MIN);

        if (rand() < 0.1) {
          // A fanout: this task coordinates three children and runs no container.
          for (let c = 0; c < 3; c++) {
            const childId = `${id}-c${c}`;
            const childEnd = start + (c + 1) * 3 * MIN;
            insTask.run(childId, runId, id, "build", "engineer", "sonnet", "complete", iso(start), iso(start), iso(childEnd));
            tasks++;
            attempt(runId, childId, start, childEnd, "ok");
          }
        }
        clock = end + MIN;
      }
      // The orchestrator's own session task — excluded from the runtime chart.
      if (rand() < 0.05) {
        insTask.run(`session-${r}`, runId, null, "session", "orchestrator", "opus", "complete", iso(created), iso(created), iso(created + 2 * HOUR));
        tasks++;
      }
    }
    // Top up with run-level review-loop noise to the operator's event volume.
    for (let i = 0; events < TARGET_EVENTS; i++) {
      ev(`run-aged-${i % 1000}`, null, pick(["review_loop.ci_observed", "review.state_changed", "run.note"]), "{}", now - Math.floor(rand() * 200 * DAY));
    }
  })();
  db.close();
  return { tasks, events };
})();

const realFetch = globalThis.fetch;
const { server } = await import("./server.js");
const { AGENT_RUNTIME_WINDOWS, agentRuntimeRowsStatement, opsMetricsStatements } = await import("./queries.js");

after(() => {
  server.closeAllConnections?.();
  server.close();
  rmSync(tmpHome, { recursive: true, force: true });
});

async function waitForServer(ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await realFetch(`${BASE}/`); return; } catch { await new Promise((r) => setTimeout(r, 40)); }
  }
  throw new Error(`server on ${TEST_PORT} did not start within ${ms}ms`);
}
await waitForServer();

function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.ceil(0.95 * sorted.length) - 1]!;
}

async function measure(path: string): Promise<{ p95: number; max: number; samples: number[]; body: unknown }> {
  let body: unknown = null;
  const samples: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const res = await realFetch(`${BASE}${path}`);
    body = await res.json();
    samples.push(Math.round(performance.now() - t0));
    assert.equal(res.status, 200, `${path} answered ${res.status}`);
  }
  return { p95: p95(samples), max: Math.max(...samples), samples, body };
}

test("FG-836: the fixture is production-shaped — the operator's task and event volume", () => {
  assert.ok(seeded.tasks >= TARGET_TASKS, `tasks=${seeded.tasks}`);
  assert.ok(seeded.events >= TARGET_EVENTS, `events=${seeded.events}`);
  console.log(`# FG-836 fixture: ${seeded.tasks} tasks, ${seeded.events} events`);
});

for (const window of AGENT_RUNTIME_WINDOWS) {
  test(`FG-836: GET /api/agent-runtime?window=${window} p95 < ${BUDGET_MS} ms over ${SAMPLES} runs`, async () => {
    const { p95: p, max, samples, body } = await measure(`/api/agent-runtime?window=${window}`);
    console.log(`# FG-836 /api/agent-runtime?window=${window}: p95=${p}ms max=${max}ms`);
    const trends = body as { overall: Array<{ sampleCount: number }> };
    assert.ok(trends.overall.reduce((n, b) => n + b.sampleCount, 0) > 0, "the window carries observations — not a vacuous empty answer");
    assert.ok(p < BUDGET_MS, `p95 ${p}ms exceeds ${BUDGET_MS}ms (${samples.join(",")})`);
  });
}

for (const since of ["30d", "7d", "90d", "all"]) {
  const path = since === "30d" ? "/api/ops" : `/api/ops?since=${since}`;
  test(`FG-836: GET ${path} p95 < ${BUDGET_MS} ms over ${SAMPLES} runs`, async () => {
    const { p95: p, max, samples, body } = await measure(path);
    console.log(`# FG-836 ${path}: p95=${p}ms max=${max}ms`);
    const ops = body as { runs: { total: number }; failureKinds: unknown[] };
    assert.ok(ops.runs.total > 0 && ops.failureKinds.length > 0, "the roll-up carries runs and failures — not vacuous");
    assert.ok(p < BUDGET_MS, `p95 ${p}ms exceeds ${BUDGET_MS}ms (${samples.join(",")})`);
  });
}

// ── The plan: what keeps the budget from eroding as the store grows ────────────

type PlanRow = { id: number; parent: number; detail: string };

function planOf(sql: string, params: unknown[]): PlanRow[] {
  const db = new Database(DB_PATH, { readonly: true });
  try {
    return db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as PlanRow[];
  } finally {
    db.close();
  }
}

// Every alias the two endpoints give the events table, plus its bare name.
const EVENTS_ALIASES = ["events", "e"];

function assertSetBased(name: string, plan: PlanRow[]): void {
  const text = plan.map((r) => r.detail).join("\n");
  assert.ok(plan.length > 0, `${name}: no plan`);
  assert.doesNotMatch(text, /CORRELATED/, `${name}: a correlated subquery is re-evaluated per row:\n${text}`);
  const eventsAccess = plan.filter((r) => EVENTS_ALIASES.some((a) => new RegExp(`^(SCAN|SEARCH) ${a}\\b`).test(r.detail)));
  assert.ok(eventsAccess.length > 0, `${name}: expected the plan to read events:\n${text}`);
  for (const row of eventsAccess) {
    assert.match(row.detail, /^SEARCH /, `${name}: events is scanned, not searched through an index:\n${text}`);
    assert.match(row.detail, /USING (COVERING )?INDEX /, `${name}: events access uses no index:\n${text}`);
  }
}

for (const window of AGENT_RUNTIME_WINDOWS) {
  test(`FG-836: the /api/agent-runtime ${window} statement is set-based — events searched by (task_id, event_type), nothing correlated`, () => {
    const statement = agentRuntimeRowsStatement(window);
    const plan = planOf(statement.sql, statement.params);
    assertSetBased(`agent-runtime ${window}`, plan);
    assert.ok(
      plan.some((r) => /SEARCH e USING INDEX idx_events_task_type_created \(task_id=\? AND event_type=\?\)/.test(r.detail)),
      `the per-task events summary reads through the FG-836 index:\n${plan.map((r) => r.detail).join("\n")}`,
    );
  });
}

for (const since of ["30d", "all"]) {
  test(`FG-836: every /api/ops statement (since=${since}) is set-based`, () => {
    const statements = opsMetricsStatements(since);
    for (const statement of Object.values(statements)) {
      const plan = planOf(statement.sql, statement.params);
      const text = plan.map((r) => r.detail).join("\n");
      assert.doesNotMatch(text, /CORRELATED/, `${statement.name}: a correlated subquery is re-evaluated per row:\n${text}`);
      if (statement.name === "failedKinds" || statement.name === "counts") assertSetBased(`ops ${statement.name}`, plan);
      else assert.ok(!/\b(SCAN|SEARCH) (e|events)\b/.test(text), `${statement.name} does not read events`);
    }
    const failedPlan = planOf(statements.failedKinds.sql, statements.failedKinds.params).map((r) => r.detail).join("\n");
    assert.match(failedPlan, /SEARCH e USING INDEX idx_events_task_type_created \(task_id=\? AND event_type=\?\)/, failedPlan);
  });
}

// Runs last: the dashboard opens the store read-only and cannot create the index,
// so until a current forge binary has opened it, the endpoints read a store without
// it. They must stay set-based and inside the budget there too, on idx_events_task.
test("FG-836: a store that predates idx_events_task_type_created stays in budget and set-based", async () => {
  const writable = new Database(DB_PATH);
  writable.exec("DROP INDEX idx_events_task_type_created");
  try {
    for (const window of AGENT_RUNTIME_WINDOWS) {
      const statement = agentRuntimeRowsStatement(window);
      assertSetBased(`agent-runtime ${window} (no FG-836 index)`, planOf(statement.sql, statement.params));
      const { p95: p, samples } = await measure(`/api/agent-runtime?window=${window}`);
      console.log(`# FG-836 (no index) /api/agent-runtime?window=${window}: p95=${p}ms`);
      assert.ok(p < BUDGET_MS, `p95 ${p}ms exceeds ${BUDGET_MS}ms (${samples.join(",")})`);
    }
    for (const statement of Object.values(opsMetricsStatements("all"))) {
      const text = planOf(statement.sql, statement.params).map((r) => r.detail).join("\n");
      assert.doesNotMatch(text, /CORRELATED/, `${statement.name}:\n${text}`);
      assert.doesNotMatch(text, /\bSCAN (e|events)\b/, `${statement.name}:\n${text}`);
    }
    const failedPlan = planOf(opsMetricsStatements("all").failedKinds.sql, opsMetricsStatements("all").failedKinds.params)
      .map((r) => r.detail).join("\n");
    assert.match(failedPlan, /SEARCH e USING INDEX idx_events_task \(task_id=\?\)/, failedPlan);
    const { p95: p, samples } = await measure("/api/ops?since=all");
    console.log(`# FG-836 (no index) /api/ops?since=all: p95=${p}ms`);
    assert.ok(p < BUDGET_MS, `p95 ${p}ms exceeds ${BUDGET_MS}ms (${samples.join(",")})`);
  } finally {
    writable.exec(SCHEMA_SQL);
    writable.close();
  }
});
