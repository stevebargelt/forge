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
// is. So current-activity stays comfortably inside its deadline.
//
// HOW THE SIBLING IS MADE SLOW — DETERMINISTICALLY, not via a real docker race (RF-1).
// The slowness is a CONTROLLABLE docker-inspect fan-out injected into the real server
// (`__setInFlightProbeForTest`): each simulated inspect blocks the event loop for a fixed
// PER_INSPECT_BLOCK_MS via `Atomics.wait` — the same synchronous-thread-hold a hung
// `execFileSync` imposes, but with a duration the test owns rather than a `sleep` shim's
// wall-clock. That determinism lets this file ESTABLISH the causal chain the earlier
// single-sample check only assumed:
//   1. an UNBOUNDED fan-out (RUNNING_TASKS x block) exceeds the 8s deadline outright —
//      so anything queued behind it aborts (the negative control: the bound is
//      load-bearing, not decorative);
//   2. the BUDGETED fan-out clips that same fan-out well under the deadline, probing
//      strictly FEWER than RUNNING_TASKS containers (the budget short-circuits the tail);
//   3. under REAL concurrent polling a current-activity read QUEUES behind the block — its
//      latency reflects the ~3s hold — yet still lands inside its budget with headroom,
//      repeated across bursts rather than sampled once.

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { SCHEMA_SQL } from "../../src/store/schema.js";
import { applyMigrations } from "../../src/store/db.js";
import {
  budgetedLivenessProbe,
  RECONCILE_FANOUT_BUDGET_MS,
  RECONCILE_PROBE_TIMEOUT_MS,
} from "../../src/ops/reconcile-candidate.js";
import type { LivenessProbe, LivenessState } from "../../src/ops/reconcile-candidate.js";
import {
  CURRENT_ACTIVITY_TIMEOUT_MS,
} from "../client/current-activity-render.js";

const TEST_PORT = 18742;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// The server-side budget this test proves current-activity stays under while a slow
// sibling is polled concurrently — deliberately far below the 8s client deadline so the
// assertion demonstrates SUBSTANTIAL headroom, not a photo-finish. The worst-case
// shared-thread stall the bounded fan-out can impose is ~RECONCILE_FANOUT_BUDGET_MS +
// one RECONCILE_PROBE_TIMEOUT_MS; 6s leaves room for CI jitter while staying a full 2s
// under the deadline.
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
const RUNNING_TASKS = 6; // enough that an UNBOUNDED fan-out (6 x block) blows the 8s deadline
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

