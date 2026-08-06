// FG-591 step 2: the dispatcher POLICY and the dispatcher LEASE, against a real
// in-memory SQLite DB running the REAL store code.
//
// THE BAR THIS FILE HOLDS ITSELF TO. The policy's whole job is to REFUSE things, so
// every "requires" invariant is proven by its negative half:
//   * a disarmed policy is READABLE and blocks nothing but new claims — the lease it
//     already holds still renews, because a disarm that stopped renewal would lapse a
//     lease over a running container and invite the duplicate execution the claim
//     primitive exists to prevent;
//   * a max_active_runs reduction below current usage changes NO live row — proven
//     against real live claims made through claimNextEligible, with a full row census
//     of every table before and after;
//   * a TTL under the derived floor refuses BY NAME and writes NOTHING (census again);
//   * a superseded generation can neither renew nor release;
//   * a takeover happens only after STRICT expiry — and, because the store clock
//     cannot be parked on an exact instant, strictness is proven against the CAS
//     PREDICATE itself run with now set exactly equal to the expiry, with a mutant
//     that drops the predicate shown to steal a live lease.
//
// STATED LIMIT: like every DB test in this repo this runs ONE process against ONE
// handle, and SQLite treats BEGIN IMMEDIATE as BEGIN when no other connection exists,
// so the LOCKING mechanism is inert here. The fencing CAS predicates are not — they
// are ordinary SQL and are what these tests exercise.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "./db.js";
import { setPublicationClockOffsetForTest } from "./publications.js";
import { upsertTicket, type TicketRow } from "./tickets.js";
import { enqueueTicket, rankTicket, QueueRefusal } from "./queue.js";
import {
  claimNextEligible,
  heartbeatClaim,
  liveClaims,
  MIN_LEASE_TTL_MS,
  CLAIM_HEARTBEAT_INTERVAL_MS,
  CLAIM_WRITE_LOCK_WAIT_MS,
} from "./queue-claims.js";
import {
  DEFAULT_CAPACITY_SCOPE,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_WORKFLOW,
  HOST_POLICY_SCOPE,
  acquireDispatcherLease,
  dispatcherLeaseHeldBy,
  dispatcherLeaseView,
  getDispatcherLease,
  getDispatcherPolicy,
  releaseDispatcherLease,
  renewDispatcherLease,
  setDispatcherPolicy,
  setProjectDefaultWorkflow,
} from "./dispatcher-policy.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-dispatcher";
const PK2 = "pk-dispatcher-two";
const NOW = "2026-08-06T00:00:00Z";
const OPERATOR = "steve@laptop";

/** A lease TTL at the derived floor: short enough to age past with the store clock. */
const TTL = MIN_LEASE_TTL_MS;
const OWNER_A = `dispatcher@${PK}@instance-A`;
const OWNER_B = `dispatcher@${PK}@instance-B`;

const READY_BODY = [
  "## Problem",
  "Something is wrong.",
  "",
  "## Goal",
  "Make it right.",
  "",
  "## Acceptance Criteria",
  "- it works",
].join("\n");

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setPublicationClockOffsetForTest(0);
  for (const pk of [PK, PK2]) registerDbProject(pk);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ─── fixtures ────────────────────────────────────────────────────────────────

