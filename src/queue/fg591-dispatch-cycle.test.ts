// FG-591 (step 6): the dispatch cycle, against a real in-memory SQLite DB running
// the REAL policy, evidence, compatibility and claim modules. Nothing is mocked —
// the whole point of this step is that four shipped primitives compose into one
// decision, and a test that stubbed any of them would prove nothing about that.
//
// THE BAR THIS FILE HOLDS ITSELF TO, following fg610-queue-claims.test.ts and
// fg591-compatibility.test.ts: every "records why" claim is proven by reading the
// DURABLE ROW back out of SQLite rather than the returned object, because the return
// value would be identical if recordEvaluation never committed. And every refusal is
// paired with the arrangement that must still GRANT — a dispatcher that claims
// nothing passes every refusal assertion and is worthless.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import { upsertTicket, type TicketRow } from "../store/tickets.js";
import { enqueueTicket, rankTicket } from "../store/queue.js";
import {
  claimNextEligible,
  recordClaimLaunch,
  setClaimPhaseHookForTest,
  MIN_LEASE_TTL_MS,
  type QueueClaim,
  type ScanEntry,
} from "../store/queue-claims.js";
import { setDispatcherPolicy } from "../store/dispatcher-policy.js";
import { DISPATCH_REASONS, evaluationsFor, latestEvaluation } from "../store/dispatcher-evidence.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";
import { runDispatchCycle, runDispatchPass, DEFAULT_LOST_RETRY_LIMIT } from "./dispatch-cycle.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-dispatch";
const PK2 = "pk-dispatch-two";
const OWNER = "dispatcher-1";
const NOW = "2026-08-06T00:00:00Z";

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
  setClaimPhaseHookForTest(null);
  for (const pk of [PK, PK2]) registerDbProject(pk);
});

afterEach(() => {
  setClaimPhaseHookForTest(null);
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

function ticket(id: string, over: Partial<TicketRow> = {}): TicketRow {
  return {
    projectKey: PK,
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
    ...over,
  };
}

/** Rank and enqueue, in the order given — so ids[0] is rank 1. */
function seedQueued(ids: string[], projectKey: string = PK): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id, { projectKey }));
  });
  for (const id of ids) {
    rankTicket(projectKey, id);
    const res = enqueueTicket(projectKey, id);
    assert.equal(res.ok, true, `${id} must enqueue for the fixture to mean anything`);
  }
}

/** ARM autonomous dispatch. Every grant path needs this; the disarmed cases
 *  deliberately do not call it. */
function arm(over: { maxActiveRuns?: number } = {}): void {
  setDispatcherPolicy({
    armed: true,
    maxActiveRuns: over.maxActiveRuns ?? 1,
    capacityScope: "host",
    // The lease TTL and heartbeat cadence are left at the shipped defaults: the policy
    // module refuses a pair that cannot survive one missed renewal, and re-deriving a
    // valid pair here would just be a second copy of that arithmetic.
    updatedBy: "operator@test",
  });
}

/** A genuine, durable blocker — the thing a temporary scheduling wait must never be
 *  confused with, and must never be written as. */
function seedBlocker(ticketId: string, projectKey = PK): void {
  db.prepare(
    `INSERT INTO blocker_evidence (id, project_key, ticket_id, reason, source, created_at, kind, queue_projection)
     VALUES (?, ?, ?, 'waiting on an upstream decision', 'dependency:FG-999', ?, 'dependency', 'blocked')`,
  ).run(`be-${ticketId}`, projectKey, ticketId, NOW);
}

/** Make a ticket readiness-ineligible by removing its stored assessment entirely —
 *  "never assessed", which is a durable fact rather than a scheduling one. */
function stripReadiness(ticketId: string, projectKey = PK): void {
  db.prepare(`DELETE FROM readiness_assessments WHERE project_key = ? AND ticket_id = ?`).run(
    projectKey,
    ticketId,
  );
}

/** Execution the claim ledger cannot see: an operator's own `forge new --ticket`, as
 *  launch-observations records it. This is what makes a candidate TEMPORARILY
 *  INCOMPATIBLE without making it blocked. */