// ── A logging `docker` shim, first on PATH ───────────────────────────────────────────
// The SLOWNESS lives in the injected probe below, not here — this shim only records that
// a path shelled out to docker, so /api/current-activity can be proven to spawn NONE
// (BD-7). It returns instantly.
const RIG = mkdtempSync(join(tmpdir(), "fg742-rig-"));
const CALL_LOG = join(RIG, "calls.log");
writeFileSync(CALL_LOG, "");
const SHIM_DIR = join(RIG, "bin");
mkdirSync(SHIM_DIR, { recursive: true });
const dockerShim = join(SHIM_DIR, "docker");
writeFileSync(dockerShim, `#!/bin/sh\nprintf '%s\\n' "docker $*" >> "${CALL_LOG}"\nprintf 'true\\n'\n`);
chmodSync(dockerShim, 0o755);
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ""}`;

function dockerCalls(): string[] {
  return readFileSync(CALL_LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
}

// ── The controllable slow docker-inspect fan-out (RF-1) ──────────────────────────────
// A deterministic stand-in for a hung `docker inspect`: it holds the SINGLE event-loop
// thread synchronously for PER_INSPECT_BLOCK_MS — the exact starvation a real
// `execFileSync` against a slow daemon imposes — via `Atomics.wait`, which blocks the
// thread for the timeout with no waker. RUNNING_TASKS x PER_INSPECT_BLOCK_MS deliberately
// exceeds the 8s deadline, so an UNBOUNDED fan-out blows it and the per-request budget is
// what has to clip it back under.
const PER_INSPECT_BLOCK_MS = 1500;
assert.ok(
  RUNNING_TASKS * PER_INSPECT_BLOCK_MS > CURRENT_ACTIVITY_TIMEOUT_MS,
  "an unbounded fan-out must exceed the client deadline for the negative control to mean anything",
);
assert.ok(
  PER_INSPECT_BLOCK_MS <= RECONCILE_PROBE_TIMEOUT_MS,
  "each simulated inspect must model a probe within the per-inspect timeout, not one longer than production allows",
);

let probeCalls = 0;
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
const slowInspect: LivenessProbe = (_name): LivenessState => {
  probeCalls++;
  sleepSync(PER_INSPECT_BLOCK_MS);
  // A hung daemon resolves to `unknown` — conservative, never a reconcile candidate.
  return "unknown";
};

const realFetch = globalThis.fetch;
const { server, __setInFlightProbeForTest } = await import("./server.js");

after(() => {
  __setInFlightProbeForTest(null);
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

async function timedInFlight(): Promise<number> {
  const t0 = Date.now();
  await (await realFetch(`${BASE}/api/in-flight`)).text();
  return Date.now() - t0;
}

test("FG-742: the aged store ALONE does not make current-activity slow — the query is fast in isolation", async () => {
  // No concurrent /api/in-flight here, so no docker block. If the thousands of retained
  // rows were the cause, this would be slow; it is not, which is why the fix targets the
  // sibling's event-loop block and NOT the store volume (AC2).
  __setInFlightProbeForTest(null);
  const samples: number[] = [];
  for (let i = 0; i < 10; i++) samples.push((await timedCurrentActivity()).ms);
  const max = Math.max(...samples);
  assert.ok(max < 1500, `current-activity over an aged store should be fast in isolation; max=${max}ms (${samples.join(",")})`);
});

test("FG-742: current-activity path spawns NO subprocess — the isolation does not weaken BD-7", async () => {
  __setInFlightProbeForTest(null);
  writeFileSync(CALL_LOG, "");
  for (let i = 0; i < 3; i++) await timedCurrentActivity();
  assert.deepEqual(dockerCalls(), [], `current-activity must make no outbound call; observed: ${dockerCalls().join(", ")}`);
});

test("FG-742: an UNBOUNDED docker fan-out exceeds the current-activity deadline — the bound is load-bearing", async () => {
  // The negative control: with the budget REMOVED (the raw slow probe wired straight in),
  // a single /api/in-flight poll fans out over every running container unbounded and holds
  // the shared thread past the 8s client deadline. A current-activity read queued behind
  // this WOULD abort — which is the whole failure FG-742 fixes. Deterministic: the block
  // is RUNNING_TASKS x PER_INSPECT_BLOCK_MS, owned by this test, not a docker race.
  probeCalls = 0;
  __setInFlightProbeForTest(() => slowInspect);
  const ms = await timedInFlight();
  assert.equal(probeCalls, RUNNING_TASKS, `an unbounded fan-out probes every running container; probed ${probeCalls}/${RUNNING_TASKS}`);
  assert.ok(
    ms >= CURRENT_ACTIVITY_TIMEOUT_MS,
    `unbounded, one /api/in-flight poll must hold the loop past the ${CURRENT_ACTIVITY_TIMEOUT_MS}ms deadline; took ${ms}ms`,
  );
});

test("FG-742: the BUDGETED fan-out clips the same slow probe well under the deadline — and probes fewer containers", async () => {
  // The positive control: the SAME slow probe, now wrapped in the per-request budget the
  // route actually wires (budgetedLivenessProbe(RECONCILE_FANOUT_BUDGET_MS)). The budget
  // short-circuits the tail of the fan-out to `unknown` WITHOUT blocking, so the poll
  // returns far inside the budget and demonstrably probes FEWER than every container.
  probeCalls = 0;
  __setInFlightProbeForTest(() => budgetedLivenessProbe(RECONCILE_FANOUT_BUDGET_MS, slowInspect));
  const ms = await timedInFlight();
  assert.ok(
    probeCalls > 0 && probeCalls < RUNNING_TASKS,
    `the budget must clip the fan-out: expected some-but-not-all of ${RUNNING_TASKS} probed, got ${probeCalls}`,
  );
  assert.ok(ms < SERVER_BUDGET_MS, `the bounded fan-out must stay well under the budget; took ${ms}ms (budget ${SERVER_BUDGET_MS}ms)`);
});

// A current-activity poller that runs OFF the server's event-loop thread (a Worker), so
// it can issue its poll while that thread is frozen inside the fan-out — the arrival
// mid-block an in-process client can never produce, because the block freezes the client
// too (the reads always outran it). On each "poll" message it waits on the shared barrier
// the fan-out flips the instant it starts holding the loop, THEN fetches — so the request
// is provably in flight during the block and must queue behind it.
const POLLER_SRC = `
  const { parentPort, workerData } = require("node:worker_threads");
  const barrier = new Int32Array(workerData.buffer);
  parentPort.on("message", async () => {
    Atomics.wait(barrier, 0, 0);
    const t0 = Date.now();
    const res = await fetch(workerData.base + "/api/current-activity");
    const body = await res.json();
    parentPort.postMessage({ ms: Date.now() - t0, body });
  });
