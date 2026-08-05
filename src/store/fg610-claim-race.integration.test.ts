// FG-610 verify: the CROSS-PROCESS claim race, against ONE real on-disk store file.
//
// WHY THIS FILE EXISTS AT ALL. Every DB test in this repo runs one process against
// one handle, and SQLite treats BEGIN IMMEDIATE as BEGIN when no other connection
// exists — so the locking mechanism that makes claim-next atomic is INERT in the unit
// tier. A green single-process run is not evidence about a concurrency primitive, and
// neither is a container pass. Here, >= 4 REAL OS processes are lined up on a file
// barrier against one FORGE_DB_PATH file (the src/store/fg562-claim-worker.ts
// precedent) so the contention is genuine.
//
// AND WHY EVERY GREEN ASSERTION IS PAIRED WITH A FALSIFICATION. A green race with no
// mutant baseline cannot distinguish "the CAS holds" from "the race never opened".
// Each of the three mutants in fg610-claim-worker.ts is RUN here and DEMONSTRATED to
// fail the corresponding assertion first:
//   duplicate  — a check-then-act outside a transaction: several processes each
//                BELIEVE they won the same ticket (and the store's unique index is
//                what turns that into an error rather than a duplicate container).
//   capacity   — a count taken outside the transaction: the ceiling is SILENTLY
//                exceeded, with no constraint violation and no trace in the data.
//   steal      — a takeover without the strict-expiry binding: a LIVE lease is taken.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyMigrations, assertSchemaVersionSupported, setDbForTest, SCHEMA_VERSION, writeTransaction } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { FORGE_HOME } from "../util/paths.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { upsertTicket } from "./tickets.js";
import { enqueueTicket, rankTicket } from "./queue.js";
import { claimNextEligible, liveClaims, MIN_LEASE_TTL_MS } from "./queue-claims.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

const WORKER = join(dirname(fileURLToPath(import.meta.url)), "fg610-claim-worker.ts");
const PK = "pk-race";
const NOW = "2026-08-05T00:00:00Z";
const TTL = MIN_LEASE_TTL_MS;

const READY_BODY = [
  "## Problem",
  "Contended.",
  "",
  "## Goal",
  "Exactly one winner.",
  "",
  "## Acceptance Criteria",
  "- one winner",
].join("\n");

let tmpSeq = 0;
function freshDir(name: string): string {
  const d = join(mkdtempSync(join(FORGE_HOME, `fg610-${name}-`)), `run-${tmpSeq++}`);
  mkdirSync(d, { recursive: true });
  return d;
}

/** A NEW-binary open of a real file: exactly getDb()'s writable path (the
 *  fg562-store-compatibility / fg562-continuation-claim template). */
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

function onFileDb<T>(path: string, fn: (db: Database.Database) => T): T {
  const db = openFileDb(path);
  const prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  try {
    return fn(db);
  } finally {
    setPublicationClockOffsetForTest(0);
    setDbForTest(prev as Database.Database);
    db.close();
  }
}

/** Seed a db-mode project with N ranked, queued, ready tickets, through the REAL
 *  store code — so what the workers race over is a genuine executable queue. */
function seedQueue(dbFile: string, n: number): void {
  onFileDb(dbFile, (db) => {
    db.prepare(
      `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
       VALUES (?, 'race-evidence', 'path', ?)`,
    ).run(PK, NOW);
    db.prepare(`INSERT OR REPLACE INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`).run(PK, NOW);
    writeTransaction(() => {
      for (let i = 1; i <= n; i++) {
        upsertTicket({
          projectKey: PK,
          ticketId: `FG-${i}`,
          type: "story",
          status: "active",
          title: `contended ${i}`,
          body: READY_BODY,
          importedAt: NOW,
        });
      }
    });
    for (let i = 1; i <= n; i++) {
      rankTicket(PK, `FG-${i}`);
      assert.equal(enqueueTicket(PK, `FG-${i}`).ok, true);
    }
    db.pragma("wal_checkpoint(TRUNCATE)");
  });
}

type WorkerReport = {
  workerId: string;
  won: string[];
  believed: string[];
  uniqueErrors: string[];
  stolen: string[];
};

/** Spawn `k` REAL node processes against `dbFile`, lined up on a file barrier so they
 *  hit the claim loop together. Bounded: rejects if a worker exceeds 60s. */