function seedForeignLaunch(ticketId: string, launchId = `launch-${ticketId}`): void {
  db.prepare(
    `INSERT INTO launch_observations
       (launch_id, command, cwd, project_dir, association_kind, ticket_id, started_at, observed_at, state, terminal)
     VALUES (?, 'forge new feature', '/repos/one', NULL, 'ticket', ?, ?, ?, 'running', 0)`,
  ).run(launchId, ticketId, NOW, NOW);
}

/** Bind a granted claim to a run whose live task has its OWN worktree, which is what
 *  turns that claim's lane from `unknown` into `isolated`.
 *
 *  This is not test scaffolding for its own sake — it is step 7's job, done by hand.
 *  Until a claim records a launch and its run records a task, compatibility.ts refuses
 *  to say where that work will execute, and every later candidate IN THE SAME REPO
 *  waits. So a fixture that wants two concurrent claims has to make the first one's
 *  workspace knowable, exactly as the real launch path will. */
function bindRun(
  claim: QueueClaim,
  runId: string,
  over: { worktreePath?: string; projectKey?: string } = {},
): void {
  const projectKey = over.projectKey ?? PK;
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, 'active', ?, '/repos/one')`,
  ).run(runId, `title ${runId}`, NOW);
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, worktree_path)
     VALUES (?, ?, 'build', 'backend-specialist', 'running', '{}', ?, ?)`,
  ).run(`task-${runId}`, runId, NOW, over.worktreePath ?? `/wt/${runId}`);
  const stamped = recordClaimLaunch({
    projectKey,
    claimId: claim.id,
    owner: claim.owner,
    generation: claim.generation,
    launchId: `launch-${runId}`,
    runId,
  });
  assert.notEqual(stamped, null, "the launch stamp must land for the fixture to mean anything");
}

function rankOf(ticketId: string, projectKey = PK): number | null {
  const row = db
    .prepare(`SELECT priority_rank FROM tickets WHERE project_key = ? AND ticket_id = ?`)
    .get(projectKey, ticketId) as { priority_rank: number | null } | undefined;
  assert.notEqual(row, undefined, `${ticketId} must exist to have a rank`);
  return (row as { priority_rank: number | null }).priority_rank;
}

/** The evaluation rows as SQLite actually holds them — read back rather than trusted
 *  from the return value, which would be identical if nothing committed. */
function evaluationRows(projectKey = PK): {
  reason: string;
  detail: string | null;
  claim_id: string | null;
  claimed_ticket_id: string | null;
  scan_evidence: string | null;
  capacity_limit: number | null;
  capacity_used: number | null;
  capacity_holders: string | null;
  dispatcher_owner: string;
  dispatcher_generation: number | null;
  wake_kind: string | null;
}[] {
  return db
    .prepare(
      `SELECT reason, detail, claim_id, claimed_ticket_id, scan_evidence, capacity_limit, capacity_used,
              capacity_holders, dispatcher_owner, dispatcher_generation, wake_kind
         FROM dispatcher_evaluations WHERE project_key = ? ORDER BY id ASC`,
    )
    .all(projectKey) as ReturnType<typeof evaluationRows>;
}

function liveClaimRows(projectKey?: string): { id: string; ticket_id: string; scan_evidence: string | null }[] {
  return (
    projectKey === undefined
      ? db.prepare(`SELECT id, ticket_id, scan_evidence FROM queue_claims WHERE state = 'live' ORDER BY id`).all()
      : db
          .prepare(
            `SELECT id, ticket_id, scan_evidence FROM queue_claims
              WHERE project_key = ? AND state = 'live' ORDER BY id`,
          )
          .all(projectKey)
  ) as { id: string; ticket_id: string; scan_evidence: string | null }[];
}

function scanEvidenceOf(json: string | null): ScanEntry[] {
  assert.notEqual(json, null, "expected scan evidence to be persisted");
  return JSON.parse(json as string) as ScanEntry[];
}

