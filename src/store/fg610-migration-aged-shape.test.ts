// FG-610 (FG-496 Slice E): forward-open safety against a HAND-AUTHORED AGED
// CONSTRAINT SHAPE, which is then made to SERVE every new claim/lease/recovery path.
//
// ─── WHY THE FIXTURE IS HAND-AUTHORED ────────────────────────────────────────
// fg608-migration-parity.test.ts already proves COLUMN parity generically, and it
// builds its "old" DB by DROPping columns off today's fresh schema — so that fixture
// carries TODAY'S CONSTRAINTS by construction: today's PK membership, today's UNIQUE
// shape, today's foreign keys. The dogfood host's real defect was a ticket_events
// table with a SINGLE-COLUMN primary key, a constraint shape no amount of column
// dropping can produce, and that is exactly why it stayed invisible until
// `forge backlog migrate` died on the host.
//
// So the DDL below is written out BY HAND in the shape a pre-FG-610 binary actually
// created — aged CONSTRAINTS, not merely absent columns — and the ordinary open path
// (SCHEMA_SQL then applyMigrations, exactly as getDb does it) is then asked to bring
// it forward and SERVE: claim-next grants, heartbeat renews, an expired lease is
// taken over, a release lands, and FG-609's rank / enqueue / reorder / readiness all
// still work on the same store. Column-presence parity does not satisfy that.

import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "./schema.js";
import { applyMigrations, setDbForTest, writeTransaction } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { upsertTicket, getTicket } from "./tickets.js";
import {
  dequeueTicket,
  enqueueTicket,
  executableQueue,
  moveQueuePosition,
  queueEvents,
  rankTicket,
  rankedOrder,
  readinessView,
  recheckReadiness,
} from "./queue.js";
import {
  claimNextEligible,
  claimHistoryForTicket,
  getClaim,
  heartbeatClaim,
  liveClaims,
  recordClaimLaunch,
  releaseClaim,
  takeoverExpiredClaim,
  MIN_LEASE_TTL_MS,
  TAKEOVER_OUTCOME,
} from "./queue-claims.js";

const PK = "pk-aged-e";
const AGED_AT = "2026-03-04T05:06:07.000Z";
const TTL = MIN_LEASE_TTL_MS;

const READY_BODY = [
  "## Problem",
  "An aged store must claim.",
  "",
  "## Goal",
  "It opens, migrates, and serves every claim path.",
  "",
  "## Acceptance Criteria",
  "- it claims",
].join("\n");

// The store as a PRE-SLICE-E binary wrote it. Hand-authored, carrying AGED
// CONSTRAINT SHAPES a drop-from-fresh fixture cannot produce:
//
//   tickets                — no priority_rank, no revision/body_hash, no CHECK on
//                            status (the CHECK arrived with FG-606 and an older row
//                            is not bound by it).
//   ticket_events          — the DOGFOOD HOST'S SINGLE-COLUMN PRIMARY KEY. Kept on
//                            purpose: it is what proves the fixture is genuinely aged,
//                            and the FG-608 rebuild has to converge it before any of
//                            Slice E's paths run.
//   queue_membership       — the FG-609 table WITHOUT its composite FOREIGN KEY and
//                            without its index. CREATE TABLE IF NOT EXISTS no-ops over
//                            it forever, so this constraint divergence survives the
//                            open — which is the point.
//   readiness_assessments  — likewise, no FOREIGN KEY.
//   queue_events           — an INTEGER PRIMARY KEY with NO AUTOINCREMENT, and no
//                            indexes. Another constraint-level divergence.
//   blocker_evidence       — the Slice A five columns only.
//
// There is NO queue_claims table at all — that is the other half of forward-open
// safety, and the half this slice adds.
const AGED_SCHEMA_SQL = `
CREATE TABLE tickets (
  project_key   TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL,
  title         TEXT NOT NULL,
  body          TEXT NOT NULL DEFAULT '',
  created       TEXT,
  closed        TEXT,
  closed_commit TEXT,
  epic          TEXT,
  frontmatter   TEXT,
  imported_at   TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id)
);

CREATE TABLE blocker_evidence (
  id          TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  reason      TEXT,
  source      TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (project_key, ticket_id, source),
  FOREIGN KEY (project_key, ticket_id)
    REFERENCES tickets(project_key, ticket_id) ON DELETE CASCADE
);

CREATE TABLE ticket_events (
  event_key   TEXT PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE queue_membership (
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  enqueued_at TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id)
);

CREATE TABLE readiness_assessments (
  project_key  TEXT NOT NULL,
  ticket_id    TEXT NOT NULL,
  body_hash    TEXT NOT NULL,
  outcome      TEXT NOT NULL,
  evaluated_at TEXT NOT NULL,
  PRIMARY KEY (project_key, ticket_id)
);

CREATE TABLE queue_events (
  id          INTEGER PRIMARY KEY,
  project_key TEXT NOT NULL,
  ticket_id   TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE project_identity (
  project_key          TEXT PRIMARY KEY,
  repo_evidence_key    TEXT NOT NULL UNIQUE,
  repo_evidence_source TEXT NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE TABLE ticket_storage_mode (
  project_key TEXT PRIMARY KEY,
  mode        TEXT NOT NULL DEFAULT 'markdown',
  updated_at  TEXT NOT NULL
);

CREATE TABLE runs (
  id         TEXT PRIMARY KEY,
  workflow   TEXT NOT NULL,
  title      TEXT NOT NULL,
  status     TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE tasks (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  phase        TEXT NOT NULL,
  agent_role   TEXT NOT NULL,
  status       TEXT NOT NULL,
  task_package TEXT NOT NULL,
  created_at   TEXT NOT NULL
);

CREATE TABLE ticket_dispatch_evidence (
  task_id       TEXT PRIMARY KEY,
  project_key   TEXT NOT NULL,
  ticket_id     TEXT NOT NULL,
  revision      INTEGER NOT NULL,
  body_hash     TEXT NOT NULL,
  dispatched_at TEXT NOT NULL
);
`;

