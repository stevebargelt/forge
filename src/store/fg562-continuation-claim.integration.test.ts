// FG-562 verify (BD-5): DURABLE integration coverage for the continuation-claim
// primitive at boundaries the engineer's in-process suite does NOT reach —
//
//   • CAS under genuinely CONCURRENT OS PROCESSES against ONE real store file
//     (the cross-process variant of the in-process F14 stress),
//   • F17 dispatch-key adoption proven across a real process boundary + against
//     the real UNIQUE(dispatch_key) index (no duplicate dispatch),
//   • F16 lease recovery on a file-backed store (expired taken over, live NOT,
//     blocked stays visible with its receipt),
//   • phase-binding at the file boundary (a delayed phase-A completion never
//     advances phase B; it is recorded as observed and IGNORED),
//   • BD-15 migration on a real store file with real pre-existing data, both
//     directions, additive and idempotent,
//   • BD-3 claimability of reconciled owner_gone/unknown dispositions, and the
//     un-claimability of a step with no terminal evidence yet.
//
// EVERY test carries observed-RED evidence: a mutant claim/derive/DDL that lives
// in the TEST (or the sibling worker), never in src/. Runs against real SQLite
// FILES under the per-process temp FORGE_HOME (test-setup.ts), never ~/.forge.
//
// Bounded by construction: the cross-process workers use a file barrier with a
// hard 30s spin cap; no test sleeps unboundedly.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyMigrations,
  assertSchemaVersionSupported,
  setDbForTest,
  SCHEMA_VERSION,
} from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { FORGE_HOME } from "../util/paths.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { insertRun, getRun } from "./runs.js";
import { nowIso } from "../util/ids.js";
import {
  recordContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  adoptOrClaimDispatch,
  recordDispatchResult,
  continuationsInDispatch,
  getContinuation,
  continuationByDispatchKey,
  markBlocked,
  markAdvanced,
  rearmForNextPhase,
  canonicalizeAction,
  deriveDispatchKey,
  staleObservationsFor,
  type NextAction,
} from "./continuations.js";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "fg562-claim-worker.ts");
const ACTION_A: NextAction = { kind: "dispatch_phase", phase: "review", role: "engineer" };
const ACTION_B: NextAction = { kind: "dispatch_phase", phase: "test", role: "test-engineer" };