async function runWorkers(opts: {
  mode: string;
  k: number;
  n: number;
  capacity: number;
  dbFile: string;
  barrierDir: string;
  extraEnv?: Record<string, string>;
}): Promise<{ results: WorkerReport[]; wallMs: number }> {
  const { mode, k, n, capacity, dbFile, barrierDir, extraEnv = {} } = opts;
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
        CAPACITY: String(capacity),
        TTL_MS: String(TTL),
        PROJECT_KEY: PK,
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
  const results: WorkerReport[] = readdirSync(barrierDir)
    .filter((f) => f.startsWith("result-"))
    .map((f) => JSON.parse(readFileSync(join(barrierDir, f), "utf8")) as WorkerReport);
  return { results, wallMs };
}

function liveRows(dbFile: string): { ticket_id: string; owner: string; state: string }[] {
  const db = new Database(dbFile, { readonly: true });
  const rows = db
    .prepare(`SELECT ticket_id, owner, state FROM queue_claims WHERE state = 'live' ORDER BY ticket_id`)
    .all() as { ticket_id: string; owner: string; state: string }[];
  db.close();
  return rows;
}

const K = 4;
const N = 60;

// ===========================================================================
// 1) DUPLICATE CLAIM — the race is genuinely open, and the real primitive closes it.
// ===========================================================================
describe("cross-process duplicate-claim race (real OS processes, one store file)", () => {
  test(`RED baseline: a check-then-act claim lets MULTIPLE of ${K} processes believe they won the same ticket`, async () => {
    const dir = freshDir("dupred");
    const dbFile = join(dir, "dup.db");
    seedQueue(dbFile, N);

    const { results, wallMs } = await runWorkers({
      mode: "mutant-duplicate",
      k: K,
      n: N,
      capacity: N,
      dbFile,
      barrierDir: join(dir, "barrier"),
    });
    assert.equal(results.length, K, "every worker reported");

    const believers = new Map<string, number>();
    for (const r of results) for (const t of r.believed) believers.set(t, (believers.get(t) ?? 0) + 1);
    const contested = [...believers.values()].filter((c) => c > 1).length;
    const rejected = results.reduce((n, r) => n + r.uniqueErrors.length, 0);

    // THE FALSIFICATION, in two halves. (a) The window is REAL: EVERY process read
    // "no live claim" for EVERY ticket and each would have dispatched a container.
    assert.equal(
      contested,
      N,
      `FALSIFICATION: all ${N} tickets had ${K} cross-process believers under the check-then-act mutant`,
    );
    for (const r of results) {
      assert.equal(r.believed.length, N, `worker ${r.workerId} believed it had won every ticket`);
    }
    // (b) What stopped the duplicate ROW was the store, not the code path: the
    // partial unique index rejected every losing insert.
    assert.equal(rejected, N * (K - 1), "the partial unique index is what converted each duplicate into an error");
    // The invariant itself never broke, even under the mutant.
    const perTicket = new Map<string, number>();
    for (const row of liveRows(dbFile)) perTicket.set(row.ticket_id, (perTicket.get(row.ticket_id) ?? 0) + 1);
    assert.ok([...perTicket.values()].every((c) => c === 1), "idx_queue_claims_live was never violated");
    // eslint-disable-next-line no-console
    console.log(
      `  [FG-610 dup RED] ${contested}/${N} tickets multiply believed, ${rejected} inserts rejected by the index, ${K} processes, ${wallMs}ms`,
    );
  });

  test(`GREEN: the real claim grants EXACTLY ONE winner per ticket across ${K} processes, with zero index rejections`, async () => {
    const dir = freshDir("dupgreen");
    const dbFile = join(dir, "dup.db");
    seedQueue(dbFile, N);

    const { results, wallMs } = await runWorkers({
      mode: "race",
      k: K,
      n: N,
      capacity: N,
      dbFile,
      barrierDir: join(dir, "barrier"),
    });
    assert.equal(results.length, K, "every worker reported");

    const winners = new Map<string, string[]>();
    let total = 0;
    for (const r of results) {
      for (const t of r.won) {
        winners.set(t, [...(winners.get(t) ?? []), r.workerId]);
        total++;
      }
      assert.deepEqual(r.uniqueErrors, [], "the real path never even reaches the index backstop");
    }
    assert.equal(total, N, `exactly ${N} grants across ${K} processes — never two, never a torn write`);
    for (let i = 1; i <= N; i++) {
      assert.equal(winners.get(`FG-${i}`)?.length, 1, `FG-${i}: exactly one cross-process winner`);
    }

    // The store corroborates: one live claim per ticket, each owned by one worker.
    const rows = liveRows(dbFile);
    assert.equal(rows.length, N);
    for (const row of rows) assert.match(row.owner, /^w[0-3]$/, "each claim has a single consistent owner");
    // eslint-disable-next-line no-console
    console.log(`  [FG-610 dup GREEN] ${N} tickets × ${K} processes, exactly ${total} winners in ${wallMs}ms`);
  });
});