function reasonFor(entries: readonly ScanEntry[], ticketId: string): ScanEntry {
  const found = entries.find((e) => e.ticketId === ticketId);
  assert.notEqual(found, undefined, `expected ${ticketId} to be named in the scan evidence`);
  return found as ScanEntry;
}

// ─── a grant ─────────────────────────────────────────────────────────────────

describe("FG-591 AC10/AC14: a grant persists the claim's evidence AND an evaluation row", () => {
  test("both durable records exist after one cycle, and they agree", () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 1 });

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER, generation: 7, wakeKind: "queue_changed" });

    assert.equal(out.grants.length, 1);
    const claim = out.grants[0]?.claim as QueueClaim;
    assert.equal(claim.ticketId, "FG-1", "the FIRST ranked candidate must be the one claimed");

    // The claim's OWN scan evidence — queue-claims persists this only on a grant.
    const claims = liveClaimRows(PK);
    assert.equal(claims.length, 1);
    assert.equal(claims[0]?.id, claim.id);
    const claimEvidence = scanEvidenceOf(claims[0]?.scan_evidence ?? null);
    assert.equal(reasonFor(claimEvidence, "FG-1").reason, "eligible");

    // The evaluation row — the thing that did NOT exist before this step.
    const rows = evaluationRows();
    const granted = rows.filter((r) => r.reason === "granted");
    assert.equal(granted.length, 1, "exactly one granted row for one grant");
    assert.equal(granted[0]?.claim_id, claim.id);
    assert.equal(granted[0]?.claimed_ticket_id, "FG-1");
    assert.equal(granted[0]?.dispatcher_owner, OWNER);
    assert.equal(granted[0]?.dispatcher_generation, 7, "the fencing generation is recorded");
    assert.equal(granted[0]?.wake_kind, "queue_changed", "which wake drove the look is recorded");
    assert.equal(granted[0]?.capacity_limit, 1);

    // The two records carry the SAME scan, so the evidence trail is one story.
    assert.deepEqual(scanEvidenceOf(granted[0]?.scan_evidence ?? null), claimEvidence);
  });

  test("a fresh grant's workspace is not yet knowable, so the SAME cycle takes no second claim — and says so", () => {
    // The documented cost of compatibility.ts's refuse-on-ambiguity rule, asserted
    // here rather than left to be discovered: a claim that has been granted but has
    // recorded no launch yet holds an UNKNOWN lane, and a second candidate in the same
    // repository waits for it. The wait is TEMPORARY, self-clearing and on the record.
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    arm({ maxActiveRuns: 3 });

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.deepEqual(out.grants.map((g) => g.claim.ticketId), ["FG-1"]);
    assert.equal(out.finalReason, "incompatible_only", "not no_capacity — the ceiling had room to spare");
    assert.deepEqual(
      evaluationRows().map((r) => r.reason),
      ["granted", "incompatible_only"],
      "EVERY pass wrote its own row, including the one that granted nothing",
    );
    assert.match(
      evaluationRows().at(-1)?.detail ?? "",
      /workspace is not yet knowable/,
      "the operator is told WHY a second slot went unused, rather than seeing an unexplained idle ceiling",
    );
  });

  test("the cycle refills to the ceiling once each claim's workspace is knowable, and never past it", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    arm({ maxActiveRuns: 2 });

    const first = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.deepEqual(first.grants.map((g) => g.claim.ticketId), ["FG-1"]);
    bindRun(first.grants[0]?.claim as QueueClaim, "run-1");

    const second = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.deepEqual(
      second.grants.map((g) => g.claim.ticketId),
      ["FG-2"],
      "canonical rank order; the queue refilled with no operator input",
    );
    bindRun(second.grants[0]?.claim as QueueClaim, "run-2");

    const third = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.equal(third.grants.length, 0);
    assert.equal(third.finalReason, "no_capacity", "the ceiling, not compatibility, is what stops the third");
    assert.equal(liveClaimRows().length, 2, "the ceiling is never exceeded");
    assert.equal(rankOf("FG-3"), 3, "the candidate the ceiling turned away keeps its rank");
  });
});