function registerDbProject(projectKey: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at)
     VALUES (?, ?, 'path', ?)`,
  ).run(projectKey, `evidence-${projectKey}`, NOW);
  db.prepare(
    `INSERT OR REPLACE INTO ticket_storage_mode (project_key, mode, updated_at) VALUES (?, 'db', ?)`,
  ).run(projectKey, NOW);
}

function ticket(id: string, projectKey: string): TicketRow {
  return {
    projectKey,
    ticketId: id,
    type: "story",
    status: "active",
    title: `title ${id}`,
    body: READY_BODY,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: NOW,
    importedFrom: null,
  };
}

function seedQueued(ids: string[], projectKey: string = PK): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id, projectKey));
  });
  for (const id of ids) {
    rankTicket(projectKey, id);
    const res = enqueueTicket(projectKey, id);
    assert.equal(res.ok, true, `${id} must enqueue for the fixture to mean anything`);
  }
}

/** EVERY row of EVERY table, as text. Stronger than counting rows: a refusal that
 *  quietly UPDATED a column passes a count census and fails this one. */
function fullDump(): string {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
}

/** Every table EXCEPT the one a policy write is expected to touch. What "an admission
 *  test is not a reaper" means, expressed as data. */
function dumpExcept(excluded: string[]): string {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  )
    .map((t) => t.name)
    .filter((t) => !excluded.includes(t));
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
}

function refusalFrom(fn: () => unknown): QueueRefusal {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof QueueRefusal, `expected a QueueRefusal, got ${String(e)}`);
    return e as QueueRefusal;
  }
  assert.fail("expected a refusal, but the call succeeded");
}

// ─── (1) reading the policy: fail closed, and say when a value is a default ──

describe("reading the policy", () => {
  test("a store that has NEVER been configured is DISARMED, and says so", () => {
    const p = getDispatcherPolicy();
    assert.equal(p.armed, false, "fail-closed: a store nobody armed never dispatches");
    assert.equal(p.configured, false, "and the surface must be able to say the values are defaults");
    assert.equal(p.maxActiveRuns, DEFAULT_MAX_ACTIVE_RUNS);
    assert.equal(p.capacityScope, DEFAULT_CAPACITY_SCOPE);
    assert.equal(p.capacityScope, "host", "the ceiling protects the machine, not one project");
    assert.equal(p.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    assert.equal(p.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    assert.equal(p.defaultWorkflow, DEFAULT_WORKFLOW);
    assert.equal(p.updatedAt, null);
    assert.equal(p.updatedBy, null);
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatcher_policy`).get() as { n: number }).n,
      0,
      "reading the policy never materialises a row",
    );
  });

  test("the SHIPPED DEFAULTS satisfy the cadence rule they are validated against", () => {
    // A default pair that its own validator would refuse is a trap laid for the first
    // operator who edits one field: the untouched half makes their write refuse.
    const p = setDispatcherPolicy({ armed: true, updatedBy: OPERATOR });
    assert.equal(p.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    assert.equal(p.heartbeatMs, DEFAULT_HEARTBEAT_MS);
    assert.ok(
      DEFAULT_LEASE_TTL_MS >= 2 * DEFAULT_HEARTBEAT_MS + CLAIM_WRITE_LOCK_WAIT_MS,
      "the default TTL survives a missed renewal plus the write-lock wait",
    );
    assert.ok(DEFAULT_LEASE_TTL_MS >= MIN_LEASE_TTL_MS);
  });

  test("a partially written row still reads as a complete, safe answer", () => {
    // A hand-written row with NULL everywhere but the required columns — the shape an
    // aged store or a half-finished write leaves behind.
    db.prepare(`INSERT INTO dispatcher_policy (scope_key, updated_at) VALUES ('host', ?)`).run(NOW);
    const p = getDispatcherPolicy();
    assert.equal(p.armed, false, "NULL armed is DISARMED");
    assert.equal(p.maxActiveRuns, DEFAULT_MAX_ACTIVE_RUNS);
    assert.equal(p.leaseTtlMs, DEFAULT_LEASE_TTL_MS);
    assert.equal(p.configured, true, "the row exists, even if it says nothing");
  });

  test("an unrecognised capacity_scope in the row reads as the default rather than as itself", () => {
    db.prepare(
      `INSERT INTO dispatcher_policy (scope_key, capacity_scope, updated_at) VALUES ('host', 'galaxy', ?)`,
    ).run(NOW);
    assert.equal(getDispatcherPolicy().capacityScope, DEFAULT_CAPACITY_SCOPE);
  });
});

// ─── (2) writing the policy: who, and what refuses ───────────────────────────

