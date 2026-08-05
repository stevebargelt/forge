// FG-610 verify: a REAL child-process worker for the cross-process claim coverage.
//
// This is NOT a test file (no `.test.ts` suffix, so neither the unit nor the
// integration find picks it up). It is spawned as a genuine OS process by
// fg610-claim-race.integration.test.ts, pointed at ONE shared SQLite store file via
// FORGE_DB_PATH, so claimNextEligible's BEGIN IMMEDIATE locking is exercised across
// real process boundaries rather than in-process only — where SQLite treats BEGIN
// IMMEDIATE as BEGIN and the entire mechanism under test is inert.
//
// Modes (env MODE):
//   race                — claim through the REAL claimNextEligible until it refuses;
//                         report which tickets this worker was granted.
//   mutant-duplicate    — the FALSIFICATION for the duplicate-claim race: a
//                         check-then-act that reads "is there a live claim?" OUTSIDE
//                         any transaction and then inserts. Reports what it BELIEVED
//                         it had won (which is what a dispatcher would act on) and
//                         which inserts the partial unique index rejected.
//   mutant-capacity     — the FALSIFICATION for over-admission: counts live claims
//                         OUTSIDE the transaction and never re-counts inside it. This
//                         is the asymmetric one — nothing in SQLite can enforce a
//                         COUNT ceiling, so it over-admits SILENTLY, with no
//                         constraint violation and no trace in the data.
//   mutant-steal        — the FALSIFICATION for live-lease theft: a takeover UPDATE
//                         with the `lease_expires_at_ms < ?` binding REMOVED.
//   takeover            — the REAL takeover verb, raced against a LIVE lease.
//
// A file barrier (ready file + GO file) lines all workers up so the contention is
// genuine; everything is bounded (a hard spin cap, no hangs).

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from "./db.js";
import { storeNowMs } from "./publications.js";
import { claimNextEligible, takeoverExpiredClaim, type CapacityScope } from "./queue-claims.js";

const MODE = process.env["MODE"] ?? "race";
const WORKER_ID = process.env["WORKER_ID"] ?? "0";
const N = Number(process.env["N"] ?? "0");
const CAPACITY = Number(process.env["CAPACITY"] ?? "0");
const TTL_MS = Number(process.env["TTL_MS"] ?? "20000");
const PROJECT_KEY = process.env["PROJECT_KEY"] ?? "pk-race";
const SCOPE = (process.env["CAPACITY_SCOPE"] ?? "project") as CapacityScope;
const TARGET_CLAIM = process.env["TARGET_CLAIM"] ?? "";
const BARRIER_DIR = process.env["BARRIER_DIR"] ?? "";
const GO_FILE = process.env["GO_FILE"] ?? "";

const OWNER = `w${WORKER_ID}`;

type WorkerReport = {
  workerId: string;
  /** Tickets this worker actually holds a live claim for. */
  won: string[];
  /** Tickets this worker BELIEVED it had won — what a dispatcher would act on. */
  believed: string[];
  /** Inserts the partial unique index rejected. */
  uniqueErrors: string[];
  /** Claims this worker took away from their holder. */
  stolen: string[];
};

function report(r: Partial<WorkerReport>): void {
  const full: WorkerReport = { workerId: WORKER_ID, won: [], believed: [], uniqueErrors: [], stolen: [], ...r };
  writeFileSync(join(BARRIER_DIR, `result-${WORKER_ID}.json`), JSON.stringify(full));
}

function announceReady(): void {
  writeFileSync(join(BARRIER_DIR, `ready-${WORKER_ID}`), "1");
}

/** Bounded barrier: announce readiness, then spin (with a hard cap) until the parent
 *  drops the GO file. No hang — after the cap we proceed anyway. */
function awaitGo(): void {
  announceReady();
  const deadline = Date.now() + 30_000;
  while (!existsSync(GO_FILE) && Date.now() < deadline) {
    // tight spin; the window is sub-second in practice
  }
}

function ticketIds(): string[] {
  return Array.from({ length: N }, (_, i) => `FG-${i + 1}`);
}

// ── the REAL path ────────────────────────────────────────────────────────────

function runRace(): void {
  awaitGo();
  const won: string[] = [];
  // Drain: keep claiming until the primitive refuses. A refusal is terminal for this
  // worker — it never retries in a spin, so a green run cannot be an artifact of one
  // worker simply outlasting the others.
  for (let i = 0; i < N + 2; i++) {
    const out = claimNextEligible({
      projectKey: PROJECT_KEY,
      owner: OWNER,
      capacity: CAPACITY,
      capacityScope: SCOPE,
      leaseTtlMs: TTL_MS,
    });
    if (out.claimed === null) break;
    won.push(out.claimed.ticketId);
  }
  report({ won, believed: won });
}

