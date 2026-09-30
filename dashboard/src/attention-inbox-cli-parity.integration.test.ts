// FG-820: the "one derivation" guarantee, as a test. `forge attention list --json` and GET
// /api/attention-inbox must serve the SAME envelope for the same store and scope — the
// CLI drives the REAL co-located bin/forge (which shells into the dashboard entry), the
// route is the real server. The only field allowed to differ is `generatedAt`, the wall
// clock of each read.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureFetch } from "./test-support/fixture-fetch.js";

const TEST_PORT = 18820;
const BASE = `http://127.0.0.1:${TEST_PORT}`;
process.env.FORGE_DASHBOARD_REMOTE = "0";
const { awaitDashboardReady } = await import("./test-support/await-dashboard-ready.js");

const tmpHome = mkdtempSync(join(tmpdir(), "forge-inbox-parity-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { insertConflict } = await import("@forge/kanban-projection");

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");
const AT = "2026-09-20T09:00:00Z";
const OLDER = "2026-09-19T09:00:00Z";
// Relative to the real clock: each surface reads with its own Date.now(), and a start 15m
// ago is past the 10m campaign-gate staleness cutoff yet well inside the 24h lookback for both.
const VERIF_START = new Date(Date.now() - 15 * 60_000).toISOString();

const projectDir = mkdtempSync(join(tmpdir(), "forge-inbox-parity-proj-"));
mkdirSync(join(projectDir, ".forge", "workflows"), { recursive: true });
copyFileSync(join(REPO_ROOT, "seeds/workflows/feature.yml"), join(projectDir, ".forge", "workflows", "feature.yml"));
const otherDir = mkdtempSync(join(tmpdir(), "forge-inbox-parity-other-"));

writeTransaction(() => {
  const db = getDb();
  const run = db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir, metadata) VALUES (?,?,?,?,?,?,?)`,
  );
  const task = db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at) VALUES (?,?,?,?,?,?,?,?)`,
  );
  const event = db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`);

  // A gate wait (medium), a red block (high) and an auth wall (high) in the project.
  run.run("run-gate", "feature", "gate run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-900" }));
  task.run("task-gate", "run-gate", "architect", "architecture-advisor", "awaiting_gate", "{}", AT, OLDER);
  run.run("run-red", "feature", "red run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-901" }));
  task.run("task-red", "run-red", "build", "engineer", "blocked_by_red", "{}", AT, OLDER);
  run.run("run-auth", "feature", "auth run", "active", AT, projectDir, JSON.stringify({ ticketId: "FG-902" }));
  task.run("task-auth", "run-auth", "build", "engineer", "failed", "{}", AT, OLDER);
  event.run("run-auth", "task-auth", "task.failed", JSON.stringify({ failure_kind: "auth_missing" }), AT);

  // A merge conflict in ANOTHER checkout — present host-wide, absent from the project scope.
  run.run("run-other", "feature", "other run", "active", AT, otherDir, null);
  task.run("task-other", "run-other", "build", "engineer", "failed", "{}", AT, OLDER);
  event.run("run-other", "task-other", "task.failed", JSON.stringify({ failure_kind: "merge_conflict" }), AT);

  // A stale campaign host gate under an active campaign in the project.
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir) VALUES (?,?,?,?,?,?,?,?)`,
  ).run("camp-parity", "running", "tickets", "[]", "sequential", VERIF_START, VERIF_START, projectDir);
  db.prepare(
    `INSERT INTO campaign_items (id, campaign_id, item_order, ticket_id, lifecycle_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)`,
  ).run("citem-parity", "camp-parity", 0, "FG-903", "running", VERIF_START, VERIF_START);
  event.run(
    null,
    null,
    "campaign_item.host_gate_started",
    JSON.stringify({ attemptId: "att-parity", campaignId: "camp-parity", itemId: "citem-parity", ticketId: "FG-903", command: "npm run test:all", testedSha: "deadbeef012" }),
    VERIF_START,
  );
});

// An open external-board conflict (host-wide source).
insertConflict({
  id: "kc-parity",
  projectIdentity: "pk-parity",
  ticketIdentity: "FG-904",
  provider: "fake",
  externalCardId: "card-1",
  kind: "deleted",
  forgeVersion: { column: "doing" },
  externalVersion: null,
  detectedBy: "sync",
  detectedAt: AT,
  createdAt: AT,
});

const { server } = await import("./server.js");
await awaitDashboardReady(BASE, { timeoutMs: 4000 });
after(() => {
  server.closeAllConnections?.();
  server.close();
});

async function route(query: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 4000;
  for (;;) {
    try {
      const res = await fixtureFetch(`${BASE}/api/attention-inbox${query}`);
      return (await res.json()) as Record<string, unknown>;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 40));
    }
  }
}

function cli(args: string[]): string {
  return execFileSync("sh", [join(REPO_ROOT, "bin", "forge"), "attention", "list", ...args], {
    cwd: projectDir,
    env: { ...process.env, FORGE_HOME: tmpHome },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function withoutClock(envelope: Record<string, unknown>): Record<string, unknown> {
  assert.equal(typeof envelope.generatedAt, "string", `not an envelope: ${JSON.stringify(envelope)}`);
  const { generatedAt: _clock, ...rest } = envelope;
  return rest;
}

const SCOPES: Array<{ name: string; query: string; args: string[] }> = [
  { name: "host-wide (no scope)", query: "", args: [] },
  { name: "one project checkout", query: `?projectDir=${encodeURIComponent(projectDir)}`, args: ["--project", projectDir] },
  { name: "one run", query: "?runId=run-auth", args: ["--run", "run-auth"] },
];

for (const scope of SCOPES) {
  test(`FG-820: CLI --json and GET /api/attention-inbox are deep-equal — ${scope.name}`, async () => {
    const fromRoute = await route(scope.query);
    const fromCli = JSON.parse(cli(["--json", ...scope.args])) as Record<string, unknown>;
    assert.deepEqual(withoutClock(fromCli), withoutClock(fromRoute));
  });
}

test("FG-820: the fixture exercises every source kind and the scopes actually differ (guards a vacuous parity)", async () => {
  const hostWide = (await route("")) as { items: Array<{ kind: string }>; counts: { open: number; high: number }; degraded: string[] };
  assert.deepEqual(hostWide.degraded, []);
  assert.deepEqual(
    [...new Set(hostWide.items.map((i) => i.kind))].sort(),
    ["auth_setup", "blocked_by_red_or_reviewer", "kanban_conflict", "merge_conflict", "stale_verification", "waiting_gate"],
  );
  assert.deepEqual(hostWide.counts, { open: 6, high: 4 });

  const scoped = (await route(`?projectDir=${encodeURIComponent(projectDir)}`)) as { items: Array<{ kind: string }> };
  assert.ok(!scoped.items.some((i) => i.kind === "merge_conflict"), "the other checkout's merge conflict leaked into the project scope");

  const oneRun = (await route("?runId=run-auth")) as { items: Array<{ id: string }>; counts: unknown; scope: unknown };
  assert.deepEqual(
    oneRun.items.map((i) => i.id),
    ["task:task-auth"],
  );
  assert.deepEqual(oneRun.counts, { open: 1, high: 1 });
  assert.deepEqual(oneRun.scope, { runId: "run-auth", projectDirs: null });
});

test("FG-820: the human render's totals footer is the envelope's counts", () => {
  const lines = cli([]).trimEnd().split("\n");
  assert.match(lines[0]!, /^KIND\s+SEVERITY\s+REASON\s+REQUESTED ACTION$/);
  assert.equal(lines.at(-1), "6 open · 4 high");
});
