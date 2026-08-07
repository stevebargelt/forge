// FG-591 (step 8): the long-lived dispatcher, against a real in-memory SQLite DB
// running the REAL policy, evidence, compatibility, claim, cycle and execution
// modules. The only substituted thing is the tmux/subprocess boundary — step 7's own
// ExecutionSeams — and the sleep that paces the process.
//
// THE BAR THIS FILE HOLDS ITSELF TO:
//
//  * "The second ticket started on its own" is proven from the LAUNCHER, not from the
//    claim table. A claim that is granted and never launched, and a second container
//    started for work already running, are both invisible in a claim-row assertion and
//    both are the defect this ticket exists to prevent.
//
//  * Every recovery claim is paired with the arrangement that must NOT recover. A
//    dispatcher that recovers everything passes every recovery assertion and is a
//    duplicate-execution engine; a watchdog that fires on the happy path would report
//    a healthy event path as a lost signal.
//
//  * The clock is the STORE's. The sleep seam advances it, so "the watchdog became
//    due" and "the lease lapsed" are the same kind of fact the production code
//    compares, not a wall-clock coincidence.
//
// STATED LIMIT: like every DB test in this repo this runs ONE process against ONE
// handle, so SQLite's BEGIN IMMEDIATE locking is inert here. The fencing CAS
// predicates are not — they are ordinary SQL and are what these tests exercise. The
// cross-process cases are step 15's.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "../store/publications.js";
import { upsertTicket, type TicketRow } from "../store/tickets.js";
import { enqueueTicket, queueView, rankTicket, QueueRefusal } from "../store/queue.js";
import {
  claimHistoryForTicket,
  claimNextEligible,
  liveClaims,
  MIN_LEASE_TTL_MS,
  type QueueClaim,
} from "../store/queue-claims.js";
import {
  acquireDispatcherLease,
  getDispatcherLease,
  setDispatcherPolicy,
} from "../store/dispatcher-policy.js";
import { evaluationsFor, latestEvaluation, listWakes } from "../store/dispatcher-evidence.js";
import { recordLaunchObservation } from "../store/launch-observations.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";
import type { LaunchMeta } from "../v2/launch.js";
import { hydrateActiveRunFacts, makeCompatibilityPredicate } from "./compatibility.js";
import type { ExecutionSeams } from "./dispatch-execution.js";
import {
  DISPATCHER_ID_ENV,
  MIN_WATCHDOG_INTERVAL_MS,
  dispatcherHealth,
  observeRunTerminalWakes,
  resolveDispatcherOwner,
  runDispatcherLoop,
  runDispatcherTick,
  type DispatcherLoopOptions,
  type DispatcherLoopSummary,
  type DispatcherTick,
  type SleepFn,
} from "./dispatcher-loop.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let CHECKOUT: string;
let clockOffsetMs = 0;

const PK = "pk-dispatcher-loop";
const PK2 = "pk-dispatcher-loop-two";
const NOW = "2026-08-06T00:00:00Z";
const OWNER = "dispatcher@pk-dispatcher-loop@instance-A";
const FORGE_BIN = ["/usr/bin/node", "/opt/forge/dist/cli/index.js"];

/** One TTL for the claim leases and the dispatcher lease alike, comfortably above the
 *  derived floor, so "due for a heartbeat" and "the lease lapsed" stay independent
 *  facts a test moves one at a time. */
const TTL = 120_000;
const HEARTBEAT_MS = 5_000;
/** Well above MIN_WATCHDOG_INTERVAL_MS, and a whole multiple of the poll below, so the
 *  number of idle iterations before the watchdog fires is arithmetic rather than luck. */
const WATCHDOG_MS = 60_000;
const POLL_MS = 20_000;

const READY_BODY = [
  "## Problem",
  "Something is wrong.",
  "",
  "## Goal",
  "Make it right.",
  "",
  "## Acceptance Criteria",
  "- it works",
].join("\n");

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  clockOffsetMs = 0;
  setPublicationClockOffsetForTest(0);
  CHECKOUT = mkdtempSync(join(tmpdir(), "fg591-loop-checkout-"));
  registerDbProject(PK);
  assert.ok(TTL >= MIN_LEASE_TTL_MS, "the fixture TTL must clear the derived floor");
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(CHECKOUT, { recursive: true, force: true });
});

// ─── fixtures ────────────────────────────────────────────────────────────────

