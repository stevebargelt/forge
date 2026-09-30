// FG-836: the set-based rewrite of /api/agent-runtime and /api/ops changes HOW the
// aggregates are computed, never WHAT they are. This file keeps the pre-FG-836
// correlated-subquery derivations frozen under test-only names and asserts that the
// shipped endpoints return bucket-for-bucket, kind-for-kind the same answer on one
// fixture that carries every shape the old queries had an opinion about: tasks with
// no exit event (layer 2), no-exit orphans (the FG-758 shape — kept as-is here, not
// fixed), unauthorized exits, stale prior-attempt events, starts after exits, fanout
// parents and their children, several task.failed events per task including a
// created_at tie, reconcile audits, unparseable timestamps and payloads — plus a
// seeded random population over the same event vocabulary to catch what hand-picked
// cases miss.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations } from "../../src/store/db.js";
import type { AgentRuntimeRow, AgentRuntimeRowFilter, AgentRuntimeWindow, OpsMetrics } from "./queries.js";

const home = mkdtempSync(join(tmpdir(), "forge-fg836-golden-"));
process.env.FORGE_HOME = home;
const DB_PATH = join(home, "forge.db");

const { agentRuntimeTrends, agentRuntimeTrendsFrom, opsMetrics, AGENT_RUNTIME_WINDOWS } = await import("./queries.js");

const NOW = Date.parse("2026-09-29T15:30:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms: number) => new Date(ms).toISOString();

// ── The fixture ──────────────────────────────────────────────────────────────

const store = new Database(DB_PATH);
store.exec(SCHEMA_SQL);
applyMigrations(store);

const insRun = store.prepare(
  "INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?,?,?,?,?,?,?)",
);
const insTask = store.prepare(
  `INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, agent_model, status, task_package, created_at, started_at, completed_at)
   VALUES (?,?,?,?,?,?,?,'{}',?,?,?)`,
);
const insEvent = store.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)");

type Ev = [type: string, at: string, payload?: string | null];
type T = {
  id: string; run: string; role?: string; phase?: string; status?: string; parent?: string | null;
  started: string | null; completed: string | null; events?: Ev[];
};

function task(t: T): void {
  insTask.run(
    t.id, t.run, t.parent ?? null, t.phase ?? "build", t.role ?? "engineer", "sonnet", t.status ?? "complete",
    t.started ?? iso(NOW - 10 * DAY), t.started, t.completed,
  );
  for (const [type, at, payload] of t.events ?? []) insEvent.run(t.run, t.id, type, payload === undefined ? "{}" : payload, at);
}

const failed = (kind: string) => JSON.stringify({ failure_kind: kind });
const at = (base: number, minutes: number) => iso(base + minutes * MIN);

