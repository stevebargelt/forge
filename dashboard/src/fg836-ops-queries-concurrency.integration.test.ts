// FG-836: a set-based query must stay usable under the poll burst a dashboard can
// create. This boots server.ts as a separate dashboard process against an aged,
// production-sized store; importing the request handler would not exercise the real
// read-only startup path or its single HTTP event loop.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations } from "../../src/store/db.js";
import {
  DASHBOARD_READY_MARKER,
  REAL_BOOT_TEST_TIMEOUT_MS,
  awaitBootOrFail,
  httpReady,
  probeRealBootPreconditions,
  spawnRealBoot,
  stopAllRealBoots,
} from "./test-support/real-boot.js";

const PORT = 19018;
const BASE = `http://127.0.0.1:${PORT}`;
const TASKS = 7_000;
const EVENTS = 65_000;
const home = mkdtempSync(join(tmpdir(), "fg836-concurrency-"));
const dbPath = join(home, "forge.db");
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();

function seedProductionSizedStore(): { tasks: number; events: number } {
  const db = new Database(dbPath);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  const run = db.prepare("INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?,?,?,?,?,?,?)");
  const task = db.prepare(`INSERT INTO tasks (id, run_id, parent_id, phase, agent_role, agent_model, status, task_package, created_at, started_at, completed_at)
    VALUES (?,?,?,?,?,?,?,'{}',?,?,?)`);
  const event = db.prepare("INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)");
  let taskCount = 0;
  let eventCount = 0;
  const add = (runId: string, taskId: string | null, type: string, at: number) => {
    event.run(runId, taskId, type, "{}", iso(at));
    eventCount++;
  };
  db.transaction(() => {
    for (let i = 0; taskCount < TASKS; i++) {
      const runId = `aged-run-${i}`;
      const created = now - (i % 180) * 86_400_000 - (i % 12) * 3_600_000;
      run.run(runId, "feature", `aged ${i}`, i % 7 === 0 ? "failed" : "complete", iso(created), iso(created + 3_600_000), "/operator/forge");
      add(runId, null, "run.created", created);
      for (let k = 0; k < 4 && taskCount < TASKS; k++) {
        const taskId = `aged-task-${i}-${k}`;
        const start = created + k * 600_000;
        const end = start + 300_000 + (k % 3) * 60_000;
        task.run(taskId, runId, null, "build", k % 5 === 0 ? "tech-lead" : "engineer", "sonnet", "complete", iso(start), iso(start), iso(end));
        add(runId, taskId, "task.dispatched", start - 1_000);
        add(runId, taskId, "container.started", start + 1_000);
        add(runId, taskId, "agent.progress", start + 60_000);
        add(runId, taskId, "agent.progress", start + 120_000);
        add(runId, taskId, "container.exited", end - 1_000);
        add(runId, taskId, "task.completed", end);
        taskCount++;
      }
    }
    for (let i = eventCount; i < EVENTS; i++) add(`aged-run-${i % 1750}`, null, "review_loop.ci_observed", now - (i % 180) * 86_400_000);
  })();
  db.close();
  return { tasks: taskCount, events: eventCount };
}

const seeded = seedProductionSizedStore();
const dashboardDir = resolve(fileURLToPath(new URL("..", import.meta.url)));
const tsxCli = resolve(dashboardDir, "..", "node_modules", "tsx", "dist", "cli.mjs");

after(async () => {
  await stopAllRealBoots();
  rmSync(home, { recursive: true, force: true });
});

test("FG-836: ten parallel /api/agent-runtime requests each finish within 2 s on a 7k/65k store", { timeout: REAL_BOOT_TEST_TIMEOUT_MS }, async () => {
  assert.ok(seeded.tasks >= TASKS && seeded.events >= EVENTS, `${seeded.tasks} tasks, ${seeded.events} events`);
  await probeRealBootPreconditions({ files: [tsxCli, join(dashboardDir, "src", "server.ts")] });
  const child = spawnRealBoot("FG-836 dashboard subprocess", process.execPath, [tsxCli, "src/server.ts"], {
    cwd: dashboardDir,
    env: { ...process.env, FORGE_HOME: home, PORT: String(PORT), HOST: "127.0.0.1" },
  });
  // The cold tsx loader imports the complete production dashboard graph before binding;
  // the shared startup bound gives readiness room without weakening the per-request 2 s budget.
  await awaitBootOrFail(child, { readyMarker: DASHBOARD_READY_MARKER, probe: httpReady(`${BASE}/api/agent-runtime?window=7d`, (status) => status === 200) });
  const results = await Promise.all(Array.from({ length: 10 }, async () => {
    const started = performance.now();
    const response = await fetch(`${BASE}/api/agent-runtime?window=90d`);
    const body = await response.json() as { overall: unknown[] };
    return { status: response.status, elapsed: performance.now() - started, observations: body.overall.length };
  }));
  for (const result of results) {
    assert.equal(result.status, 200);
    assert.ok(result.observations > 0, "a concurrent request returned a vacuous runtime DTO");
    assert.ok(result.elapsed < 2_000, `request took ${Math.round(result.elapsed)}ms`);
  }
});