function registerDbProject(projectKey: string): void {
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

function ticket(id: string, over: Partial<TicketRow> = {}): TicketRow {
  return {
    projectKey: PK,
    ticketId: id,
    type: "story",
    status: "active",
    title: `title ${id}`,
    body: READY_BODY,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: NOW,
    importedFrom: CHECKOUT,
    ...over,
  };
}

/** Rank and enqueue in the order given, so ids[0] is rank 1. */
function seedQueued(ids: string[]): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id));
  });
  for (const id of ids) {
    rankTicket(PK, id);
    const res = enqueueTicket(PK, id);
    assert.equal(res.ok, true, `${id} must enqueue for the fixture to mean anything`);
  }
}

function arm(over: { maxActiveRuns?: number; armed?: boolean } = {}): void {
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

/**
 * THE LAUNCHER. Substitutes only the tmux/subprocess boundary and then behaves the
 * way `forge new --ticket` actually does: it writes a REAL launch observation through
 * the store's own writer and inserts a REAL run row carrying the ticket association,
 * so run discovery, binding and reconciliation all read production rows.
 */
type Launcher = {
  execution: ExecutionSeams;
  launches: { argv: string[]; cwd: string; name: string; ticketId: string }[];
  removed: string[];
  runIdFor: Map<string, string>;
};

function launcher(): Launcher {
  const launches: Launcher["launches"] = [];
  const removed: string[] = [];
  const runIdFor = new Map<string, string>();
  let n = 0;

  const execution: ExecutionSeams = {
    startLaunch: (argv, opts) => {
      n++;
      const ticketId = ticketIdFromArgv(argv);
      launches.push({ argv, cwd: opts.cwd, name: opts.name, ticketId });
      // The identity is the one ALREADY stamped on the claim — a launcher that minted
      // its own would orphan the container the stamp points at.
      const meta: LaunchMeta = {
        id: opts.id,
        command: argv,
        tmuxSession: `forge-${opts.id}`,
        launcherPid: process.pid,
        ownerPid: null,
        startedAt: "2026-08-06T00:00:00.000Z",
        logPath: `/tmp/launch-${n}/out.log`,
        cwd: opts.cwd,
      };
      return meta;
    },
    recordLaunchStart: (meta, association) => {
      recordLaunchObservation({
        launchId: meta.id,
        name: meta.id,
        command: meta.command,
        cwd: meta.cwd,
        projectDir: meta.cwd,
        association: { ticketId: association.ticketId },
        startedAt: meta.startedAt,
        observedAt: meta.startedAt,
        status: { state: "running" },
      });
      // `forge new` creates the run before it exits; that is what binds a claim to an
      // execution, so the fixture creates one here rather than pretending later.
      const runId = `run-${association.ticketId}`;
      runIdFor.set(association.ticketId, runId);
      getDb()
        .prepare(
          `INSERT INTO runs (id, workflow, title, status, created_at, metadata, project_dir)
           VALUES (?, 'feature', ?, 'active', ?, ?, ?)`,
        )
        .run(runId, `title ${association.ticketId}`, "2026-08-06T00:00:05.000Z", JSON.stringify({ ticketId: association.ticketId }), meta.cwd);
      return true;
    },
    removeLaunch: (id) => {
      removed.push(id);
    },
    promoteLaunchObservations: () => 0,
    cancelWork: () => {
      throw new Error("cancelWork must not be reached by a dispatcher-loop fixture");
    },
  };

  return { execution, launches, removed, runIdFor };
}

function ticketIdFromArgv(argv: string[]): string {
  const at = argv.indexOf("--ticket");
  return at >= 0 ? (argv[at + 1] ?? "") : "";
}

/** A live task with its OWN worktree — compatibility.ts's `isolated` lane, which is
 *  what makes a second run in the same repository parallel-safe. Idempotent, so a
 *  per-sleep sweep can call it for every launched run. */
function seedIsolatedTask(runId: string, ticketId: string): void {
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, worktree_path)
       VALUES (?, ?, 'build', 'backend-specialist', 'running', '{}', ?, ?)`,
    )
    .run(`task-${ticketId}`, runId, NOW, `/wt/${runId}/task-${ticketId}`);
}

function finishRun(ticketId: string, status: "complete" | "failed" | "abandoned" = "complete"): void {
  const res = getDb()
    .prepare(`UPDATE runs SET status = ? WHERE id = ?`)
    .run(status, `run-${ticketId}`);
  assert.equal(res.changes, 1, `the fixture must have a run for ${ticketId} to finish`);
}

/** The sleep seam: advances the STORE clock by exactly what was slept, and lets a test
 *  make the world change between ticks without ever sending an operator message. */
function sleepAdvancingClock(onSleep?: (sleptCount: number) => void): SleepFn {
  let count = 0;
  return async (ms: number) => {
    count++;
    clockOffsetMs += ms;
    setPublicationClockOffsetForTest(clockOffsetMs);
    onSleep?.(count);
  };
}

function loopOptions(over: Partial<DispatcherLoopOptions> = {}): DispatcherLoopOptions {
  return {
    projectKey: PK,
    owner: OWNER,
    forgeBin: FORGE_BIN,
    watchdogIntervalMs: WATCHDOG_MS,
    wakePollMs: POLL_MS,
    maxTicks: 1,
    maxIterations: 60,
    // The dispatcher under test is ONE long-lived instance across several runLoop
    // calls in a test; releasing the lease at the end of each would be an orderly
    // shutdown, not the continuation (or crash) these tests are about.
    releaseLeaseOnStop: false,
    ...over,
  };
}

function ticketsLaunched(l: Launcher): string[] {
  return l.launches.map((x) => x.ticketId);
}

function liveClaimFor(ticketId: string): QueueClaim | undefined {
  return liveClaims(PK).find((c) => c.ticketId === ticketId);
}

function fullDump(): string {
  const tables = (
    getDb()
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  return tables
    .map((t) => `${t}:${JSON.stringify(getDb().prepare(`SELECT * FROM "${t}"`).all())}`)
    .join("\n");
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const LOOP_SOURCE = readFileSync(join(MODULE_DIR, "dispatcher-loop.ts"), "utf8");
const CYCLE_SOURCE = readFileSync(join(MODULE_DIR, "dispatch-cycle.ts"), "utf8");

// ─── identity ────────────────────────────────────────────────────────────────

describe("FG-591 step 8: the dispatcher identity is instance-stable or refused", () => {
  test("refuses when no stable identity is declared, and names the env var and the reason", () => {
    const res = resolveDispatcherOwner(PK, {});
    assert.equal(res.ok, false);
    if (res.ok) return;
    assert.match(res.error, new RegExp(DISPATCHER_ID_ENV));
    assert.match(res.error, /host-stable owner/i, "the refusal must say WHY a hostname is not enough");
  });

  test("the same declared id yields the same owner across restarts, and differs per project", () => {
    const a = resolveDispatcherOwner(PK, { [DISPATCHER_ID_ENV]: "instance-A" });
    const again = resolveDispatcherOwner(PK, { [DISPATCHER_ID_ENV]: "instance-A" });
    const other = resolveDispatcherOwner(PK2, { [DISPATCHER_ID_ENV]: "instance-A" });
    assert.equal(a.ok && again.ok && a.owner === again.owner, true, "restart adoption needs a stable owner");
    assert.notEqual(a.ok && other.ok ? other.owner : "", a.ok ? a.owner : "x");
  });
});

describe("FG-591 step 8: the watchdog is a HEALTH bound with a floor", () => {
  test("a watchdog interval under the floor refuses by name and starts nothing", () => {
    arm();
    assert.throws(
      () =>
        runDispatcherTick({
          projectKey: PK,
          owner: OWNER,
          trigger: "startup",
          forgeBin: FORGE_BIN,
          watchdogIntervalMs: MIN_WATCHDOG_INTERVAL_MS - 1,
        }),
      (e: unknown) => e instanceof QueueRefusal && /health bound/i.test((e as Error).message),
    );
    assert.equal(getDispatcherLease(PK), undefined, "a refused tick must not have acquired an identity");
    assert.equal(evaluationsFor(PK).length, 0, "a refused tick must not have evaluated anything");
  });
});

// ─── the AC: continuous progress with no operator input ──────────────────────

describe("FG-591 step 8: capacity 1, two queued tickets, no operator input", () => {
  test("the SECOND ticket is launched after the first reaches terminal", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    const summary = await runDispatcherLoop(
      loopOptions({
        maxTicks: 2,
        maxIterations: 100,
        seams: {
          execution: l.execution,
          // The ONLY thing that happens between the ticks: the first run finishes.
          // No wake is recorded by hand, no CLI verb is run, no message is sent.
          sleep: sleepAdvancingClock(() => {
            if (l.launches.length === 1) finishRun("FG-1");
          }),
        },
      }),
    );

    assert.deepEqual(
      ticketsLaunched(l),
      ["FG-1", "FG-2"],
      "the queue must have advanced on its own — proven at the LAUNCHER, not at the claim table",
    );
    assert.equal(summary.ticks.length, 2);
    const second = summary.ticks[1] as DispatcherTick;
    assert.equal(second.trigger, "wake", "the run-terminal transition must reach the loop as a durable WAKE");
    assert.equal(second.reconciled.length, 1);
    assert.equal(second.reconciled[0]?.ticketId, "FG-1");
    assert.equal(second.reconciled[0]?.outcome, "completed");
    assert.equal(second.reconciled[0]?.recoveredWithoutWake, false, "the event path delivered; this was no lost signal");
    assert.equal(second.cycle?.grants[0]?.claim.ticketId, "FG-2");

    assert.equal(liveClaimFor("FG-1"), undefined, "the finished reservation must be retired");
    assert.equal(liveClaimFor("FG-2")?.launchId !== null, true, "the new reservation must carry its launch stamp");
    assert.equal(claimHistoryForTicket(PK, "FG-1").length, 1, "FG-1 must have been claimed exactly once, ever");
  });

  test("the durable wake it acted on is a run_terminal record, not a poll result", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();
    await runDispatcherLoop(
      loopOptions({
        maxTicks: 2,
        maxIterations: 100,
        seams: {
          execution: l.execution,
          sleep: sleepAdvancingClock(() => {
            if (l.launches.length === 1) finishRun("FG-1");
          }),
        },
      }),
    );

    const wakes = listWakes(PK);
    const terminal = wakes.filter((w) => w.kind === "run_terminal");
    assert.equal(terminal.length, 1, "one transition, one durable record");
    assert.equal(terminal[0]?.wakeKey, `run:${l.runIdFor.get("FG-1")}`, "keyed by the subject that changed");
    assert.equal(terminal[0]?.state, "consumed");
    assert.equal(terminal[0]?.consumedBy, OWNER, "consumed by compare-and-set, and the record says by whom");
  });

  test("CONTROL: while the first run is still ACTIVE, nothing else is launched and the ceiling says why", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    await runDispatcherLoop(
      loopOptions({
        maxTicks: 3,
        maxIterations: 100,
        seams: { execution: l.execution, sleep: sleepAdvancingClock() },
      }),
    );

    assert.deepEqual(ticketsLaunched(l), ["FG-1"], "a ceiling of 1 must not be exceeded while the run is live");
    const latest = latestEvaluation(PK);
    assert.equal(latest?.reason, "no_capacity");
    assert.equal(latest?.capacityLimit, 1);
    assert.deepEqual(
      latest?.capacityHolders?.map((h) => `${h.projectKey}:${h.ticketId}`),
      [`${PK}:FG-1`],
      "a host-scoped refusal must NAME who holds the slot",
    );
  });

  test("a finished ticket leaves the queue with its RANK intact, and is never re-launched", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    await runDispatcherLoop(
      loopOptions({
        maxTicks: 4,
        maxIterations: 120,
        seams: {
          execution: l.execution,
          sleep: sleepAdvancingClock(() => {
            if (l.launches.length === 1) finishRun("FG-1");
          }),
        },
      }),
    );

    const view = queueView(PK);
    const one = view.find((e) => e.ticketId === "FG-1");
    assert.equal(one?.queued, false, "the planning intent is satisfied once the work ran and ended");
    assert.equal(one?.rank, 1, "the RANK survives, so re-enqueueing returns it to the operator's own position");
    assert.equal(one?.status, "active", "nothing here writes a lifecycle status — Done stays derived");
    assert.equal(
      ticketsLaunched(l).filter((t) => t === "FG-1").length,
      1,
      "a completed ticket left in the queue would be re-claimed forever; it is launched exactly once",
    );
  });
});

// ─── refilling to the ceiling without waiting on the health bound ────────────

describe("FG-591 step 8: capacity greater than one fills to the ceiling, and no further", () => {
  test("the second slot is filled by a follow-up tick, NOT by the watchdog", async () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    arm({ maxActiveRuns: 2 });
    const l = launcher();

    const summary = await runDispatcherLoop(
      loopOptions({
        maxTicks: 4,
        maxIterations: 60,
        // A watchdog that could not possibly fire inside this test: whatever fills the
        // second slot, it is not the health bound.
        watchdogIntervalMs: 60 * 60_000,
        seams: {
          execution: l.execution,
          sleep: sleepAdvancingClock(() => {
            // The first run's task takes its OWN worktree, so the workspace lane is
            // isolated and a second run in this repo is genuinely parallel-safe.
            for (const [ticketId, runId] of l.runIdFor) seedIsolatedTask(runId, ticketId);
          }),
        },
      }),
    );

    assert.deepEqual(ticketsLaunched(l), ["FG-1", "FG-2"], "the ceiling must fill, and stop at 2");
    assert.equal(
      summary.ticks.some((t) => t.trigger === "watchdog"),
      false,
      "the health bound must not be what refills capacity",
    );
    assert.ok(
      summary.ticks.some((t) => t.trigger === "refill"),
      "a launch must schedule the follow-up look that the unknown-lane refusal needs",
    );
    assert.equal(liveClaims(PK).length, 2);
    assert.equal(liveClaimFor("FG-3"), undefined, "the third candidate is turned away by the ceiling, not claimed");
    assert.equal(latestEvaluation(PK)?.reason, "no_capacity");
  });

  test("a bypassed candidate's durable RANK is byte-identical before and after", async () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    arm({ maxActiveRuns: 1 });
    const before = getDb()
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(PK);
    const l = launcher();

    await runDispatcherLoop(
      loopOptions({ maxTicks: 3, maxIterations: 80, seams: { execution: l.execution, sleep: sleepAdvancingClock() } }),
    );

    const after = getDb()
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(PK);
    assert.deepEqual(after, before, "the dispatcher never reorders the operator's queue");
  });
});

// ─── the watchdog: a lost signal, bounded ────────────────────────────────────

describe("FG-591 step 8: with the primary wake suppressed, the watchdog recovers — exactly once", () => {
  async function runWithSuppressedWakes(l: Launcher, maxTicks: number): Promise<DispatcherLoopSummary> {
    return runDispatcherLoop(
      loopOptions({
        maxTicks,
        maxIterations: 200,
        seams: {
          execution: l.execution,
          // THE SUPPRESSION. The primary signal never gets recorded, so the ONLY thing
          // left that can notice the finished run is the health bound.
          observeWakes: () => [],
          // The run finishes AFTER the post-launch refill follow-up has already looked
          // and found it still running — a run that outlives one poll interval, which
          // every real one does. What is left to notice it is the watchdog and nothing
          // else, which is the arrangement this suite is about.
          sleep: sleepAdvancingClock((slept) => {
            if (slept >= 2 && l.launches.length === 1) finishRun("FG-1");
          }),
        },
      }),
    );
  }

  test("one launch, one durable recovery record, and no second container", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    const summary = await runWithSuppressedWakes(l, 4);

    assert.deepEqual(ticketsLaunched(l), ["FG-1", "FG-2"], "the watchdog alone must be sufficient to make progress");
    const watchdogTick = summary.ticks.find((t) => t.trigger === "watchdog");
    assert.ok(watchdogTick, "no watchdog tick fired — the test proved nothing about the health bound");
    assert.equal(
      watchdogTick?.reconciled.find((r) => r.ticketId === "FG-1")?.recoveredWithoutWake,
      true,
      "the health bound must be what found the finished run, and must SAY that no wake announced it",
    );

    const recoveries = listWakes(PK).filter((w) => w.kind === "recovery");
    assert.equal(recoveries.length, 1, "a lost signal must leave EXACTLY ONE durable recovery record");
    assert.match(recoveries[0]?.detail ?? "", /did not deliver/i);
    assert.equal(
      listWakes(PK).filter((w) => w.kind === "run_terminal").length,
      0,
      "the suppression must really have suppressed the primary path",
    );

    assert.equal(claimHistoryForTicket(PK, "FG-1").length, 1, "FG-1 was reserved once and executed once");
    assert.equal(l.removed.length, 0, "recovery must not have killed anything");
  });

  test("further ticks do not accumulate a second recovery record for the same claim", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    await runWithSuppressedWakes(l, 8);

    assert.equal(listWakes(PK).filter((w) => w.kind === "recovery").length, 1);
    assert.deepEqual(ticketsLaunched(l), ["FG-1", "FG-2"]);
  });

  test("NEGATIVE CONTROL: when the event path DOES deliver, no recovery record is written", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    await runDispatcherLoop(
      loopOptions({
        maxTicks: 4,
        maxIterations: 120,
        seams: {
          execution: l.execution,
          sleep: sleepAdvancingClock(() => {
            if (l.launches.length === 1) finishRun("FG-1");
          }),
        },
      }),
    );

    assert.equal(
      listWakes(PK).filter((w) => w.kind === "recovery").length,
      0,
      "a healthy signal path reported as a lost one is an alarm that means nothing",
    );
  });
});

// ─── disarm mid-flight (D5) ──────────────────────────────────────────────────

describe("FG-591 step 8 (D5): disarming stops NEW claims and nothing else", () => {
  test("running work is untouched, its lease keeps renewing, and the refusal is recorded", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 2 });
    const l = launcher();

    // Tick 1: FG-1 is claimed and launched while dispatch is armed.
    await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));
    assert.deepEqual(ticketsLaunched(l), ["FG-1"]);
    const before = liveClaimFor("FG-1") as QueueClaim;
    assert.ok(before, "the fixture needs a live claim to protect");

    // The operator disarms mid-flight.
    setDispatcherPolicy({ armed: false, updatedBy: "operator" });

    await runDispatcherLoop(
      loopOptions({ maxTicks: 3, maxIterations: 120, seams: { execution: l.execution, sleep: sleepAdvancingClock() } }),
    );

    assert.deepEqual(ticketsLaunched(l), ["FG-1"], "a disarmed dispatcher must claim and launch NOTHING new");
    assert.equal(liveClaimFor("FG-2"), undefined);

    const after = liveClaimFor("FG-1") as QueueClaim;
    assert.ok(after, "disarm is an admission test, never a reaper — the live claim must survive");
    assert.equal(after.id, before.id);
    assert.ok(
      after.heartbeatAtMs > before.heartbeatAtMs,
      "a disarmed dispatcher must KEEP HEARTBEATING the leases it holds, or a takeover duplicates its container",
    );
    assert.ok(after.leaseExpiresAtMs > before.leaseExpiresAtMs);
    assert.equal(after.launchId, before.launchId, "the launch identity must not move");

    const run = getDb().prepare(`SELECT status FROM runs WHERE id = ?`).get("run-FG-1") as { status: string };
    assert.equal(run.status, "active", "the running work must be untouched");
    assert.equal(l.removed.length, 0, "disarm must not remove a launch");

    const latest = latestEvaluation(PK);
    assert.equal(latest?.reason, "disabled");
    assert.match(latest?.detail ?? "", /disarmed/);
    assert.equal(latest?.scanEvidence, null, "a disarmed pass scans nothing, and an empty array would say it did");
  });

  test("a capacity REDUCTION below current usage terminates nothing and only refuses the next claim", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 2 });
    const l = launcher();
    await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));
    const before = liveClaimFor("FG-1") as QueueClaim;

    setDispatcherPolicy({ maxActiveRuns: 1, updatedBy: "operator" });

    await runDispatcherLoop(
      loopOptions({ maxTicks: 2, maxIterations: 120, seams: { execution: l.execution, sleep: sleepAdvancingClock() } }),
    );

    assert.deepEqual(ticketsLaunched(l), ["FG-1"]);
    assert.equal(liveClaimFor("FG-1")?.id, before.id, "the ceiling is an ADMISSION test, never a reaper");
    assert.equal(latestEvaluation(PK)?.reason, "no_capacity");
  });
});

// ─── restart, and the fenced identity ────────────────────────────────────────

describe("FG-591 step 8: a restart ADOPTS the lease and its claims", () => {
  test("the successor renews its own identity, relaunches nothing and duplicates no claim", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    const first = await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));
    const leaseAfterFirst = getDispatcherLease(PK);
    const claimAfterFirst = liveClaimFor("FG-1") as QueueClaim;
    assert.equal(first.ticks[0]?.identity.held, true);
    assert.deepEqual(ticketsLaunched(l), ["FG-1"]);

    // The process goes away without releasing anything — a crash, a closed laptop lid,
    // a killed tmux pane. A successor starts with the SAME declared identity.
    const second = await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));

    const tick = second.ticks[0] as DispatcherTick;
    assert.equal(tick.identity.held, true);
    assert.equal(tick.identity.held ? tick.identity.mode : "", "renewed", "the successor must ADOPT its own lease");
    assert.equal(
      getDispatcherLease(PK)?.generation,
      leaseAfterFirst?.generation,
      "adoption must not bump the fencing generation — that is what a TAKEOVER does",
    );
    assert.equal(
      (getDb().prepare(`SELECT COUNT(*) AS n FROM dispatcher_leases`).get() as { n: number }).n,
      1,
      "a restart must not leave a second dispatcher identity beside the first",
    );

    assert.deepEqual(ticketsLaunched(l), ["FG-1"], "the adopted claim's container must NOT be started a second time");
    assert.equal(liveClaimFor("FG-1")?.id, claimAfterFirst.id);
    assert.equal(claimHistoryForTicket(PK, "FG-1").length, 1);
  });

  test("a DIFFERENT live owner holds the lease: the loop fails closed, claims nothing and says who holds it", async () => {
    seedQueued(["FG-1"]);
    arm({ maxActiveRuns: 1 });
    acquireDispatcherLease({ projectKey: PK, owner: "dispatcher@other@instance-B", ttlMs: TTL });
    const l = launcher();

    const summary = await runDispatcherLoop(
      loopOptions({ maxTicks: 3, maxIterations: 40, seams: { execution: l.execution, sleep: sleepAdvancingClock() } }),
    );

    assert.equal(summary.stopReason, "lease_lost");
    assert.match(summary.alert ?? "", /dispatcher@other@instance-B/);
    assert.match(summary.alert ?? "", /STRICT expiry/);
    assert.deepEqual(ticketsLaunched(l), [], "a process that is not the dispatcher must launch nothing");
    assert.equal(liveClaims(PK).length, 0, "and claim nothing");
    assert.equal(evaluationsFor(PK).length, 0, "and decide nothing — the identity check precedes every decision");
  });
});

// ─── the predicate never runs under the machine-wide write lock ──────────────

describe("FG-591 step 8: the compatibility predicate is never invoked inside a write transaction", () => {
  /** Tracks how deep we are inside db.transaction(...) — the ONE write path
   *  (writeTransaction) runs through it, so depth > 0 means the machine-wide write
   *  lock is held. */
  function installTxnTracker(real: DatabaseInstance): { depth: () => number; restore: () => void } {
    let depth = 0;
    const proxy = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "transaction") {
          return (fn: (...args: unknown[]) => unknown) =>
            (value as (f: unknown) => unknown).call(target, (...args: unknown[]) => {
              depth++;
              try {
                return fn(...args);
              } finally {
                depth--;
              }
            });
        }
        if (typeof value !== "function") return value;
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    }) as DatabaseInstance;
    setDbForTest(proxy);
    return { depth: () => depth, restore: () => void setDbForTest(real) };
  }

  test("a REAL claim evaluation invokes the predicate at transaction depth ZERO", () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 2 });
    const tracker = installTxnTracker(db);
    try {
      // The predicate the dispatch cycle builds, constructed exactly as it builds it.
      const facts = hydrateActiveRunFacts({ projectKey: PK, capacityScope: "host" });
      const pure = makeCompatibilityPredicate(facts);
      const depths: number[] = [];

      const out = claimNextEligible({
        projectKey: PK,
        owner: OWNER,
        capacity: 2,
        capacityScope: "host",
        leaseTtlMs: TTL,
        isCompatible: (candidate, active) => {
          depths.push(tracker.depth());
          return pure(candidate, active);
        },
      });

      assert.equal(out.reason, "granted");
      assert.ok(depths.length > 0, "the predicate must actually have been consulted");
      assert.deepEqual([...new Set(depths)], [0], "the predicate ran while the machine-wide write lock was held");

      // NEGATIVE CONTROL: the tracker can see a transaction, so the zero above means
      // something.
      let insideDepth = -1;
      writeTransaction(() => {
        insideDepth = tracker.depth();
      });
      assert.ok(insideDepth > 0, "the tracker cannot see a write transaction — the assertion above proves nothing");
    } finally {
      tracker.restore();
    }
  });

  test("neither the loop nor the cycle opens a write transaction around the decision", () => {
    for (const [name, source] of [
      ["dispatcher-loop.ts", LOOP_SOURCE],
      ["dispatch-cycle.ts", CYCLE_SOURCE],
    ] as const) {
      assert.equal(
        /\bwriteTransaction\s*\(/.test(source),
        false,
        `${name} calls writeTransaction — caller code under the machine-wide write lock stalls every forge ` +
          `process on this host, and the predicate runs in the caller`,
      );
    }
  });

  test("the loop writes no ticket status, no blocker evidence and no rank", () => {
    for (const forbidden of ["blocker_evidence", "priority_rank", "tickets.status", "rankTicket", "moveQueuePosition"]) {
      assert.equal(
        LOOP_SOURCE.includes(forbidden),
        false,
        `the dispatcher loop names ${forbidden}; blocked and in_progress stay DERIVED and the operator's ` +
          `rank is never the dispatcher's to move`,
      );
    }
  });
});