store.transaction(() => {
  const b = NOW - 2 * DAY;
  insRun.run("r-edge", "feature", "edges", "complete", iso(b - HOUR), iso(b + DAY), "/proj/a");
  insRun.run("r-fail", "feature", "fails", "failed", iso(b - HOUR), iso(b + DAY), "/proj/a");
  insRun.run("r-live", "feature", "live", "active", iso(NOW - HOUR), null, "/proj/b");
  insRun.run("r-aband", "invoke", "abandoned", "abandoned", iso(NOW - 3 * DAY), iso(NOW - 3 * DAY), "/proj/b");

  // Layer 1: start then exit.
  task({ id: "t-l1", run: "r-edge", started: at(b, 0), completed: at(b, 40),
    events: [["container.started", at(b, 1)], ["container.exited", at(b, 30)]] });
  // Layer 2: no exit, no start — the pre-instrumentation leaf.
  task({ id: "t-l2", run: "r-edge", role: "tech-lead", started: at(b, 0), completed: at(b, 25) });
  // No-exit orphan (FG-758's shape): started a container, never logged an exit, swept
  // as orphaned. Administrative kind -> dropped; the unswept twin keeps completed_at.
  task({ id: "t-orphan", run: "r-edge", status: "failed", started: at(b, 0), completed: at(b, 600),
    events: [["container.started", at(b, 1)], ["task.failed", at(b, 600), failed("orphaned")]] });
  task({ id: "t-orphan-unswept", run: "r-edge", status: "complete", started: at(b, 0), completed: at(b, 900),
    events: [["container.started", at(b, 1)]] });
  // Exit with no start at all: attached but unauthorized -> dropped outright.
  task({ id: "t-unauth", run: "r-edge", started: at(b, 0), completed: at(b, 300),
    events: [["container.exited", at(b, 280)]] });
  // Start AFTER the first exit: the first exit is passed over for the second.
  task({ id: "t-late-start", run: "r-edge", started: at(b, 0), completed: at(b, 120),
    events: [["container.exited", at(b, 5)], ["container.started", at(b, 10)], ["container.idle_timeout", at(b, 90)],
      ["container.exited", at(b, 100)]] });
  // Start and exit at the same instant: the start authorizes the exit it coincides with.
  task({ id: "t-same-instant", run: "r-edge", role: "test-engineer", started: at(b, 0), completed: at(b, 30),
    events: [["container.started", at(b, 7)], ["container.exited", at(b, 7)]] });
  // Two exits at the same instant: the id tie-break picks the first inserted.
  task({ id: "t-exit-tie", run: "r-edge", started: at(b, 0), completed: at(b, 70),
    events: [["container.started", at(b, 0)], ["container.git_unavailable", at(b, 50)], ["container.exited", at(b, 50)]] });
  // Retried in place: every prior-attempt event predates started_at and is ignored.
  task({ id: "t-retry", run: "r-edge", role: "red-wide", status: "failed", started: at(b, 200), completed: at(b, 260),
    events: [["container.started", at(b, 10)], ["container.exited", at(b, 20)], ["task.failed", at(b, 21), failed("agent_error")],
      ["container.started", at(b, 201)], ["container.exited", at(b, 250)], ["task.failed", at(b, 251), failed("idle_timeout")]] });
  // Prior attempt was cancelled (administrative), this attempt failed on its own.
  task({ id: "t-retry-admin", run: "r-edge", status: "failed", started: at(b, 200), completed: at(b, 230),
    events: [["task.failed", at(b, 100), failed("cancelled")], ["task.failed", at(b, 230), failed("agent_error")]] });
  // Several task.failed on this attempt; the LATEST (a gate rejection) wins -> dropped.
  task({ id: "t-multi-fail", run: "r-fail", status: "failed", started: at(b, 0), completed: at(b, 500),
    events: [["task.failed", at(b, 60), failed("agent_error")], ["task.failed", at(b, 500), failed("gate_rejected")]] });
  // task.failed tie on created_at: id DESC picks the later insert.
  task({ id: "t-fail-tie", run: "r-fail", status: "failed", started: at(b, 0), completed: at(b, 45),
    events: [["task.failed", at(b, 45), failed("cancelled")], ["task.failed", at(b, 45), failed("agent_error")]] });
  task({ id: "t-fail-tie2", run: "r-fail", status: "failed", started: at(b, 0), completed: at(b, 46),
    events: [["task.failed", at(b, 46), failed("agent_error")], ["task.failed", at(b, 46), failed("cancelled")]] });
  // Failure payloads that are not objects / not JSON / NULL.
  task({ id: "t-fail-bad", run: "r-fail", status: "failed", started: at(b, 0), completed: at(b, 33),
    events: [["task.failed", at(b, 33), "{not json"]] });
  task({ id: "t-fail-null", run: "r-fail", status: "failed", started: at(b, 0), completed: at(b, 34),
    events: [["task.failed", at(b, 34), null]] });
  task({ id: "t-fail-none", run: "r-fail", status: "failed", started: at(b, 0), completed: at(b, 35) });
  // Reconciled into complete (administrative success) vs a same-status backfill.
  task({ id: "t-recon", run: "r-edge", started: at(b, 0), completed: at(b, 800),
    events: [["task.reconciled", at(b, 800), JSON.stringify({ from: "running", to: "complete" })],
      ["task.reconciled", at(b, 801), JSON.stringify({ from: "complete", to: "complete" })]] });
  task({ id: "t-recon-same", run: "r-edge", started: at(b, 0), completed: at(b, 55),
    events: [["task.reconciled", at(b, 56), JSON.stringify({ from: "complete", to: "complete" })],
      ["task.reconciled", at(b, 57), null]] });
  // Fanout coordinator with children and no container; a parent whose only start was a
  // prior attempt; a parent that ran its own container this attempt.
  task({ id: "p-coord", run: "r-edge", started: at(b, 0), completed: at(b, 3 * 24 * 60) });
  task({ id: "c-1", run: "r-edge", parent: "p-coord", started: at(b, 5), completed: at(b, 50),
    events: [["container.started", at(b, 5)], ["container.exited", at(b, 49)]] });
  task({ id: "c-2", run: "r-fail", parent: "p-coord", status: "failed", started: at(b, 5), completed: at(b, 51),
    events: [["container.started", at(b, 5)], ["container.exited", at(b, 50)], ["task.failed", at(b, 51), failed("idle_timeout")]] });
  task({ id: "p-stale", run: "r-edge", started: at(b, 100), completed: at(b, 2000),
    events: [["container.started", at(b, 10)]] });
  task({ id: "c-3", run: "r-edge", parent: "p-stale", started: at(b, 101), completed: at(b, 102) });
  task({ id: "p-real", run: "r-edge", started: at(b, 0), completed: at(b, 90),
    events: [["container.started", at(b, 1)], ["container.exited", at(b, 80)]] });
  task({ id: "c-4", run: "r-edge", parent: "p-real", started: at(b, 2), completed: at(b, 3) });
  // Unparseable event timestamps never mask a valid sibling.
  task({ id: "t-bad-ts", run: "r-edge", started: at(b, 0), completed: at(b, 60),
    events: [["container.started", "garbage"], ["container.started", at(b, 2)], ["container.exited", "not-a-date"],
      ["container.exited", at(b, 44)], ["task.failed", "zzz", failed("cancelled")]] });
  // Unparseable started_at: no event is bounded after it.
  task({ id: "t-bad-start", run: "r-edge", started: "someday", completed: at(b, 60),
    events: [["container.started", at(b, 2)], ["container.exited", at(b, 44)]] });
  // Completed before started, completed in the future, orchestrator session, no role end.
  task({ id: "t-backwards", run: "r-edge", started: at(b, 100), completed: at(b, 50) });
  task({ id: "t-future", run: "r-live", started: iso(NOW - HOUR), completed: iso(NOW + HOUR) });
  task({ id: "t-session", run: "r-live", role: "orchestrator", phase: "session", started: iso(NOW - 2 * HOUR), completed: iso(NOW - HOUR) });
  task({ id: "t-orch-other", run: "r-live", role: "orchestrator", phase: "plan", started: iso(NOW - 2 * HOUR), completed: iso(NOW - HOUR) });
  task({ id: "t-running", run: "r-live", status: "running", started: iso(NOW - HOUR), completed: null,
    events: [["container.started", iso(NOW - HOUR)]] });
  task({ id: "t-aband", run: "r-aband", status: "failed", started: iso(NOW - 3 * DAY), completed: iso(NOW - 3 * DAY + HOUR),
    events: [["task.failed", iso(NOW - 3 * DAY + HOUR), failed("fanout_wave_orphaned")]] });
  // Window edges are deliberately awkward: inclusion is owned by completed_at,
  // while the measured end may be an observed container exit. Keep both sides in
  // the fixed fixture so a future query rewrite cannot accidentally move either
  // predicate into the event summary CTE.
  const sevenDayBoundary = NOW - 7 * DAY;
  task({ id: "t-boundary-exit", run: "r-edge", role: "boundary-exit", started: iso(sevenDayBoundary - HOUR), completed: iso(sevenDayBoundary),
    events: [["container.started", iso(sevenDayBoundary - 30 * MIN)], ["container.exited", iso(sevenDayBoundary)]] });
  task({ id: "t-boundary-overrun", run: "r-edge", role: "boundary-overrun", started: iso(sevenDayBoundary + MIN), completed: iso(NOW - MIN),
    events: [["container.started", iso(sevenDayBoundary + 2 * MIN)], ["container.exited", iso(NOW + HOUR)]] });
  insEvent.run("r-edge", null, "task.cancelled", "{}", at(b, 1));
  insEvent.run("r-fail", null, "run.cancelled", "{}", at(b, 1));
  insEvent.run("r-fail", "t-retry", "task.retried", "{}", at(b, 199));
  insEvent.run("r-aband", null, "task.blocked_by_red", "{}", iso(NOW - 3 * DAY));

  // The seeded random population: every event type the derivations read, placed
  // before, at and after started_at, over 200 days so every window has rows.
  let seed = 836;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const pick = <V>(xs: readonly V[]): V => xs[Math.floor(rand() * xs.length)]!;
  const roles = ["engineer", "tech-lead", "red-wide", "test-engineer", "documentation-maintainer"];
  const kinds = ["agent_error", "idle_timeout", "cancelled", "orphaned", "gate_rejected", "oom_killed", "pre_container_crash"];
  const types = ["container.started", "container.exited", "container.idle_timeout", "container.dependency_provisioning_failed",
    "container.git_unavailable", "container.killed", "task.failed", "task.reconciled", "task.completed", "agent.progress"];
  for (let r = 0; r < 120; r++) {
    const created = NOW - Math.floor(rand() * 200 * DAY);
    const runId = `rr-${r}`;
    const runStatus = pick(["complete", "complete", "failed", "abandoned", "active"]);
    insRun.run(runId, "feature", `random ${r}`, runStatus, iso(created), iso(created + DAY), pick(["/proj/a", "/proj/b"]));
    const ids: string[] = [];
    for (let k = 0; k < 6; k++) {
      const id = `rt-${r}-${k}`;
      const start = created + Math.floor(rand() * 6 * HOUR);
      const done = start + Math.floor((rand() - 0.05) * 3 * HOUR);
      const status = pick(["complete", "complete", "failed", "failed", "running"]);
      const parent = ids.length > 0 && rand() < 0.2 ? pick(ids) : null;
      const events: Ev[] = [];
      const n = Math.floor(rand() * 9);
      for (let e = 0; e < n; e++) {
        const type = pick(types);
        const when = start + Math.floor((rand() - 0.3) * 4 * HOUR);
        const payload = type === "task.failed" ? failed(pick(kinds))
          : type === "task.reconciled" ? JSON.stringify({ from: pick(["running", "complete", "failed"]), to: pick(["complete", "failed"]) })
          : "{}";
        events.push([type, iso(rand() < 0.1 ? start : when), payload]);
      }
      task({ id, run: runId, role: pick(roles), status, parent, started: rand() < 0.03 ? null : iso(start),
        completed: status === "running" && rand() < 0.5 ? null : iso(done), events });
      ids.push(id);
    }
    if (rand() < 0.3) insEvent.run(runId, null, pick(["task.cancelled", "run.cancelled", "task.retried", "task.blocked_by_red"]), "{}", iso(created + HOUR));
  }
})();
store.close();