// ===========================================================================
// 2) CAPACITY — the asymmetric one. No index can catch a breached COUNT.
// ===========================================================================
describe("cross-process capacity ceiling", () => {
  const CAP = 1;

  test(`RED baseline: a capacity count taken OUTSIDE the transaction over-admits SILENTLY past a ceiling of ${CAP}`, async () => {
    const dir = freshDir("capred");
    const dbFile = join(dir, "cap.db");
    seedQueue(dbFile, K);

    const { results } = await runWorkers({
      mode: "mutant-capacity",
      k: K,
      n: K,
      capacity: CAP,
      dbFile,
      barrierDir: join(dir, "barrier"),
    });
    assert.equal(results.length, K);
    const live = liveRows(dbFile).length;
    assert.ok(
      live > CAP,
      `FALSIFICATION: ${live} live claims against a ceiling of ${CAP} — over-admitted with NO constraint violation and no trace`,
    );
    // eslint-disable-next-line no-console
    console.log(`  [FG-610 cap RED] ${live} live claims against a ceiling of ${CAP} across ${K} processes`);
  });

  test(`GREEN: the real claim never exceeds a ceiling of ${CAP} across ${K} processes`, async () => {
    const dir = freshDir("capgreen");
    const dbFile = join(dir, "cap.db");
    seedQueue(dbFile, N);

    const { results } = await runWorkers({
      mode: "race",
      k: K,
      n: N,
      capacity: CAP,
      dbFile,
      barrierDir: join(dir, "barrier"),
    });
    const total = results.reduce((n, r) => n + r.won.length, 0);
    assert.equal(total, CAP, `exactly ${CAP} grant across ${K} racing processes`);
    assert.equal(liveRows(dbFile).length, CAP, "COUNT(live claims) <= capacity after the race");
  });

  test(`GREEN: a host-scope ceiling of 2 admits exactly 2 across ${K} processes`, async () => {
    const dir = freshDir("caphost");
    const dbFile = join(dir, "cap.db");
    seedQueue(dbFile, N);
    const { results } = await runWorkers({
      mode: "race",
      k: K,
      n: N,
      capacity: 2,
      dbFile,
      barrierDir: join(dir, "barrier"),
      extraEnv: { CAPACITY_SCOPE: "host" },
    });
    assert.equal(results.reduce((n, r) => n + r.won.length, 0), 2);
    assert.equal(liveRows(dbFile).length, 2);
  });
});