// ─── the primary observer, on its own ────────────────────────────────────────

describe("FG-591 step 8: the primary wake observer", () => {
  test("records one durable run_terminal wake per transition and collapses a repeat", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();
    await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));

    assert.deepEqual(observeRunTerminalWakes({ projectKey: PK, owner: OWNER }), [], "a live run is not a transition");

    finishRun("FG-1");
    const first = observeRunTerminalWakes({ projectKey: PK, owner: OWNER });
    assert.equal(first.length, 1);
    const again = observeRunTerminalWakes({ projectKey: PK, owner: OWNER });
    assert.equal(again.length, 1, "a second observation returns the SAME pending record");
    assert.equal(again[0]?.id, first[0]?.id, "a duplicate poke is harmless by construction, not by care");
    assert.equal(listWakes(PK).filter((w) => w.kind === "run_terminal").length, 1);
  });

  test("an ENQUEUE while the dispatcher is idle wakes it, without waiting for the watchdog", async () => {
    // AC15's most common queue change. The dispatcher starts with an EMPTY queue and
    // its watchdog far in the future, so a tick can only happen if the enqueue itself
    // left a durable signal.
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    const summary = await runDispatcherLoop(
      loopOptions({
        maxTicks: 2,
        maxIterations: 100,
        seams: {
          execution: l.execution,
          // The operator enqueues while the loop sleeps — after the startup tick has
          // already looked and found nothing.
          sleep: sleepAdvancingClock((slept) => {
            if (slept === 1) seedQueued(["FG-1"]);
          }),
        },
      }),
    );

    const woken = summary.ticks.filter((t) => t.trigger === "wake");
    assert.equal(woken.length, 1, `nothing woke the dispatcher — it waited for its watchdog. ${fullDump()}`);
    assert.deepEqual(
      woken[0]?.wakes.map((w) => w.kind),
      ["queue_changed"],
      "the signal it acted on is the queue change itself",
    );
    assert.deepEqual(ticketsLaunched(l), ["FG-1"], "the enqueued ticket was launched on the wake");

    const queueWakes = listWakes(PK).filter((w) => w.kind === "queue_changed");
    assert.deepEqual(
      queueWakes.map((w) => w.wakeKey),
      ["ticket:FG-1"],
      "rank + enqueue name ONE subject, so they collapse onto one durable record",
    );
    assert.equal(queueWakes[0]?.state, "consumed", "the wake is consumed exactly once, by the dispatcher that acted");
  });

  test("observes only the claims THIS owner holds", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();
    await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));
    finishRun("FG-1");

    assert.deepEqual(
      observeRunTerminalWakes({ projectKey: PK, owner: "dispatcher@somebody-else" }),
      [],
      "a dispatcher must not narrate transitions under a reservation it does not hold",
    );
  });
});

