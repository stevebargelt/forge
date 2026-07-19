// FG-563 (Slice 4) — test-engineer FALSIFICATION + integration regressions for the
// orchestrator continuation-CONSUMER, exercised on the REAL consumer path.
//
// The engineer's self-validation (continuation-consumer.integration.test.ts) injects
// stub seams for the two hardest-to-fake boundaries — the canonical launch reader
// (`reader(TERMINAL)`) and the physical dispatch (`insertRun` shim). That is fine for
// unit-shaping the branch logic, but the brief is explicit:
//
//   "Tests must run on the REAL consumer path (real readLaunch/classifyExit, real
//    continuations store rows, real run-creation), NOT simplified fixtures. A test
//    exercising the primitive in isolation does NOT satisfy these AC."
//
// So this file drives the consumer with:
//   • the REAL `readLaunch` / `classifyExit` — actual launch records written to disk
//     under LAUNCHES_DIR, classified by the production reader, tmux never faked; and
//   • the REAL run-creation path — `startRun` stamping the F17 dispatch receipt into
//     run metadata, discovered back by the REAL `runByDispatchKey` for adopt-not-
//     duplicate.
//
// Each test uses UNIQUE launch/continuation ids and writes a clean launch dir, because
// LAUNCHES_DIR is a shared on-disk location (a leftover `exit` file from a sibling test
// would otherwise make a "running" fixture read terminal).
//
// Every assertion below was OBSERVED RED against a deliberately-broken consumer before
// it was green (see the run's result.json `notes` for the red-before-green log): the
// BD-3 re-read guard, the still-running re-arm, the F17 adopt-not-duplicate lookup, and
// the watchdog lost-signal discipline were each reverted in turn and this suite caught
// each one.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  getDb,
  closeDb,
  applyMigrations,
  assertSchemaVersionSupported,
  setDbForTest,
  SCHEMA_VERSION,
} from "../store/db.js";
import { SCHEMA_SQL } from "../store/schema.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import { FORGE_HOME } from "../util/paths.js";
import {
  recordContinuation,
  getContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  continuationsInDispatch,
  recordDispatchResult,
  renewClaim,
  type NextAction,
} from "../store/continuations.js";
import { runByDispatchKey, getRun } from "../store/runs.js";
import { listLostSignalRecoveries, lostSignalRecoveriesFor } from "../store/continuation-lost-signal.js";
import { renderLostSignals } from "../cli/commands/lost-signals.js";
import {
  consumeContinuation,
  recoverInFlightDispatches,
  LOST_SIGNAL_WATCHDOG_INTERVAL_MS,
  DEFAULT_CLAIM_LEASE_MS,
  type ContinuationIdentity,
  type PhysicalDispatch,
} from "./continuation-consumer.js";
import { LAUNCHES_DIR, type WaitOutcome, type LaunchView } from "./launch.js";
import { WorkflowSchema, type Workflow } from "./schema.js";
import { startRun } from "./startRun.js";

// A per-test file-backed db under the process temp FORGE_HOME, exactly as the
// engineer's suite bootstraps it (real schema, real migrations, real store).
function freshDb(name: string): () => void {
  const path = join(FORGE_HOME, name);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, SCHEMA_VERSION);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  const prev = setDbForTest(db);
  return () => {
    setPublicationClockOffsetForTest(0);
    db.close();
    if (prev) setDbForTest(prev);
    else closeDb();
  };
}

const NEXT: NextAction = { kind: "start_run", workflow: "feature", title: "next phase" };

// A per-test scope binding a UNIQUE continuation + launch id, so the shared
// on-disk LAUNCHES_DIR and the store never bleed between tests.
type Scope = { cid: string; lid: string; identity: (over?: Partial<ContinuationIdentity>) => ContinuationIdentity };
function scope(tag: string): Scope {
  const cid = `cont-${tag}`;
  const lid = `launch-${tag}`;
  return {
    cid,
    lid,
    identity: (over = {}) => ({
      continuationId: cid,
      sourceLaunchId: lid,
      consumerKind: "orchestrator",
      currentPhase: "build",
      nextAction: NEXT,
      ...over,
    }),
  };
}

function seedContinuation(s: Scope): void {
  recordContinuation({
    continuationId: s.cid,
    consumerKind: "orchestrator",
    sourceLaunchId: s.lid,
    currentPhase: "build",
    nextAction: NEXT,
  });
}

