// FG-562 verify: a REAL child-process worker for the cross-process CAS coverage.
//
// This is NOT a test file (no `.test.ts` suffix, so neither the unit nor the
// integration find picks it up). It is spawned as a genuine OS process by
// fg562-continuation-claim.integration.test.ts, pointed at ONE shared SQLite store
// file via FORGE_DB_PATH, so `claimContinuationDispatch`'s BEGIN IMMEDIATE locking
// is exercised across real process boundaries rather than in-process only.
//
// Modes (env MODE):
//   race        — attempt to claim continuations stress-0..N-1 through the REAL
//                 phase-bound CAS; report which ids this worker was granted.
//   race-mutant — attempt the SAME claims through a deliberately BROKEN claim that
//                 drops the prior-state/lease binding (it will "steal" an already
//                 dispatching row). This is the falsification baseline: it produces
//                 MULTIPLE winners per row. Test-only; lives here, never in src.
//   derive      — recompute the deterministic dispatch_key for one identity and
//                 report it, proving cross-process receipt determinism (F17).
//
// A file barrier (ready file + GO file) lines all workers up on the claim loop so
// the contention is genuine; everything is bounded (a hard spin cap, no hangs).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.js";
import { storeNowMs } from "./publications.js";
import {
  claimContinuationDispatch,
  canonicalizeAction,
  deriveDispatchKey,
  type NextAction,
} from "./continuations.js";

const MODE = process.env["MODE"] ?? "race";
const WORKER_ID = process.env["WORKER_ID"] ?? "0";
const N = Number(process.env["N"] ?? "0");
const BARRIER_DIR = process.env["BARRIER_DIR"] ?? "";
const GO_FILE = process.env["GO_FILE"] ?? "";

const ACTION: NextAction = { kind: "dispatch_phase", phase: "review", role: "engineer" };

function resultPath(): string {
  return join(BARRIER_DIR, `result-${WORKER_ID}.json`);
}

/** Announce this worker reached the barrier — the parent waits for every
 *  worker's ready file before releasing the GO. */
function announceReady(): void {
  writeFileSync(join(BARRIER_DIR, `ready-${WORKER_ID}`), "1");
}

/** Bounded barrier: announce readiness, then spin (with a hard cap) until the
 *  parent drops the GO file. No hang — after the cap we proceed anyway. */
function awaitGo(): void {
  announceReady();
  const deadline = Date.now() + 30_000;
  while (!existsSync(GO_FILE) && Date.now() < deadline) {
    // tight spin; the window is sub-second in practice
  }
}

/** The FALSIFICATION mutant: an UPDATE that binds the phase keys but NOT the
 *  prior state or the lease — it matches a row already in `dispatching` and
 *  overwrites the owner, so every racer reports changes===1. A uniqueness/CAS
 *  regression would look exactly like this and produce multiple winners. */
function claimMutantStealDispatching(id: string, launch: string, owner: string): boolean {
  const db = getDb();
  const now = storeNowMs();
  const canonical = canonicalizeAction(ACTION);
  const dispatchKey = deriveDispatchKey(id, launch, canonical) + `:${owner}`; // also non-deterministic
  const res = db
    .transaction((): number => {
      return db
        .prepare(
          `UPDATE continuations
              SET state = 'dispatching', claim_owner = ?, claim_expires_at = ?, dispatch_key = ?, updated_at = ?
            WHERE continuation_id = ?
              AND source_launch_id = ?
              AND current_phase = ?
              AND state IN ('ready','dispatching')`,
        )
        .run(owner, now + 30_000, dispatchKey, new Date(now).toISOString(), id, launch, "phase-A").changes;
    })
    .immediate();
  return res === 1;
}

function runRace(mutant: boolean): void {
  awaitGo();
  const won: number[] = [];
  for (let i = 0; i < N; i++) {
    const id = `stress-${i}`;
    const launch = `L-${i}`;
    const owner = `w${WORKER_ID}`;
    let granted: boolean;
    if (mutant) {
      granted = claimMutantStealDispatching(id, launch, owner);
    } else {
      const out = claimContinuationDispatch({
        continuationId: id,
        sourceLaunchId: launch,
        consumerKind: "orchestrator",
        currentPhase: "phase-A",
        nextAction: ACTION,
        expectedState: "ready",
        owner,
        leaseTtlMs: 30_000,
      });
      granted = out.granted;
    }
    if (granted) won.push(i);
  }
  writeFileSync(resultPath(), JSON.stringify({ workerId: WORKER_ID, won }));
}

function runDerive(): void {
  announceReady(); // satisfy the parent's readiness barrier; no GO needed
  const id = process.env["CONT_ID"] ?? "";
  const launch = process.env["LAUNCH_ID"] ?? "";
  const action = JSON.parse(process.env["ACTION_JSON"] ?? "{}") as NextAction;
  const key = deriveDispatchKey(id, launch, canonicalizeAction(action));
  writeFileSync(resultPath(), JSON.stringify({ workerId: WORKER_ID, key }));
}

if (MODE === "derive") {
  runDerive();
} else {
  runRace(MODE === "race-mutant");
}