// ── The frozen pre-FG-836 derivations ────────────────────────────────────────

const legacy = new Database(DB_PATH, { readonly: true });

// Verbatim the agentRuntimeTrends row query as it shipped before FG-836.
function legacyAgentRuntimeRows(filter: AgentRuntimeRowFilter): AgentRuntimeRow[] {
  const exitEvents = ["container.exited", "container.idle_timeout", "container.dependency_provisioning_failed", "container.git_unavailable"]
    .map((e) => `'${e}'`).join(",");
  return legacy.prepare(`
    SELECT t.agent_role AS role, t.started_at AS started, t.completed_at AS completed, t.status AS status,
      (SELECT x.created_at FROM events x
        WHERE x.task_id = t.id AND x.event_type IN (${exitEvents})
          AND julianday(x.created_at) >= julianday(t.started_at)
          AND EXISTS (SELECT 1 FROM events s
            WHERE s.task_id = t.id AND s.event_type = 'container.started'
              AND julianday(s.created_at) >= julianday(t.started_at)
              AND julianday(s.created_at) <= julianday(x.created_at))
        ORDER BY julianday(x.created_at), x.id LIMIT 1) AS agentExit,
      EXISTS (SELECT 1 FROM events e
        WHERE e.task_id = t.id AND e.event_type IN (${exitEvents})
          AND julianday(e.created_at) >= julianday(t.started_at)) AS attachedExit,
      EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id) AS hasChildren,
      EXISTS (SELECT 1 FROM events cs
        WHERE cs.task_id = t.id AND cs.event_type = 'container.started'
          AND julianday(cs.created_at) >= julianday(t.started_at)) AS containerStarted,
      (SELECT f.payload FROM events f
        WHERE f.task_id = t.id AND f.event_type = 'task.failed'
          AND julianday(f.created_at) >= julianday(t.started_at)
        ORDER BY julianday(f.created_at) DESC, f.id DESC LIMIT 1) AS failedPayload,
      (SELECT group_concat(c.payload, char(30)) FROM events c
        WHERE c.task_id = t.id AND c.event_type = 'task.reconciled'
          AND julianday(c.created_at) >= julianday(t.started_at)) AS reconciledPayloads
    FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.agent_role IS NOT NULL
      AND t.started_at IS NOT NULL
      AND t.completed_at IS NOT NULL
      AND NOT (t.agent_role = 'orchestrator' AND t.phase IS 'session')
      ${filter.clause}
  `).all(...filter.params) as AgentRuntimeRow[];
}

