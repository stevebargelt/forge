// FG-591 (step 15): a REAL child-process DISPATCHER, for the cross-process cases.
//
// This is NOT a test file (no `.test.ts` suffix, so neither the unit nor the
// integration find picks it up). It is spawned as a genuine OS process by
// fg591-dispatch.integration.test.ts, pointed at ONE shared SQLite store file via
// FORGE_DB_PATH — the src/store/fg610-claim-worker.ts precedent, and for the same
// reason it exists there: every other DB test in this repo runs one process against
// one handle, and SQLite treats BEGIN IMMEDIATE as BEGIN when no other connection
// exists, so claimNextEligible's locking — the thing that makes the ceiling and the
// at-most-one-live-claim invariant hold — is INERT in the unit tier.
//
// ─── WHAT IS REAL HERE, AND WHAT IS SUBSTITUTED ──────────────────────────────
// REAL: the dispatcher loop, its fenced identity, the durable wake path, the
// dispatch cycle, the compatibility hydration and predicate, claimNextEligible, the
// claim lease and its takeover, the launch stamp, the run binding, the release
// vocabulary and the evaluation journal. Every one of those runs as production
// ships it, against a real on-disk store shared with other processes.
//
// SUBSTITUTED: exactly ONE boundary — step 7's ExecutionSeams, the tmux/subprocess
// edge. `forge new` would start a Docker container, and a test that starts thirty of
// them proves nothing it could not prove otherwise. The substitute does what
// `forge new --ticket` actually does to the STORE and nothing more: it records a real
// launch observation through the store's own writer, inserts a real run row carrying
// the ticket association, and (by default) records the run's first task in its own
// worktree along with the dispatch evidence a spawn writes. So run discovery, claim
// binding, the workspace-lane derivation and the In-progress projection all read
// production rows written by production writers.
//
// The argv the dispatcher built is REPORTED rather than discarded: the AC that a
// claimed ticket launches through the ordinary single-ticket run path — and never a
// campaign verb — is checked against the real string this process was handed.
//
// ─── MODES (env MODE) ────────────────────────────────────────────────────────
//   loop   — the long-lived dispatcher: adopt-or-create the fenced identity, consume
//            wakes, heartbeat, reconcile, decide, launch. Bounded by MAX_TICKS /
//            MAX_ITERATIONS and stoppable by a STOP_FILE the parent drops.
//   cycle  — ONE dispatch cycle plus a launch per grant, with NO dispatcher lease.
//            This is the arrangement the lease exists to prevent (several deciders
//            over one queue), and it is exactly the arrangement in which the CLAIM
//            primitive must still admit at most one winner. Used for the K-way race
//            over a single ticket.
//
// Everything is bounded: a file barrier lines the workers up so the contention is
// genuine, every loop carries a hard iteration cap, and no mode can block forever.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, writeTransaction } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { getTicket, recordDispatchEvidence } from "../store/tickets.js";
import { ticketBodyHash } from "../store/queue.js";
import { recordLaunchObservation } from "../store/launch-observations.js";
import { evaluationsFor } from "../store/dispatcher-evidence.js";
import { liveClaims } from "../store/queue-claims.js";
import type { LaunchMeta } from "../v2/launch.js";
import { runDispatchCycle } from "./dispatch-cycle.js";
import { launchClaimedTicket, type ExecutionSeams, type LaunchClaimResult } from "./dispatch-execution.js";
import { resolveDispatcherOwner, runDispatcherLoop, type DispatcherTick } from "./dispatcher-loop.js";

const MODE = process.env["MODE"] ?? "loop";
const WORKER_ID = process.env["WORKER_ID"] ?? "0";
const PROJECT_KEY = process.env["PROJECT_KEY"] ?? "";
const PROJECT_DIR = process.env["PROJECT_DIR"] ?? "";
const WORKFLOW = process.env["WORKFLOW"] ?? "";
const BARRIER_DIR = process.env["BARRIER_DIR"] ?? "";
const GO_FILE = process.env["GO_FILE"] ?? "";
const STOP_FILE = process.env["STOP_FILE"] ?? "";
const MAX_TICKS = Number(process.env["MAX_TICKS"] ?? "1");
const MAX_ITERATIONS = Number(process.env["MAX_ITERATIONS"] ?? "200");
const WATCHDOG_MS = Number(process.env["WATCHDOG_MS"] ?? "600000");
const POLL_MS = Number(process.env["POLL_MS"] ?? "50");
/** How this worker's launched run records its first task: `isolated` gives it its own
 *  worktree (compatibility.ts's isolated lane, which is what makes a second run in the
 *  same repository parallel-safe), `shared` executes against the repo checkout itself,
 *  and `none` leaves the run with no task at all (the window before the first spawn). */