// ── REAL launch records on disk, read by the production readLaunch ────────────
// A terminal launch: meta.json + a parseable `exit` file. readLaunch reads the
// exit record and runs classifyExit — the tmux/owner path is never touched, so
// this is the genuine canonical reader with no fake. The dir is wiped first so a
// sibling test's leftover `exit` file can never contaminate a fresh fixture.
function writeLaunch(id: string, over: Record<string, unknown> = {}): string {
  const dir = join(LAUNCHES_DIR, id);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const meta = {
    id,
    command: ["echo", "hi"],
    tmuxSession: `forge-${id}`,
    launcherPid: process.pid,
    ownerPid: process.pid,
    startedAt: "2026-07-19T00:00:00Z",
    logPath: join(dir, "log"),
    cwd: "/tmp",
    ...over,
  };
  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
  return dir;
}

/** A genuinely-terminal launch — a real `exit` record classifyExit reads. */
function writeTerminalLaunch(id: string, exitRaw: string): void {
  const dir = writeLaunch(id);
  writeFileSync(join(dir, "exit"), exitRaw);
}

/** A genuinely-RUNNING launch, with NO tmux dependency: `starting: true` + a LIVE
 *  launcherPid (this process) makes readLaunch classify `running` off the record
 *  alone. No exit file, so it is honestly still executing. */
function writeRunningLaunch(id: string): void {
  writeLaunch(id, { starting: true, launcherPid: process.pid });
}

/** Guarantee no launch record exists on disk for this id (the absent case). */
function removeLaunch(id: string): void {
  rmSync(join(LAUNCHES_DIR, id), { recursive: true, force: true });
}

// A minimal but SCHEMA-VALID workflow so `startRun` (the real run-creation
// function the `forge continue` command wires) is exercised for real — not a hand
// fabricated object.
const TEST_WORKFLOW: Workflow = WorkflowSchema.parse({
  name: "feature",
  description: "continuation-consumer real-path test workflow",
  steps: [{ id: "build", agent: "engineer" }],
});

