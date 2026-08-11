// FG-591 (step 15): THE DISPATCH-SEMANTICS SUITE the AC enumerates, driven through
// REAL dispatcher processes against ONE real on-disk store file.
//
// WHY THIS FILE IS NOT MORE UNIT TESTS. Steps 6, 7 and 8 each ship a unit tier that
// runs one process against one in-memory handle. That tier can prove a fencing CAS
// (ordinary SQL) but it CANNOT prove anything about the two properties this ticket
// actually rests on — at most one live claim per ticket, and a ceiling that is never
// exceeded — because SQLite treats BEGIN IMMEDIATE as BEGIN when no other connection
// exists, so the locking those properties depend on is inert there. Here every
// dispatcher is a genuine OS process (src/queue/fg591-dispatch-worker.ts), lined up
// on a file barrier against one FORGE_DB_PATH file, exactly as FG-610's claim race
// established for the primitive underneath.
//
// WHAT IS REAL AND WHAT IS SUBSTITUTED is stated in the worker's own header: the only
// substituted thing is step 7's ExecutionSeams — the tmux/Docker boundary — and the
// substitute writes the same store rows `forge new --ticket` writes, through the
// store's own writers. Everything that decides anything is production code.
//
// THE BAR EVERY CASE HOLDS ITSELF TO:
//
//  * "It started" is proven at the LAUNCHER, never at the claim table. A claim that
//    is granted and never launched, and a second container started for work already
//    running, are both invisible in a claim-row assertion and both are the defect.
//
//  * Every non-deterministic race is FOLLOWED by a deterministic probe. A race can
//    only assert invariants ("exactly two launched, never three"); the NAMED durable
//    reason a loser recorded is then proven by a fresh worker run against the settled
//    state, so no assertion depends on which process happened to win.
//
//  * A bypass is paired with its rank. "The dispatcher skipped it" is only half the
//    AC; the other half is that the operator's durable order is byte-identical
//    afterwards, and that the item is reconsidered once the world moves.
//
//  * A scheduling wait is paired with blocker_evidence staying untouched. That table
//    is partly CONTAINER-VISIBLE through blocked-source.ts, so a wait written there
//    would reinterpret the ticket's status for every agent container on the next
//    publish — with no code change anywhere in the container path.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  assertSchemaVersionSupported,
  getDb,
  setDbForTest,
  writeTransaction,
  SCHEMA_VERSION,
} from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { FORGE_HOME } from "../util/paths.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "../store/publications.js";
import {
  getTicket,
  upsertBlockerEvidence,
  upsertSeamTicket,
  upsertTicket,
  upsertTicketRelation,
  type TicketRow,
} from "../store/tickets.js";
import { enqueueTicket, queueView, rankTicket, readinessView, recheckReadiness } from "../store/queue.js";
import { claimHistoryForTicket, liveClaims, MIN_LEASE_TTL_MS, type QueueClaim } from "../store/queue-claims.js";
import { setDispatcherPolicy } from "../store/dispatcher-policy.js";
import { evaluationsFor, latestEvaluation, type DispatcherEvaluation } from "../store/dispatcher-evidence.js";
import { completeRun } from "../store/runs.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";
import { buildDispatchArgv, discoverRunForClaim, resolveDispatchTarget } from "./dispatch-execution.js";
import type { WorkerReport } from "./fg591-dispatch-worker.js";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "fg591-dispatch-worker.ts");
const NOW = "2026-08-06T00:00:00Z";

/** Comfortably above the derived floor, so nothing lapses on its own inside a bounded
 *  test and every expiry a case needs is one the case ARRANGED durably (by rewriting
 *  the stored deadline, as a crashed controller's row actually looks to a peer). */
const TTL = MIN_LEASE_TTL_MS;
const HEARTBEAT_MS = 5_000;
/** A watchdog that cannot fire inside any case here: whatever makes progress, it is
 *  the event path and not the health bound. Step 16 owns the watchdog falsification. */
const WATCHDOG_MS = 10 * 60_000;
const POLL_MS = 50;

const WORKER_TIMEOUT_MS = 60_000;
const READY_TIMEOUT_MS = 40_000;
const PROBE_TIMEOUT_MS = 30_000;

const READY_BODY = [
  "## Problem",
  "Work is queued and nothing runs it.",
  "",
  "## Goal",
  "A dispatcher that starts the next compatible item.",
  "",
  "## Acceptance Criteria",
  "- it starts",
].join("\n");

// ─── the store, shared with the workers ──────────────────────────────────────

let tmpSeq = 0;

/** FG-693: every fixture path is rooted at a PHYSICAL directory. `mkdtemp` hands back
 *  the spelling it was given, and FORGE_HOME is a temp root that on darwin is reached
 *  through a symlink (/var -> /private/var) — so without this every path in this file
 *  would be an ALIAS of the tree it names, and every assertion about a directory the
 *  dispatcher decided would silently be asserting a platform-specific spelling. The
 *  alias cases belong in the FG-693 block at the bottom of this file, where they are
 *  arranged on purpose and are exercised on EVERY host, rather than being smeared over
 *  the whole suite on one of them. */
function freshDir(name: string): string {
  const d = join(mkdtempSync(join(FORGE_HOME, `fg591-${name}-`)), `run-${tmpSeq++}`);
  mkdirSync(d, { recursive: true });
  return realpathSync(d);
}

type Store = { dbFile: string; dir: string; done: () => void };

/** A NEW-binary open of a REAL file: exactly getDb()'s writable path, the
 *  fg610-claim-race template. The parent holds this open for the whole case and the
 *  workers open the same file in their own processes, which is what makes the WAL
 *  contention genuine rather than simulated. */
function openStore(name: string): Store {
  const dir = freshDir(name);
  const dbFile = join(dir, "forge.db");
  const db = new Database(dbFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, SCHEMA_VERSION);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("busy_timeout = 10000");
  const prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  return {
    dbFile,
    dir,
    done: () => {
      setPublicationClockOffsetForTest(0);
      setDbForTest(prev as Database.Database);
      db.close();
    },
  };
}

function checkoutDir(store: Store, projectKey: string): string {
  const dir = join(store.dir, `checkout-${projectKey}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function registerProject(projectKey: string): void {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
       VALUES (?, ?, 'path', ?)`,
    )
    .run(projectKey, `evidence-${projectKey}`, NOW);
  getDb()
    .prepare(`INSERT OR REPLACE INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`)
    .run(projectKey, NOW);
}

function ticketRow(projectKey: string, ticketId: string, checkout: string, body = READY_BODY): TicketRow {
  return {
    projectKey,
    ticketId,
    type: "story",
    status: "active",
    title: `title ${ticketId}`,
    body,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: NOW,
    importedFrom: checkout,
  };
}

/** Rank and enqueue through the REAL store verbs, in the order given, so ids[0] is
 *  rank 1 and the readiness assessment every scan reads was written by the enqueue
 *  that an operator would have run. */
