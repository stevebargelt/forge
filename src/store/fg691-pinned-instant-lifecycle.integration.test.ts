// FG-691 verify: pinning an instant must hold across the real store lifecycle,
// not only across isolated predicates. This uses the SQLite store and its actual
// claim/dispatcher verbs; the clock offset advances time without sleeping.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { upsertTicket } from "./tickets.js";
import { enqueueTicket, rankTicket } from "./queue.js";
import {
  claimIsStillHeld,
  claimNextEligible,
  MIN_LEASE_TTL_MS,
  recoverableClaims,
  takeoverExpiredClaim,
} from "./queue-claims.js";
import {
  acquireDispatcherLease,
  dispatcherLeaseHeldBy,
  dispatcherLeaseView,
} from "./dispatcher-policy.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

const PK = "pk-fg691-lifecycle";
const TTL = MIN_LEASE_TTL_MS;
const OWNER_A = "dispatcher@pk-fg691-lifecycle@a";
const OWNER_B = "dispatcher@pk-fg691-lifecycle@b";
const READY_BODY = ["## Problem", "Pinned clocks must agree.", "", "## Goal", "Exercise the lease boundary.", "", "## Acceptance Criteria", "- it works"].join("\n");

let db: DatabaseInstance;
let previousDb: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  previousDb = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  db.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, 'fg691-evidence', 'path', '2026-08-07T00:00:00Z')`,
  ).run(PK);
  db.prepare(`INSERT INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', '2026-08-07T00:00:00Z')`).run(PK);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(previousDb as DatabaseInstance);
  db.close();
});

function seedQueuedTicket(): void {
  writeTransaction(() => {
    upsertTicket({
      projectKey: PK,
      ticketId: "FG-691",
      type: "story",
      status: "active",
      title: "Pinned instant lifecycle",
      body: READY_BODY,
      importedAt: "2026-08-07T00:00:00Z",
    });
  });
  rankTicket(PK, "FG-691");
  assert.equal(enqueueTicket(PK, "FG-691").ok, true);
}

test("claim lifecycle grants, holds at expiry, then fences the predecessor after takeover", () => {
  seedQueuedTicket();
  const granted = claimNextEligible({
    projectKey: PK,
    owner: "controller-a",
    capacity: 1,
    capacityScope: "project",
    leaseTtlMs: TTL,
  }).claimed;
  assert.ok(granted, "the real claim verb grants a live claim");

  const expiry = granted.leaseExpiresAtMs;
  const heldAtExpiry = claimIsStillHeld({ ...claimIdentity(granted), nowMs: expiry });
  const recoverableAtExpiry = recoverableClaims("project", PK, expiry).some((claim) => claim.id === granted.id);
  assert.equal(heldAtExpiry, true, "the incumbent may drive at the exact expiry instant");
  assert.equal(recoverableAtExpiry, false, "the same row is not available for takeover at that instant");
  assert.notEqual(heldAtExpiry, recoverableAtExpiry, "exactly one real claim predicate authorizes the lifecycle boundary");

  setPublicationClockOffsetForTest(TTL + 1);
  const taken = takeoverExpiredClaim({ projectKey: PK, claimId: granted.id, owner: "controller-b", leaseTtlMs: TTL });
  assert.ok(taken.claimed, "the real takeover verb adopts a strictly expired claim");
  assert.equal(taken.claimed.generation, granted.generation + 1);
  assert.equal(claimIsStillHeld({ ...claimIdentity(granted), nowMs: expiry + 1 }), false, "the former owner is fenced at the expired instant");
  assert.equal(
    claimIsStillHeld({ ...claimIdentity(taken.claimed), nowMs: expiry + 1 }),
    true,
    "the successor is the only authorized owner after takeover",
  );
});

test("dispatcher lifecycle preserves exact-expiry exclusion and fences the former owner", () => {
  const created = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
  assert.ok(created.granted, "the real acquire verb creates the incumbent lease");
  const expiry = created.lease.leaseExpiresAtMs;

  const denied = acquireDispatcherLease({ projectKey: PK, owner: OWNER_B, ttlMs: TTL, nowMs: expiry });
  const viewAtExpiry = dispatcherLeaseView(PK, expiry);
  assert.equal(denied.granted, false, "takeover is denied at the exact expiry instant");
  assert.equal(viewAtExpiry.live, true, "the same pinned instant reports the incumbent live");
  assert.equal(viewAtExpiry.expired, false);
  assert.equal(dispatcherLeaseHeldBy(PK, OWNER_A, created.lease.generation, expiry), true);

  const successor = acquireDispatcherLease({ projectKey: PK, owner: OWNER_B, ttlMs: TTL, nowMs: expiry + 1 });
  assert.ok(successor.granted, "the real acquire verb takes over one millisecond later");
  assert.equal(successor.mode, "took_over");
  assert.equal(dispatcherLeaseHeldBy(PK, OWNER_A, created.lease.generation, expiry + 1), false, "the expired former owner is fenced");
  assert.equal(dispatcherLeaseHeldBy(PK, OWNER_B, successor.lease.generation, expiry + 1), true, "the live successor is authorized");
});

test("omitting nowMs keeps the production default path live and non-recoverable", () => {
  seedQueuedTicket();
  const claim = claimNextEligible({
    projectKey: PK,
    owner: "controller-a",
    capacity: 1,
    capacityScope: "project",
    leaseTtlMs: TTL,
  }).claimed;
  assert.ok(claim);
  assert.equal(claimIsStillHeld(claimIdentity(claim)), true, "the existing no-instant authorization call remains live");
  assert.equal(recoverableClaims("project", PK).some((row) => row.id === claim.id), false, "the existing no-instant recovery call remains unchanged");

  const lease = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
  assert.ok(lease.granted);
  assert.equal(dispatcherLeaseView(PK).live, true, "the existing no-instant operator view remains live");
  assert.equal(dispatcherLeaseHeldBy(PK, OWNER_A, lease.lease.generation), true, "the existing no-instant fence remains authorized");
  const renewed = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
  assert.ok(renewed.granted);
  assert.equal(renewed.mode, "renewed", "the existing no-instant acquire path still adopts its owner");
});

function claimIdentity(claim: { id: string; owner: string; generation: number }): {
  projectKey: string;
  claimId: string;
  owner: string;
  generation: number;
} {
  return { projectKey: PK, claimId: claim.id, owner: claim.owner, generation: claim.generation };
}