function runTakeover(): void {
  awaitGo();
  const out = takeoverExpiredClaim({
    projectKey: PROJECT_KEY,
    claimId: TARGET_CLAIM,
    owner: OWNER,
    leaseTtlMs: TTL_MS,
  });
  report({ stolen: out.claimed ? [out.claimed.ticketId] : [] });
}

// ── the FALSIFICATION mutants ────────────────────────────────────────────────

/** THE DUPLICATE-CLAIM MUTANT. Check-then-act with NO transaction around the pair,
 *  which is the shape of "I checked, so it is free": the liveness read is taken
 *  BEFORE the barrier and acted on after it. That ordering is deliberate and is what
 *  makes this baseline DETERMINISTIC rather than a coin flip on scheduler timing —
 *  the defect it models (a decision made outside the transaction that commits it) has
 *  exactly this shape, and a falsification baseline that only sometimes falsifies is
 *  worth nothing.
 *
 *  Reporting BOTH numbers is the point: `believed` counts the processes that would
 *  each have dispatched a container for the same ticket (so the window is provably
 *  open, and the green run is evidence rather than luck), and `uniqueErrors` shows
 *  which line of defence actually closed it — the store's partial unique index, not
 *  the code path. */
function runMutantDuplicate(): void {
  const db = getDb();
  const believed = ticketIds().filter(
    (ticketId) =>
      db
        .prepare(`SELECT 1 FROM queue_claims WHERE project_key = ? AND ticket_id = ? AND state = 'live'`)
        .get(PROJECT_KEY, ticketId) === undefined,
  );
  awaitGo();

  const won: string[] = [];
  const uniqueErrors: string[] = [];
  for (const ticketId of believed) {
    // <- a dispatcher would act on `believed`, before ever reaching this insert
    const now = storeNowMs();
    try {
      db.prepare(
        `INSERT INTO queue_claims (id, project_key, ticket_id, owner, generation, ticket_revision,
           lease_expires_at_ms, heartbeat_at_ms, state, claimed_at)
         VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'live', ?)`,
      ).run(`mut-${OWNER}-${ticketId}`, PROJECT_KEY, ticketId, OWNER, now + TTL_MS, now, new Date(now).toISOString());
      won.push(ticketId);
    } catch (e) {
      if (/UNIQUE/i.test((e as Error).message)) uniqueErrors.push(ticketId);
      else throw e;
    }
  }
  report({ won, believed, uniqueErrors });
}

/** THE OVER-ADMISSION MUTANT. The capacity count is taken OUTSIDE the write
 *  transaction and never re-taken inside it. Each worker targets its OWN ticket, so
 *  the unique index never fires — and nothing else in SQLite can. The result is a
 *  silent, permanent breach of the ceiling with no constraint violation and no trace,
 *  which is exactly why over-admission is the sharpest risk in this slice. */
function runMutantCapacity(): void {
  const db = getDb();
  const ticketId = ticketIds()[Number(WORKER_ID) % Math.max(1, N)]!;
  // The count is read BEFORE the barrier releases, which is the honest exaggeration of
  // "read, then act later" — the same defect a phase-1-only count has, made reliable.
  const seen = (
    db.prepare(`SELECT COUNT(*) AS n FROM queue_claims WHERE project_key = ? AND state = 'live'`).get(PROJECT_KEY) as {
      n: number;
    }
  ).n;
  awaitGo();
  if (seen >= CAPACITY) {
    report({});
    return;
  }
  const now = storeNowMs();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO queue_claims (id, project_key, ticket_id, owner, generation, ticket_revision,
         lease_expires_at_ms, heartbeat_at_ms, state, claimed_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, 'live', ?)`,
    ).run(`mut-${OWNER}-${ticketId}`, PROJECT_KEY, ticketId, OWNER, now + TTL_MS, now, new Date(now).toISOString());
  }).immediate();
  report({ won: [ticketId], believed: [ticketId] });
}

/** THE LIVE-LEASE-THEFT MUTANT. The takeover UPDATE with its strict-expiry binding
 *  removed. It matches a row whose lease has NOT lapsed and retires it, so a second
 *  controller drives a ticket whose first controller's container is still running. */
function runMutantSteal(): void {
  awaitGo();
  const db = getDb();
  const now = storeNowMs();
  const stolen = db
    .transaction((): number =>
      db
        .prepare(
          `UPDATE queue_claims SET state = 'released', outcome = 'stolen', released_at = ?
            WHERE id = ? AND state = 'live'`,
        )
        .run(new Date(now).toISOString(), TARGET_CLAIM).changes,
    )
    .immediate();
  report({ stolen: stolen === 1 ? [TARGET_CLAIM] : [] });
}

switch (MODE) {
  case "mutant-duplicate":
    runMutantDuplicate();
    break;
  case "mutant-capacity":
    runMutantCapacity();
    break;
  case "mutant-steal":
    runMutantSteal();
    break;
  case "takeover":
    runTakeover();
    break;
  default:
    runRace();
}