function seedQueued(projectKey: string, ids: string[], checkout: string): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticketRow(projectKey, id, checkout));
  });
  for (const id of ids) {
    rankTicket(projectKey, id);
    assert.equal(enqueueTicket(projectKey, id).ok, true, `${id} must enqueue for the fixture to mean anything`);
  }
}

function arm(over: { armed?: boolean; maxActiveRuns?: number } = {}): void {
  setDispatcherPolicy({
    armed: over.armed ?? true,
    maxActiveRuns: over.maxActiveRuns ?? 1,
    capacityScope: "host",
    leaseTtlMs: TTL,
    heartbeatMs: HEARTBEAT_MS,
    defaultWorkflow: "feature",
    updatedBy: "fixture-operator",
  });
}

// ─── the workers ─────────────────────────────────────────────────────────────

type WorkerSpec = {
  id: string;
  projectKey: string;
  projectDir: string;
  /** The instance-stable declaration. Two runs carrying the same one are ONE
   *  dispatcher identity across a restart; two different ones are two dispatchers. */
  dispatcherId: string;
  mode?: "loop" | "cycle";
  maxTicks?: number;
  maxIterations?: number;
  seedTask?: "isolated" | "shared" | "none";
  stopFile?: string;
};

type RunWorkersInput = {
  store: Store;
  barrier: string;
  workers: WorkerSpec[];
  /** The parent's "meanwhile", run AFTER the barrier releases and CONCURRENTLY with
   *  the workers. This is where a run is finished or a policy is changed — never an
   *  operator message to the dispatcher, which is the whole point. */
  meanwhile?: () => Promise<void>;
};

async function runWorkers(input: RunWorkersInput): Promise<WorkerReport[]> {
  const { store, barrier, workers } = input;
  mkdirSync(barrier, { recursive: true });
  const goFile = join(barrier, "GO");

  const children = workers.map((w) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
      env: {
        ...process.env,
        FORGE_DB_PATH: store.dbFile,
        FORGE_HOME,
        MODE: w.mode ?? "loop",
        WORKER_ID: w.id,
        PROJECT_KEY: w.projectKey,
        PROJECT_DIR: w.projectDir,
        FORGE_DISPATCHER_ID: w.dispatcherId,
        BARRIER_DIR: barrier,
        GO_FILE: goFile,
        ...(w.stopFile !== undefined ? { STOP_FILE: w.stopFile } : {}),
        MAX_TICKS: String(w.maxTicks ?? 1),
        MAX_ITERATIONS: String(w.maxIterations ?? 200),
        WATCHDOG_MS: String(WATCHDOG_MS),
        POLL_MS: String(POLL_MS),
        SEED_TASK: w.seedTask ?? "isolated",
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`worker ${w.id} exceeded ${WORKER_TIMEOUT_MS}ms`));
      }, WORKER_TIMEOUT_MS);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`worker ${w.id} exited ${String(code)}: ${stderr}`));
      });
    });
    return { child, done };
  });

  try {
    const readyDeadline = Date.now() + READY_TIMEOUT_MS;
    const allReady = (): boolean => workers.every((w) => existsSync(join(barrier, `ready-${w.id}`)));
    while (!allReady() && Date.now() < readyDeadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(allReady(), "every worker announced readiness before the barrier deadline");
    writeFileSync(goFile, "1");

    if (input.meanwhile) await input.meanwhile();
    await Promise.all(children.map((c) => c.done));
  } finally {
    for (const c of children) c.child.kill("SIGKILL");
  }

  return readdirSync(barrier)
    .filter((f) => f.startsWith("result-"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(barrier, f), "utf8")) as WorkerReport);
}

/** One worker, one barrier directory of its own, and the report it wrote. */
async function runWorker(store: Store, name: string, spec: WorkerSpec, meanwhile?: () => Promise<void>): Promise<WorkerReport> {
  const barrier = join(store.dir, `barrier-${name}`);
  const reports = await runWorkers({
    store,
    barrier,
    workers: [spec],
    ...(meanwhile !== undefined ? { meanwhile } : {}),
  });
  const report = reports[0] as WorkerReport;
  assert.equal(report.error, null, `worker ${spec.id} reported an error: ${report.error ?? ""}`);
  return report;
}

function launchedTickets(r: WorkerReport): string[] {
  return r.launched.map((l) => l.ticketId);
}

// ─── probes the parent uses while the workers run ────────────────────────────

async function waitFor<T>(label: string, probe: () => T | null | undefined, timeoutMs = PROBE_TIMEOUT_MS): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== null && value !== undefined) return value;
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

function runIdFor(ticketId: string): string | undefined {
  const row = getDb()
    .prepare(`SELECT id FROM runs WHERE json_extract(metadata, '$.ticketId') = ? ORDER BY created_at ASC, id ASC LIMIT 1`)
    .get(ticketId) as { id: string } | undefined;
  return row?.id;
}

/** Finish a run the way a real one ends: its live tasks reach a terminal disposition
 *  and the run row goes terminal through the store's own writer. Nothing here touches
 *  a claim — the reservation is retired by its LEASE OWNER observing this, which is
 *  the ordering the whole design rests on. */
function finishRun(runId: string): void {
  writeTransaction(() => {
    getDb().prepare(`UPDATE tasks SET status = 'complete', completed_at = ? WHERE run_id = ?`).run(NOW, runId);
  });
  assert.equal(completeRun(runId), true, `the fixture must be able to complete ${runId}`);
}

/** A container executing this ticket OUTSIDE the claim ledger — an operator's
 *  `forge new --ticket`, a campaign item, a review loop. It carries the project's own
 *  checkout as its project_dir, so it is attributed to THIS project rather than being
 *  kept only because it could not be attributed away. */
function seedForeignLaunch(ticketId: string, checkout: string, launchId = `foreign-${ticketId}`): string {
  writeTransaction(() => {
    getDb()
      .prepare(
        `INSERT INTO launch_observations
           (launch_id, name, command, cwd, project_dir, association_kind, ticket_id, started_at, observed_at, state, terminal)
         VALUES (?, ?, '["forge","new"]', ?, ?, 'ticket', ?, ?, ?, 'running', 0)`,
      )
      .run(launchId, launchId, checkout, checkout, ticketId, NOW, NOW);
  });
  return launchId;
}