describe("writing the policy", () => {
  test("arming records WHO and WHEN", () => {
    const p = setDispatcherPolicy({ armed: true, maxActiveRuns: 3, updatedBy: OPERATOR });
    assert.equal(p.armed, true);
    assert.equal(p.maxActiveRuns, 3);
    assert.equal(p.updatedBy, OPERATOR);
    assert.ok(p.updatedAt, "and when");
    assert.equal(getDispatcherPolicy().armed, true, "the fact is durable, not returned-only");
  });

  test("a policy write with no author refuses by name and writes nothing", () => {
    const before = fullDump();
    const r = refusalFrom(() => setDispatcherPolicy({ armed: true, updatedBy: "" }));
    assert.match(r.message, /must name WHO made it/);
    assert.equal(fullDump(), before, "a refused policy write writes nothing");
  });

  test("a partial update moves only the named field", () => {
    setDispatcherPolicy({ armed: true, maxActiveRuns: 4, defaultWorkflow: "bugfix", updatedBy: OPERATOR });
    const p = setDispatcherPolicy({ maxActiveRuns: 2, updatedBy: "someone-else" });
    assert.equal(p.maxActiveRuns, 2);
    assert.equal(p.armed, true, "lowering the ceiling did not disarm");
    assert.equal(p.defaultWorkflow, "bugfix", "and did not reset the workflow");
    assert.equal(p.updatedBy, "someone-else");
  });

  test("disarming is a separate fact from the ceiling", () => {
    setDispatcherPolicy({ armed: true, maxActiveRuns: 3, updatedBy: OPERATOR });
    const p = setDispatcherPolicy({ armed: false, updatedBy: OPERATOR });
    assert.equal(p.armed, false);
    assert.equal(p.maxActiveRuns, 3, "the ceiling is unchanged — disarm is not a reset");
  });

  test("a lease TTL below MIN_LEASE_TTL_MS refuses BY NAME and writes nothing", () => {
    const before = fullDump();
    const r = refusalFrom(() =>
      setDispatcherPolicy({ leaseTtlMs: MIN_LEASE_TTL_MS - 1, heartbeatMs: CLAIM_HEARTBEAT_INTERVAL_MS, updatedBy: OPERATOR }),
    );
    assert.match(r.message, new RegExp(String(MIN_LEASE_TTL_MS)), "the floor is named, not implied");
    assert.match(r.message, /below the derived floor/);
    assert.match(r.message, /taken over while its container is still running/);
    assert.match(r.message, /Nothing was written/);
    assert.equal(fullDump(), before, "and nothing was, in fact, written");
  });

  test("a TTL that cannot survive the heartbeat cadence refuses and names both numbers", () => {
    const before = fullDump();
    // Legal against the floor on its own; illegal beside a 5-minute renewal cadence.
    const r = refusalFrom(() => setDispatcherPolicy({ leaseTtlMs: MIN_LEASE_TTL_MS, updatedBy: OPERATOR }));
    assert.match(r.message, /cannot survive/);
    assert.match(r.message, new RegExp(String(DEFAULT_HEARTBEAT_MS)), "the cadence it collides with is named");
    assert.equal(fullDump(), before);

    // Moving BOTH together is how the operator narrows it, and that is accepted.
    const ok = setDispatcherPolicy({ leaseTtlMs: 60_000, heartbeatMs: 20_000, updatedBy: OPERATOR });
    assert.equal(ok.leaseTtlMs, 60_000);
    assert.equal(ok.heartbeatMs, 20_000);
  });

  test("raising the heartbeat against an already-narrow TTL refuses — the MERGED result is validated", () => {
    setDispatcherPolicy({ leaseTtlMs: 60_000, heartbeatMs: 20_000, updatedBy: OPERATOR });
    const before = fullDump();
    const r = refusalFrom(() => setDispatcherPolicy({ heartbeatMs: 45_000, updatedBy: OPERATOR }));
    assert.match(r.message, /cannot survive/);
    assert.equal(fullDump(), before, "the half-written pair never reached the row");
  });

  test("a sub-floor heartbeat refuses — the heartbeat must not become the contention", () => {
    const before = fullDump();
    const r = refusalFrom(() =>
      setDispatcherPolicy({ heartbeatMs: CLAIM_HEARTBEAT_INTERVAL_MS - 1, updatedBy: OPERATOR }),
    );
    assert.match(r.message, /below the .*floor/);
    assert.equal(fullDump(), before);
  });

  test("a nonsense ceiling or scope refuses; a ceiling of 0 is legal and means admit nothing", () => {
    for (const bad of [-1, 1.5, Number.NaN]) {
      const before = fullDump();
      const r = refusalFrom(() => setDispatcherPolicy({ maxActiveRuns: bad, updatedBy: OPERATOR }));
      assert.match(r.message, /non-negative whole number/);
      assert.equal(fullDump(), before);
    }
    const scopeRefusal = refusalFrom(() =>
      setDispatcherPolicy({ capacityScope: "galaxy" as never, updatedBy: OPERATOR }),
    );
    assert.match(scopeRefusal.message, /project \| host/);

    assert.equal(setDispatcherPolicy({ maxActiveRuns: 0, updatedBy: OPERATOR }).maxActiveRuns, 0);
  });

  test("an empty default workflow refuses — an unresolvable launch target is the failure this closes", () => {
    const r = refusalFrom(() => setDispatcherPolicy({ defaultWorkflow: "  ", updatedBy: OPERATOR }));
    assert.match(r.message, /non-empty workflow name/);
  });

  test("a project row overlays ONLY the workflow, and cannot be named 'host'", () => {
    setDispatcherPolicy({ armed: true, maxActiveRuns: 3, defaultWorkflow: "feature", updatedBy: OPERATOR });
    setProjectDefaultWorkflow({ projectKey: PK, workflow: "bugfix", updatedBy: OPERATOR });

    const forProject = getDispatcherPolicy(PK);
    assert.equal(forProject.defaultWorkflow, "bugfix");
    assert.equal(forProject.maxActiveRuns, 3, "the ceiling still comes from the host row");
    assert.equal(forProject.armed, true, "and so does armed — a project cannot arm itself");
    assert.equal(getDispatcherPolicy(PK2).defaultWorkflow, "feature", "another project keeps the host default");

    // A project row carries a ceiling nowhere — the columns are simply never written.
    const row = db.prepare(`SELECT * FROM dispatcher_policy WHERE scope_key = ?`).get(PK) as {
      armed: number | null;
      max_active_runs: number | null;
      lease_ttl_ms: number | null;
    };
    assert.equal(row.armed, null);
    assert.equal(row.max_active_runs, null);
    assert.equal(row.lease_ttl_ms, null);

    const r = refusalFrom(() =>
      setProjectDefaultWorkflow({ projectKey: HOST_POLICY_SCOPE, workflow: "x", updatedBy: OPERATOR }),
    );
    assert.match(r.message, /reserved singleton scope_key/);
  });

  test("a project row for a markdown-mode project refuses by name", () => {
    db.prepare(`UPDATE ticket_storage_mode SET mode = 'markdown' WHERE project_key = ?`).run(PK2);
    const before = fullDump();
    const r = refusalFrom(() => setProjectDefaultWorkflow({ projectKey: PK2, workflow: "x", updatedBy: OPERATOR }));
    assert.match(r.message, /storage mode/);
    assert.equal(fullDump(), before);
  });
});