/** An aged store with real pre-Slice-E rows, opened exactly as a real open does:
 *  SCHEMA_SQL (whose CREATEs no-op over the existing tables — the very reason the
 *  FG-608 bug was invisible) followed by applyMigrations. */
function agedThenMigrated(): DatabaseInstance {
  const db = new Database(":memory:");
  db.exec(AGED_SCHEMA_SQL);

  const ins = db.prepare(
    `INSERT INTO tickets (project_key, ticket_id, type, status, title, body, created, imported_at)
     VALUES (?, ?, 'story', 'active', ?, ?, '2026-01-01', ?)`,
  );
  ins.run(PK, "FG-1", "aged one", READY_BODY, AGED_AT);
  ins.run(PK, "FG-2", "aged two", READY_BODY, AGED_AT);
  ins.run(PK, "FG-3", "aged three", READY_BODY, AGED_AT);

  // The project was already cut over to db mode by the aged binary — otherwise the
  // D6 guard would refuse and this file could not prove the claim paths at all.
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, 'aged-evidence', 'path', ?)`,
  ).run(PK, AGED_AT);
  db.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`).run(PK, AGED_AT);

  // Operator queue state the aged binary had already written, in the aged shape.
  db.prepare(`INSERT INTO queue_membership (project_key, ticket_id, enqueued_at) VALUES (?, 'FG-1', ?)`).run(PK, AGED_AT);

  db.exec(SCHEMA_SQL);
  applyMigrations(db);
  db.pragma("foreign_keys = ON");
  return db;
}

function withAgedDb<T>(fn: (db: DatabaseInstance) => T): T {
  const db = agedThenMigrated();
  const prev = setDbForTest(db);
  setPublicationClockOffsetForTest(0);
  try {
    return fn(db);
  } finally {
    setPublicationClockOffsetForTest(0);
    setDbForTest(prev as DatabaseInstance);
    db.close();
  }
}

// ─── the fixture is genuinely aged ───────────────────────────────────────────