const SEED_TASK = process.env["SEED_TASK"] ?? "isolated";

/** The forge binary prefix a dispatcher would be given. Nothing is executed with it —
 *  the launch seam intercepts — but it is what buildDispatchArgv composes, and the
 *  parent asserts the resulting argv is the ordinary single-ticket run path. */
const FORGE_BIN = [process.execPath, "/opt/forge/dist/cli/index.js"];

export type WorkerLaunch = {
  ticketId: string;
  launchId: string;
  argv: string[];
  cwd: string;
  name: string;
};

export type WorkerReport = {
  workerId: string;
  mode: string;
  projectKey: string;
  owner: string;
  /** Containers this worker actually started — the ONLY evidence that answers "did
   *  the work start", which a claim-row assertion cannot. */
  launched: WorkerLaunch[];
  /** Prior execution this worker ADOPTED instead of starting a second container. */
  adopted: { ticketId: string; launchId: string | null; runId: string | null; detail: string }[];
  /** Grants that ended in no container: an unresolvable target, or a launch that threw. */
  refused: { ticketId: string; kind: string; detail: string }[];
  /** Tickets this worker was granted a claim for. */
  granted: string[];
  /** The durable evaluation reasons THIS worker recorded, oldest first. */
  reasons: string[];
  ticks: { trigger: string; finalReason: string | null; skipped: string | null }[];
  /** Live claims (any owner) as this worker saw them on exit — a sample of the
   *  ceiling from inside the race rather than only after it. */
  liveClaimsOnExit: { ticketId: string; owner: string; projectKey: string }[];
  stopReason: string | null;
  alert: string | null;
  error: string | null;
};

function reportPath(): string {
  return join(BARRIER_DIR, `result-${WORKER_ID}.json`);
}

function report(r: Partial<WorkerReport>): void {
  const full: WorkerReport = {
    workerId: WORKER_ID,
    mode: MODE,
    projectKey: PROJECT_KEY,
    owner: "",
    launched: [],
    adopted: [],
    refused: [],
    granted: [],
    reasons: [],
    ticks: [],
    liveClaimsOnExit: [],
    stopReason: null,
    alert: null,
    error: null,
    ...r,
  };
  mkdirSync(BARRIER_DIR, { recursive: true });
  writeFileSync(reportPath(), JSON.stringify(full));
}

function announceReady(): void {
  mkdirSync(BARRIER_DIR, { recursive: true });
  writeFileSync(join(BARRIER_DIR, `ready-${WORKER_ID}`), "1");
}

/** Bounded barrier: announce readiness, then spin (with a hard cap) until the parent
 *  drops the GO file. No hang — after the cap we proceed anyway. Skipped entirely when
 *  no GO file was named, which is how the uncontended single-worker cases run. */
function awaitGo(): void {
  announceReady();
  if (GO_FILE.length === 0) return;
  const deadline = Date.now() + 30_000;
  while (!existsSync(GO_FILE) && Date.now() < deadline) {
    // tight spin; the window is sub-second in practice
  }
}

// ─── the substituted boundary: what `forge new --ticket` does to the STORE ────

type Launcher = {
  seams: ExecutionSeams;
  launched: WorkerLaunch[];
};

function isoNow(): string {
  return new Date().toISOString();
}

function ticketIdFromArgv(argv: readonly string[]): string {
  const at = argv.indexOf("--ticket");
  return at >= 0 ? (argv[at + 1] ?? "") : "";
}