// ─── (3) the policy is an ADMISSION TEST, never a reaper ─────────────────────

describe("policy edits never touch running work (D5)", () => {
  test("reducing max_active_runs BELOW current usage changes no live row", () => {
    // A third queued ticket, so the refusal below is the CEILING and not an empty queue.
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    setDispatcherPolicy({ armed: true, maxActiveRuns: 2, updatedBy: OPERATOR });

    const a = claimNextEligible({
      projectKey: PK,
      owner: OWNER_A,
      capacity: 2,
      capacityScope: "host",
      leaseTtlMs: TTL,
    });
    const b = claimNextEligible({
      projectKey: PK,
      owner: OWNER_A,
      capacity: 2,
      capacityScope: "host",
      leaseTtlMs: TTL,
    });
    assert.ok(a.claimed && b.claimed, "two live claims for the reduction to be below");
    assert.equal(liveClaims(PK).length, 2);

    const before = dumpExcept(["dispatcher_policy"]);
    const p = setDispatcherPolicy({ maxActiveRuns: 1, updatedBy: OPERATOR });
    assert.equal(p.maxActiveRuns, 1, "the ceiling is now BELOW current usage");

    assert.equal(dumpExcept(["dispatcher_policy"]), before, "not one row outside the policy moved");
    assert.equal(liveClaims(PK).length, 2, "both claims are still live — a ceiling is not a reaper");
    // And the claims are still fully drivable: the reservation is untouched.
    assert.ok(
      heartbeatClaim({
        projectKey: PK,
        claimId: a.claimed!.id,
        owner: OWNER_A,
        generation: a.claimed!.generation,
        leaseTtlMs: TTL,
      }),
      "an over-ceiling claim still heartbeats — the work keeps running",
    );

    // What it DOES do: the next admission refuses.
    const next = claimNextEligible({
      projectKey: PK,
      owner: OWNER_A,
      capacity: p.maxActiveRuns,
      capacityScope: "host",
      leaseTtlMs: TTL,
    });
    assert.equal(next.claimed, null);
    assert.equal(next.claimed === null ? next.reason : "", "capacity");
  });

  test("disarming leaves every live claim alone AND the lease still renews", () => {
    seedQueued(["FG-1"]);
    setDispatcherPolicy({ armed: true, maxActiveRuns: 2, updatedBy: OPERATOR });
    const grant = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(grant.granted);
    const claim = claimNextEligible({
      projectKey: PK,
      owner: OWNER_A,
      capacity: 2,
      capacityScope: "host",
      leaseTtlMs: TTL,
    });
    assert.ok(claim.claimed);

    const before = dumpExcept(["dispatcher_policy"]);
    const p = setDispatcherPolicy({ armed: false, updatedBy: OPERATOR });
    assert.equal(p.armed, false);
    assert.equal(dumpExcept(["dispatcher_policy"]), before, "disarm terminated nothing and released nothing");

    // The disarmed policy is READABLE, and the dispatcher keeps its identity alive.
    assert.equal(
      renewDispatcherLease({ projectKey: PK, owner: OWNER_A, generation: grant.lease.generation, ttlMs: TTL }),
      true,
      "renewal is NOT gated on armed: a lapsed lease over a running container invites a duplicate",
    );
    assert.equal(dispatcherLeaseHeldBy(PK, OWNER_A, grant.lease.generation), true);
    assert.ok(
      heartbeatClaim({
        projectKey: PK,
        claimId: claim.claimed!.id,
        owner: OWNER_A,
        generation: claim.claimed!.generation,
        leaseTtlMs: TTL,
      }),
      "and the claim it already holds keeps being heartbeated",
    );
    assert.equal(liveClaims(PK).length, 1);
  });

  test("no code path in this module names queue_claims at all", () => {
    // The structural half of "never a reaper". A test can only prove the paths it
    // calls; this proves the module has no such path to call.
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "dispatcher-policy.ts"), "utf8");
    const code = src
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//") && !l.trimStart().startsWith("*"))
      .join("\n");
    assert.equal(/queue_claims/.test(code), false, "the policy module cannot touch a claim row");
    assert.equal(/blocker_evidence/.test(code), false, "and never reinterprets a ticket's status");
    assert.equal(/\btickets\b/.test(code), false, "and never writes ticket state");
  });
});