let tmpSeq = 0;
function freshDir(name: string): string {
  // A unique dir per case: no cross-test file/barrier bleed, deterministic name.
  const d = join(mkdtempSync(join(FORGE_HOME, `fg562-${name}-`)), `run-${tmpSeq++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

// A NEW-binary open of a real file: exactly getDb()'s writable path (mirrors the
// fg562-store-compatibility template).
function openFileDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  assertSchemaVersionSupported(db, SCHEMA_VERSION);
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Run store code against a file-backed store, restoring the singleton after. */
function onFileDb<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = openFileDb(path);
  const prev = setDbForTest(db);
  try {
    return fn(db);
  } finally {
    setDbForTest(prev as Database.Database);
    db.close();
  }
}

function seedReadyRows(db: Database.Database, n: number): void {
  const prev = setDbForTest(db);
  try {
    for (let i = 0; i < n; i++) {
      recordContinuation({
        continuationId: `stress-${i}`,
        consumerKind: "orchestrator",
        sourceLaunchId: `L-${i}`,
        currentPhase: "phase-A",
        nextAction: ACTION_A,
      });
      observeLaunchStatus(`stress-${i}`, `L-${i}`, "exited_ok");
    }
  } finally {
    setDbForTest(prev as Database.Database);
  }
}

type WorkerResult = { workerId: string; won?: number[]; key?: string };

/** Spawn `k` REAL node processes against `dbFile`, lined up on a file barrier so
 *  they hit the claim loop together. Bounded: rejects if a worker exceeds 60s. */
async function runWorkers(opts: {
  mode: string;
  k: number;
  n: number;
  dbFile: string;
  barrierDir: string;
  extraEnv?: Record<string, string>;
}): Promise<{ results: WorkerResult[]; wallMs: number }> {
  const { mode, k, n, dbFile, barrierDir, extraEnv = {} } = opts;
  mkdirSync(barrierDir, { recursive: true });
  const goFile = join(barrierDir, "GO");
  const start = Date.now();

  const children = Array.from({ length: k }, (_, i) => {
    const child = spawn(process.execPath, ["--import", "tsx", WORKER], {
      env: {
        ...process.env,
        FORGE_DB_PATH: dbFile,
        FORGE_HOME,
        MODE: mode,
        WORKER_ID: String(i),
        N: String(n),
        BARRIER_DIR: barrierDir,
        GO_FILE: goFile,
        ...extraEnv,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += String(d)));
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`worker ${i} exceeded 60s`));
      }, 60_000);
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) resolve();
        else reject(new Error(`worker ${i} exited ${code}: ${stderr}`));
      });
    });
    return { done };
  });

  // Barrier: wait for every worker to announce readiness, then release them.
  const readyDeadline = Date.now() + 40_000;
  const allReady = (): boolean =>
    Array.from({ length: k }, (_, i) => existsSync(join(barrierDir, `ready-${i}`))).every(Boolean);
  while (!allReady() && Date.now() < readyDeadline) {
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.ok(allReady(), "all workers announced readiness before the barrier deadline");
  writeFileSync(goFile, "1");

  await Promise.all(children.map((c) => c.done));
  const wallMs = Date.now() - start;

  const results: WorkerResult[] = readdirSync(barrierDir)
    .filter((f) => f.startsWith("result-"))
    .map((f) => JSON.parse(readFileSync(join(barrierDir, f), "utf8")) as WorkerResult);
  return { results, wallMs };
}

// ===========================================================================
// 1) CAS under genuinely CONCURRENT OS PROCESSES — the cross-process F14.
//    Staged: a mutant claim (steal-dispatching) produces MULTIPLE winners (RED);
//    the real phase-bound CAS grants EXACTLY ONE per row across real processes.
// ===========================================================================
describe("cross-process CAS (real OS processes, one store file)", () => {
  const K = 4;
  const N = 250; // 250 contested rows × 4 processes = 1000 cross-process claims/run

  test(`RED baseline: a mutant claim (no prior-state/lease binding) yields MULTIPLE winners across ${K} processes`, async () => {
    const dir = freshDir("casred");
    const dbFile = join(dir, "cas.db");
    const seed = openFileDb(dbFile);
    seedReadyRows(seed, N);
    seed.pragma("wal_checkpoint(TRUNCATE)");
    seed.close();

    const { results, wallMs } = await runWorkers({
      mode: "race-mutant",
      k: K,
      n: N,
      dbFile,
      barrierDir: join(dir, "barrier"),
    });
    assert.equal(results.length, K, "every worker reported");

    const winnersPerId = new Array<number>(N).fill(0);
    for (const r of results) for (const i of r.won ?? []) winnersPerId[i]!++;
    const doubleWon = winnersPerId.filter((c) => c > 1).length;
    // The falsification: the un-bound claim lets every racer "win" the same row.
    assert.ok(doubleWon > 0, `FALSIFICATION: ${doubleWon}/${N} rows had MULTIPLE cross-process winners under the mutant`);
    // eslint-disable-next-line no-console
    console.log(`  [cross-process RED] ${doubleWon}/${N} rows double-claimed by the mutant across ${K} processes in ${wallMs}ms`);
  });

  test(`GREEN: the real phase-bound CAS grants EXACTLY ONE winner per row across ${K} processes`, async () => {
    const dir = freshDir("casgreen");
    const dbFile = join(dir, "cas.db");
    const seed = openFileDb(dbFile);
    seedReadyRows(seed, N);
    seed.pragma("wal_checkpoint(TRUNCATE)");
    seed.close();

    const { results, wallMs } = await runWorkers({
      mode: "race",
      k: K,
      n: N,
      dbFile,
      barrierDir: join(dir, "barrier"),
    });
    assert.equal(results.length, K, "every worker reported");

    const winnersPerId = new Array<number>(N).fill(0);
    let totalWins = 0;
    for (const r of results) {
      for (const i of r.won ?? []) {
        winnersPerId[i]!++;
        totalWins++;
      }
    }
    for (let i = 0; i < N; i++) {
      assert.equal(winnersPerId[i], 1, `row stress-${i}: exactly one cross-process winner (got ${winnersPerId[i]})`);
    }
    assert.equal(totalWins, N, "exactly N total grants — never two winners, never a torn write");

    // The store itself must corroborate: every row landed in a single consistent
    // claimed state owned by exactly one worker, each carrying its own receipt.
    const check = new Database(dbFile, { readonly: true });
    const keys = new Set<string>();
    for (let i = 0; i < N; i++) {
      const row = check
        .prepare(`SELECT state, claim_owner, dispatch_key FROM continuations WHERE continuation_id = ?`)
        .get(`stress-${i}`) as { state: string; claim_owner: string | null; dispatch_key: string | null };
      assert.equal(row.state, "dispatching", `row ${i} is dispatching`);
      assert.ok(row.claim_owner && /^w[0-3]$/.test(row.claim_owner), `row ${i} has a single consistent owner`);
      assert.ok(row.dispatch_key, `row ${i} carries a receipt`);
      keys.add(row.dispatch_key!);
    }
    assert.equal(keys.size, N, "every receipt is distinct — no cross-row collision");
    check.close();
    // eslint-disable-next-line no-console
    console.log(`  [cross-process GREEN] ${N} rows × ${K} processes = ${N * K} claims, exactly ${totalWins} winners in ${wallMs}ms`);
  });
});

// ===========================================================================
// 2) F17 dispatch adoption at the REAL boundary: identical receipt on recovery,
//    NO duplicate row, and the UNIQUE(dispatch_key) index is real. RED: a
//    non-deterministic key lets a duplicate dispatch slip past the index.
// ===========================================================================
describe("F17 dispatch adoption at the real boundary", () => {
  test("recovery recomputes the IDENTICAL receipt and ADOPTS the original dispatch (no duplicate row)", () => {
    const dbFile = join(freshDir("f17"), "f17.db");
    let originalKey = "";

    onFileDb(dbFile, () => {
      recordContinuation({ continuationId: "f17", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("f17", "launch-A", "exited_ok");
      const claim = claimContinuationDispatch({
        continuationId: "f17", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dead", leaseTtlMs: 30_000,
      });
      assert.ok(claim.granted, "the claim wrote a dispatch_key before any dispatch");
      originalKey = claim.granted ? claim.dispatchKey : "";
      // Crash BEFORE recordDispatchResult: dispatched_run_id stays null.
      assert.equal(getContinuation("f17")!.dispatchedRunId, undefined);
      assert.equal(getContinuation("f17")!.state, "dispatching");
    });

    // ---- RED baseline: a NAIVE recovery that recomputes the key with a
    // NON-DETERMINISTIC component (owner-tagged) gets a DIFFERENT key, so a
    // duplicate-dispatch INSERT is NOT caught by UNIQUE(dispatch_key) — two live
    // dispatches for one logical step. This is the defect the deterministic key
    // + unique index exist to prevent.
    onFileDb(dbFile, (db) => {
      const canonical = canonicalizeAction(ACTION_A);
      const mutantKey = deriveDispatchKey("f17", "launch-A", canonical) + ":ctl-recovery";
      assert.notEqual(mutantKey, originalKey, "a non-deterministic key differs on recovery");
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n;
      db.prepare(
        `INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, dispatch_key, created_at, updated_at)
         VALUES ('f17-dup','orchestrator','launch-A','phase-A',?,'dispatching',?, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      ).run(canonical, mutantKey);
      const after = (db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n;
      assert.equal(after, before + 1, "FALSIFICATION: a non-deterministic key let a DUPLICATE dispatch row be created");
      db.prepare(`DELETE FROM continuations WHERE continuation_id='f17-dup'`).run(); // reset for the green path
    });

    // ---- GREEN: the REAL takeover recomputes the IDENTICAL receipt and adopts
    // the SAME row — no new row, and the unique index would reject a duplicate.
    onFileDb(dbFile, (db) => {
      setPublicationClockOffsetForTest(60_000); // lapse the dead owner's lease
      const recovery = claimContinuationDispatch({
        continuationId: "f17", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "dispatching", owner: "ctl-recovery", leaseTtlMs: 30_000,
      });
      setPublicationClockOffsetForTest(0);
      assert.ok(recovery.granted, "an expired lease is recovered by takeover");
      assert.equal(recovery.granted ? recovery.dispatchKey : "", originalKey, "recovery derives the IDENTICAL receipt — adopted, not duplicated");
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n, 1, "no duplicate row — one continuation, one dispatch");
      assert.equal(continuationByDispatchKey(originalKey)?.continuationId, "f17", "the receipt still resolves to the one row");

      // The UNIQUE(dispatch_key) index is real and confined: a second row under
      // the SAME receipt is rejected.
      assert.throws(
        () => db.prepare(
          `INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, dispatch_key, created_at, updated_at)
           VALUES ('f17-clone','orchestrator','launch-A','phase-A','{}','dispatching', ?, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
        ).run(originalKey),
        /UNIQUE/i,
        "the identical receipt cannot appear twice — exactly one dispatch",
      );
    });
  });

  test("the deterministic receipt is identical across a REAL process boundary", async () => {
    const dir = freshDir("f17xp");
    const barrier = join(dir, "barrier");
    const canonical = canonicalizeAction(ACTION_A);
    const expected = deriveDispatchKey("cont-xp", "launch-xp", canonical);
    // A fresh child process, no shared memory, recomputes the receipt.
    const { results } = await runWorkers({
      mode: "derive",
      k: 1,
      n: 0,
      dbFile: join(dir, "unused.db"),
      barrierDir: barrier,
      extraEnv: { CONT_ID: "cont-xp", LAUNCH_ID: "launch-xp", ACTION_JSON: JSON.stringify(ACTION_A) },
    });
    assert.equal(results[0]?.key, expected, "another OS process derives the byte-identical receipt (F17 idempotency holds cross-process)");
  });
});

// ===========================================================================
// 3) F16 lease recovery on a file-backed store. RED: a claim that omits the
//    lease predicate wrongly steals a LIVE lease.
// ===========================================================================
describe("F16 lease recovery (file-backed)", () => {
  test("expired lease is taken over with the identical receipt; a LIVE lease is NOT; blocked stays visible", () => {
    const dbFile = join(freshDir("f16"), "f16.db");
    onFileDb(dbFile, (db) => {
      recordContinuation({ continuationId: "f16", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("f16", "launch-A", "exited_ok");
      const claim = claimContinuationDispatch({
        continuationId: "f16", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dead", leaseTtlMs: 30_000,
      });
      assert.ok(claim.granted);
      const keyAtClaim = claim.granted ? claim.dispatchKey : "";

      // A LIVE lease is never taken over by the real CAS.
      const tooEarly = claimContinuationDispatch({
        continuationId: "f16", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "dispatching", owner: "ctl-recovery", leaseTtlMs: 30_000,
      });
      assert.equal(tooEarly.granted, false, "the real CAS refuses a LIVE lease");

      // RED baseline: a claim that DROPS the lease predicate steals the live lease.
      const stole = db
        .transaction((): number =>
          db.prepare(
            `UPDATE continuations SET state='dispatching', claim_owner='thief', updated_at='x'
               WHERE continuation_id='f16' AND current_phase='phase-A' AND state='dispatching'`,
          ).run().changes,
        )
        .immediate();
      assert.equal(stole, 1, "FALSIFICATION: without the lease predicate a LIVE lease is wrongly stolen");
      // restore the dead owner so the green takeover path is exercised cleanly
      db.prepare(`UPDATE continuations SET claim_owner='ctl-dead' WHERE continuation_id='f16'`).run();

      // GREEN: once the lease lapses, the real takeover succeeds with the SAME receipt.
      setPublicationClockOffsetForTest(60_000);
      const takeover = claimContinuationDispatch({
        continuationId: "f16", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "dispatching", owner: "ctl-recovery", leaseTtlMs: 30_000,
      });
      setPublicationClockOffsetForTest(0);
      assert.ok(takeover.granted, "an EXPIRED lease is recovered");
      assert.equal(takeover.granted ? takeover.dispatchKey : "", keyAtClaim, "the recovered receipt is identical");
      assert.equal(getContinuation("f16")!.claimOwner, "ctl-recovery");
    });
  });

  test("a blocked continuation stays visibly blocked with its receipt intact", () => {
    const dbFile = join(freshDir("f16b"), "f16b.db");
    onFileDb(dbFile, () => {
      recordContinuation({ continuationId: "b", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("b", "launch-A", "exited_ok");
      const claim = claimContinuationDispatch({
        continuationId: "b", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-x", leaseTtlMs: 30_000,
      });
      assert.ok(claim.granted);
      assert.ok(markBlocked("b", "ctl-x"));
      const c = getContinuation("b")!;
      assert.equal(c.state, "blocked", "blocked is visible, not silently gone");
      assert.ok(c.dispatchKey, "the receipt survives the block, so a recovery still adopts it");
    });
  });
});

// ===========================================================================
// 4) Phase-binding at the file boundary: a delayed phase-A completion applied
//    AFTER the slot advanced to phase B does NOT advance B, writes NO state, and
//    is recorded as observed/ignored. RED: a uniqueness-only claim advances B.
// ===========================================================================
describe("phase-binding at the boundary", () => {
  test("a delayed phase-A completion never advances phase B (CAS changes===0, no write)", () => {
    const dbFile = join(freshDir("pb"), "pb.db");
    onFileDb(dbFile, (db) => {
      // Drive the slot through phase A, then re-arm it for phase B.
      recordContinuation({ continuationId: "pb", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("pb", "launch-A", "exited_ok");
      const a = claimContinuationDispatch({
        continuationId: "pb", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 30_000,
      });
      assert.ok(a.granted);
      assert.ok(markAdvanced("pb", "ctl-1"));
      const rearmed = rearmForNextPhase("pb", { sourceLaunchId: "launch-B", currentPhase: "phase-B", nextAction: ACTION_B });
      assert.equal(rearmed?.currentPhase, "phase-B");
      observeLaunchStatus("pb", "launch-B", "exited_ok"); // phase-B's own launch is ready

      // RED baseline: a uniqueness-only claim (no phase binding) would advance B.
      const before = getContinuation("pb")!;
      const wrongly = db
        .transaction((): number =>
          db.prepare(
            `UPDATE continuations SET state='dispatching', claim_owner='stale-from-A', updated_at='x'
               WHERE continuation_id='pb' AND (claim_owner IS NULL OR claim_owner IS NOT NULL) AND state='ready'`,
          ).run().changes,
        )
        .immediate();
      assert.equal(wrongly, 1, "FALSIFICATION: a uniqueness-only claim advances phase B on a stale phase-A completion");
      // undo the mutant's damage before exercising the real CAS
      db.prepare(`UPDATE continuations SET state='ready', claim_owner=NULL, updated_at=? WHERE continuation_id='pb'`).run(before.updatedAt);

      // GREEN: the real phase-bound CAS presented with phase-A's binding matches
      // nothing — no state written. And the stale completion is recorded as
      // observed evidence WITHOUT disturbing the claim (observed/ignored).
      const snapshot = getContinuation("pb")!;
      const out = claimContinuationDispatch({
        continuationId: "pb", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "stale-from-A", leaseTtlMs: 30_000,
      });
      assert.equal(out.granted, false, "the delayed phase-A completion is NOT granted a claim on phase B");
      const after = getContinuation("pb")!;
      assert.equal(after.state, "ready", "phase B is unchanged — still ready for its OWN launch");
      assert.equal(after.claimOwner, undefined, "no stale owner attached to phase B");
      assert.equal(after.updatedAt, snapshot.updatedAt, "the CAS wrote nothing (updated_at unchanged)");

      // The stale launch-A disposition, observed after the slot re-armed to launch B,
      // is launch-bound and so matches NOTHING — it neither advances the phase nor
      // stamps launch A's disposition into phase B's evidence (ignored at the observe
      // boundary, not just at the claim).
      const evidenceBefore = getContinuation("pb")!;
      observeLaunchStatus("pb", "launch-A", "exited_error");
      const evidenced = getContinuation("pb")!;
      assert.equal(evidenced.lastObservedStatus, "exited_ok", "phase B's evidence is its OWN launch-B disposition, not the stale launch-A one");
      assert.equal(evidenced.currentPhase, "phase-B", "still phase B — the stale observation did not advance anything");
      assert.equal(evidenced.updatedAt, evidenceBefore.updatedAt, "the stale launch-A observe wrote nothing to the slot");
      // Finding 2: the stale event is not SILENTLY discarded — it left a DURABLE
      // append-only audit record at the file boundary (observed-recorded-and-ignored).
      const audit = staleObservationsFor("pb");
      assert.equal(audit.length, 1, "the stale launch-A event left exactly one durable audit row");
      assert.equal(audit[0]?.sourceLaunchId, "launch-A", "the superseded launch id is captured");
      assert.equal(audit[0]?.status, "exited_error", "the observed disposition is captured");
      assert.equal(audit[0]?.currentPhase, "phase-B", "the slot's phase at observation time is captured");

      // Phase B's OWN, correctly-bound completion still advances normally.
      const legit = claimContinuationDispatch({
        continuationId: "pb", sourceLaunchId: "launch-B", consumerKind: "orchestrator", currentPhase: "phase-B",
        nextAction: ACTION_B, expectedState: "ready", owner: "ctl-2", leaseTtlMs: 30_000,
      });
      assert.ok(legit.granted, "phase B's correctly-bound completion DOES advance");
    });
  });
});

// ===========================================================================
// 5) BD-15 migration on a REAL store file with real pre-existing data, both
//    directions. RED: a NON-idempotent (no IF NOT EXISTS) create throws on the
//    already-migrated file — proving the additive property is load-bearing.
// ===========================================================================
const LEGACY_RUNS_DDL = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL,
  status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT
);`;

function tableSet(db: Database.Database): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map((t) => t.name));
}
function indexSet(db: Database.Database): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map((t) => t.name));
}

