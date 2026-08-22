// FG-742: /api/current-activity must answer inside its 8s client deadline under the
// real dashboard poll mix, even when a SLOW sibling route and an aged production-shaped
// store are in play.
//
// THE DIAGNOSED MECHANISM (recorded here because the fix only makes sense against it).
// The current-activity query is fast — it reads persisted state and shells out to
// nothing (FG-679/BD-7). It exceeded its deadline anyway because it shares ONE
// event-loop thread with /api/in-flight, whose FG-290 reconcile annotation
// `execFileSync`s `docker inspect` per running containerized task (BD-13's recorded
// serving-path exception). That fan-out is synchronous and, before FG-742, UNBOUNDED:
// against a slow or hung docker daemon it holds the single dashboard thread for the sum
// of every probe, and a current-activity poll queued behind it cannot be serviced until
// the block clears — so it aborts at 8s and Home renders "Host and CI waits
// unavailable" while `forge status` shows live work. Not the store volume, not the
// current-activity query, not FG-705 path resolution: a slow SIBLING starving the loop.
//
// THE CONTRACT THIS TEST PINS. A per-request budget (RECONCILE_FANOUT_BUDGET_MS) plus a
// per-inspect timeout (RECONCILE_PROBE_TIMEOUT_MS) bound how long one /api/in-flight
// poll can hold the loop, regardless of how many containers it probes or how hung docker
// is. So current-activity stays comfortably inside its deadline. This drives the REAL
// server over a REAL slow `docker` (a PATH shim that sleeps), against a store seeded with
// thousands of launch/task/event/review rows, and measures the current-activity wall
// clock repeatedly — not one sample.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations } from "../../src/store/db.js";
import {
  CURRENT_ACTIVITY_TIMEOUT_MS,
} from "../client/current-activity-render.js";

const TEST_PORT = 18742;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// The server-side budget this test proves current-activity stays under while a slow
// sibling is polled concurrently — deliberately far below the 8s client deadline so the
// assertion demonstrates SUBSTANTIAL headroom, not a photo-finish. The worst-case
// shared-thread stall the bounded fan-out can impose is ~RECONCILE_FANOUT_BUDGET_MS +
// one RECONCILE_PROBE_TIMEOUT_MS (~4.5s); 6s leaves room for CI jitter while staying a
// full 2s under the deadline.
const SERVER_BUDGET_MS = 6000;

const tmpHome = mkdtempSync(join(tmpdir(), "fg742-home-"));
process.env.FORGE_HOME = tmpHome;
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

// ── An aged, production-shaped store: thousands of launch/task/event/review rows ──────
const db = new Database(join(tmpHome, "forge.db"));
db.exec(SCHEMA_SQL);
applyMigrations(db);

const LIVE_RUN = "run-live-fg742";
const LIVE_TICKET = "FG-742";
const LIVE_SHA = "f".repeat(40);
const PROJECT = "/proj/forge";
const RUNNING_TASKS = 6; // enough that an UNBOUNDED fan-out (6 x sleep) blows the 8s deadline
const iso = (ms: number) => new Date(ms).toISOString();
const now = Date.now();