function endForeignLaunch(launchId: string): void {
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE launch_observations SET terminal = 1, state = 'exited', exit_code = 0 WHERE launch_id = ?`)
      .run(launchId);
  });
}

/** The operator's durable order, as bytes. Compared before and after a dispatch pass:
 *  "the dispatcher bypassed it" is only half the AC. */
function rankDump(projectKey: string): string {
  return JSON.stringify(
    getDb()
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(projectKey),
  );
}

function scanEntryFor(evaluation: DispatcherEvaluation | undefined, ticketId: string): { reason: string; detail: string | null } {
  const entry = (evaluation?.scanEvidence ?? []).find((e) => e.ticketId === ticketId);
  assert.ok(entry, `the durable scan evidence must name ${ticketId}; it named ${JSON.stringify(evaluation?.scanEvidence)}`);
  return { reason: entry.reason, detail: entry.detail };
}

function grantEvaluation(projectKey: string, ticketId: string): DispatcherEvaluation {
  const found = evaluationsFor(projectKey, { limit: 200 }).find(
    (e) => e.reason === "granted" && e.claimedTicketId === ticketId,
  );
  assert.ok(found, `a durable grant evaluation for ${ticketId} must exist`);
  return found;
}

function liveClaimFor(projectKey: string, ticketId: string): QueueClaim | undefined {
  return liveClaims(projectKey).find((c) => c.ticketId === ticketId);
}

function blockerEvidenceCount(): number {
  return (getDb().prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get() as { n: number }).n;
}

function launchObservationCount(ticketId: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS n FROM launch_observations WHERE ticket_id = ?`).get(ticketId) as { n: number }
  ).n;
}

/** Age a durable deadline into the past, rather than sleeping through it. Every reader
 *  compares against the STORE clock, so this is exactly what a crashed dispatcher's
 *  rows look like to a peer process. */
function expireClaimLease(claimId: string): void {
  writeTransaction(() => {
    getDb().prepare(`UPDATE queue_claims SET lease_expires_at_ms = 1, heartbeat_at_ms = 1 WHERE id = ?`).run(claimId);
  });
}

function expireDispatcherLease(projectKey: string): void {
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE dispatcher_leases SET lease_expires_at_ms = 1, heartbeat_at_ms = 1 WHERE project_key = ?`)
      .run(projectKey);
  });
}

/** Rewind every live claim's heartbeat so the next tick finds it DUE on the policy
 *  cadence — the arrangement that makes "a disarmed dispatcher keeps renewing" a
 *  fact this test can observe without sleeping through a real cadence. */
function makeHeartbeatsDue(projectKey: string): void {
  const past = storeNowMs() - 10 * HEARTBEAT_MS;
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE queue_claims SET heartbeat_at_ms = ? WHERE project_key = ? AND state = 'live'`)
      .run(past, projectKey);
  });
}