`;

test("FG-742: a current-activity poll arriving DURING the bounded block queues behind it yet stays inside its deadline (repeated)", async () => {
  // The regression proper: a current-activity poll that lands WHILE /api/in-flight holds
  // the single event loop must be delayed by that hold (queued behind the slow sibling)
  // and still answer inside its deadline — the exact coupling RF-1 flagged the earlier
  // check for asserting without establishing. The bound (test above) is what makes the
  // hold survivable; test "an UNBOUNDED docker fan-out…" is the negative control showing
  // the same queued poll would abort without it. Repeated across bursts, never one sample.
  const barrier = new Int32Array(new SharedArrayBuffer(4));
  __setInFlightProbeForTest(() =>
    budgetedLivenessProbe(RECONCILE_FANOUT_BUDGET_MS, (name) => {
      // The instant the fan-out begins holding the loop, release the off-thread poller.
      Atomics.store(barrier, 0, 1);
      Atomics.notify(barrier, 0);
      return slowInspect(name);
    }),
  );
  const poller = new Worker(POLLER_SRC, { eval: true, workerData: { base: BASE, buffer: barrier.buffer } });

  const BURSTS = 3;
  // A poll that queued behind the block waits the whole bounded fan-out (~2 x block); one
  // that somehow raced ahead would return in single-digit ms (see the isolation test).
  // >= one full inspect block cleanly proves the poll genuinely queued behind the sibling.
  const QUEUING_EVIDENCE_MS = PER_INSPECT_BLOCK_MS;
  const latencies: number[] = [];
  try {
    for (let b = 0; b < BURSTS; b++) {
      Atomics.store(barrier, 0, 0); // re-arm the barrier for this burst
      const polled = new Promise<{ ms: number; body: CaBody }>((resolve) => poller.once("message", resolve));
      poller.postMessage("poll");
      await new Promise((r) => setTimeout(r, 25)); // let the poller reach the barrier first
      const callsBefore = probeCalls;
      await realFetch(`${BASE}/api/in-flight`).then((r) => r.text());
      assert.ok(
        probeCalls > callsBefore,
        `burst ${b + 1} must exercise the slow sibling route rather than only current-activity`,
      );
      const { ms, body } = await polled;
      latencies.push(ms);
      // The poll genuinely queued behind the block...
      assert.ok(
        ms >= QUEUING_EVIDENCE_MS,
        `the concurrent poll must queue behind the slow sibling (latency >= ${QUEUING_EVIDENCE_MS}ms); ` +
          `burst ${b + 1} returned in ${ms}ms — it did not actually overlap the block`,
      );
      // ...yet stayed well inside its deadline, with headroom.
      assert.ok(
        ms < SERVER_BUDGET_MS,
        `current-activity must stay well inside its ${CURRENT_ACTIVITY_TIMEOUT_MS}ms deadline under concurrent slow polling; ` +
          `burst ${b + 1} took ${ms}ms budget=${SERVER_BUDGET_MS}ms`,
      );
      // The core operator wait signal did not disappear behind an unavailable message: the
      // live candidate's pending CI observation is still served, unevicted by the 80
      // historical ci_observed rows.
      const obs = body.requiredCi.observations.find((o) => o.ticketId === LIVE_TICKET);
      assert.ok(obs, `the live CI wait signal must survive under load; state=${body.requiredCi.state}`);
      assert.equal(obs!.candidateSha, LIVE_SHA);
    }
  } finally {
    await poller.terminate();
  }
  assert.equal(latencies.length, BURSTS, "every burst must have produced a measured concurrent poll");
});