const seed = db.transaction(() => {
  // 80 historical, COMPLETED runs with tasks + a ci_observed apiece — the retained
  // volume the reproduction requires, not an empty fixture.
  const insRun = db.prepare(`INSERT INTO runs (id, workflow, title, status, created_at, completed_at, project_dir) VALUES (?,?,?,?,?,?,?)`);
  const insTask = db.prepare(`INSERT INTO tasks (id, run_id, phase, agent_role, agent_model, status, task_package, created_at, started_at, completed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`);
  const insEvent = db.prepare(`INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?,?,?,?,?)`);
  const insLaunch = db.prepare(`INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, run_id, ticket_id, started_at, observed_at, state, purpose, terminal) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insReview = db.prepare(`INSERT INTO reviews (id, run_id, ticket_id, workspace_dir, candidate_sha, state, review_mode, created_at, updated_at) VALUES (?,?,?,?,?,?, 'evidence_led', ?, ?)`);
  const insTicket = db.prepare(`INSERT INTO tickets (project_key, ticket_id, type, status, title, imported_at) VALUES ('forge',?,?,?,?,?)`);

  for (let i = 0; i < 80; i++) {
    const runId = `run-hist-${i}`;
    const created = now - (i + 1) * 3_600_000;
    insRun.run(runId, "feature", `historical run ${i}`, "completed", iso(created), iso(created + 600_000), PROJECT);
    for (let t = 0; t < 5; t++) {
      const taskId = `task-hist-${i}-${t}`;
      insTask.run(taskId, runId, "build", "engineer", "sonnet", "completed", "{}", iso(created), iso(created), iso(created + 60_000));
      insEvent.run(runId, taskId, "task.completed", "{}", iso(created + 60_000));
    }
    // A historical ci_observed for a CLOSED run — exactly the noise that must not evict
    // the live candidate, and the volume the LIMIT-500 window scan is measured against.
    insEvent.run(runId, null, "review_loop.ci_observed", JSON.stringify({
      attemptId: `att-${i}`, ticketId: `FG-${100 + i}`, projectDir: PROJECT, candidateSha: `${i}`.padStart(40, "a"),
      observedAt: iso(created + 30_000), outcome: "passed", contexts: [{ context: "test", state: "success", observedAt: iso(created + 30_000) }],
    }), iso(created + 30_000));
    insTicket.run(`FG-${100 + i}`, "story", "done", `hist ticket ${i}`, iso(created));
    if (i % 2 === 0) insReview.run(`rev-hist-${i}`, runId, `FG-${100 + i}`, PROJECT, `${i}`.padStart(40, "a"), "settled", iso(created + 120_000), iso(created + 120_000));
  }

  // ~2200 launch observations, overwhelmingly terminal history — the aged host's shape.
  for (let i = 0; i < 2200; i++) {
    const started = now - (i + 1) * 120_000;
    insLaunch.run(
      `launch-hist-${String(i).padStart(6, "0")}`, `hist ${i}`, JSON.stringify(["npm", "run", "test:worktree"]),
      PROJECT, PROJECT, "explicit", `run-hist-${i % 80}`, `FG-${100 + (i % 80)}`,
      iso(started), iso(started + 90_000), "exited_ok", "host_verification", 1,
    );
  }

  // ── THE LIVE WORK — the core operator wait signal that must never disappear ──────────
  insRun.run(LIVE_RUN, "feature", "live FG-742 run", "active", iso(now - 300_000), null, PROJECT);
  for (let t = 0; t < RUNNING_TASKS; t++) {
    const taskId = `task-live-${t}`;
    insTask.run(taskId, LIVE_RUN, "build", "engineer", "sonnet", "running", "{}", iso(now - 200_000), iso(now - 200_000), null);
    // container.started makes the row eligible for /api/in-flight's `docker inspect`
    // probe — the synchronous serving-path work FG-742 has to bound.
    insEvent.run(LIVE_RUN, taskId, "container.started", JSON.stringify({ container: `forge-${taskId}` }), iso(now - 200_000));
  }
  insTicket.run(LIVE_TICKET, "story", "active", "live ticket", iso(now - 300_000));
  // An OPEN review anchors the live candidate as current work.
  insReview.run("rev-live", LIVE_RUN, LIVE_TICKET, PROJECT, LIVE_SHA, "verifying", iso(now - 100_000), iso(now - 100_000));
  // A FRESH, pending ci_observed for the live run — the CI wait signal Home renders.
  insEvent.run(LIVE_RUN, null, "review_loop.ci_observed", JSON.stringify({
    attemptId: "att-live", ticketId: LIVE_TICKET, projectDir: PROJECT, candidateSha: LIVE_SHA,
    observedAt: iso(now - 30_000), outcome: "pending",
    contexts: [{ context: "test", state: "in_progress", url: "https://ci.invalid/1", observedAt: iso(now - 30_000) }],
  }), iso(now - 30_000));
  // A fresh, running host-verification launch associated with the live run.
  insLaunch.run("launch-live-aaaaaa", "live", JSON.stringify(["npm", "run", "test:worktree"]),
    PROJECT, PROJECT, "explicit", LIVE_RUN, LIVE_TICKET, iso(now - 200_000), iso(now - 10_000), "running", "host_verification", 0);
});
seed();
db.close();

// ── A SLOW `docker` shim, first on PATH: a hung/very-slow daemon ─────────────────────
// It sleeps longer than the per-inspect timeout so the reconcile probe MUST bound it;
// every invocation is logged so the current-activity path can be proven to spawn none.
const RIG = mkdtempSync(join(tmpdir(), "fg742-rig-"));
const CALL_LOG = join(RIG, "calls.log");
writeFileSync(CALL_LOG, "");
const SHIM_DIR = join(RIG, "bin");
mkdirSync(SHIM_DIR, { recursive: true });
const dockerShim = join(SHIM_DIR, "docker");
writeFileSync(dockerShim, `#!/bin/sh\nprintf '%s\\n' "docker $*" >> "${CALL_LOG}"\nsleep 3\nprintf 'true\\n'\n`);
chmodSync(dockerShim, 0o755);
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ""}`;

function dockerCalls(): string[] {
  return readFileSync(CALL_LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
}

const realFetch = globalThis.fetch;
const { server } = await import("./server.js");

after(() => {
  rmSync(RIG, { recursive: true, force: true });
  rmSync(tmpHome, { recursive: true, force: true });
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { await realFetch(`${BASE}/`); return; } catch { await new Promise((r) => setTimeout(r, 40)); }
  }
  throw new Error(`server on ${TEST_PORT} did not start within ${ms}ms`);
}
await waitForServer();

type CaBody = {
  requiredCi: { state: string; observations: Array<{ candidateSha: string; ticketId: string | null; state: string }> };
  hostVerification: Array<{ launchId: string }>;
};

async function timedCurrentActivity(): Promise<{ ms: number; body: CaBody }> {
  const t0 = Date.now();
  const res = await realFetch(`${BASE}/api/current-activity`);
  const body = await res.json() as CaBody;
  return { ms: Date.now() - t0, body };
}

test("FG-742: the aged store ALONE does not make current-activity slow — the query is fast in isolation", async () => {
  // No concurrent /api/in-flight here, so no docker block. If the thousands of retained
  // rows were the cause, this would be slow; it is not, which is why the fix targets the
  // sibling's event-loop block and NOT the store volume (AC2).
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) samples.push((await timedCurrentActivity()).ms);
  const max = Math.max(...samples);
  assert.ok(max < 1500, `current-activity over an aged store should be fast in isolation; max=${max}ms (${samples.join(",")})`);
});

test("FG-742: current-activity path spawns NO subprocess — the isolation does not weaken BD-7", async () => {
  writeFileSync(CALL_LOG, "");
  for (let i = 0; i < 3; i++) await timedCurrentActivity();
  assert.deepEqual(dockerCalls(), [], `current-activity must make no outbound call; observed: ${dockerCalls().join(", ")}`);
});

test("FG-742: /api/in-flight's slow docker fan-out IS bounded — the negative control is live", async () => {
  // Proves the shim is actually reached (so the contention test below is not vacuous) AND
  // that the whole fan-out is bounded well under the deadline despite a hung daemon.
  writeFileSync(CALL_LOG, "");
  const t0 = Date.now();
  await (await realFetch(`${BASE}/api/in-flight`)).text();
  const ms = Date.now() - t0;
  assert.ok(dockerCalls().some((c) => c.startsWith("docker inspect")), "the docker probe shim must be reached");
  assert.ok(ms < SERVER_BUDGET_MS, `a single /api/in-flight poll must not hold the thread past the budget; took ${ms}ms with ${RUNNING_TASKS} running containers`);
});

test("FG-742: current-activity stays inside its deadline while a slow sibling is polled concurrently (repeated)", async () => {
  // Each burst fires ONE slow /api/in-flight (the event-loop block) alongside several
  // current-activity reads, so the reads must queue behind the block on the shared
  // thread. Repeated across bursts — never a single-sample assertion (AC4). Bursts are
  // serialized so only one bounded block is ever outstanding at a time.
  const BURSTS = 4;
  const READS_PER_BURST = 4;
  const latencies: number[] = [];
  for (let b = 0; b < BURSTS; b++) {
    const callsBefore = dockerCalls().length;
    const inflight = realFetch(`${BASE}/api/in-flight`).then((r) => r.text());
    const reads = Array.from({ length: READS_PER_BURST }, () => timedCurrentActivity());
    const [, ...results] = await Promise.all([inflight, ...reads]);
    const burstCalls = dockerCalls().slice(callsBefore);
    assert.ok(
      burstCalls.some((call) => call.startsWith("docker inspect")),
      `burst ${b + 1} must exercise the slow sibling route rather than only current-activity`,
    );
    for (const r of results) {
      latencies.push(r.ms);
      // The core operator wait signal did not disappear behind an unavailable message:
      // the live candidate's pending CI observation is still served, unevicted by the
      // 80 historical ci_observed rows.
      const obs = r.body.requiredCi.observations.find((o) => o.ticketId === LIVE_TICKET);
      assert.ok(obs, `the live CI wait signal must survive under load; state=${r.body.requiredCi.state}`);
      assert.equal(obs!.candidateSha, LIVE_SHA);
    }
  }
  const max = Math.max(...latencies);
  assert.ok(
    max < SERVER_BUDGET_MS,
    `current-activity must stay well inside its ${CURRENT_ACTIVITY_TIMEOUT_MS}ms deadline under concurrent slow polling; ` +
      `max=${max}ms budget=${SERVER_BUDGET_MS}ms samples=[${latencies.join(",")}]`,
  );
});