// Verbatim opsMetrics as it shipped before FG-836 (unscoped: the scope predicate is
// the same text in both and is not what the rewrite touched).
function legacyOpsMetrics(since: string): OpsMetrics {
  const cutoff = since === "all" ? null
    : (() => { const m = since.match(/^(\d+)d$/); return m?.[1] ? new Date(Date.now() - parseInt(m[1], 10) * 86400_000).toISOString() : null; })();
  const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? Math.round((s[mid - 1]! + s[mid]!) / 2) : s[mid]!;
  };
  const win = () => cutoff ? { clause: " AND r.created_at >= ?", params: [cutoff] } : { clause: "", params: [] as unknown[] };
  const rw = win();
  const runRows = legacy.prepare(`
    SELECT r.id, r.status AS status,
      (SELECT COUNT(*) FROM tasks t WHERE t.run_id = r.id AND t.parent_id IS NULL AND t.status = 'failed') AS failed
    FROM runs r WHERE 1 = 1 ${rw.clause}
  `).all(...rw.params) as Array<{ id: string; status: string; failed: number }>;
  const total = runRows.length;
  const terminalRows = runRows.filter((r) => r.status === "complete" || r.status === "failed" || r.status === "abandoned");
  const terminal = terminalRows.length;
  const clean = terminalRows.filter((r) => r.status === "complete" && r.failed === 0).length;
  const tw = win();
  const taskCount = (legacy.prepare(`
    SELECT COUNT(*) AS c FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.parent_id IS NULL ${tw.clause}
  `).get(...tw.params) as { c: number }).c;
  const fw = win();
  const failedKindRows = legacy.prepare(`
    SELECT e.payload AS payload
    FROM events e
    JOIN tasks t ON t.id = e.task_id
    JOIN runs  r ON r.id = t.run_id
    WHERE e.event_type = 'task.failed'
      AND t.parent_id IS NULL AND t.status = 'failed'
      AND e.created_at = (SELECT MAX(e2.created_at) FROM events e2 WHERE e2.task_id = e.task_id AND e2.event_type = 'task.failed')
      ${fw.clause}
  `).all(...fw.params) as Array<{ payload: string | null }>;
  const kindCounts = new Map<string, number>();
  for (const row of failedKindRows) {
    let kind = "unknown";
    try { const p = row.payload ? JSON.parse(row.payload) : null; if (p && typeof p.failure_kind === "string") kind = p.failure_kind; } catch { /* keep unknown */ }
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const failureKinds = [...kindCounts.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
  const dw = win();
  const durRows = legacy.prepare(`
    SELECT t.phase AS phase, t.started_at AS started, t.completed_at AS completed
    FROM tasks t JOIN runs r ON r.id = t.run_id
    WHERE t.parent_id IS NULL AND t.started_at IS NOT NULL AND t.completed_at IS NOT NULL ${dw.clause}
  `).all(...dw.params) as Array<{ phase: string; started: string; completed: string }>;
  const byPhase = new Map<string, number[]>();
  for (const r of durRows) {
    const ms = new Date(r.completed).getTime() - new Date(r.started).getTime();
    if (ms >= 0) { const arr = byPhase.get(r.phase) ?? []; arr.push(ms); byPhase.set(r.phase, arr); }
  }
  const durations = [...byPhase.entries()].map(([dimension, arr]) => ({ dimension, count: arr.length, medianMs: median(arr) })).sort((a, b) => b.count - a.count);
  const cw = win();
  const countRows = legacy.prepare(`
    SELECT e.event_type AS et, COUNT(*) AS c
    FROM events e JOIN runs r ON r.id = e.run_id
    WHERE e.event_type IN ('task.cancelled','run.cancelled','task.retried','task.blocked_by_red') ${cw.clause}
    GROUP BY e.event_type
  `).all(...cw.params) as Array<{ et: string; c: number }>;
  const countOf = (t: string) => countRows.find((r) => r.et === t)?.c ?? 0;
  return {
    runs: { total, active: total - terminal, terminal, clean, withFailures: terminal - clean, successRate: terminal > 0 ? clean / terminal : 0 },
    taskCount,
    failureKinds,
    durations,
    counts: {
      idleKills: failureKinds.find((f) => f.kind === "idle_timeout")?.count ?? 0,
      cancels: countOf("task.cancelled") + countOf("run.cancelled"),
      retries: countOf("task.retried"),
      redBlocks: countOf("task.blocked_by_red"),
    },
  };
}

// The failure-kind list is ordered by count only; the relative order of two kinds
// with EQUAL counts fell out of whichever plan SQLite chose and was never part of
// the contract, so ties are compared as a set.
const tieStable = (m: OpsMetrics): OpsMetrics => ({
  ...m,
  failureKinds: [...m.failureKinds].sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind)),
});