// A dispatcher that runs the REAL run-creation path: startRun stamps the receipt
// into run metadata (the CP2 F17 bridge) exactly as the production cliDispatch
// does, minus the docker-spawning runNext. Counts its real invocations.
function realDispatcher() {
  const runIds: string[] = [];
  const fn: PhysicalDispatch = (args) => {
    const { runId } = startRun({
      workflow: TEST_WORKFLOW,
      title: "next phase",
      inputs: {},
      projectDir: "/tmp/p",
      dispatchKey: args.dispatchKey,
    });
    runIds.push(runId);
    return { runId };
  };
  return { fn, runIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// BD-3: the consumer re-reads the AUTHORITATIVE record — a fabricated/stale wake
// hint can NEVER drive an advance. Proven against the REAL readLaunch.
// ─────────────────────────────────────────────────────────────────────────────

test("BD-3 (real reader): a delivery wake whose REAL launch record is still running never advances", () => {
  const done = freshDb("fg563-rp-bd3-running.db");
  const s = scope("bd3run");
  try {
    seedContinuation(s);
    writeRunningLaunch(s.lid); // the real record says: still executing
    const d = realDispatcher();
    // A "delivery" wake means something told the controller the launch completed.
    // The consumer must ignore that hint and re-read the canonical record itself.
    const out = consumeContinuation(s.identity(), { owner: "ctl", dispatch: d.fn });
    assert.equal(out.kind, "rearmed");
    assert.equal(out.kind === "rearmed" ? out.reason : "", "still_running");
    assert.equal(d.runIds.length, 0, "no real run created off a still-running record");
    assert.equal(getContinuation(s.cid)?.state, "awaiting_completion", "slot never promoted");
  } finally {
    done();
  }
});

test("BD-3 (real reader): a fabricated 'terminal' waitOutcome is ignored — the real running record wins", () => {
  const done = freshDb("fg563-rp-bd3-fabricated.db");
  const s = scope("bd3fab");
  try {
    seedContinuation(s);
    writeRunningLaunch(s.lid);
    const d = realDispatcher();
    // The waiter hands over a FABRICATED terminal view. BD-3: the consumer never
    // ingests the waiter's view as truth — it re-reads the authoritative record,
    // which is still running, and declines to advance.
    const fabricated: WaitOutcome = {
      kind: "terminal",
      view: { id: s.lid, status: { state: "exited_ok", code: 0 } } as unknown as LaunchView,
    };
    const out = consumeContinuation(s.identity(), { owner: "ctl", dispatch: d.fn, waitOutcome: fabricated });
    assert.equal(out.kind, "rearmed", "the fabricated terminal did NOT advance — the real record is running");
    assert.equal(d.runIds.length, 0, "nothing dispatched on a fabricated terminal");
    assert.equal(getContinuation(s.cid)?.state, "awaiting_completion");
  } finally {
    done();
  }
});

test("BD-3 (real reader): an absent launch record re-arms as unknown_launch, never advances", () => {
  const done = freshDb("fg563-rp-bd3-absent.db");
  const s = scope("bd3absent");
  try {
    seedContinuation(s);
    removeLaunch(s.lid); // no launch record on disk at all
    const d = realDispatcher();
    const out = consumeContinuation(s.identity(), { owner: "ctl", dispatch: d.fn });
    assert.equal(out.kind, "rearmed");
    assert.equal(out.kind === "rearmed" ? out.reason : "", "unknown_launch");
    assert.equal(d.runIds.length, 0);
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Terminal advance over the REAL reader + REAL run-creation, across the full
// canonical LaunchStatus vocabulary (classifyExit), not just exited_ok.
// ─────────────────────────────────────────────────────────────────────────────

for (const [label, exitRaw] of [
  ["exited_ok", `{"code":0,"signal":null}`],
  ["exited_error", `{"code":1,"signal":null}`],
  ["signaled", `{"code":null,"signal":"SIGKILL"}`],
] as const) {
  test(`terminal advance (real classifyExit): a ${label} launch advances and creates exactly one real run`, () => {
    const done = freshDb(`fg563-rp-advance-${label}.db`);
    const s = scope(`adv-${label.replace(/_/g, "-")}`);
    try {
      seedContinuation(s);
      writeTerminalLaunch(s.lid, exitRaw);
      const d = realDispatcher();
      const out = consumeContinuation(s.identity(), { owner: "ctl", dispatch: d.fn });
      assert.equal(out.kind, "advanced", `a ${label} disposition is terminal and advances`);
      assert.equal(d.runIds.length, 1, "exactly one real run created");
      const c = getContinuation(s.cid);
      assert.equal(c?.state, "advanced");
      // The run created by the REAL startRun is discoverable by the REAL receipt.
      assert.ok(out.kind === "advanced" && out.dispatchKey, "an advance carries the receipt");
      if (out.kind === "advanced") {
        const run = runByDispatchKey(out.dispatchKey);
        assert.equal(run?.id, d.runIds[0], "runByDispatchKey resolves the real run created under the receipt");
        assert.equal(getRun(d.runIds[0]!)?.metadata?.["dispatchKey"], out.dispatchKey, "receipt stamped in run metadata");
      }
      assert.equal(lostSignalRecoveriesFor(s.cid).length, 0, "normal delivery writes NO lost-signal row");
    } finally {
      done();
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// F13/F14 on the real path: a duplicate delivery wake yields ONE claim, ONE real
// run; the loser observes advanced state and creates nothing.
// ─────────────────────────────────────────────────────────────────────────────

test("F13 (real path): a duplicate delivery wake creates exactly one real run; the loser sees advanced", () => {
  const done = freshDb("fg563-rp-f13.db");
  const s = scope("f13");
  try {
    seedContinuation(s);
    writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
    const d = realDispatcher();
    const first = consumeContinuation(s.identity(), { owner: "ctl-A", dispatch: d.fn });
    const second = consumeContinuation(s.identity(), { owner: "ctl-B", dispatch: d.fn });
    assert.equal(first.kind, "advanced");
    assert.equal(second.kind, "already_advanced", "the duplicate wake does nothing");
    assert.equal(d.runIds.length, 1, "exactly one real run across both wakes — no duplicate dispatch");
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F17 crash-after-spawn recovery on the REAL run-creation + REAL runByDispatchKey:
// the recovery ADOPTS the original real run rather than re-running startRun.
// ─────────────────────────────────────────────────────────────────────────────

test("F17 (real path): restart-replay ADOPTS the original real run via runByDispatchKey — never re-runs startRun", () => {
  const done = freshDb("fg563-rp-f17.db");
  const s = scope("f17");
  try {
    // Build the genuine crash-after-spawn-before-record window on the real primitives.
    seedContinuation(s);
    writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
    observeLaunchStatus(s.cid, s.lid, "exited_ok");
    const claim = claimContinuationDispatch({
      continuationId: s.cid,
      sourceLaunchId: s.lid,
      consumerKind: "orchestrator",
      currentPhase: "build",
      nextAction: NEXT,
      expectedState: "ready",
      owner: "crashed-ctl",
      leaseTtlMs: 1000,
    });
    assert.ok(claim.granted);
    const receipt = getContinuation(s.cid)!.dispatchKey!;
    // The physical run was created by the REAL startRun under the receipt — then the
    // controller crashed before recordDispatchResult/markAdvanced.
    const { runId: originalRunId } = startRun({
      workflow: TEST_WORKFLOW,
      title: "next phase",
      inputs: {},
      projectDir: "/tmp/p",
      dispatchKey: receipt,
    });
    assert.equal(getContinuation(s.cid)?.state, "dispatching", "slot stuck mid-dispatch");
    assert.equal(continuationsInDispatch({ consumerKind: "orchestrator" }).length, 1);

    // Age past the crashed controller's lease so a fresh controller may take over.
    setPublicationClockOffsetForTest(5000);

    const d = realDispatcher();
    const recovered = recoverInFlightDispatches({ owner: "recoverer", dispatch: d.fn });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0]!.kind, "advanced");
    assert.equal(recovered[0]!.kind === "advanced" ? recovered[0]!.adopted : false, true, "ADOPTED, not spawned");
    assert.equal(d.runIds.length, 0, "startRun was NOT called again on recovery");
    const c = getContinuation(s.cid);
    assert.equal(c?.state, "advanced");
    assert.equal(c?.dispatchedRunId, originalRunId, "the ORIGINAL real run was adopted");
    // Sanity: only ONE run in the store carries this receipt.
    assert.equal(runByDispatchKey(receipt)?.id, originalRunId);
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F19 / F22: no model wake / advance inferred from job DURATION. The watchdog
// interval is a FIXED health cadence, and a launch that has "run" arbitrarily long
// still produces NO advance until its record is genuinely terminal.
// ─────────────────────────────────────────────────────────────────────────────

test("F19: the watchdog interval is a FIXED health constant, never sized from a job estimate", () => {
  // A duration-derived wake would need the interval to be a function of the job; it
  // is a module constant (30 min). This is the structural guarantee that no
  // fixed-estimate wake is scheduled from a guessed job duration.
  assert.equal(LOST_SIGNAL_WATCHDOG_INTERVAL_MS, 30 * 60 * 1000);
  assert.equal(typeof LOST_SIGNAL_WATCHDOG_INTERVAL_MS, "number");
});

test("F19/F22 (real path): a long-running launch produces NO advance and NO wake inference on any wake", () => {
  const done = freshDb("fg563-rp-f19.db");
  const s = scope("f19");
  try {
    seedContinuation(s);
    writeRunningLaunch(s.lid); // still executing, however long it has been
    const d = realDispatcher();
    // Even a watchdog fire (the only timer in play) over a still-running launch does
    // nothing but re-arm — it neither advances nor infers a timeout/fairness verdict
    // from how long the job has run, and writes no lost-signal row.
    const wd = consumeContinuation(s.identity(), { owner: "wd", trigger: "watchdog", dispatch: d.fn });
    assert.equal(wd.kind, "rearmed");
    assert.equal(wd.kind === "rearmed" ? wd.reason : "", "still_running");
    assert.equal(d.runIds.length, 0, "no advance from duration");
    assert.equal(lostSignalRecoveriesFor(s.cid).length, 0, "a still-running watchdog fire is NOT a lost signal");
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// CP5 / F18 watchdog discipline on the real path, plus the OPERATOR surface end
// to end: a real terminal launch, recovered by the watchdog, is answerable via
// `forge lost-signals` — which controller, which launch, recovered-by-watchdog.
// ─────────────────────────────────────────────────────────────────────────────

test("CP5 (real path): a watchdog recovering a terminal-but-unadvanced real launch writes exactly one operator-answerable row", () => {
  const done = freshDb("fg563-rp-cp5.db");
  const s = scope("cp5");
  try {
    seedContinuation(s);
    writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
    const d = realDispatcher();
    const out = consumeContinuation(s.identity(), { owner: "wd-7", trigger: "watchdog", dispatch: d.fn });
    assert.equal(out.kind, "advanced");
    assert.equal(out.kind === "advanced" ? out.lostSignalRecovered : false, true);
    assert.equal(d.runIds.length, 1, "the recovered work created its real run");

    // Operator surface, end to end over the real stored row.
    const rows = listLostSignalRecoveries({ consumerKind: "orchestrator" });
    assert.equal(rows.length, 1, "exactly one lost-signal recovery row");
    const human = renderLostSignals(rows, false);
    assert.match(human, /1 lost-signal recovery/);
    assert.match(human, /controller=wd-7/, "answers WHICH controller — without transcript archaeology");
    assert.match(human, new RegExp(`launch=${s.lid}`), "answers WHICH launch");
    assert.match(human, /recovered-by=watchdog/, "answers recovered-by-watchdog vs normal delivery");
    assert.match(human, /status=exited_ok/, "carries the authoritative disposition");
  } finally {
    done();
  }
});

test("F18 (real path): a watchdog firing AFTER a normal delivery advanced writes NO false lost-signal row", () => {
  const done = freshDb("fg563-rp-f18.db");
  const s = scope("f18");
  try {
    seedContinuation(s);
    writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
    const d = realDispatcher();
    // Normal delivery advances first (no lost signal).
    const delivered = consumeContinuation(s.identity(), { owner: "ctl", dispatch: d.fn });
    assert.equal(delivered.kind, "advanced");
    // A watchdog re-fires later over the same terminal record.
    const wd = consumeContinuation(s.identity(), { owner: "wd", trigger: "watchdog", dispatch: d.fn });
    assert.equal(wd.kind, "already_advanced", "the watchdog does nothing over already-advanced work");
    assert.equal(d.runIds.length, 1, "no duplicate real run");
    assert.equal(lostSignalRecoveriesFor(s.cid).length, 0, "NO false lost-signal claim (F18)");
    assert.equal(listLostSignalRecoveries().length, 0, "the operator surface shows no phantom recovery");
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX B (round 2): two same-host controllers share the default owner
// (orchestrator@HOSTNAME) and both pass the same-owner re-adoption check, so a
// DB-level guard is the only thing that stops both from spawning a physical run
// under the SAME continuation dispatch_key. The runs UNIQUE(dispatch_key) index
// makes the second insert COLLIDE; the consumer catches that and ADOPTS the
// existing run instead of duplicating (F14/F17). Exercised on the REAL run-creation
// path + the REAL unique index — the collision below is a genuine SQLITE_CONSTRAINT.
// ─────────────────────────────────────────────────────────────────────────────

test("FIX B (real path): a same-receipt insert COLLISION makes the loser ADOPT the winner's run — exactly one physical run", () => {
  const done = freshDb("fg563-rp-fixb.db");
  const s = scope("fixb");
  try {
    seedContinuation(s);
    writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
    // Model the two-controller race INSIDE the dispatch seam: the concurrent WINNER
    // has already inserted its physical run under this receipt (committed, discoverable
    // by the key); OUR insert under the SAME receipt then hits the REAL runs
    // UNIQUE(dispatch_key) index and throws — proving the exactly-one guarantee.
    const winnerRunIds: string[] = [];
    let ourInsertAttempts = 0;
    const dispatch: PhysicalDispatch = (args) => {
      const winner = startRun({
        workflow: TEST_WORKFLOW,
        title: "next phase",
        inputs: {},
        projectDir: "/tmp/p",
        dispatchKey: args.dispatchKey,
      });
      winnerRunIds.push(winner.runId);
      ourInsertAttempts++;
      // Our duplicate insert under the SAME receipt collides on the real UNIQUE index.
      startRun({
        workflow: TEST_WORKFLOW,
        title: "next phase",
        inputs: {},
        projectDir: "/tmp/p",
        dispatchKey: args.dispatchKey,
      });
      return { runId: "unreachable" };
    };

    const out = consumeContinuation(s.identity(), { owner: "orchestrator@host", dispatch });

    // Post-fix: the collision is caught, the winner's run adopted, the slot advances.
    assert.equal(out.kind, "advanced", "the collision loser ADOPTS the winner's run rather than blocking");
    assert.equal(winnerRunIds.length, 1, "exactly one physical run was created under the receipt");
    assert.equal(ourInsertAttempts, 1, "our duplicate insert was attempted and rejected by the UNIQUE index");
    const c = getContinuation(s.cid);
    assert.equal(c?.state, "advanced");
    assert.equal(c?.dispatchedRunId, winnerRunIds[0], "the WINNER's run was adopted — no duplicate spawned");
    if (out.kind === "advanced") {
      assert.equal(runByDispatchKey(out.dispatchKey)?.id, winnerRunIds[0], "exactly one run resolves by the receipt");
    }
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX C (round 2, F18): a watchdog that has LOST its claim lease must write NO
// lost-signal recovery row and take NO action. The pre-fix path renewed its lease
// WITHOUT checking the result, then fired the audit hook (a separate transaction)
// before the owner-scoped markAdvanced failed — leaving a FALSE recovery record for
// an advance that never happened. Exercised with a GENUINE lease takeover on the
// real primitive: a concurrent controller steals the lease mid-dispatch.
// ─────────────────────────────────────────────────────────────────────────────

test("FIX C (real path): a watchdog that LOST its lease mid-dispatch writes NO lost-signal row and does not advance", () => {
  const done = freshDb("fg563-rp-fixc.db");
  const s = scope("fixc");
  try {
    seedContinuation(s);
    writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
    // The watchdog (wd-A) wins the fresh claim, then — in the window between winning
    // the claim and the settling renew — a CONCURRENT controller (wd-B) GENUINELY
    // takes the lease over on the real primitive (wd-A's lease is aged out). So when
    // control returns, wd-A's owner-scoped renewClaim genuinely returns false.
    let mineRunId = "";
    const dispatch: PhysicalDispatch = (args) => {
      const mine = startRun({
        workflow: TEST_WORKFLOW,
        title: "next phase",
        inputs: {},
        projectDir: "/tmp/p",
        dispatchKey: args.dispatchKey,
      });
      mineRunId = mine.runId;
      // Age past wd-A's lease and let wd-B take the in-flight claim over for real.
      setPublicationClockOffsetForTest(DEFAULT_CLAIM_LEASE_MS + 5000);
      const takeover = claimContinuationDispatch({
        continuationId: s.cid,
        sourceLaunchId: s.lid,
        consumerKind: "orchestrator",
        currentPhase: "build",
        nextAction: NEXT,
        expectedState: "dispatching",
        owner: "wd-B",
        leaseTtlMs: 60_000,
      });
      assert.ok(takeover.granted, "a concurrent controller genuinely took the lease over");
      return { runId: mine.runId };
    };

    const out = consumeContinuation(s.identity(), { owner: "wd-A", trigger: "watchdog", dispatch });

    assert.equal(out.kind, "lost_claim", "the lease-losing watchdog takes no advance action");
    // THE fix: no false lost-signal recovery row is written under a lost lease.
    assert.equal(lostSignalRecoveriesFor(s.cid).length, 0, "NO false lost-signal recovery row (F18)");
    assert.equal(listLostSignalRecoveries().length, 0, "the operator surface shows no phantom recovery");
    const c = getContinuation(s.cid);
    assert.notEqual(c?.state, "advanced", "wd-A did NOT advance the slot under a lost lease");
    assert.equal(c?.claimOwner, "wd-B", "the genuine winner (wd-B) owns the slot");
    assert.ok(mineRunId, "the dispatch itself did run");
  } finally {
    done();
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// FG-563 fixer round 3 — HIGH-3: CODE-ENFORCED controller identity + REAL fencing.
//
// The round-2 default owner was orchestrator@HOSTNAME — STABLE PER HOST. Two same-host
// orchestrator sessions therefore resolved to the SAME owner, so the owner-scoped
// primitives (claim/renew) could not fence them: a losing watchdog could still write a
// false continuation_lost_signal_recoveries row (F18 violation). The fix makes the owner
// identify the CONTROLLER, never the host (resolveControllerOwner in continue.ts), and
// FAILS CLOSED rather than falling back to a host-stable value. With DISTINCT unique
// owners, the round-2 lease/fencing logic below ACTUALLY fences.
//
// "Restart" semantics being proven:
//   • Repeated `forge continue` PROCESSES in ONE session share that session's owner and
//     re-adopt their own in-flight dispatch.
//   • A NEW session after a crash is a DIFFERENT owner: it may not impersonate the old
//     one — only TAKE OVER after the previous lease EXPIRES.
// All exercised on the REAL primitives (claim/renew/adopt/advance) + REAL run-creation.

/** Build a genuine mid-dispatch (claimed, real run recorded, un-advanced) slot owned
 *  by `owner` with a `leaseTtlMs` lease — the crash/in-flight window on real primitives.
 *  Returns the original run id created under the receipt. */
function midDispatch(s: Scope, owner: string, leaseTtlMs = 60_000): string {
  seedContinuation(s);
  writeTerminalLaunch(s.lid, `{"code":0,"signal":null}`);
  observeLaunchStatus(s.cid, s.lid, "exited_ok");
  const claim = claimContinuationDispatch({
    continuationId: s.cid,
    sourceLaunchId: s.lid,
    consumerKind: "orchestrator",
    currentPhase: "build",
    nextAction: NEXT,
    expectedState: "ready",
    owner,
    leaseTtlMs,
  });
  assert.ok(claim.granted, "the mid-dispatch claim was granted");
  const receipt = getContinuation(s.cid)!.dispatchKey!;
  const { runId } = startRun({
    workflow: TEST_WORKFLOW,
    title: "next phase",
    inputs: {},
    projectDir: "/tmp/p",
    dispatchKey: receipt,
  });
  assert.ok(recordDispatchResult(s.cid, owner, { runId }), "the physical run id is recorded under the owner");
  assert.equal(getContinuation(s.cid)!.state, "dispatching", "slot is mid-dispatch (claimed, un-advanced)");
  return runId;
}

test("HIGH-3 (real path): two invocations from ONE session (same owner) RE-ADOPT the same in-flight dispatch; a mutant ephemeral owner is fenced from its own work (RED)", () => {
  const done = freshDb("fg563-rp-h3-readopt.db");
  const s = scope("h3readopt");
  try {
    const runId = midDispatch(s, "session-X@host");
    const d = realDispatcher();

    // RED baseline: if each `forge continue` invocation resolved to a DIFFERENT
    // (ephemeral/random) owner instead of the STABLE session id, the second invocation
    // could not re-adopt its OWN in-flight dispatch — a live lease it does not own is
    // unclaimable, so it would be wrongly fenced from its own work and dispatch nothing.
    const mutant = consumeContinuation(s.identity(), { owner: "ephemeral-92af", dispatch: d.fn });
    assert.equal(mutant.kind, "lost_claim", "FALSIFICATION: a non-stable owner is fenced from its OWN in-flight dispatch");
    assert.equal(d.runIds.length, 0, "and dispatches nothing");
    assert.equal(getContinuation(s.cid)?.claimOwner, "session-X@host", "the mutant did not steal the live lease");

    // GREEN: the SAME session owner (repeated `forge continue` PROCESS, one logical
    // controller) re-adopts the in-flight dispatch and settles it — no duplicate run.
    const out = consumeContinuation(s.identity(), { owner: "session-X@host", dispatch: d.fn });
    assert.equal(out.kind, "advanced");
    assert.equal(out.kind === "advanced" ? out.adopted : false, true, "re-adopted, not re-dispatched");
    assert.equal(d.runIds.length, 0, "startRun not called again — the original run is adopted");
    assert.equal(getContinuation(s.cid)?.dispatchedRunId, runId, "the ORIGINAL run is the one advanced");
  } finally {
    done();
  }
});

test("HIGH-3 (real path): two same-host sessions with DISTINCT owners FENCE each other — neither claims the other's LIVE dispatch", () => {
  const done = freshDb("fg563-rp-h3-fence.db");
  const s = scope("h3fence");
  try {
    midDispatch(s, "session-A@host"); // A holds a LIVE lease mid-dispatch
    const d = realDispatcher();
    const out = consumeContinuation(s.identity(), { owner: "session-B@host", dispatch: d.fn });
    assert.equal(out.kind, "lost_claim", "session-B cannot take A's LIVE dispatch");
    assert.equal(d.runIds.length, 0, "B dispatches nothing");
    const c = getContinuation(s.cid);
    assert.equal(c?.claimOwner, "session-A@host", "A still owns the live lease — B did not impersonate it");
    assert.equal(c?.state, "dispatching", "the slot is unchanged");
  } finally {
    done();
  }
});

test("HIGH-3 (primitive): a replacement session CANNOT renew the previous session's LIVE lease (owner-scoped renewClaim fails — no impersonation)", () => {
  const done = freshDb("fg563-rp-h3-renew-live.db");
  const s = scope("h3renewlive");
  try {
    midDispatch(s, "session-A@host", 60_000);
    const before = getContinuation(s.cid)!;
    // A replacement session (different owner) tries to renew A's LIVE lease.
    assert.equal(renewClaim(s.cid, "session-B@host", 60_000), false, "a different owner cannot renew a lease it does not hold");
    const after = getContinuation(s.cid)!;
    assert.equal(after.claimOwner, "session-A@host", "ownership is unchanged — no impersonation");
    assert.equal(after.claimExpiresAt, before.claimExpiresAt, "the impostor did not extend the lease");
    // The TRUE owner (same session) renews its OWN lease — the re-adoption path.
    assert.equal(renewClaim(s.cid, "session-A@host", 60_000), true, "the true owner renews its own lease");
  } finally {
    done();
  }
});

test("HIGH-3 (real path): a replacement session CAN take over ONLY after the previous lease EXPIRES — then adopts the original run, no duplicate", () => {
  const done = freshDb("fg563-rp-h3-expiry.db");
  const s = scope("h3expiry");
  try {
    const runId = midDispatch(s, "session-A@host", 1000); // short lease
    const d = realDispatcher();
    // Before expiry: a LIVE lease blocks the replacement.
    const early = consumeContinuation(s.identity(), { owner: "session-B@host", dispatch: d.fn });
    assert.equal(early.kind, "lost_claim", "a LIVE lease blocks the replacement session");
    assert.equal(getContinuation(s.cid)?.claimOwner, "session-A@host", "A still owns it pre-expiry");

    // After the lease expires, the replacement legitimately takes over.
    setPublicationClockOffsetForTest(5000);
    const out = consumeContinuation(s.identity(), { owner: "session-B@host", dispatch: d.fn });
    assert.equal(out.kind, "advanced", "after expiry the replacement takes over via the normal claim path");
    assert.equal(out.kind === "advanced" ? out.adopted : false, true, "and ADOPTS the original run");
    assert.equal(d.runIds.length, 0, "no second run dispatched");
    assert.equal(getContinuation(s.cid)?.dispatchedRunId, runId, "the original run is the one advanced");
    assert.equal(getContinuation(s.cid)?.claimOwner, "session-B@host", "B legitimately owns it post-expiry");
  } finally {
    done();
  }
});

test("HIGH-3 (real path): the LOSING watchdog (distinct owner vs the live holder) writes NO lost-signal row; a host-stable owner collision WOULD (RED)", () => {
  const done = freshDb("fg563-rp-h3-losing-wd.db");
  try {
    // RED baseline: under the round-2 host-stable owner the watchdog resolves to the
    // SAME owner as the live holder, so it is NOT fenced — it re-adopts and (being a
    // watchdog) writes a lost-signal recovery row it never legitimately won.
    const red = scope("h3wdred");
    midDispatch(red, "orchestrator@HOSTNAME", 60_000);
    const dr = realDispatcher();
    const collided = consumeContinuation(red.identity(), { owner: "orchestrator@HOSTNAME", trigger: "watchdog", dispatch: dr.fn });
    assert.equal(collided.kind, "advanced", "a same-owner watchdog is NOT fenced (the host-stable defect)");
    assert.equal(lostSignalRecoveriesFor(red.cid).length, 1, "FALSIFICATION: the host-stable collision let a watchdog write a lost-signal row");

    // GREEN: with DISTINCT session owners the watchdog is fenced by the live lease and
    // writes NOTHING — the F18 promise the code-enforced identity restores.
    const green = scope("h3wdgreen");
    midDispatch(green, "session-A@host", 60_000);
    const dg = realDispatcher();
    const out = consumeContinuation(green.identity(), { owner: "session-B@host", trigger: "watchdog", dispatch: dg.fn });
    assert.equal(out.kind, "lost_claim", "the distinct-owner watchdog loses the live lease");
    assert.equal(lostSignalRecoveriesFor(green.cid).length, 0, "NO false lost-signal recovery row (F18)");
    assert.equal(dg.runIds.length, 0, "and it dispatches nothing");
  } finally {
    done();
  }
});
