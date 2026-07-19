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
  type NextAction,
} from "../store/continuations.js";
import { runByDispatchKey, getRun } from "../store/runs.js";
import { listLostSignalRecoveries, lostSignalRecoveriesFor } from "../store/continuation-lost-signal.js";
import { renderLostSignals } from "../cli/commands/lost-signals.js";
import {
  consumeContinuation,
  recoverInFlightDispatches,
  LOST_SIGNAL_WATCHDOG_INTERVAL_MS,
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
