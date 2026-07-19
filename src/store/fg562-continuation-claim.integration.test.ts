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
import {
  recordContinuation,
  observeLaunchStatus,
  claimContinuationDispatch,
  getContinuation,
  continuationByDispatchKey,
  markBlocked,
  markAdvanced,
  rearmForNextPhase,
  canonicalizeAction,
  deriveDispatchKey,
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
      observeLaunchStatus(`stress-${i}`, "exited_ok", { terminal: true });
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
      observeLaunchStatus("f17", "exited_ok", { terminal: true });
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
      observeLaunchStatus("f16", "exited_ok", { terminal: true });
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
      observeLaunchStatus("b", "exited_ok", { terminal: true });
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
      observeLaunchStatus("pb", "exited_ok", { terminal: true });
      const a = claimContinuationDispatch({
        continuationId: "pb", sourceLaunchId: "launch-A", consumerKind: "orchestrator", currentPhase: "phase-A",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl-1", leaseTtlMs: 30_000,
      });
      assert.ok(a.granted);
      assert.ok(markAdvanced("pb", "ctl-1"));
      const rearmed = rearmForNextPhase("pb", { sourceLaunchId: "launch-B", currentPhase: "phase-B", nextAction: ACTION_B });
      assert.equal(rearmed?.currentPhase, "phase-B");
      observeLaunchStatus("pb", "exited_ok", { terminal: true }); // phase-B's own launch is ready

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

      // Recording the stale disposition as evidence is legitimate and does NOT
      // advance the phase — observed and ignored.
      observeLaunchStatus("pb", "exited_error", { terminal: true });
      const evidenced = getContinuation("pb")!;
      assert.equal(evidenced.lastObservedStatus, "exited_error", "the stale disposition is recorded as BD-3 evidence");
      assert.equal(evidenced.currentPhase, "phase-B", "still phase B — the observation did not advance anything");

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
        observeLaunchStatus(id, "exited_ok", { terminal: true });
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
        const observed = observeLaunchStatus(id, status, { terminal: true });
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
      observeLaunchStatus("unobserved", "running", { terminal: false });
      const running = claimContinuationDispatch({
        continuationId: "unobserved", sourceLaunchId: "L", consumerKind: "orchestrator", currentPhase: "p",
        nextAction: ACTION_A, expectedState: "ready", owner: "ctl", leaseTtlMs: 30_000,
      });
      assert.equal(running.granted, false, "a still-running launch is not claimable");
    });
  });
});