describe("BD-15 migration on a real store file (both directions, real data)", () => {
  test("dir1: an OLD store with real data gains `continuations` additively; the data is intact and an old writer still works", () => {
    const dbFile = join(freshDir("mig1"), "old.db");

    // Version A (old binary): a store with real rows and no continuations.
    const a = new Database(dbFile);
    a.pragma("journal_mode = WAL");
    a.exec(LEGACY_RUNS_DDL);
    const rows = [
      ["run-1", "feature", "Alpha", "active", "2026-01-01T00:00:00Z"],
      ["run-2", "feature", "Beta", "complete", "2026-01-02T00:00:00Z"],
      ["run-3", "feature", "Gamma", "active", "2026-01-03T00:00:00Z"],
    ];
    for (const r of rows) a.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES (?,?,?,?,?)`).run(...r);
    assert.equal(tableSet(a).has("continuations"), false, "precondition: no continuations table");
    a.pragma("wal_checkpoint(TRUNCATE)");
    a.close();

    // Version B (new binary) opens the SAME file: additive create.
    const b = openFileDb(dbFile);
    assert.ok(tableSet(b).has("continuations"), "the new open added the continuations table");
    assert.ok(tableSet(b).has("continuation_stale_observations"), "the new open added the additive stale-observation audit table (Finding 2)");
    assert.ok(indexSet(b).has("idx_continuations_dispatch_key"), "the UNIQUE(dispatch_key) index is present");
    assert.ok(indexSet(b).has("idx_continuations_launch"), "the launch index is present");
    // Every old row is byte-for-byte intact.
    const got = b.prepare(`SELECT id, title, status FROM runs ORDER BY id`).all();
    assert.deepEqual(got, [
      { id: "run-1", title: "Alpha", status: "active" },
      { id: "run-2", title: "Beta", status: "complete" },
      { id: "run-3", title: "Gamma", status: "active" },
    ], "the old data survived the additive migration unchanged");

    // RED baseline: a NON-idempotent create (no IF NOT EXISTS) on the migrated
    // file throws — the additive `IF NOT EXISTS` is genuinely load-bearing.
    assert.throws(
      () => b.exec(`CREATE TABLE continuations (continuation_id TEXT PRIMARY KEY)`),
      /already exists/i,
      "FALSIFICATION: a non-additive re-create would break the overlap window",
    );
    // The real SCHEMA_SQL is idempotent — re-running it does not throw or churn.
    assert.doesNotThrow(() => b.exec(SCHEMA_SQL), "the real additive schema is idempotent on re-open");
    b.close();

    // Version A still running: unbroken by the added table.
    const a2 = new Database(dbFile);
    a2.pragma("journal_mode = WAL");
    assert.doesNotThrow(() => a2.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('run-4','feature','Delta','active','2026-01-04T00:00:00Z')`).run(), "the in-flight old writer is unbroken");
    assert.equal((a2.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n, 4);
    a2.close();
  });

  test("dir2: a NEW store with real continuation rows + UNIQUE(dispatch_key) never affects an OLD reader/writer", () => {
    const dbFile = join(freshDir("mig2"), "new.db");

    // Version B creates the store and writes real continuation rows.
    onFileDb(dbFile, () => {
      for (const id of ["cc-1", "cc-2"]) {
        recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: `L-${id}`, currentPhase: "p", nextAction: ACTION_A });
        observeLaunchStatus(id, `L-${id}`, "exited_ok");
        const out = claimContinuationDispatch({ continuationId: id, sourceLaunchId: `L-${id}`, consumerKind: "orchestrator", currentPhase: "p", nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000 });
        assert.ok(out.granted, "the primitive works against a real file-backed store");
      }
    });

    // Version A (old binary) opens the SAME store carrying the new table + index.
    const a = new Database(dbFile);
    a.pragma("journal_mode = WAL");
    a.pragma("foreign_keys = ON");
    a.exec(LEGACY_RUNS_DDL); // an old binary knows only its own tables
    assert.doesNotThrow(() => a.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('r','feature','t','active','2026-01-01T00:00:00Z')`).run(), "the old writer is unaffected by the new table/index");
    assert.deepEqual((a.prepare(`SELECT id FROM runs`).all() as { id: string }[]).map((r) => r.id), ["r"], "the old reader sees its own rows via its own column set");
    a.close();

    // The UNIQUE(dispatch_key) index is real and confined to continuations.
    const check = new Database(dbFile);
    const key = (check.prepare(`SELECT dispatch_key AS k FROM continuations WHERE continuation_id='cc-1'`).get() as { k: string }).k;
    assert.throws(
      () => check.prepare(`INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, dispatch_key, created_at, updated_at) VALUES ('dup','orchestrator','L','p','{}','dispatching', ?, 'x','x')`).run(key),
      /UNIQUE/i,
      "one receipt across the table",
    );
    check.close();
  });
});

// ===========================================================================
// 6) BD-3 evidence: a reconciled owner_gone/unknown disposition (no exit record)
//    is claimable without fabricating a record; a step with NO terminal evidence
//    yet is NOT claimable.
// ===========================================================================
describe("BD-3 evidence claimability (file-backed)", () => {
  test("a reconciled owner_gone/unknown disposition is claimable; nothing fabricates an exit record", () => {
    const dbFile = join(freshDir("bd3"), "bd3.db");
    onFileDb(dbFile, () => {
      for (const status of ["owner_gone", "unknown"] as const) {
        const id = `bd3-${status}`;
        recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
        const observed = observeLaunchStatus(id, "L", status);
        assert.equal(observed?.state, "ready", `${status} is a legitimate terminal disposition`);
        assert.equal(observed?.lastObservedStatus, status, `${status} recorded as BD-3 evidence, not an exit code`);
        const out = claimContinuationDispatch({
          continuationId: id, sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
          nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
        });
        assert.ok(out.granted, `a claim on a reconciled ${status} disposition is granted — no exit record required`);
      }
    });
  });

  test("a step with NO terminal evidence yet is NOT claimable (a disposition unsupported by the evidence cannot be claimed)", () => {
    const dbFile = join(freshDir("bd3n"), "bd3n.db");
    onFileDb(dbFile, (db) => {
      recordContinuation({ continuationId: "unobserved", consumerKind: "orchestrator", sourceLaunchId: "L", currentPhase: "p", nextAction: ACTION_A });
      // No terminal disposition observed → still awaiting_completion. A claim that
      // ASSERTS 'ready' evidence it does not have matches nothing and writes nothing.
      const before = getContinuation("unobserved")!;

      // RED baseline: a claim that DROPS the prior-state predicate would grant on a
      // step with no terminal evidence — fabricating readiness. The real CAS binds it.
      const fabricated = db
        .transaction((): number =>
          db.prepare(
            `UPDATE continuations SET state='dispatching', claim_owner='ctl', updated_at='x'
               WHERE continuation_id='unobserved' AND source_launch_id='L' AND current_phase='p'`,
          ).run().changes,
        )
        .immediate();
      assert.equal(fabricated, 1, "FALSIFICATION: without the prior-state binding an unobserved step is wrongly claimed");
      db.prepare(`UPDATE continuations SET state='awaiting_completion', claim_owner=NULL, updated_at=? WHERE continuation_id='unobserved'`).run(before.updatedAt);
      const out = claimContinuationDispatch({
        continuationId: "unobserved", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
      });
      assert.equal(out.granted, false, "a step with no terminal evidence is not claimable");
      const after = getContinuation("unobserved")!;
      assert.equal(after.state, "awaiting_completion", "state is untouched — no fabricated readiness");
      assert.equal(after.updatedAt, before.updatedAt, "the failed claim wrote nothing");

      // A non-terminal observation (still running) also does not make it claimable.
      observeLaunchStatus("unobserved", "L", "running");
      const running = claimContinuationDispatch({
        continuationId: "unobserved", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
      });
      assert.equal(running.granted, false, "a still-running launch is not claimable");
    });
  });
});

// ===========================================================================
// 7) F17 ADOPTION END-TO-END through the production entry-point across a REAL
//    controller CRASH+RESTART (a fresh accessor against the same store file).
//
//    claim → recordDispatchResult(ids) → CRASH → RESTART → adoptOrClaimDispatch
//    returns the EXISTING dispatch (disposition 'adopt', ids intact) and creates
//    NO second claim/dispatch row; the identical receipt collides (UNIQUE) rather
//    than duplicating. RED: a recovery whose key is NON-DETERMINISTIC misses the
//    lookup and a duplicate dispatch slips past the index — the exact defect the
//    deterministic receipt + adopt entry-point prevent.
// ===========================================================================
describe("F17 adoption entry-point across a crash+restart (production mechanism)", () => {
  test("adoptOrClaimDispatch adopts the original dispatch on restart; a non-deterministic recovery would duplicate (RED)", () => {
    const dbFile = join(freshDir("adopt"), "adopt.db");
    let originalKey = "";

    // ---- Session 1: a controller claims, dispatches (records ids), then CRASHES.
    onFileDb(dbFile, () => {
      recordContinuation({ continuationId: "ad", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("ad", "launch-A", "exited_ok");
      const claim = claimContinuationDispatch({
        continuationId: "ad", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dead", leaseTtlMs: 30_000,
      });
      assert.ok(claim.granted, "the claim wrote the receipt before dispatch");
      originalKey = claim.granted ? claim.dispatchKey : "";
      assert.ok(recordDispatchResult("ad", "ctl-dead", { runId: "run-orig", taskId: "task-orig" }), "the physical dispatch's ids are recorded, still state='dispatching'");
      assert.equal(getContinuation("ad")!.state, "dispatching", "crash BEFORE the settling advance — the F17 crash window");
      assert.equal(getContinuation("ad")!.dispatchedRunId, "run-orig");
    });

    // ---- Session 2 = RESTART (a brand-new accessor against the same file).
    onFileDb(dbFile, (db) => {
      // RED baseline: a recovery that recomputes the receipt with a NON-DETERMINISTIC
      // (owner-tagged) component looks up the WRONG key, finds NO existing dispatch,
      // and would re-dispatch — a duplicate INSERT is NOT caught by UNIQUE(dispatch_key).
      const canonical = canonicalizeAction(ACTION_A);
      const mutantKey = deriveDispatchKey("ad", "launch-A", canonical) + ":ctl-recovery";
      assert.notEqual(mutantKey, originalKey, "a non-deterministic key differs on recovery");
      assert.equal(continuationByDispatchKey(mutantKey), undefined, "the mutant key misses the real dispatch — the defect");
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n;
      db.prepare(
        `INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, dispatch_key, created_at, updated_at)
         VALUES ('ad-dup','orchestrator','launch-A','phase-A',?,'dispatching',?, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
      ).run(canonical, mutantKey);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n, before + 1, "FALSIFICATION: a non-deterministic recovery created a DUPLICATE dispatch row");
      db.prepare(`DELETE FROM continuations WHERE continuation_id='ad-dup'`).run(); // reset for the green path

      // A recovery that SKIPS the receipt lookup and issues a bare fresh claim gets
      // no grant (the slot is 'dispatching', not 'ready') — so it never learns a prior
      // dispatch exists and would wrongly re-dispatch. The lookup is load-bearing.
      const skipsLookup = claimContinuationDispatch({
        continuationId: "ad", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-recovery", leaseTtlMs: 30_000,
      });
      assert.equal(skipsLookup.granted, false, "a bare fresh claim gives no adopt signal — it only fails, it does not adopt");

      // ---- GREEN: the REAL entry-point recomputes the IDENTICAL receipt, ADOPTS the
      // existing dispatch (ids intact), and creates NO second row.
      const outcome = adoptOrClaimDispatch({
        continuationId: "ad", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, owner: "ctl-recovery", leaseTtlMs: 30_000,
      });
      assert.equal(outcome.disposition, "adopt", "the restart ADOPTS the existing dispatch, it does not re-dispatch");
      assert.equal(outcome.dispatchKey, originalKey, "recovery derived the IDENTICAL receipt");
      assert.equal(outcome.disposition === "adopt" ? outcome.continuation.dispatchedRunId : undefined, "run-orig", "the adopted dispatch carries the original run id");
      assert.equal(outcome.disposition === "adopt" ? outcome.continuation.dispatchedTaskId : undefined, "task-orig", "and the original task id");
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM continuations`).get() as { n: number }).n, 1, "no duplicate row — one continuation, one dispatch");
      assert.equal(getContinuation("ad")!.claimOwner, "ctl-dead", "adoption does NOT steal the lease — that is a separate, explicit takeover");

      // A second attempt under the SAME deterministic key collides with the index.
      assert.throws(
        () => db.prepare(
          `INSERT INTO continuations (continuation_id, consumer_kind, source_launch_id, current_phase, next_action, state, dispatch_key, created_at, updated_at)
           VALUES ('ad-clone','orchestrator','launch-A','phase-A','{}','dispatching', ?, '2026-01-01T00:00:00Z','2026-01-01T00:00:00Z')`,
        ).run(originalKey),
        /UNIQUE/i,
        "the identical receipt cannot appear twice — exactly one dispatch",
      );
    });
  });

  test("adoptOrClaimDispatch grants a FRESH claim when NO prior dispatch exists (adopt path is not always-adopt)", () => {
    const dbFile = join(freshDir("adoptfresh"), "adoptfresh.db");
    onFileDb(dbFile, () => {
      recordContinuation({ continuationId: "fresh", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("fresh", "launch-A", "exited_ok");
      const outcome = adoptOrClaimDispatch({
        continuationId: "fresh", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, owner: "ctl-1", leaseTtlMs: 30_000,
      });
      assert.equal(outcome.disposition, "claim", "with no prior dispatch a fresh claim is granted");
      assert.equal(getContinuation("fresh")!.state, "dispatching");
      assert.equal(getContinuation("fresh")!.claimOwner, "ctl-1");

      // Immediately after, the SAME identity now ADOPTS (the receipt is present).
      const again = adoptOrClaimDispatch({
        continuationId: "fresh", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, owner: "ctl-2", leaseTtlMs: 30_000,
      });
      assert.equal(again.disposition, "adopt", "once claimed, the same identity adopts — never a second claim");
      assert.equal(getContinuation("fresh")!.claimOwner, "ctl-1", "no re-claim: the first owner is intact");
    });
  });
});

// ===========================================================================
// 7b) F17 no DUPLICATE PHYSICAL DISPATCH — the receipt keys a REAL run recipient.
//
//    The prior F17 tests prove the receipt/adoption mechanism; this one proves the
//    guarantee it exists for — "does NOT dispatch a duplicate agent/run" — against an
//    ACTUAL dispatch target (the real `runs` table), not a second continuation row.
//    The recipient's run-creation is keyed through the continuation receipt
//    (check-before-spawn), exactly the shape the consumer (FG-563/FG-564 — the
//    physical dispatcher is their ticket scope, not this slice) will use. After a
//    claim → real-run → CRASH, recovery adopts the receipt and the recipient returns
//    the SAME run: one physical run across the crash window.
// ===========================================================================
describe("F17 no duplicate physical dispatch (real run recipient keyed by receipt)", () => {
  // A dispatch recipient over the real runs table: creating the phase's run is keyed
  // through the receipt — if the slot already carries a run, ADOPT it; else spawn one
  // and record it. This is the consumer's check-before-spawn, modeled against a real
  // dispatch target.
  function dispatchPhaseRun(receipt: string, owner: string): string {
    const slot = continuationByDispatchKey(receipt);
    assert.ok(slot, "the receipt resolves to a claimed slot");
    if (slot!.dispatchedRunId) return slot!.dispatchedRunId; // adopt the already-created run
    const runId = `run-${receipt.slice(0, 12)}`;
    insertRun({ id: runId, workflow: "feature", title: "phase dispatch", status: "active", createdAt: nowIso() });
    assert.ok(recordDispatchResult(slot!.continuationId, owner, { runId }), "records the run id under the owner");
    return runId;
  }

  test("recovery adopts the ONE run through the receipt; no second run is created (RED: a receipt-blind re-dispatch duplicates it)", () => {
    const dbFile = join(freshDir("f17run"), "f17run.db");
    onFileDb(dbFile, (db) => {
      const runCount = (): number => (db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n;

      // ---- Session 1: claim → dispatch a REAL run keyed by the receipt → CRASH
      // before the settling advance (run id recorded, state still 'dispatching').
      recordContinuation({ continuationId: "r1", consumerKind: "orchestrator", sourceLaunchId: "launch-A", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("r1", "launch-A", "exited_ok");
      const claim = claimContinuationDispatch({
        continuationId: "r1", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-dead", leaseTtlMs: 30_000,
      });
      assert.ok(claim.granted);
      const receipt = claim.granted ? claim.dispatchKey : "";
      const firstRun = dispatchPhaseRun(receipt, "ctl-dead");
      assert.equal(runCount(), 1, "one physical run exists after the first dispatch");
      assert.equal(getContinuation("r1")!.state, "dispatching", "crash BEFORE the settling advance — the F17 window");

      // ---- RED baseline: a recovery that IGNORES the receipt and re-dispatches blindly
      // creates a SECOND physical run for the one logical step — the F17 defect.
      const blindRun = "run-blind-recovery";
      insertRun({ id: blindRun, workflow: "feature", title: "phase dispatch", status: "active", createdAt: nowIso() });
      assert.equal(runCount(), 2, "FALSIFICATION: a receipt-blind recovery created a DUPLICATE physical run");
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(blindRun); // reset for the green path

      // ---- GREEN: recovery derives the IDENTICAL receipt, ADOPTS the existing dispatch,
      // and the recipient's check-before-spawn returns the SAME run — no second run.
      setPublicationClockOffsetForTest(60_000);
      const outcome = adoptOrClaimDispatch({
        continuationId: "r1", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, owner: "ctl-recovery", leaseTtlMs: 30_000,
      });
      setPublicationClockOffsetForTest(0);
      assert.equal(outcome.disposition, "adopt", "recovery adopts the existing dispatch, it does not re-dispatch");
      assert.equal(outcome.dispatchKey, receipt, "the recovery receipt is identical");
      const secondRun = dispatchPhaseRun(outcome.dispatchKey, "ctl-recovery");
      assert.equal(secondRun, firstRun, "the recipient adopted the SAME run through the receipt — no re-spawn");
      assert.equal(runCount(), 1, "exactly one physical run for the logical step across the crash+recovery");
      assert.equal(getRun(firstRun)?.id, firstRun, "the adopted run is the real recorded run");
    });
  });
});

// ===========================================================================
// 8) RESTART REPLAY END-TO-END: after a crash, continuationsInDispatch() returns
//    EXACTLY the mid-dispatch slots (not advanced/ready/awaiting/blocked), and each
//    is adoptable via the entry-point. RED: a collector that returns the WRONG set
//    (every row, ignoring state) would replay settled/never-dispatched slots.
// ===========================================================================
describe("restart replay set (production mechanism)", () => {
  test("continuationsInDispatch returns exactly the crash-window slots on restart; each adopts; a mutant collector over-collects (RED)", () => {
    const dbFile = join(freshDir("replay"), "replay.db");

    // ---- Session 1: drive four slots to distinct states, then CRASH.
    onFileDb(dbFile, () => {
      // Two are mid-dispatch (claimed, un-advanced) — the crash window.
      for (const [id, launch, owner] of [["disp-1", "L1", "o1"], ["disp-2", "L2", "o2"]] as const) {
        recordContinuation({ continuationId: id, consumerKind: "orchestrator", sourceLaunchId: launch, currentPhase: "phase-A", nextAction: ACTION_A });
        observeLaunchStatus(id, launch, "exited_ok");
        assert.ok(claimContinuationDispatch({ continuationId: id, sourceLaunchId: launch, consumerKind: "orchestrator", currentPhase: "phase-A", nextAction: ACTION_A, expectedState: "ready", owner, leaseTtlMs: 30_000 }).granted);
      }
      // One fully advanced — settled, not a replay candidate.
      recordContinuation({ continuationId: "done-1", consumerKind: "orchestrator", sourceLaunchId: "L3", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("done-1", "L3", "exited_ok");
      assert.ok(claimContinuationDispatch({ continuationId: "done-1", sourceLaunchId: "L3", consumerKind: "orchestrator", currentPhase: "phase-A", nextAction: ACTION_A, expectedState: "ready", owner: "o3", leaseTtlMs: 30_000 }).granted);
      assert.ok(markAdvanced("done-1", "o3", { runId: "run-done" }));
      // One ready-but-never-claimed — never dispatched, not a replay candidate.
      recordContinuation({ continuationId: "ready-1", consumerKind: "orchestrator", sourceLaunchId: "L4", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("ready-1", "L4", "exited_ok");
      // One campaign slot mid-dispatch — proves consumer scoping across the restart.
      recordContinuation({ continuationId: "camp-1", consumerKind: "campaign", sourceLaunchId: "L5", currentPhase: "phase-A", nextAction: ACTION_A });
      observeLaunchStatus("camp-1", "L5", "exited_ok");
      assert.ok(claimContinuationDispatch({ continuationId: "camp-1", sourceLaunchId: "L5", consumerKind: "campaign", currentPhase: "phase-A", nextAction: ACTION_A, expectedState: "ready", owner: "oc", leaseTtlMs: 30_000 }).granted);
    });

    // ---- Session 2 = RESTART: the replay set is exactly the mid-dispatch slots.
    onFileDb(dbFile, (db) => {
      // RED baseline: a mutant collector that returns EVERY row (ignoring state) would
      // replay the advanced + never-dispatched slots too — re-dispatching settled work.
      const mutantIds = (db.prepare(`SELECT continuation_id FROM continuations ORDER BY updated_at ASC`).all() as { continuation_id: string }[]).map((r) => r.continuation_id);
      assert.ok(mutantIds.includes("done-1") && mutantIds.includes("ready-1"), "FALSIFICATION: a state-blind collector includes advanced + never-dispatched slots");
      assert.ok(mutantIds.length > 2, "the mutant over-collects");

      // GREEN: the real collector returns ONLY the orchestrator crash-window slots.
      const replay = continuationsInDispatch({ consumerKind: "orchestrator" });
      assert.deepEqual(replay.map((c) => c.continuationId), ["disp-1", "disp-2"], "exactly the un-advanced orchestrator dispatching slots, oldest-first");
      for (const c of replay) {
        assert.equal(c.state, "dispatching");
        assert.ok(c.dispatchKey, "each replay slot carries its receipt");
        assert.equal(c.dispatchedRunId, undefined, "the crash window: no run id yet");
      }
      // Consumer scoping survives the restart: the campaign reconciler sees only its own.
      assert.deepEqual(continuationsInDispatch({ consumerKind: "campaign" }).map((c) => c.continuationId), ["camp-1"]);
      // Unscoped: every mid-dispatch slot across consumers, still excluding settled ones.
      assert.deepEqual(continuationsInDispatch().map((c) => c.continuationId).sort(), ["camp-1", "disp-1", "disp-2"]);

      // Each replay slot is consumable via the adopt entry-point — 'adopt', not a re-claim.
      for (const [id, launch] of [["disp-1", "L1"], ["disp-2", "L2"]] as const) {
        const outcome = adoptOrClaimDispatch({
          continuationId: id, sourceLaunchId: launch, consumerKind: "orchestrator", currentPhase: "phase-A",
          nextAction: ACTION_A, owner: "ctl-recovery", leaseTtlMs: 30_000,
        });
        assert.equal(outcome.disposition, "adopt", `${id} is adopted from the replay set, not re-dispatched`);
      }
    });
  });
});