// ─── the refusals: an idle queue still leaves an answer ──────────────────────

describe("FG-591 AC10: a pass that grants nothing names why EACH candidate was passed over", () => {
  test("blocked, ineligible, already-claimed and temporarily-incompatible are four distinct answers", () => {
    // Rank order: BLOCKED, INELIGIBLE, HELD, INCOMPAT.
    seedQueued(["FG-BLOCKED", "FG-INELIGIBLE", "FG-HELD", "FG-INCOMPAT"]);
    seedBlocker("FG-BLOCKED");
    stripReadiness("FG-INELIGIBLE");
    seedForeignLaunch("FG-INCOMPAT");
    arm({ maxActiveRuns: 4 });

    // A competing dispatcher holds FG-HELD on a live lease.
    const held = claimNextEligible({
      projectKey: PK,
      owner: "other-dispatcher",
      capacity: 4,
      capacityScope: "host",
      leaseTtlMs: MIN_LEASE_TTL_MS * 4,
    });
    assert.equal(held.claimed?.ticketId, "FG-HELD", "the fixture needs the third candidate held");
    // Bound to an ISOLATED workspace, so the held claim is not itself an unknown lane —
    // otherwise FG-INCOMPAT would refuse on FG-HELD's unknown workspace and this test
    // would prove that instead of what it means to prove.
    bindRun(held.claimed as QueueClaim, "run-held");

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.grants.length, 0, "nothing was claimable");
    assert.equal(out.finalReason, "incompatible_only");

    const latest = latestEvaluation(PK);
    assert.notEqual(latest, undefined, "an idle pass STILL leaves a durable answer");
    const evidence = latest?.scanEvidence as ScanEntry[];
    assert.equal(reasonFor(evidence, "FG-BLOCKED").reason, "queue_blocked");
    assert.equal(reasonFor(evidence, "FG-INELIGIBLE").reason, "readiness_ineligible");
    assert.equal(reasonFor(evidence, "FG-HELD").reason, "already_claimed");
    assert.match(
      reasonFor(evidence, "FG-HELD").detail ?? "",
      /other-dispatcher/,
      "the holder is named, not merely the fact of a holder",
    );
    assert.equal(reasonFor(evidence, "FG-INCOMPAT").reason, "incompatible");
    assert.match(
      reasonFor(evidence, "FG-INCOMPAT").detail ?? "",
      /waiting for FG-INCOMPAT to finish/,
      "the compatibility reason reaches the durable record in the AC's own words",
    );

    // And the four reasons survive as four DISTINCT values, not a collapsed "nothing
    // was eligible".
    assert.equal(new Set(evidence.map((e) => e.reason)).size, 4);
  });

  test("no_eligible_work and incompatible_only are different top-level answers", () => {
    seedQueued(["FG-1"]);
    seedBlocker("FG-1");
    arm({ maxActiveRuns: 2 });

    const blockedOnly = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.equal(blockedOnly.finalReason, "no_eligible_work");
    assert.match(
      blockedOnly.passes[0]?.evaluation.detail ?? "",
      /canonical rank order/,
      "the operator is told the queue WAS walked, not that it was empty",
    );

    // Same queue, one ready-but-unsafe-to-overlap candidate: a TEMPORARY wait.
    seedQueued(["FG-2"]);
    seedForeignLaunch("FG-2");
    const waiting = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.equal(waiting.finalReason, "incompatible_only");
    assert.match(
      waiting.passes[0]?.evaluation.detail ?? "",
      /temporary scheduling wait, NOT a blocker/,
      "the detail says in words what the reason says in vocabulary",
    );
  });

  test("a temporary scheduling wait NEVER becomes a blocker_evidence row", () => {
    seedQueued(["FG-1"]);
    seedForeignLaunch("FG-1");
    arm();

    const before = db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get() as { n: number };
    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });
    const after = db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get() as { n: number };

    assert.equal(out.finalReason, "incompatible_only");
    assert.equal(after.n, before.n, "blocker_evidence is partly CONTAINER-VISIBLE; a scheduling wait must not touch it");
    assert.equal(after.n, 0);
  });
});