// ─── (4) the dispatcher lease ────────────────────────────────────────────────

describe("the dispatcher lease", () => {
  test("a fresh acquire creates generation 1 and records the operator-facing holder", () => {
    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL, host: "laptop", pid: 4242 });
    assert.ok(g.granted);
    assert.equal(g.mode, "created");
    assert.equal(g.lease.generation, 1);
    assert.equal(g.lease.owner, OWNER_A);
    assert.equal(g.lease.host, "laptop");
    assert.equal(g.lease.pid, 4242);
    assert.ok(g.lease.leaseExpiresAtMs > g.lease.heartbeatAtMs, "expiry is ahead of the heartbeat stamp");
  });

  test("the same owner re-acquiring ADOPTS its own identity at the same generation", () => {
    const first = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(first.granted);
    const again = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(again.granted);
    assert.equal(again.mode, "renewed");
    assert.equal(again.lease.generation, 1, "a restart adopts rather than duplicating");
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatcher_leases`).get() as { n: number }).n,
      1,
      "and there is still exactly one dispatcher identity for this project",
    );
  });

  test("a DIFFERENT owner cannot take a LIVE lease, and is told who holds it", () => {
    acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    const before = fullDump();
    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_B, ttlMs: TTL });
    assert.equal(g.granted, false);
    assert.equal(g.granted === false ? g.reason : "", "held_by_live_owner");
    assert.equal(g.lease.owner, OWNER_A, "the live holder is NAMED — waiting is not abandonment");
    assert.equal(fullDump(), before, "a denied acquire writes nothing");
  });

  test("the lease must be STRICTLY in the past — exactly-at-expiry is still live", () => {
    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(g.granted);
    const expiry = g.lease.leaseExpiresAtMs;

    // The store clock cannot be parked on an exact instant, so strictness is proven
    // against the CAS PREDICATE itself, run with now set exactly equal to the expiry.
    const atExpiry = db
      .prepare(
        `UPDATE dispatcher_leases SET owner = 'probe'
          WHERE project_key = ? AND generation = ? AND lease_expires_at_ms < ?`,
      )
      .run(PK, g.lease.generation, expiry);
    assert.equal(atExpiry.changes, 0, "lease_expires_at_ms == now is NOT expired");
    assert.equal(getDispatcherLease(PK)!.owner, OWNER_A);

    // One millisecond past it, the real verb takes over and bumps the fencing token.
    setPublicationClockOffsetForTest(TTL + 1);
    const taken = acquireDispatcherLease({ projectKey: PK, owner: OWNER_B, ttlMs: TTL });
    assert.ok(taken.granted);
    assert.equal(taken.mode, "took_over");
    assert.equal(taken.lease.owner, OWNER_B);
    assert.equal(taken.lease.generation, 2);
  });

  test("FALSIFICATION: a takeover that DROPS the strict-expiry predicate steals a live lease", () => {
    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(g.granted);
    // The mutant: the same UPDATE with the `lease_expires_at_ms < ?` binding removed.
    // Without seeing it succeed, the green assertion above cannot tell "the predicate
    // holds" from "the row was never matchable".
    const stolen = db
      .prepare(`UPDATE dispatcher_leases SET owner = ? WHERE project_key = ? AND generation = ?`)
      .run(OWNER_B, PK, g.lease.generation);
    assert.equal(stolen.changes, 1, "FALSIFICATION: without the strict-expiry predicate a LIVE lease is stolen");
  });

  test("a SUPERSEDED generation can neither renew nor release", () => {
    const first = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(first.granted);
    setPublicationClockOffsetForTest(TTL + 1);
    const second = acquireDispatcherLease({ projectKey: PK, owner: OWNER_B, ttlMs: TTL });
    assert.ok(second.granted);
    assert.equal(second.lease.generation, 2);

    const before = fullDump();
    assert.equal(
      renewDispatcherLease({ projectKey: PK, owner: OWNER_A, generation: 1, ttlMs: TTL }),
      false,
      "the superseded owner renews nothing",
    );
    assert.equal(
      releaseDispatcherLease(PK, OWNER_A, 1),
      false,
      "and cannot clear the live holder's identity",
    );
    assert.equal(dispatcherLeaseHeldBy(PK, OWNER_A, 1), false, "nor is it authorized to decide anything");
    assert.equal(dispatcherLeaseHeldBy(PK, OWNER_B, 2), true);
    assert.equal(fullDump(), before, "a fenced-out dispatcher wrote nothing at all");
  });

  test("an EXPIRED owner renews nothing — an expired lease authorizes nothing", () => {
    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(g.granted);
    setPublicationClockOffsetForTest(TTL + 1);
    assert.equal(
      renewDispatcherLease({ projectKey: PK, owner: OWNER_A, generation: 1, ttlMs: TTL }),
      false,
      "a lapsed lease cannot be resurrected out from under a recoverer that already decided to adopt it",
    );
    assert.equal(dispatcherLeaseHeldBy(PK, OWNER_A, 1), false);
    // The way back in is re-acquisition, which is the same-owner adoption path.
    const back = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(back.granted);
    assert.equal(back.mode, "renewed");
  });

  test("release is owner+generation scoped, and releases no CLAIM", () => {
    seedQueued(["FG-1"]);
    setDispatcherPolicy({ armed: true, maxActiveRuns: 1, updatedBy: OPERATOR });
    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(g.granted);
    const claim = claimNextEligible({
      projectKey: PK,
      owner: OWNER_A,
      capacity: 1,
      capacityScope: "host",
      leaseTtlMs: TTL,
    });
    assert.ok(claim.claimed);

    assert.equal(releaseDispatcherLease(PK, OWNER_B, 1), false, "a stranger releases nothing");
    assert.equal(releaseDispatcherLease(PK, OWNER_A, 99), false, "nor does a wrong generation");
    assert.equal(releaseDispatcherLease(PK, OWNER_A, g.lease.generation), true);
    assert.equal(getDispatcherLease(PK), undefined);

    assert.equal(liveClaims(PK).length, 1, "the claim survives its dispatcher — it is a separate durable fact");
    assert.equal(liveClaims(PK)[0]!.state, "live");
  });

  test("leases are per project — one dispatcher's identity never fences another's", () => {
    const a = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    const b = acquireDispatcherLease({ projectKey: PK2, owner: `dispatcher@${PK2}@instance-A`, ttlMs: TTL });
    assert.ok(a.granted && b.granted);
    assert.equal(a.lease.generation, 1);
    assert.equal(b.lease.generation, 1);
    assert.equal(dispatcherLeaseHeldBy(PK2, OWNER_A, 1), false);
  });

  test("a lease TTL below the floor refuses on acquire AND on renew, and writes nothing", () => {
    const beforeAcquire = fullDump();
    const r1 = refusalFrom(() =>
      acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: MIN_LEASE_TTL_MS - 1 }),
    );
    assert.match(r1.message, /below the derived floor/);
    assert.equal(fullDump(), beforeAcquire);

    const g = acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    assert.ok(g.granted);
    const beforeRenew = fullDump();
    const r2 = refusalFrom(() =>
      renewDispatcherLease({ projectKey: PK, owner: OWNER_A, generation: 1, ttlMs: 0 }),
    );
    assert.match(r2.message, /below the derived floor/);
    assert.equal(fullDump(), beforeRenew, "a refused renewal does not shorten the live lease either");
  });

  test("an anonymous owner, an unregistered project and a markdown project all refuse by name", () => {
    const before = fullDump();
    assert.match(
      refusalFrom(() => acquireDispatcherLease({ projectKey: PK, owner: "  ", ttlMs: TTL })).message,
      /instance-stable owner/,
    );
    assert.match(
      refusalFrom(() => acquireDispatcherLease({ projectKey: "nope", owner: OWNER_A, ttlMs: TTL })).message,
      /no project_identity row/,
    );
    db.prepare(`UPDATE ticket_storage_mode SET mode = 'markdown' WHERE project_key = ?`).run(PK2);
    assert.match(
      refusalFrom(() => acquireDispatcherLease({ projectKey: PK2, owner: OWNER_A, ttlMs: TTL })).message,
      /storage mode/,
    );
    assert.equal(
      (db.prepare(`SELECT COUNT(*) AS n FROM dispatcher_leases`).get() as { n: number }).n,
      0,
      "no refused acquire left an identity behind",
    );
    assert.notEqual(before, "", "census taken");
  });
});

// ─── (5) the operator surface: dead, idle and absent are DIFFERENT answers ───

describe("dispatcherLeaseView", () => {
  test("no dispatcher at all is not the same answer as a dead one", () => {
    const absent = dispatcherLeaseView(PK);
    assert.equal(absent.lease, null);
    assert.equal(absent.live, false);
    assert.equal(absent.expired, false, "there is nothing to have expired");
    assert.equal(absent.msSinceHeartbeat, null);

    acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    const alive = dispatcherLeaseView(PK);
    assert.equal(alive.live, true);
    assert.equal(alive.expired, false);
    assert.ok((alive.msSinceHeartbeat ?? -1) >= 0);

    setPublicationClockOffsetForTest(10 * TTL);
    const dead = dispatcherLeaseView(PK);
    assert.equal(dead.live, false);
    assert.equal(dead.expired, true, "'the dispatcher died' is distinguishable from 'nothing to do'");
    assert.ok((dead.msSinceHeartbeat ?? 0) >= 10 * TTL, "and how long ago it was last alive is readable");
    assert.equal(dead.lease?.owner, OWNER_A, "with the holder still named");
  });

  test("live and expired are mutually exclusive at every instant", () => {
    acquireDispatcherLease({ projectKey: PK, owner: OWNER_A, ttlMs: TTL });
    for (const offset of [0, TTL / 2, TTL + 1, 10 * TTL]) {
      setPublicationClockOffsetForTest(offset);
      const v = dispatcherLeaseView(PK);
      assert.notEqual(v.live, v.expired, `at offset ${offset} the lease is exactly one of the two`);
      assert.equal(v.live, dispatcherLeaseHeldBy(PK, OWNER_A, 1), "and the view agrees with the fence");
    }
  });
});