// ===========================================================================
// 1) SEQUENTIAL DISPATCH AT CAPACITY ONE — the ticket's own reproduction, with
//    no operator input at all.
// ===========================================================================
describe("FG-591 step 15: sequential dispatch at capacity one, in a real dispatcher process", () => {
  test("the SECOND ticket is launched after the first reaches terminal, with no operator message", async () => {
    const store = openStore("sequential");
    try {
      const PK = "pk-sequential";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2"], checkout);
      arm({ maxActiveRuns: 1 });
      const stopFile = join(store.dir, "STOP");

      let sampledLive = 0;
      const report = await runWorker(
        store,
        "sequential",
        {
          id: "0",
          projectKey: PK,
          projectDir: checkout,
          dispatcherId: "instance-A",
          maxTicks: 6,
          maxIterations: 600,
          stopFile,
        },
        async () => {
          // The parent's ENTIRE contribution: finish the first run. No wake is
          // recorded by hand, no CLI verb is run, no message is sent.
          const first = await waitFor("the first run to exist", () => runIdFor("FG-1"));
          sampledLive = Math.max(sampledLive, liveClaims(PK).length);
          finishRun(first);
          await waitFor("the second run to exist", () => runIdFor("FG-2"));
          sampledLive = Math.max(sampledLive, liveClaims(PK).length);
          writeFileSync(stopFile, "1");
        },
      );

      assert.deepEqual(
        launchedTickets(report),
        ["FG-1", "FG-2"],
        "the queue advanced on its own — proven at the LAUNCHER, not at the claim table",
      );
      assert.equal(sampledLive, 1, "a ceiling of one was never exceeded at any moment the parent sampled it");

      // The event path, not the health bound: the watchdog here is ten minutes away.
      const triggers = report.ticks.map((t) => t.trigger);
      assert.equal(triggers[0], "startup");
      assert.ok(triggers.includes("wake"), `the run-terminal transition must reach the loop as a durable WAKE (${triggers.join(",")})`);
      assert.equal(triggers.includes("watchdog"), false, "the health bound must not be what made progress");

      const history = claimHistoryForTicket(PK, "FG-1");
      assert.equal(history.length, 1, "FG-1 was reserved exactly once, ever");
      assert.equal(history[0]?.outcome, "completed", "the reservation was retired by the execution reaching terminal");

      const view = queueView(PK);
      const one = view.find((e) => e.ticketId === "FG-1");
      assert.equal(one?.queued, false, "the planning intent is satisfied once the work it asked for ran and ended");
      assert.equal(one?.rank, 1, "the RANK survives, so re-enqueueing returns it to the operator's own position");
      assert.equal(one?.status, "active", "nothing stores a lifecycle status — Done stays derived");
      assert.ok(liveClaimFor(PK, "FG-2")?.launchId, "the new reservation carries its launch stamp");
    } finally {
      store.done();
    }
  });

  test("the launch is the ORDINARY single-ticket run path — no campaign verb anywhere in the argv", async () => {
    const store = openStore("argv");
    try {
      const PK = "pk-argv";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      arm({ maxActiveRuns: 1 });

      const report = await runWorker(store, "argv", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-A",
      });

      const launch = report.launched[0];
      assert.ok(launch, "the fixture must have launched something to assert about");
      const argv = launch.argv;
      assert.deepEqual(
        argv.slice(argv.indexOf("new")),
        ["new", "feature", "title FG-1", "--ticket", "FG-1", "--project", checkout],
        "a claimed ticket launches as an ordinary single-ticket run",
      );
      assert.equal(
        argv.some((a) => /campaign/i.test(a)),
        false,
        "no campaign verb, no campaign plan, no implicit campaign creation",
      );
      assert.equal(launch.cwd, checkout, "the launch is started IN the project's checkout");
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 2) THE CEILING, under CONCURRENT dispatcher processes. Host scope, so the
//    resource being protected is the machine and not one project's board.
// ===========================================================================
describe("FG-591 step 15: a host-scoped ceiling under concurrent dispatcher processes", () => {
  test("three dispatchers, three projects, a ceiling of two: exactly two containers start and never a third", async () => {
    const store = openStore("ceiling");
    try {
      // DISTINCT ticket ids per project, deliberately. compatibility.ts compares an
      // active claim's ticket id against the candidate's WITHOUT comparing project
      // keys, so two projects sharing an id namespace would refuse each other's
      // identically-numbered tickets under a host-scoped active set — a cross-project
      // false wait that has nothing to do with the ceiling this case is about. Seeding
      // distinct ids keeps the ONLY thing that can turn a candidate away here the
      // ceiling itself.
      const PROJECTS = ["pk-cap-a", "pk-cap-b", "pk-cap-c"];
      const dirs = new Map<string, string>();
      for (const [i, pk] of PROJECTS.entries()) {
        const checkout = checkoutDir(store, pk);
        dirs.set(pk, checkout);
        registerProject(pk);
        const prefix = String.fromCharCode(65 + i);
        seedQueued(pk, [`${prefix}-1`, `${prefix}-2`], checkout);
      }
      arm({ maxActiveRuns: 2 });

      const reports = await runWorkers({
        store,
        barrier: join(store.dir, "barrier-ceiling"),
        workers: PROJECTS.map((pk, i) => ({
          id: String(i),
          projectKey: pk,
          projectDir: dirs.get(pk) as string,
          dispatcherId: `instance-${pk}`,
          maxTicks: 3,
          maxIterations: 24,
        })),
      });

      assert.equal(reports.length, 3, "every dispatcher reported");
      for (const r of reports) assert.equal(r.error, null, r.error ?? "");

      const totalLaunched = reports.reduce((n, r) => n + r.launched.length, 0);
      assert.equal(totalLaunched, 2, "exactly two containers started across three racing dispatcher processes");

      const live = getDb().prepare(`SELECT project_key, ticket_id FROM queue_claims WHERE state = 'live'`).all();
      assert.equal(live.length, 2, "COUNT(live claims) never exceeded the host ceiling");
      const everClaimed = (getDb().prepare(`SELECT COUNT(*) AS n FROM queue_claims`).get() as { n: number }).n;
      assert.equal(
        everClaimed,
        2,
        "and it was never breached-then-corrected: only two claim rows were ever created, in any state",
      );

      // A DETERMINISTIC PROBE against the settled state. A race can only assert the
      // invariant; the NAMED reason a refused project records must not depend on which
      // process happened to win, so it is proven here, afterwards, by a fresh
      // dispatcher for a project that holds no slot.
      const holders = new Set((live as { project_key: string }[]).map((r) => r.project_key));
      const starved = PROJECTS.find((pk) => !holders.has(pk)) ?? (PROJECTS[0] as string);
      const evaluationsBefore = evaluationsFor(starved, { limit: 500 }).length;
      const probe = await runWorker(store, "ceiling-probe", {
        id: "probe",
        projectKey: starved,
        projectDir: dirs.get(starved) as string,
        // The SAME declared identity the race gave this project, so the probe ADOPTS
        // its own dispatcher lease rather than failing closed against the one the
        // race left behind — a probe that never ticked would leave the assertions
        // below reading the RACE's last evaluation and calling it the probe's.
        dispatcherId: `instance-${starved}`,
      });
      assert.notEqual(probe.stopReason, "lease_lost", `the probe must have held the identity: ${probe.alert ?? ""}`);
      assert.deepEqual(probe.launched, [], "a project with no slot starts nothing");

      assert.ok(
        evaluationsFor(starved, { limit: 500 }).length > evaluationsBefore,
        "the probe recorded a pass of its own — otherwise the refusal read below is the RACE's, not the probe's",
      );
      const refusal = latestEvaluation(starved);
      assert.equal(refusal?.reason, "no_capacity", "and it records WHY, durably, rather than looking idle");
      assert.equal(refusal?.capacityScope, "host");
      assert.equal(refusal?.capacityLimit, 2);
      assert.equal(refusal?.capacityUsed, 2);
      const named = (refusal?.capacityHolders ?? []).map((h) => h.projectKey);
      assert.equal(named.length, 2, "a host-scoped refusal names every holder");
      for (const holder of named) {
        assert.notEqual(holder, starved, "the holders are OTHER projects — which is the whole point of naming them");
        assert.match(refusal?.detail ?? "", new RegExp(holder), "the prose names the project holding the slot");
      }
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 3) THE CONCURRENT CLAIM RACE over ONE ticket. Several deciders, one queue —
//    the arrangement the dispatcher lease exists to prevent, and exactly the one
//    in which the CLAIM must still admit a single winner.
// ===========================================================================
describe("FG-591 step 15: concurrent claim races over one ticket", () => {
  test("four dispatcher processes, one queued ticket: one claim, one container, three durable refusals", async () => {
    const store = openStore("race");
    try {
      const PK = "pk-race";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      // Capacity is deliberately NOT the limiter here: four slots, one ticket. What
      // must stop the other three is the at-most-one-live-claim invariant alone.
      arm({ maxActiveRuns: 4 });

      const reports = await runWorkers({
        store,
        barrier: join(store.dir, "barrier-race"),
        workers: Array.from({ length: 4 }, (_, i) => ({
          id: String(i),
          projectKey: PK,
          projectDir: checkout,
          dispatcherId: `racer-${i}`,
          mode: "cycle" as const,
        })),
      });

      assert.equal(reports.length, 4);
      for (const r of reports) assert.equal(r.error, null, r.error ?? "");

      const winners = reports.filter((r) => r.granted.length > 0);
      assert.equal(winners.length, 1, "exactly one cross-process winner");
      assert.deepEqual(winners[0]?.granted, ["FG-1"]);
      assert.equal(
        reports.reduce((n, r) => n + r.launched.length, 0),
        1,
        "exactly ONE container started — a second is the duplicate execution the claim exists to prevent",
      );
      assert.equal(claimHistoryForTicket(PK, "FG-1").length, 1, "one claim row, in any state, for the whole race");
      assert.equal(liveClaims(PK).length, 1);

      // Every loser left a durable answer rather than a silence.
      for (const loser of reports.filter((r) => r.granted.length === 0)) {
        assert.ok(loser.reasons.length > 0, `worker ${loser.workerId} recorded no evaluation at all`);
        for (const reason of loser.reasons) {
          assert.ok(
            ["no_eligible_work", "lost", "no_capacity", "incompatible_only"].includes(reason),
            `a loser recorded ${reason}, which is not one of the refusals this arrangement can produce`,
          );
        }
      }

      // THE DETERMINISTIC PROBE: against the settled state, the refusal is named
      // `already_claimed` and says who holds it — no dependence on the interleaving.
      const holder = liveClaims(PK)[0] as QueueClaim;
      const probe = await runWorker(store, "race-probe", {
        id: "probe",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "racer-probe",
        mode: "cycle",
      });
      assert.deepEqual(probe.launched, []);
      const entry = scanEntryFor(latestEvaluation(PK), "FG-1");
      assert.equal(entry.reason, "already_claimed");
      assert.match(entry.detail ?? "", new RegExp(holder.owner), "the refusal names the owner holding the reservation");
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 4) THE INCOMPATIBLE TOP ITEM: bypassed, rank untouched, reconsidered.
// ===========================================================================
describe("FG-591 step 15: bypassing an incompatible top candidate", () => {
  test("the lower-ranked item runs, the bypassed rank is byte-identical, and no blocker is written", async () => {
    const store = openStore("bypass");
    try {
      const PK = "pk-bypass";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2"], checkout);
      arm({ maxActiveRuns: 1 });
      // FG-1 is ALREADY EXECUTING outside the claim ledger — an operator's own
      // `forge new --ticket`. No claim row can prevent a second container there, so
      // the predicate must.
      seedForeignLaunch("FG-1", checkout);

      const ranksBefore = rankDump(PK);
      const report = await runWorker(store, "bypass", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-bypass",
      });

      assert.deepEqual(launchedTickets(report), ["FG-2"], "the first COMPATIBLE candidate in rank order runs");
      assert.equal(rankDump(PK), ranksBefore, "the dispatcher never reorders the operator's queue");

      const grant = grantEvaluation(PK, "FG-2");
      const bypassed = scanEntryFor(grant, "FG-1");
      assert.equal(bypassed.reason, "incompatible", "the bypass is RECORDED, per candidate, in the granting row");
      assert.match(bypassed.detail ?? "", /waiting for FG-1 to finish/, "and it reads as a wait, in the AC's own words");
      assert.match(grant.detail ?? "", /passed over FG-1/, "the prose names who was passed over and why");

      const view = queueView(PK);
      const one = view.find((e) => e.ticketId === "FG-1");
      assert.equal(one?.queued, true, "a scheduling wait costs an item neither its membership...");
      assert.equal(one?.rank, 1, "...nor its rank");
      assert.equal(one?.blocked, false, "and it is NOT blocked — a temporary incompatibility is a different thing");
      assert.equal(blockerEvidenceCount(), 0, "blocker_evidence is partly CONTAINER-VISIBLE; a wait must never touch it");
    } finally {
      store.done();
    }
  });

  test("it is reconsidered — at its unchanged rank — as soon as capacity and compatibility move", async () => {
    const store = openStore("reconsider");
    try {
      const PK = "pk-reconsider";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2"], checkout);
      arm({ maxActiveRuns: 1 });
      const foreign = seedForeignLaunch("FG-1", checkout);

      const first = await runWorker(store, "reconsider-1", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-reconsider",
      });
      assert.deepEqual(launchedTickets(first), ["FG-2"]);

      // THE WORLD MOVES, and nothing else happens: the foreign container exits and the
      // claimed run finishes. No rank is touched, no re-enqueue, no operator message.
      endForeignLaunch(foreign);
      finishRun(await waitFor("FG-2's run", () => runIdFor("FG-2")));

      const second = await runWorker(store, "reconsider-2", {
        id: "1",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-reconsider",
      });

      assert.deepEqual(launchedTickets(second), ["FG-1"], "the bypassed item is reconsidered without operator input");
      assert.equal(claimHistoryForTicket(PK, "FG-1").length, 1, "and it is claimed exactly once, at its own rank");
      assert.equal(liveClaimFor(PK, "FG-1")?.ticketId, "FG-1");
      assert.equal(
        queueView(PK).find((e) => e.ticketId === "FG-1")?.rank,
        1,
        "the rank it ran at is the rank the operator gave it",
      );
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 5) DEPENDENCY AND EXCLUSIVITY CONFLICTS.
// ===========================================================================
describe("FG-591 step 15: dependency and exclusivity conflicts", () => {
  test("a dependent and an exclusive sibling both wait on the running ticket, while an unrelated sibling runs", async () => {
    const store = openStore("relations");
    try {
      const PK = "pk-relations";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2", "FG-3", "FG-4"], checkout);
      writeTransaction(() => {
        // FG-2 must integrate AFTER FG-1; FG-3 must never overlap it; FG-4 is linked
        // to it in a way that carries no scheduling meaning at all.
        upsertTicketRelation({ projectKey: PK, ticketId: "FG-2", relatedId: "FG-1", relType: "depends_on" });
        upsertTicketRelation({ projectKey: PK, ticketId: "FG-3", relatedId: "FG-1", relType: "exclusive_with" });
        upsertTicketRelation({ projectKey: PK, ticketId: "FG-4", relatedId: "FG-1", relType: "related" });
      });
      arm({ maxActiveRuns: 3 });

      const ranksBefore = rankDump(PK);
      const report = await runWorker(store, "relations", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-relations",
        maxTicks: 4,
        maxIterations: 24,
      });

      assert.deepEqual(
        launchedTickets(report),
        ["FG-1", "FG-4"],
        "the ordered and the exclusive candidate wait; the neutrally-linked one runs beside FG-1",
      );
      assert.equal(rankDump(PK), ranksBefore, "neither wait moved a rank");

      const grant = grantEvaluation(PK, "FG-4");
      const dependent = scanEntryFor(grant, "FG-2");
      assert.equal(dependent.reason, "incompatible");
      assert.match(dependent.detail ?? "", /waiting for FG-1 to finish/);
      assert.match(dependent.detail ?? "", /depends_on/, "the recorded reason names the RELATION, not just the wait");

      const exclusive = scanEntryFor(grant, "FG-3");
      assert.equal(exclusive.reason, "incompatible");
      assert.match(exclusive.detail ?? "", /exclusive_with/);

      for (const waiting of ["FG-2", "FG-3"]) {
        const entry = queueView(PK).find((e) => e.ticketId === waiting);
        assert.equal(entry?.queued, true, `${waiting} keeps its membership`);
        assert.equal(entry?.blocked, false, `${waiting} is WAITING, not blocked — the board must not conflate them`);
      }
      assert.equal(blockerEvidenceCount(), 0);
      assert.equal(latestEvaluation(PK)?.reason, "incompatible_only", "the cycle stops with the honest reason");
      assert.match(
        latestEvaluation(PK)?.detail ?? "",
        /temporary scheduling wait, NOT a blocker/,
        "and says so in the words the operator surface renders",
      );
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 6) LEASE RECOVERY BY TAKEOVER, WITH LAUNCH ADOPTION.
// ===========================================================================
describe("FG-591 step 15: lease recovery by takeover adopts the running launch", () => {
  test("a successor process takes over the expired claim and ADOPTS the container instead of starting a second one", async () => {
    const store = openStore("takeover");
    try {
      const PK = "pk-takeover";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      arm({ maxActiveRuns: 1 });

      // The first dispatcher claims, launches, and binds the run its launch created.
      const first = await runWorker(store, "takeover-1", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-A",
        maxTicks: 2,
        maxIterations: 20,
      });
      assert.deepEqual(launchedTickets(first), ["FG-1"]);
      const original = liveClaimFor(PK, "FG-1") as QueueClaim;
      assert.ok(original.launchId, "the reservation carries its launch identity");
      const originalLaunchId = original.launchId;

      // The dispatcher dies — a crash, a closed lid, a killed pane. Both leases lapse
      // durably; the CONTAINER is untouched and still running.
      expireClaimLease(original.id);
      expireDispatcherLease(PK);

      const second = await runWorker(store, "takeover-2", {
        id: "1",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-B",
        maxTicks: 2,
        maxIterations: 20,
      });

      assert.deepEqual(second.launched, [], "the successor started NO container");
      assert.equal(second.adopted.length, 1, "it adopted the one already running");
      assert.equal(second.adopted[0]?.ticketId, "FG-1");
      assert.equal(second.adopted[0]?.launchId, originalLaunchId, "and adopted the PREDECESSOR's launch identity");
      assert.match(second.adopted[0]?.detail ?? "", /predecessor/i);

      const history = claimHistoryForTicket(PK, "FG-1");
      assert.equal(history.length, 2, "the predecessor was RETIRED, not overwritten or deleted");
      assert.equal(history[0]?.outcome, "taken_over_after_lease_expiry", "the takeover history survives");
      const successor = liveClaimFor(PK, "FG-1") as QueueClaim;
      assert.ok(successor, "the successor holds a live reservation");
      assert.equal(successor.generation, (history[0]?.generation ?? 0) + 1, "the fencing generation advanced");
      assert.equal(successor.launchId, originalLaunchId, "and it points at the SAME container");
      assert.equal(launchObservationCount("FG-1"), 1, "exactly one launch was ever observed for this ticket");
      assert.equal(
        (getDb().prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n,
        1,
        "and exactly one run exists — a second would be the duplicate execution recovery must never cause",
      );
    } finally {
      store.done();
    }
  });

  test("CONTROL: a LIVE lease is not recoverable — a second dispatcher fails closed and claims nothing", async () => {
    const store = openStore("live-lease");
    try {
      const PK = "pk-live-lease";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2"], checkout);
      arm({ maxActiveRuns: 2 });

      const first = await runWorker(store, "live-lease-1", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-A",
      });
      assert.deepEqual(launchedTickets(first), ["FG-1"]);
      const held = liveClaimFor(PK, "FG-1") as QueueClaim;

      // A different dispatcher instance starts while the first one's lease is LIVE.
      const second = await runWorker(store, "live-lease-2", {
        id: "1",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-B",
      });

      assert.deepEqual(second.launched, [], "a process that is not the dispatcher launches nothing");
      assert.deepEqual(second.adopted, [], "and adopts nothing");
      assert.equal(second.stopReason, "lease_lost", "it fails closed rather than driving under a lease it does not hold");
      assert.match(second.alert ?? "", /STRICT expiry/, "and says why waiting is not evidence of abandonment");
      assert.equal(liveClaimFor(PK, "FG-1")?.id, held.id, "the live reservation is byte-untouched");
      assert.equal(liveClaimFor(PK, "FG-1")?.generation, held.generation);
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 7) READINESS DRIFT AFTER AN EDIT (D7): queued, operator-actionable, and NOT
//    re-evaluated by the dispatcher.
// ===========================================================================
describe("FG-591 step 15 (D7): a readiness assessment gone stale after an edit", () => {
  test("the item stays queued and ranked, nothing is claimed, and the dispatcher does not re-assess it", async () => {
    const store = openStore("drift");
    try {
      const PK = "pk-drift";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      arm({ maxActiveRuns: 1 });

      // The operator edits the ticket. The stored assessment now describes a revision
      // that no longer exists.
      const before = getTicket(PK, "FG-1") as TicketRow;
      writeTransaction(() => {
        upsertSeamTicket({ ...before, body: `${READY_BODY}\n- and one more thing` });
      });
      const readinessBefore = JSON.stringify(getDb().prepare(`SELECT * FROM readiness_assessments`).all());
      assert.equal(readinessView(PK, "FG-1")?.stale, true, "the fixture must actually have made the assessment stale");

      const report = await runWorker(store, "drift", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-drift",
      });

      assert.deepEqual(report.launched, [], "a stale assessment is not something the dispatcher runs on");
      assert.equal(liveClaims(PK).length, 0);
      const evaluation = latestEvaluation(PK);
      assert.equal(evaluation?.reason, "no_eligible_work");
      const entry = scanEntryFor(evaluation, "FG-1");
      assert.equal(entry.reason, "readiness_ineligible");
      assert.match(entry.detail ?? "", /stale/, "the durable reason names staleness rather than 'nothing was eligible'");

      assert.equal(
        JSON.stringify(getDb().prepare(`SELECT * FROM readiness_assessments`).all()),
        readinessBefore,
        "the dispatcher NEVER authors its own eligibility — a stale assessment is an operator-actionable board " +
          "state, not something the scan silently re-evaluates (D7)",
      );

      const view = queueView(PK).find((e) => e.ticketId === "FG-1");
      assert.equal(view?.queued, true, "it stays a queue member...");
      assert.equal(view?.rank, 1, "...at its rank...");
      assert.equal(view?.readiness?.stale, true, "...with the staleness visible to the operator, which is the actionable part");
      assert.equal(view?.blocked, false, "a stale assessment is not a blocker either");
    } finally {
      store.done();
    }
  });

  test("the OPERATOR's recheck is what clears it, and the next pass runs it", async () => {
    const store = openStore("drift-clear");
    try {
      const PK = "pk-drift-clear";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      arm({ maxActiveRuns: 1 });
      const before = getTicket(PK, "FG-1") as TicketRow;
      writeTransaction(() => {
        upsertSeamTicket({ ...before, body: `${READY_BODY}\n- and one more thing` });
      });

      const stalled = await runWorker(store, "drift-clear-1", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-drift-clear",
      });
      assert.deepEqual(stalled.launched, []);

      // The operator act — and the ONLY thing that happens between the two passes.
      recheckReadiness(PK, "FG-1");
      assert.equal(readinessView(PK, "FG-1")?.stale, false);

      const resumed = await runWorker(store, "drift-clear-2", {
        id: "1",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-drift-clear",
      });
      assert.deepEqual(launchedTickets(resumed), ["FG-1"], "the item was operator-actionable, and the action was enough");
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 8) BLOCKED versus COMPATIBILITY-WAITING, side by side in one pass.
// ===========================================================================
describe("FG-591 step 15: a genuine blocker and a scheduling wait are different things", () => {
  test("one pass records both, distinguishably, and the board projects them differently", async () => {
    const store = openStore("blocked");
    try {
      const PK = "pk-blocked";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2", "FG-3"], checkout);
      arm({ maxActiveRuns: 1 });

      // FG-1: a GENUINE blocker — durable, per-ticket, and what the Blocked projection
      // is derived from. FG-2: a temporary scheduling incompatibility, which is
      // per-evaluation evidence and lives nowhere durable.
      writeTransaction(() => {
        upsertBlockerEvidence({
          projectKey: PK,
          ticketId: "FG-1",
          reason: "waiting on an upstream decision",
          source: "dependency:FG-999",
          createdAt: NOW,
          kind: "dependency",
          detail: null,
          bodyHash: null,
          queueProjection: "blocked",
        });
      });
      seedForeignLaunch("FG-2", checkout);

      const report = await runWorker(store, "blocked", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-blocked",
      });
      assert.deepEqual(launchedTickets(report), ["FG-3"]);

      const grant = grantEvaluation(PK, "FG-3");
      assert.equal(scanEntryFor(grant, "FG-1").reason, "queue_blocked", "the blocker is named as a blocker");
      const waiting = scanEntryFor(grant, "FG-2");
      assert.equal(waiting.reason, "incompatible", "and the wait is named as a wait — never collapsed into one answer");
      assert.match(waiting.detail ?? "", /waiting for FG-2 to finish/);

      const view = queueView(PK);
      const blocked = view.find((e) => e.ticketId === "FG-1");
      const waitingEntry = view.find((e) => e.ticketId === "FG-2");
      assert.equal(blocked?.blocked, true, "Blocked is DERIVED from the evidence, on every read");
      assert.equal(blocked?.queued, true, "and a blocked item keeps its membership...");
      assert.equal(blocked?.rank, 1, "...and its rank, so it returns to its position when the blocker clears");
      assert.equal(waitingEntry?.blocked, false, "the scheduling wait must NEVER render as Blocked");
      assert.equal(
        blockerEvidenceCount(),
        1,
        "the dispatcher wrote no blocker evidence of its own: exactly the row the fixture seeded remains",
      );
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 9) DISABLE AND CAPACITY CHANGE (D5) — admission tests, never reapers.
// ===========================================================================
describe("FG-591 step 15 (D5): disarming and reducing capacity stop new claims and nothing else", () => {
  test("disarm mid-flight: running work is untouched, its lease keeps renewing, and the refusal is recorded", async () => {
    const store = openStore("disarm");
    try {
      const PK = "pk-disarm";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2", "FG-3"], checkout);
      arm({ maxActiveRuns: 2 });

      const first = await runWorker(store, "disarm-1", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-disarm",
        maxTicks: 3,
        maxIterations: 24,
      });
      assert.deepEqual(launchedTickets(first), ["FG-1", "FG-2"], "the ceiling filled while dispatch was armed");
      const before = liveClaims(PK).map((c) => ({ id: c.id, hb: c.heartbeatAtMs, lease: c.leaseExpiresAtMs, launch: c.launchId }));
      assert.equal(before.length, 2);

      // The operator disarms. The heartbeats are made DUE durably, so the next tick's
      // renewal is observable without sleeping through a real cadence.
      setDispatcherPolicy({ armed: false, updatedBy: "operator" });
      makeHeartbeatsDue(PK);

      const second = await runWorker(store, "disarm-2", {
        id: "1",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-disarm",
      });

      assert.deepEqual(second.launched, [], "a disarmed dispatcher claims and launches NOTHING new");
      assert.equal(liveClaimFor(PK, "FG-3"), undefined);
      const after = liveClaims(PK).map((c) => ({ id: c.id, hb: c.heartbeatAtMs, lease: c.leaseExpiresAtMs, launch: c.launchId }));
      assert.equal(after.length, 2, "disarm is an admission test, never a reaper — both live claims survive");
      for (const row of after) {
        const was = before.find((b) => b.id === row.id);
        assert.ok(was, "the same reservations, not new ones");
        assert.ok(
          row.hb > was.hb && row.lease > was.lease,
          "a disarmed dispatcher KEEPS HEARTBEATING what it holds, or a takeover duplicates its container",
        );
        assert.equal(row.launch, was.launch, "and the launch identity does not move");
      }
      const runs = getDb().prepare(`SELECT status FROM runs`).all() as { status: string }[];
      assert.deepEqual(runs.map((r) => r.status), ["active", "active"], "the running work is untouched");
      assert.equal(
        (getDb().prepare(`SELECT COUNT(*) AS n FROM launch_observations WHERE terminal = 1`).get() as { n: number }).n,
        0,
        "disarm removed no launch",
      );

      const evaluation = latestEvaluation(PK);
      assert.equal(evaluation?.reason, "disabled");
      assert.match(evaluation?.detail ?? "", /disarmed/);
      assert.equal(evaluation?.scanEvidence, null, "a disarmed pass scans nothing, and an empty array would say it did");
    } finally {
      store.done();
    }
  });

  test("a capacity REDUCTION below current usage refuses the next claim and terminates nothing", async () => {
    const store = openStore("reduce");
    try {
      const PK = "pk-reduce";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1", "FG-2", "FG-3"], checkout);
      arm({ maxActiveRuns: 2 });

      const first = await runWorker(store, "reduce-1", {
        id: "0",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-reduce",
        maxTicks: 3,
        maxIterations: 24,
      });
      assert.deepEqual(launchedTickets(first), ["FG-1", "FG-2"]);
      const before = liveClaims(PK).map((c) => c.id).sort();

      setDispatcherPolicy({ maxActiveRuns: 1, updatedBy: "operator" });

      const second = await runWorker(store, "reduce-2", {
        id: "1",
        projectKey: PK,
        projectDir: checkout,
        dispatcherId: "instance-reduce",
        maxTicks: 2,
        maxIterations: 20,
      });

      assert.deepEqual(second.launched, [], "a reduced ceiling refuses the NEXT claim");
      assert.deepEqual(liveClaims(PK).map((c) => c.id).sort(), before, "and reaps none of the current ones");
      assert.deepEqual(
        (getDb().prepare(`SELECT status FROM runs`).all() as { status: string }[]).map((r) => r.status),
        ["active", "active"],
        "a capacity reduction never kills work",
      );
      const evaluation = latestEvaluation(PK);
      assert.equal(evaluation?.reason, "no_capacity");
      assert.equal(evaluation?.capacityLimit, 1);
      assert.equal(evaluation?.capacityUsed, 2, "the report says plainly that usage is ABOVE the new ceiling");
    } finally {
      store.done();
    }
  });
});

// ===========================================================================
// 10) FG-693: THE DISPATCH TARGET IS A PROVEN FILESYSTEM IDENTITY, NOT A STRING.
//
//     An operating system routinely gives one directory several names: a
//     symlinked parent anywhere in the chain, a system root exposed under two
//     prefixes (darwin's /var and /private/var), a relative spelling, a trailing
//     separator. Every case below arranges such an alias EXPLICITLY, with a
//     symlink this test creates, so it runs on Linux CI exactly as it runs on the
//     host where the defect was found — no platform branch, no enumerated prefix,
//     and no case that only fires on one operating system.
//
//     The seam is the DISPATCHER's own argument production — resolveDispatchTarget
//     into buildDispatchArgv into the launch cwd — driven through a real dispatcher
//     process wherever a container is involved. Asserting against the identity
//     helper directly would prove nothing about what forge launches.
// ===========================================================================
describe("FG-693: the dispatch target is a proven filesystem identity", () => {
  test("an aliased spelling launches in the PHYSICAL checkout — the argv and the cwd are canonical on every host", async () => {
    const store = openStore("fg693-alias");
    try {
      const PK = "pk-fg693-alias";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      arm({ maxActiveRuns: 1 });

      // The operator's spelling: a symlink to the checkout, with a trailing separator
      // on top of it. Two aliasing mechanisms at once, neither of them named anywhere
      // in production code.
      const link = join(store.dir, `link-${PK}`);
      symlinkSync(checkout, link);
      const operatorSpelling = `${link}/`;
      assert.notEqual(operatorSpelling, checkout, "the fixture must actually be an alias, or this proves nothing");
      assert.equal(realpathSync(operatorSpelling), checkout, "...of exactly this checkout");

      const report = await runWorker(store, "fg693-alias", {
        id: "0",
        projectKey: PK,
        projectDir: operatorSpelling,
        dispatcherId: "instance-fg693-alias",
      });

      const launch = report.launched[0];
      assert.ok(launch, "the aliased spelling must still launch — canonicalization is not a refusal");
      assert.deepEqual(
        launch.argv.slice(launch.argv.indexOf("new")),
        ["new", "feature", "title FG-1", "--ticket", "FG-1", "--project", checkout],
        "`--project` carries the PHYSICAL checkout, not the spelling the dispatcher was handed",
      );
      assert.equal(launch.cwd, checkout, "and the container is started in that same physical directory");
      assert.equal(
        launch.argv.some((a) => a.includes(link)),
        false,
        "the alias appears NOWHERE in what forge launches — a run recorded under a spelling only this " +
          "host understands is the whole defect",
      );

      // The run the launch created records the same physical directory, so the
      // reservation can bind it. That binding is the production narrowing
      // (discoverRunForClaim), driven here against the settled store.
      const runId = runIdFor("FG-1") as string;
      assert.ok(runId, "the launch created a run");
      assert.equal(
        (getDb().prepare(`SELECT project_dir FROM runs WHERE id = ?`).get(runId) as { project_dir: string }).project_dir,
        checkout,
      );
      const claim = liveClaimFor(PK, "FG-1") as QueueClaim;
      assert.equal(discoverRunForClaim(claim).kind, "found", "the reservation binds the run its own launch created");

      // AND the binding survives a run row that recorded the OTHER spelling — which is
      // exactly what an aged row, or a run an operator started through the alias, looks
      // like. Raw string equality returns 'none' here and the reservation never binds.
      writeTransaction(() => {
        getDb().prepare(`UPDATE runs SET project_dir = ?, project_dir_canonical = NULL WHERE id = ?`).run(operatorSpelling, runId);
      });
      assert.equal(
        discoverRunForClaim(claim).kind,
        "found",
        "a run recorded under an aliased spelling of the launch directory is the SAME run",
      );
    } finally {
      store.done();
    }
  });

  test("two recorded SPELLINGS of one checkout are ONE target — not the ambiguous-checkout refusal", () => {
    const store = openStore("fg693-one-target");
    try {
      const PK = "pk-fg693-one-target";
      const checkout = checkoutDir(store, PK);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      arm({ maxActiveRuns: 1 });

      // A second ticket in the same project was imported through an alias of the SAME
      // checkout. Before FG-693 the DISTINCT over recorded bytes returned two rows and
      // the dispatcher refused `ambiguous_checkout` — reading one checkout as the
      // linked-worktree shape and stalling a project that has exactly one.
      const link = join(store.dir, `link-${PK}`);
      symlinkSync(checkout, link);
      writeTransaction(() => {
        upsertTicket(ticketRow(PK, "FG-2", `${link}/`));
      });

      const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
      assert.equal(res.ok, true, `two spellings of one checkout must resolve: ${res.ok ? "" : res.refusal.message}`);
      if (!res.ok) return;
      assert.equal(res.target.projectDir, checkout, "and they resolve to the PHYSICAL checkout");
      assert.equal(
        buildDispatchArgv(["forge"], res.target)[buildDispatchArgv(["forge"], res.target).indexOf("--project") + 1],
        checkout,
        "which is what the launch argv carries",
      );

      // A relative spelling and a `.`-bearing spelling of the same tree collapse too —
      // the contract covers the whole aliasing class, not a list of prefixes.
      writeTransaction(() => {
        upsertTicket(ticketRow(PK, "FG-3", relative(process.cwd(), checkout)));
        upsertTicket(ticketRow(PK, "FG-4", join(checkout, ".")));
      });
      const again = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
      assert.equal(again.ok, true, `every spelling of one checkout is one target: ${again.ok ? "" : again.refusal.message}`);
      assert.equal(again.ok && again.target.projectDir, checkout);
    } finally {
      store.done();
    }
  });

  test("NEGATIVE CONTROL: two genuinely distinct checkouts still refuse, even sharing a lexical prefix", () => {
    const store = openStore("fg693-distinct");
    try {
      const PK = "pk-fg693-distinct";
      const checkout = checkoutDir(store, PK);
      // A sibling whose absolute path is a strict lexical PREFIX-sharer of the first —
      // and which, being a copy of the same project, would share a git remote. Neither
      // fact makes it the same checkout: path identity is not repository identity.
      const sibling = `${checkout}-sibling`;
      mkdirSync(sibling, { recursive: true });
      registerProject(PK);
      seedQueued(PK, ["FG-1"], checkout);
      writeTransaction(() => {
        upsertTicket(ticketRow(PK, "FG-2", sibling));
      });
      arm({ maxActiveRuns: 1 });

      const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
      assert.equal(res.ok, false, "two different directories are still two checkouts");
      if (res.ok) return;
      assert.equal(res.refusal.kind, "ambiguous_checkout");
      assert.match(res.refusal.message, /linked-worktree/);
      assert.ok(res.refusal.message.includes(sibling), "the refusal names both, in the operator's own bytes");
      assert.ok(res.refusal.message.includes(checkout));
    } finally {
      store.done();
    }
  });

  test("a recorded checkout that no longer resolves still refuses BY NAME, never launching against a guess", () => {
    const store = openStore("fg693-gone");
    try {
      const PK = "pk-fg693-gone";
      const gone = join(store.dir, `checkout-${PK}-gone`);
      registerProject(PK);
      seedQueued(PK, ["FG-1"], gone);
      arm({ maxActiveRuns: 1 });

      const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
      assert.equal(res.ok, false, "a directory that is not there is not a launch target");
      if (res.ok) return;
      assert.equal(
        res.refusal.kind,
        "missing_checkout",
        "'we know where it lived and it is not there' — never 'nobody ever said where this project lives'",
      );
      assert.ok(res.refusal.message.includes(gone), "the refusal names the recorded spelling the operator would recognise");
      assert.match(res.refusal.message, /UNRESOLVED/, "and labels it as unproven rather than printing it as a path");

      // An EXPLICIT unresolvable checkout refuses identically — an operator's spelling
      // is an answer to which tree, and it does not become one by being typed.
      const explicit = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1", projectDir: join(store.dir, "typed-but-absent") });
      assert.equal(explicit.ok, false);
      assert.equal(explicit.ok === false && explicit.refusal.kind, "missing_checkout");
    } finally {
      store.done();
    }
  });
});