function makeLauncher(): Launcher {
  const launched: WorkerLaunch[] = [];
  let n = 0;

  const seams: ExecutionSeams = {
    startLaunch: (argv, opts) => {
      n++;
      // Unique ACROSS PROCESSES: two racing workers must never mint the same launch
      // identity, or the store would collapse two containers into one record and the
      // duplicate this suite is looking for would be invisible. The dispatcher mints
      // it now (it is stamped on the claim before this call), so the worker's own
      // counter only labels the record.
      const id = opts.id;
      launched.push({ ticketId: ticketIdFromArgv(argv), launchId: id, argv, cwd: opts.cwd, name: opts.name });
      const meta: LaunchMeta = {
        id,
        command: argv,
        tmuxSession: `forge-${id}`,
        launcherPid: process.pid,
        ownerPid: null,
        startedAt: isoNow(),
        logPath: join(opts.cwd, `${id}.log`),
        cwd: opts.cwd,
      };
      return meta;
    },

    recordLaunchStart: (meta, association) => {
      const runId = `run-w${WORKER_ID}-${association.ticketId}`;
      writeTransaction(() => {
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
        // `forge new` inserts the run BEFORE it exits — that is what binds a
        // reservation to an execution, so the fixture creates one here rather than
        // pretending later. created_at is >= the launch's startedAt, which is the
        // window discoverRunForClaim narrows to.
        insertRun({
          id: runId,
          workflow: WORKFLOW.length > 0 ? WORKFLOW : "feature",
          title: `run for ${association.ticketId}`,
          status: "active",
          createdAt: isoNow(),
          metadata: { ticketId: association.ticketId },
          projectDir: meta.cwd,
        });
        if (SEED_TASK !== "none") seedFirstTask(runId, association.ticketId);
      });
      return true;
    },

    removeLaunch: (id) => {
      writeTransaction(() => {
        getDb()
          .prepare(`UPDATE launch_observations SET terminal = 1, state = 'removed', observed_at = ? WHERE launch_id = ?`)
          .run(isoNow(), id);
      });
    },

    promoteLaunchObservations: () => 0,

    cancelWork: () => {
      throw new Error("cancelWork is not reachable from a dispatch worker — cancellation is an operator verb");
    },
  };

  return { seams, launched };
}

/** The run's FIRST task, written the way src/v2/spawn.ts writes one: the task row,
 *  and — because the task carries a ticket id — the ticket_dispatch_evidence row that
 *  is the ONLY thing In-progress is derived from anywhere in this store. */
function seedFirstTask(runId: string, ticketId: string): void {
  const taskId = `task-w${WORKER_ID}-${ticketId}`;
  const worktree = SEED_TASK === "shared" ? null : join(PROJECT_DIR, ".worktrees", taskId);
  getDb()
    .prepare(
      `INSERT OR IGNORE INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, worktree_path)
       VALUES (?, ?, 'build', 'backend-specialist', 'running', '{}', ?, ?)`,
    )
    .run(taskId, runId, isoNow(), worktree);
  const ticket = getTicket(PROJECT_KEY, ticketId);
  if (ticket) {
    recordDispatchEvidence({
      taskId,
      projectKey: PROJECT_KEY,
      ticketId,
      revision: ticket.revision ?? 1,
      bodyHash: ticketBodyHash(ticket),
      dispatchedAt: isoNow(),
    });
  }
}

// ─── shared reporting ────────────────────────────────────────────────────────

/** Every launch outcome is reported WITH the ticket its grant reserved. The refusal
 *  variants carry no claim of their own, and a refusal report that cannot say which
 *  ticket failed to start is the "nothing started and nothing said why" this ticket
 *  exists to close — so the pairing is kept by the caller, which has both. */
type PairedResult = { ticketId: string; result: LaunchClaimResult };

function classifyLaunchResults(results: readonly PairedResult[]): Pick<WorkerReport, "adopted" | "refused"> {
  const adopted: WorkerReport["adopted"] = [];
  const refused: WorkerReport["refused"] = [];
  for (const { ticketId, result: r } of results) {
    if (r.kind === "adopted") {
      adopted.push({ ticketId: r.claim.ticketId, launchId: r.launchId, runId: r.runId, detail: r.detail });
    } else if (r.kind === "refused") {
      refused.push({ ticketId, kind: r.refusal.kind, detail: r.refusal.message });
    } else if (r.kind === "launch_failed") {
      refused.push({ ticketId, kind: "launch_failed", detail: r.error });
    } else if (r.kind === "already_terminal") {
      refused.push({ ticketId, kind: "already_terminal", detail: r.detail });
    }
  }
  return { adopted, refused };
}

/** The durable reasons THIS owner recorded, oldest first. Read from the journal rather
 *  than accumulated in memory, so the report describes what actually persisted. */
function reasonsFor(owner: string): string[] {
  return evaluationsFor(PROJECT_KEY, { limit: 200 })
    .filter((e) => e.dispatcherOwner === owner)
    .reverse()
    .map((e) => e.reason);
}