// ─── the operator's rank is never touched ────────────────────────────────────

describe("FG-591 AC11: bypassing a candidate never reorders the operator's queue", () => {
  test("an incompatible TOP candidate keeps its priority_rank byte-identical, and the next one is claimed", () => {
    seedQueued(["FG-TOP", "FG-NEXT"]);
    seedForeignLaunch("FG-TOP");
    arm({ maxActiveRuns: 1 });

    const before = db.prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`).all(PK);
    const topRankBefore = rankOf("FG-TOP");

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.grants[0]?.claim.ticketId, "FG-NEXT", "a lower-ranked compatible candidate is claimed");
    assert.equal(rankOf("FG-TOP"), topRankBefore, "the bypassed candidate's rank did not move");
    assert.deepEqual(
      db.prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`).all(PK),
      before,
      "not one rank in the whole project moved",
    );

    // And it is RECONSIDERED once the incompatibility clears — a bypass costs a cycle,
    // never a position.
    db.prepare(`UPDATE launch_observations SET terminal = 1, state = 'exited' WHERE ticket_id = 'FG-TOP'`).run();
    db.prepare(`UPDATE queue_claims SET state = 'released', outcome = 'completed' WHERE ticket_id = 'FG-NEXT'`).run();
    const again = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.equal(again.grants[0]?.claim.ticketId, "FG-TOP", "the bypassed item is reconsidered at its original rank");
  });
});

// ─── disarmed ────────────────────────────────────────────────────────────────

describe("FG-591 AC16/D5: a disarmed policy claims nothing and still records why", () => {
  test("nothing is scanned, nothing is claimed, and the row names the operator's choice", () => {
    seedQueued(["FG-1"]);
    setDispatcherPolicy({ armed: false, maxActiveRuns: 4, updatedBy: "operator@test" });

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.finalReason, "disabled");
    assert.equal(out.grants.length, 0);
    assert.equal(liveClaimRows().length, 0, "no claim was made");

    const rows = evaluationRows();
    assert.equal(rows.length, 1, "exactly one pass — a disarmed cycle does not spin");
    assert.equal(rows[0]?.reason, "disabled");
    assert.equal(rows[0]?.scan_evidence, null, "nothing was SCANNED, which is a different fact from an empty queue");
    assert.match(rows[0]?.detail ?? "", /disarmed/);
    assert.match(rows[0]?.detail ?? "", /never a reaper/);
  });

  test("an unconfigured store is disarmed, and says so rather than dispatching by accident", () => {
    seedQueued(["FG-1"]);

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.finalReason, "disabled");
    assert.equal(liveClaimRows().length, 0);
    assert.match(latestEvaluation(PK)?.detail ?? "", /no policy has ever been written/);
  });

  test("disarming terminates nothing: a live claim and its lease are untouched", () => {
    seedQueued(["FG-1", "FG-2"]);
    arm({ maxActiveRuns: 2 });
    const first = runDispatchCycle({ projectKey: PK, owner: OWNER });
    bindRun(first.grants[0]?.claim as QueueClaim, "run-1");
    const second = runDispatchCycle({ projectKey: PK, owner: OWNER });
    assert.equal(liveClaimRows().length, 2, "two live claims, so 'terminates nothing' has something to be about");
    assert.equal(second.grants.length, 1);
    const liveBefore = db.prepare(`SELECT * FROM queue_claims ORDER BY id`).all();

    setDispatcherPolicy({ armed: false, updatedBy: "operator@test" });
    const after = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(after.finalReason, "disabled");
    assert.deepEqual(
      db.prepare(`SELECT * FROM queue_claims ORDER BY id`).all(),
      liveBefore,
      "not one byte of claim state moved when dispatch was disarmed",
    );
  });

  test("a capacity reduction below current usage claims nothing and kills nothing", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    arm({ maxActiveRuns: 2 });
    const first = runDispatchCycle({ projectKey: PK, owner: OWNER });
    bindRun(first.grants[0]?.claim as QueueClaim, "run-1");
    const second = runDispatchCycle({ projectKey: PK, owner: OWNER });
    bindRun(second.grants[0]?.claim as QueueClaim, "run-2");
    assert.equal(liveClaimRows().length, 2, "at the ceiling before it is lowered");
    const liveBefore = db.prepare(`SELECT * FROM queue_claims ORDER BY id`).all();

    setDispatcherPolicy({ maxActiveRuns: 1, updatedBy: "operator@test" });
    const after = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(after.grants.length, 0, "an admission test, applied to the NEXT claim");
    assert.equal(after.finalReason, "no_capacity");
    assert.deepEqual(
      db.prepare(`SELECT * FROM queue_claims ORDER BY id`).all(),
      liveBefore,
      "reducing the ceiling is never a reaper",
    );
  });
});