// ─── a host-scoped slot freed here is a slot freed everywhere ────────────────

describe("FG-591 step 8: releasing a claim under a HOST-scoped ceiling wakes the other projects", () => {
  test("another project's dispatcher gets a durable capacity_changed wake", async () => {
    registerDbProject(PK2);
    acquireDispatcherLease({ projectKey: PK2, owner: "dispatcher@pk2@instance-C", ttlMs: TTL });
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();

    await runDispatcherLoop(
      loopOptions({
        maxTicks: 2,
        maxIterations: 100,
        seams: {
          execution: l.execution,
          sleep: sleepAdvancingClock(() => {
            if (l.launches.length === 1) finishRun("FG-1");
          }),
        },
      }),
    );

    const theirs = listWakes(PK2);
    assert.equal(theirs.length, 1, "the other project must be told exactly once that a host slot freed");
    assert.equal(theirs[0]?.kind, "capacity_changed");
    assert.equal(theirs[0]?.state, "pending", "it is THEIR wake to consume, not ours");
    assert.match(theirs[0]?.detail ?? "", /host-scoped capacity slot was freed/);
  });
});

// ─── the operator's health read ──────────────────────────────────────────────

describe("FG-591 step 8 (D9): a stale or dead dispatcher is surfaced loudly", () => {
  test("no dispatcher at all reads as 'nothing is watching', not as 'nothing to do'", () => {
    seedQueued(["FG-1"]);
    arm();
    const health = dispatcherHealth(PK);
    assert.equal(health.lease.lease, null);
    assert.match(health.alert ?? "", /Nothing is watching/);
  });

  test("an EXPIRED lease is named as dead, with no auto-restart implied", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();
    await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));

    assert.equal(dispatcherHealth(PK).alert, null, "a freshly ticked dispatcher is healthy");

    // The host rebooted: nothing renewed the lease, and time passed.
    clockOffsetMs += TTL * 2;
    setPublicationClockOffsetForTest(clockOffsetMs);

    const health = dispatcherHealth(PK);
    assert.equal(health.lease.expired, true);
    assert.match(health.alert ?? "", /EXPIRED/);
    assert.match(health.alert ?? "", /does NOT auto-restart/);
    assert.equal(health.liveClaims.length, 1, "the reservation survives the dispatcher; a successor adopts it");
  });

  test("is a pure READ — it writes nothing", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();
    await runDispatcherLoop(loopOptions({ seams: { execution: l.execution, sleep: sleepAdvancingClock() } }));

    const before = fullDump();
    dispatcherHealth(PK);
    assert.equal(fullDump(), before, "an operator surface that mutates the thing it reports on is not a report");
  });

  test("the last evaluation is what turns 'nothing is running' into a named reason", async () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });
    const l = launcher();
    await runDispatcherLoop(
      loopOptions({ maxTicks: 2, maxIterations: 80, seams: { execution: l.execution, sleep: sleepAdvancingClock() } }),
    );

    const health = dispatcherHealth(PK);
    assert.ok(health.latestEvaluation, "every tick records one evaluation, including the ones that grant nothing");
    assert.equal(typeof health.nextWatchdogAtMs, "number", "the next health-bound deadline is durable, not recomputed");
    assert.ok((health.nextWatchdogAtMs as number) >= storeNowMs() - WATCHDOG_MS);
  });
});