function liveClaimSample(): WorkerReport["liveClaimsOnExit"] {
  return liveClaims(PROJECT_KEY).map((c) => ({ ticketId: c.ticketId, owner: c.owner, projectKey: c.projectKey }));
}

// ─── mode: loop ──────────────────────────────────────────────────────────────

async function runLoopMode(owner: string): Promise<void> {
  const launcher = makeLauncher();
  const ticks: WorkerReport["ticks"] = [];
  const launchResults: PairedResult[] = [];
  const granted: string[] = [];

  awaitGo();

  const summary = await runDispatcherLoop({
    projectKey: PROJECT_KEY,
    owner,
    forgeBin: FORGE_BIN,
    watchdogIntervalMs: WATCHDOG_MS,
    wakePollMs: POLL_MS,
    projectDir: PROJECT_DIR,
    ...(WORKFLOW.length > 0 ? { workflow: WORKFLOW } : {}),
    maxTicks: MAX_TICKS,
    maxIterations: MAX_ITERATIONS,
    // A worker is one dispatcher INSTANCE that may be restarted by the parent; an
    // orderly lease release on exit would make every restart a fresh acquisition
    // rather than the adoption these cases are about.
    releaseLeaseOnStop: false,
    ...(STOP_FILE.length > 0 ? { stopWhen: (): boolean => existsSync(STOP_FILE) } : {}),
    seams: {
      execution: launcher.seams,
      onTick: (tick: DispatcherTick) => {
        ticks.push({
          trigger: tick.trigger,
          finalReason: tick.cycle?.finalReason ?? null,
          skipped: tick.skipped,
        });
        // runDispatcherTick launches one per grant, in grant order, so the two lists
        // are index-aligned by construction.
        const grants = tick.cycle?.grants ?? [];
        for (const g of grants) granted.push(g.claim.ticketId);
        tick.launches.forEach((result, i) =>
          launchResults.push({ ticketId: grants[i]?.claim.ticketId ?? "", result }),
        );
      },
    },
  });

  report({
    owner,
    launched: launcher.launched,
    ...classifyLaunchResults(launchResults),
    granted,
    reasons: reasonsFor(owner),
    ticks,
    liveClaimsOnExit: liveClaimSample(),
    stopReason: summary.stopReason,
    alert: summary.alert,
  });
}

// ─── mode: cycle (no dispatcher lease — several deciders, one queue) ─────────

function runCycleMode(owner: string): void {
  const launcher = makeLauncher();
  awaitGo();

  const cycle = runDispatchCycle({ projectKey: PROJECT_KEY, owner, generation: null });
  const launchResults: PairedResult[] = [];
  for (const grant of cycle.grants) {
    launchResults.push({
      ticketId: grant.claim.ticketId,
      result: launchClaimedTicket({
        claim: grant.claim,
        forgeBin: FORGE_BIN,
        takenOverFrom: grant.takenOverFrom,
        projectDir: PROJECT_DIR,
        ...(WORKFLOW.length > 0 ? { workflow: WORKFLOW } : {}),
        dispatcherOwner: owner,
        dispatcherGeneration: null,
        seams: launcher.seams,
      }),
    });
  }

  report({
    owner,
    launched: launcher.launched,
    ...classifyLaunchResults(launchResults),
    granted: cycle.grants.map((g) => g.claim.ticketId),
    reasons: reasonsFor(owner),
    ticks: [{ trigger: "cycle", finalReason: cycle.finalReason, skipped: null }],
    liveClaimsOnExit: liveClaimSample(),
    stopReason: "max_ticks",
  });
}

// ─── entry ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // The instance-stable identity, resolved exactly as production resolves it. A
  // worker with no declared id must FAIL rather than invent one — that refusal is
  // itself part of what step 8 shipped, and papering over it here would let a test
  // pass against a dispatcher that cannot be fenced.
  const resolved = resolveDispatcherOwner(PROJECT_KEY, process.env);
  if (!resolved.ok) {
    report({ error: resolved.error });
    return;
  }
  if (MODE === "cycle") {
    runCycleMode(resolved.owner);
    return;
  }
  await runLoopMode(resolved.owner);
}

try {
  await main();
} catch (e) {
  // A worker that dies silently is a worker whose absence the parent reads as "it
  // claimed nothing", which is the same shape as a green result. Report, then exit
  // non-zero so the parent surfaces the failure rather than asserting against it.
  report({ error: `${(e as Error).message}\n${(e as Error).stack ?? ""}` });
  process.exitCode = 1;
}