// ── The comparisons ──────────────────────────────────────────────────────────

test("FG-836 golden: the fixture exercises every shape the derivations distinguish", () => {
  const rows = legacyAgentRuntimeRows({ cutoffStart: null, clause: "", params: [] });
  assert.ok(rows.length > 500, `expected a broad population, got ${rows.length} rows`);
  for (const [field, label] of [["attachedExit", "attached exit"], ["hasChildren", "fanout parent"], ["containerStarted", "own start"]] as const) {
    assert.ok(rows.some((r) => r[field] === 1) && rows.some((r) => r[field] === 0), `both sides of ${label} are present`);
  }
  assert.ok(rows.some((r) => r.attachedExit === 1 && r.agentExit === null), "an unauthorized exit is present");
  assert.ok(rows.some((r) => r.failedPayload !== null && r.reconciledPayloads !== null), "failures and reconcile audits are present");
});

for (const window of AGENT_RUNTIME_WINDOWS as readonly AgentRuntimeWindow[]) {
  for (const scope of [undefined, "/proj/a", ["/proj/a", "/proj/b"]] as const) {
    test(`FG-836 golden: /api/agent-runtime ${window} ${JSON.stringify(scope ?? "unscoped")} is bucket-for-bucket identical to the pre-FG-836 derivation`, () => {
      const before = agentRuntimeTrendsFrom(legacyAgentRuntimeRows, window, scope, NOW);
      const after = agentRuntimeTrends(window, scope, NOW);
      assert.ok(before.overall.some((b) => b.sampleCount > 0) || window === "1d", "the window carries observations");
      assert.deepEqual(after, before);
    });
  }
}