// ===========================================================================
// 3) LIVE-LEASE THEFT — an expired lease is recoverable; a live one never is.
// ===========================================================================
describe("cross-process lease recovery", () => {
  test("RED baseline: a takeover without the strict-expiry binding STEALS a live lease", async () => {
    const dir = freshDir("stealred");
    const dbFile = join(dir, "steal.db");
    seedQueue(dbFile, 1);
    let claimId = "";
    onFileDb(dbFile, () => {
      const out = claimNextEligible({
        projectKey: PK,
        owner: "victim",
        capacity: 5,
        capacityScope: "project",
        leaseTtlMs: TTL,
      });
      claimId = out.claimed!.id;
    });

    const { results } = await runWorkers({
      mode: "mutant-steal",
      k: K,
      n: 1,
      capacity: 5,
      dbFile,
      barrierDir: join(dir, "barrier"),
      extraEnv: { TARGET_CLAIM: claimId },
    });
    const stolen = results.reduce((n, r) => n + r.stolen.length, 0);
    assert.ok(stolen >= 1, "FALSIFICATION: without the strict-expiry predicate a LIVE lease is stolen");
    assert.equal(liveRows(dbFile).length, 0, "the victim's live claim was retired out from under it");
  });

  test("GREEN: a LIVE lease is not stealable by any of the racing processes; the victim's row is byte-unchanged", async () => {
    const dir = freshDir("stealgreen");
    const dbFile = join(dir, "steal.db");
    seedQueue(dbFile, 1);
    let claimId = "";
    onFileDb(dbFile, () => {
      const out = claimNextEligible({
        projectKey: PK,
        owner: "victim",
        capacity: 5,
        capacityScope: "project",
        leaseTtlMs: TTL,
      });
      claimId = out.claimed!.id;
    });
    const before = JSON.stringify(
      (() => {
        const db = new Database(dbFile, { readonly: true });
        const rows = db.prepare(`SELECT * FROM queue_claims ORDER BY id`).all();
        db.close();
        return rows;
      })(),
    );

    // Every worker attempts the REAL takeover against a lease that has NOT lapsed...
    const { results } = await runWorkers({
      mode: "takeover",
      k: K,
      n: 1,
      capacity: 5,
      dbFile,
      barrierDir: join(dir, "takeover-barrier"),
      extraEnv: { TARGET_CLAIM: claimId },
    });
    assert.equal(results.reduce((n, r) => n + r.stolen.length, 0), 0, "no process took a live lease");

    // ...and every worker attempts a fresh claim-next, which must also refuse it.
    const { results: racers } = await runWorkers({
      mode: "race",
      k: K,
      n: 1,
      capacity: 5,
      dbFile,
      barrierDir: join(dir, "race-barrier"),
    });
    assert.equal(racers.reduce((n, r) => n + r.won.length, 0), 0, "claim-next refuses a live-claimed ticket too");

    const after = (() => {
      const db = new Database(dbFile, { readonly: true });
      const rows = db.prepare(`SELECT * FROM queue_claims ORDER BY id`).all();
      db.close();
      return JSON.stringify(rows);
    })();
    assert.equal(after, before, "owner, generation and lease are BYTE-UNCHANGED; zero rows were written");
  });

  test("GREEN: once the lease has STRICTLY expired, exactly ONE of the racing processes recovers it", async () => {
    const dir = freshDir("recover");
    const dbFile = join(dir, "recover.db");
    seedQueue(dbFile, 1);
    let claimId = "";
    onFileDb(dbFile, () => {
      const out = claimNextEligible({
        projectKey: PK,
        owner: "crashed",
        capacity: 5,
        capacityScope: "project",
        leaseTtlMs: TTL,
      });
      claimId = out.claimed!.id;
      // Age the lease durably rather than sleeping: rewrite the stored expiry into
      // the past. Every reader compares against the STORE clock, so this is exactly
      // what a crashed controller's row looks like to a peer process.
      const db = new Database(dbFile);
      db.prepare(`UPDATE queue_claims SET lease_expires_at_ms = 1 WHERE id = ?`).run(claimId);
      db.close();
    });

    const { results } = await runWorkers({
      mode: "takeover",
      k: K,
      n: 1,
      capacity: 5,
      dbFile,
      barrierDir: join(dir, "barrier"),
      extraEnv: { TARGET_CLAIM: claimId },
    });
    assert.equal(results.reduce((n, r) => n + r.stolen.length, 0), 1, "EXACTLY ONE process recovers an expired lease");

    const db = new Database(dbFile, { readonly: true });
    const rows = db.prepare(`SELECT generation, state, owner FROM queue_claims ORDER BY generation`).all() as {
      generation: number;
      state: string;
      owner: string;
    }[];
    db.close();
    assert.equal(rows.length, 2, "the predecessor was RETIRED, not overwritten or deleted");
    assert.deepEqual(rows.map((r) => [r.generation, r.state]), [[1, "released"], [2, "live"]]);
    assert.equal(rows[0]!.owner, "crashed", "the takeover history survives");
  });
});

// ===========================================================================
// 4) BD-15: the new table on a REAL store file never breaks an old peer.
// ===========================================================================
test("FG-610: an OLD binary keeps working against a store carrying queue_claims and its unique index", () => {
  const dbFile = join(freshDir("bd15"), "old.db");
  // An old binary's store: its own tables only, no queue_claims.
  const a = new Database(dbFile);
  a.pragma("journal_mode = WAL");
  a.exec(
    `CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, workflow TEXT NOT NULL, title TEXT NOT NULL,
       status TEXT NOT NULL, created_at TEXT NOT NULL, completed_at TEXT, metadata TEXT);`,
  );
  a.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('r1','feature','A','active',?)`).run(NOW);
  assert.equal(
    (a.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='queue_claims'`).get() as { n: number }).n,
    0,
    "precondition: the old store has no queue_claims",
  );
  a.pragma("wal_checkpoint(TRUNCATE)");
  a.close();

  // A new binary opens the same file and writes real claims.
  seedQueue(dbFile, 2);
  onFileDb(dbFile, () => {
    assert.ok(
      claimNextEligible({ projectKey: PK, owner: "new", capacity: 2, capacityScope: "project", leaseTtlMs: TTL }).claimed,
    );
    assert.equal(liveClaims(PK).length, 1);
  });

  const b = new Database(dbFile, { readonly: true });
  assert.equal(b.pragma("user_version", { simple: true }), 0, "no user_version bump — the boundary was not crossed");
  b.close();

  // The old binary is unharmed: it still reads and writes its own tables.
  const a2 = new Database(dbFile);
  a2.pragma("journal_mode = WAL");
  assert.doesNotThrow(() =>
    a2.prepare(`INSERT INTO runs (id, workflow, title, status, created_at) VALUES ('r2','feature','B','active',?)`).run(NOW),
  );
  assert.equal((a2.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number }).n, 2);
  a2.close();
});