// ─── capacity, in HOST scope ─────────────────────────────────────────────────

describe("FG-591 AC9: a host-scoped refusal names which OTHER project holds the slots", () => {
  test("the no_capacity row carries the holder list, project key and all", () => {
    seedQueued(["FG-OTHER"], PK2);
    seedQueued(["FG-MINE"], PK);
    arm({ maxActiveRuns: 1 });

    const other = claimNextEligible({
      projectKey: PK2,
      owner: "dispatcher-elsewhere",
      capacity: 1,
      capacityScope: "host",
      leaseTtlMs: MIN_LEASE_TTL_MS * 4,
    });
    assert.equal(other.claimed?.ticketId, "FG-OTHER", "the fixture needs the other project holding the host slot");

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.finalReason, "no_capacity");
    assert.equal(out.grants.length, 0);

    const row = evaluationRows(PK).at(-1);
    assert.equal(row?.reason, "no_capacity");
    assert.equal(row?.capacity_limit, 1);
    assert.equal(row?.capacity_used, 1);
    const holders = JSON.parse(row?.capacity_holders ?? "null") as { projectKey: string; ticketId: string }[];
    assert.deepEqual(holders.map((h) => ({ projectKey: h.projectKey, ticketId: h.ticketId })), [
      { projectKey: PK2, ticketId: "FG-OTHER" },
    ]);
    assert.match(
      row?.detail ?? "",
      new RegExp(`1/1 live claims in host scope, with slots held by ${PK2}`),
      "a per-project board can explain its own stall from this one string",
    );
  });
});

// ─── the `lost` refusal ──────────────────────────────────────────────────────