test("FG-836 golden: the no-exit orphan is handled exactly as before (FG-758 not folded in)", () => {
  const rows = legacyAgentRuntimeRows({ cutoffStart: null, clause: " AND t.id IN ('t-orphan', 't-orphan-unswept')", params: [] });
  assert.equal(rows.length, 2);
  const before = agentRuntimeTrendsFrom(
    (f) => legacyAgentRuntimeRows({ ...f, clause: `${f.clause} AND t.id IN ('t-orphan', 't-orphan-unswept')` }), "7d", undefined, NOW);
  // The swept orphan is dropped (administrative kind); the unswept one keeps its
  // whole completed_at − started_at, the skew FG-758 exists to address.
  assert.deepEqual(before.roleSummary, [{ role: "engineer", averageMs: 900 * MIN, sampleCount: 1 }]);
  const all = agentRuntimeTrends("7d", undefined, NOW);
  assert.deepEqual(all, agentRuntimeTrendsFrom(legacyAgentRuntimeRows, "7d", undefined, NOW));
});

for (const since of ["1d", "7d", "30d", "90d", "all"]) {
  test(`FG-836 golden: /api/ops since=${since} is identical to the pre-FG-836 derivation`, () => {
    const before = legacyOpsMetrics(since);
    const after = opsMetrics(since);
    assert.ok(since === "1d" || before.failureKinds.length > 0, "the window carries failures");
    assert.deepEqual(tieStable(after), tieStable(before));
  });
}