test("FG-610: the fixture carries AGED CONSTRAINT SHAPES a drop-from-fresh fixture cannot produce", () => {
  const raw = new Database(":memory:");
  raw.exec(AGED_SCHEMA_SQL);

  // The dogfood host's single-column ticket_events PK.
  const pk = (raw.prepare(`PRAGMA table_info(ticket_events)`).all() as { name: string; pk: number }[])
    .filter((c) => c.pk > 0)
    .map((c) => c.name);
  assert.deepEqual(pk, ["event_key"], "the fixture must carry the dogfood host's aged constraint shape");

  // FG-609's queue tables WITHOUT their foreign keys — a divergence CREATE TABLE IF
  // NOT EXISTS can never repair, so the new paths genuinely run against it.
  assert.deepEqual(raw.prepare(`PRAGMA foreign_key_list(queue_membership)`).all(), []);
  assert.deepEqual(raw.prepare(`PRAGMA foreign_key_list(readiness_assessments)`).all(), []);
  assert.equal(
    /AUTOINCREMENT/i.test(
      (raw.prepare(`SELECT sql FROM sqlite_master WHERE name='queue_events'`).get() as { sql: string }).sql,
    ),
    false,
    "aged queue_events has no AUTOINCREMENT",
  );
  assert.equal(
    (raw.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='queue_claims'`).get() as {
      n: number;
    }).n,
    0,
    "precondition: the aged store has no queue_claims at all",
  );
  raw.close();

  // ...and the open path converges ticket_events, which is what lets the rest run.
  withAgedDb((db) => {
    const converged = (db.prepare(`PRAGMA table_info(ticket_events)`).all() as { name: string; pk: number }[])
      .filter((c) => c.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((c) => c.name);
    assert.deepEqual(converged, ["project_key", "ticket_id", "event_key"]);
    // The aged queue tables are LEFT as they are — additive-only means the open path
    // repairs nothing it does not have to, and nothing here depends on those FKs.
    assert.deepEqual(db.prepare(`PRAGMA foreign_key_list(queue_membership)`).all(), []);
  });
});

test("FG-610: queue_claims arrives WHOLE, with both indexes, on an aged store", () => {
  withAgedDb((db) => {
    const cols = (db.prepare(`PRAGMA table_info(queue_claims)`).all() as { name: string }[]).map((c) => c.name);
    assert.deepEqual(cols, [
      "id",
      "project_key",
      "ticket_id",
      "owner",
      "generation",
      "ticket_revision",
      "lease_expires_at_ms",
      "heartbeat_at_ms",
      "launch_id",
      "run_id",
      "state",
      "outcome",
      "scan_evidence",
      "claimed_at",
      "released_at",
    ]);
    const indexes = (db.prepare(`PRAGMA index_list(queue_claims)`).all() as { name: string; unique: number; partial: number }[]);
    const live = indexes.find((i) => i.name === "idx_queue_claims_live")!;
    assert.equal(live.unique, 1, "the at-most-one-live-claim backstop is UNIQUE");
    assert.equal(live.partial, 1, "and partial over the live state — released rows are history");
    assert.ok(indexes.some((i) => i.name === "idx_queue_claims_scope"), "the capacity-count index arrived too");
    // The aged tickets table gained the columns the claim path reads.
    const ticketCols = (db.prepare(`PRAGMA table_info(tickets)`).all() as { name: string }[]).map((c) => c.name);
    for (const c of ["priority_rank", "revision", "body_hash"]) assert.ok(ticketCols.includes(c), `tickets.${c}`);
  });
});

test("FG-610: opening an aged store does not bump user_version, and re-opening is a no-op", () => {
  withAgedDb((db) => {
    assert.equal(db.pragma("user_version", { simple: true }), 0, "additive-only: an older binary still opens this store");
    const shape = (): string =>
      JSON.stringify(db.prepare(`SELECT name, sql FROM sqlite_master ORDER BY name`).all());
    const before = shape();
    db.exec(SCHEMA_SQL);
    applyMigrations(db);
    assert.equal(shape(), before, "re-running the open path changes nothing");
  });
});

// ─── the aged store SERVES every path ───────────────────────────────────────

test("FG-610: an aged store serves claim → heartbeat → launch stamp → expiry takeover → release", () => {
  withAgedDb((db) => {
    // FG-609's own verbs still work on the aged shape, and its aged membership row
    // for FG-1 survives untouched.
    rankTicket(PK, "FG-1");
    rankTicket(PK, "FG-2");
    rankTicket(PK, "FG-3", 1);
    assert.deepEqual(rankedOrder(PK).map((r) => r.ticketId), ["FG-3", "FG-1", "FG-2"]);
    assert.equal(enqueueTicket(PK, "FG-1").ok, true);
    assert.equal(enqueueTicket(PK, "FG-2").ok, true);
    assert.equal(enqueueTicket(PK, "FG-3").ok, true);
    assert.equal(readinessView(PK, "FG-1")?.outcome, "ready");
    moveQueuePosition(PK, "FG-1", 1);
    assert.deepEqual(executableQueue(PK).map((e) => e.ticketId), ["FG-1", "FG-3", "FG-2"]);

    // CLAIM — the head of the canonical order, on an aged store.
    const claim = claimNextEligible({
      projectKey: PK,
      owner: "ctl-aged-1",
      capacity: 2,
      capacityScope: "project",
      leaseTtlMs: TTL,
    });
    assert.equal(claim.reason, "granted");
    assert.equal(claim.claimed?.ticketId, "FG-1");
    const original = claim.claimed!;

    // HEARTBEAT renews.
    setPublicationClockOffsetForTest(1_000);
    const renewed = heartbeatClaim({
      projectKey: PK,
      claimId: original.id,
      owner: "ctl-aged-1",
      generation: original.generation,
      leaseTtlMs: TTL,
    });
    assert.ok(renewed && renewed.leaseExpiresAtMs > original.leaseExpiresAtMs);

    // The LAUNCH IDENTITY is durable before any launch.
    assert.ok(
      recordClaimLaunch({
        projectKey: PK,
        claimId: original.id,
        owner: "ctl-aged-1",
        generation: original.generation,
        launchId: "launch-aged",
        runId: "run-aged",
      }),
    );

    // A second controller claims the next eligible ticket — capacity 2 admits it.
    const second = claimNextEligible({
      projectKey: PK,
      owner: "ctl-aged-2",
      capacity: 2,
      capacityScope: "project",
      leaseTtlMs: TTL,
    });
    assert.equal(second.claimed?.ticketId, "FG-3");
    // ...and a third is refused at the ceiling, on the aged store.
    const third = claimNextEligible({
      projectKey: PK,
      owner: "ctl-aged-3",
      capacity: 2,
      capacityScope: "project",
      leaseTtlMs: TTL,
    });
    assert.equal(third.reason, "capacity");

    // EXPIRY TAKEOVER: controller 1 crashes; its lease lapses; recovery adopts.
    setPublicationClockOffsetForTest(TTL + 5_000);
    const takeover = takeoverExpiredClaim({
      projectKey: PK,
      claimId: original.id,
      owner: "ctl-aged-recovery",
      leaseTtlMs: TTL,
    });
    assert.ok(takeover.claimed, "an expired lease is recovered on an aged store");
    assert.equal(takeover.claimed!.generation, original.generation + 1);
    assert.equal(
      takeover.claimed !== null ? takeover.takenOverFrom.launchId : null,
      "launch-aged",
      "recovery discovers the prior launch DIRECTLY",
    );
    assert.equal(getClaim(PK, original.id)!.state, "released");
    assert.equal(getClaim(PK, original.id)!.outcome, TAKEOVER_OUTCOME);

    // RELEASE lands.
    const released = releaseClaim({
      projectKey: PK,
      claimId: takeover.claimed!.id,
      owner: "ctl-aged-recovery",
      generation: takeover.claimed!.generation,
      outcome: "completed",
    });
    assert.equal(released?.state, "released");
    assert.equal(released?.outcome, "completed");
    assert.equal(liveClaims(PK).map((c) => c.ticketId).sort().join(","), "FG-3");

    // The claim history — including the retired predecessor — survived.
    assert.deepEqual(
      claimHistoryForTicket(PK, "FG-1").map((c) => [c.generation, c.state, c.outcome]),
      [
        [1, "released", TAKEOVER_OUTCOME],
        [2, "released", "completed"],
      ],
    );

    // FG-609's remaining verbs still work afterwards, and the aged queue_events
    // table (no AUTOINCREMENT) took every new event type.
    dequeueTicket(PK, "FG-2");
    recheckReadiness(PK, "FG-2");
    const types = new Set(queueEvents(PK).map((e) => e.eventType));
    for (const t of ["rank", "enqueue", "readiness", "reorder", "dequeue", "claim", "release"]) {
      assert.ok(types.has(t as never), `an aged store must append '${t}' events too`);
    }
    // And the claim ledger really is on this aged database.
    assert.ok(
      (db.prepare(`SELECT COUNT(*) AS n FROM queue_claims`).get() as { n: number }).n >= 3,
      "the aged store carries real claim rows",
    );
  });
});

test("FG-610: rank, membership and readiness on an aged store are untouched by the whole claim lifecycle", () => {
  withAgedDb((db) => {
    writeTransaction(() => {
      upsertTicket({
        projectKey: PK,
        ticketId: "FG-4",
        type: "story",
        status: "active",
        title: "added after the migration",
        body: READY_BODY,
        importedAt: AGED_AT,
      });
    });
    rankTicket(PK, "FG-4");
    assert.equal(enqueueTicket(PK, "FG-4").ok, true);

    const snapshot = (): string =>
      JSON.stringify([
        db.prepare(`SELECT ticket_id, priority_rank, status FROM tickets WHERE project_key = ? ORDER BY ticket_id`).all(PK),
        db.prepare(`SELECT * FROM queue_membership WHERE project_key = ? ORDER BY ticket_id`).all(PK),
        db.prepare(`SELECT * FROM readiness_assessments WHERE project_key = ? ORDER BY ticket_id`).all(PK),
      ]);
    const before = snapshot();

    const claim = claimNextEligible({
      projectKey: PK,
      owner: "ctl",
      capacity: 5,
      capacityScope: "host",
      leaseTtlMs: TTL,
    });
    assert.equal(claim.reason, "granted");
    setPublicationClockOffsetForTest(TTL + 1);
    const takeover = takeoverExpiredClaim({ projectKey: PK, claimId: claim.claimed!.id, owner: "r", leaseTtlMs: TTL });
    assert.ok(takeover.claimed);
    releaseClaim({
      projectKey: PK,
      claimId: takeover.claimed!.id,
      owner: "r",
      generation: takeover.claimed!.generation,
      outcome: "done",
    });

    assert.equal(snapshot(), before, "the scheduler mutated no rank, membership or readiness state");
    assert.equal(getTicket(PK, "FG-4")!.status, "active", "and no ticket lifecycle status");
  });
});