describe("FG-591: a `lost` refusal writes no claim and re-scans within its bound", () => {
  /** Force EVERY claim attempt to lose its re-validation, by moving the durable fact
   *  phase 2 re-checks (the ticket revision) in the window between the two phases.
   *  Nothing else can open that window inside one process — and "the retry is bounded"
   *  is not evidence unless the loop actually spins. */
  function alwaysLose(): { attempts: () => number } {
    let attempts = 0;
    setClaimPhaseHookForTest((candidateTicketId) => {
      attempts++;
      db.prepare(`UPDATE tickets SET revision = revision + 1 WHERE project_key = ? AND ticket_id = ?`).run(
        PK,
        candidateTicketId,
      );
    });
    return { attempts: () => attempts };
  }

  test("no claim is written, and the cycle stops after DEFAULT_LOST_RETRY_LIMIT re-scans", () => {
    seedQueued(["FG-1"]);
    arm({ maxActiveRuns: 2 });
    const hook = alwaysLose();

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.finalReason, "lost");
    assert.equal(out.grants.length, 0);
    assert.equal(liveClaimRows().length, 0, "a `lost` refusal writes NOTHING to queue_claims");
    assert.equal(out.lostRetries, DEFAULT_LOST_RETRY_LIMIT, "it re-scanned exactly its budget, then stopped");
    // One initial attempt plus the budgeted re-scans, and not one more.
    assert.equal(hook.attempts(), DEFAULT_LOST_RETRY_LIMIT + 1);
    const reasons = evaluationRows().map((r) => r.reason);
    assert.deepEqual(
      reasons,
      new Array(DEFAULT_LOST_RETRY_LIMIT + 1).fill("lost"),
      "each pass is durably recorded, so an operator can SEE the contention",
    );
  });

  test("the bound is caller-tunable and is respected exactly", () => {
    seedQueued(["FG-1"]);
    arm({ maxActiveRuns: 2 });
    const hook = alwaysLose();

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER, lostRetryLimit: 0 });

    assert.equal(out.lostRetries, 0);
    assert.equal(hook.attempts(), 1, "no re-scan at all when the budget is zero");
    assert.equal(evaluationRows().length, 1);
  });

  test("a `lost` that clears on the re-scan still grants, and both passes are on the record", () => {
    seedQueued(["FG-1"]);
    arm({ maxActiveRuns: 1 });

    let fired = false;
    setClaimPhaseHookForTest((candidateTicketId) => {
      if (fired) return;
      fired = true;
      db.prepare(`UPDATE tickets SET revision = revision + 1 WHERE project_key = ? AND ticket_id = ?`).run(
        PK,
        candidateTicketId,
      );
    });

    const out = runDispatchCycle({ projectKey: PK, owner: OWNER });

    assert.equal(out.grants.length, 1, "the re-scan is a real retry, not a formality");
    assert.equal(out.grants[0]?.claim.ticketId, "FG-1");
    // The trailing pass is the refill loop looking once more and finding the queue
    // exhausted — recorded like every other outcome rather than skipped as obvious.
    assert.deepEqual(evaluationRows().map((r) => r.reason), ["lost", "granted", "no_eligible_work"]);
  });
});

// ─── the vocabulary and the module's blast radius ────────────────────────────

describe("FG-591: the cycle stays inside the vocabulary and the tables it owns", () => {
  test("every reason this module can produce is one of DISPATCH_REASONS", () => {
    // Drive each branch and collect what actually landed in the column.
    seedQueued(["FG-1"]);
    runDispatchCycle({ projectKey: PK, owner: OWNER }); // disabled
    arm({ maxActiveRuns: 1 });
    runDispatchCycle({ projectKey: PK, owner: OWNER }); // granted
    runDispatchCycle({ projectKey: PK, owner: OWNER }); // no_capacity (FG-1 held, ceiling 1)

    const produced = new Set(evaluationRows().map((r) => r.reason));
    assert.ok(produced.size >= 3, "the branches under test really did diverge");
    for (const reason of produced) {
      assert.ok(
        (DISPATCH_REASONS as readonly string[]).includes(reason),
        `'${reason}' is outside the closed vocabulary FG-591 owns`,
      );
    }
  });

  test("a single pass writes exactly one evaluation row and touches no other table", () => {
    seedQueued(["FG-1"]);
    seedBlocker("FG-1");
    arm();

    const census = (): string => {
      const tables = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
          .all() as { name: string }[]
      )
        .map((t) => t.name)
        .filter((t) => t !== "dispatcher_evaluations");
      return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
    };

    const before = census();
    const pass = runDispatchPass({ projectKey: PK, owner: OWNER });
    assert.equal(pass.reason, "no_eligible_work");
    assert.equal(census(), before, "a pass that grants nothing writes ONLY its evaluation row");
    assert.equal(evaluationsFor(PK).length, 1);
  });

  test("an unresolvable project propagates the store's own refusal rather than inventing a reason", () => {
    db.prepare(`UPDATE ticket_storage_mode SET mode = 'markdown' WHERE project_key = ?`).run(PK);
    setDispatcherPolicy({ armed: true, maxActiveRuns: 1, updatedBy: "operator@test" });

    assert.throws(
      () => runDispatchCycle({ projectKey: PK, owner: OWNER }),
      /markdown/,
      "a project that cannot be dispatched at all must not read as 'no eligible work'",
    );
  });
});