test("FG-836 golden: boundary exits and in-window starts retain their legacy buckets", () => {
  const before = agentRuntimeTrendsFrom(legacyAgentRuntimeRows, "7d", undefined, NOW);
  const after = agentRuntimeTrends("7d", undefined, NOW);
  // This is a DTO-byte comparison, not a parsed-object comparison: ordering,
  // nullability and numeric rendering are part of the HTTP JSON contract too.
  assert.equal(JSON.stringify(after), JSON.stringify(before));
  assert.deepEqual(after.roleSummary.find((row) => row.role === "boundary-exit"), {
    role: "boundary-exit", averageMs: HOUR, sampleCount: 1,
  });
  assert.deepEqual(after.roleSummary.find((row) => row.role === "boundary-overrun"), {
    role: "boundary-overrun", averageMs: 7 * DAY + HOUR - MIN, sampleCount: 1,
  });
});

test("FG-836 golden: fixed-fixture endpoint DTO JSON is byte-identical to the legacy derivations", () => {
  for (const window of AGENT_RUNTIME_WINDOWS as readonly AgentRuntimeWindow[]) {
    const before = agentRuntimeTrendsFrom(legacyAgentRuntimeRows, window, undefined, NOW);
    const after = agentRuntimeTrends(window, undefined, NOW);
    assert.equal(JSON.stringify(after), JSON.stringify(before), `/api/agent-runtime?window=${window}`);
  }
  for (const since of ["1d", "7d", "30d", "90d", "all"]) {
    const before = tieStable(legacyOpsMetrics(since));
    const after = tieStable(opsMetrics(since));
    assert.equal(JSON.stringify(after), JSON.stringify(before), `/api/ops?since=${since}`);
  }
});

test("FG-836 golden: a created_at tie between task.failed events counts every tied row, as before", () => {
  // t-fail-tie and t-fail-tie2 each carry two task.failed rows at the SAME instant;
  // the MAX(created_at) selection keeps both, so each contributes one agent_error and
  // one cancelled. The count for the hand-built r-fail run proves the rewrite keeps it.
  const before = legacyOpsMetrics("7d");
  const after = opsMetrics("7d");
  const kind = (m: OpsMetrics, k: string) => m.failureKinds.find((f) => f.kind === k)?.count ?? 0;
  assert.ok(kind(before, "unknown") >= 2, "invalid and NULL payloads read as unknown");
  assert.equal(kind(after, "cancelled"), kind(before, "cancelled"));
  assert.equal(kind(after, "unknown"), kind(before, "unknown"));
});
