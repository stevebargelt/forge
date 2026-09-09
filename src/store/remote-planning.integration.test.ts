// FG-783 (step 3) integration: the in-process store authority for the Remote
// Board's bounded planning commands, driven against a REAL on-disk SQLite file
// running the REAL store code — no subprocess, no mocks. On-disk (not :memory:)
// because AC2 requires proving idempotency ACROSS A SERVER RESTART, which we
// simulate by closing the DB handle and reopening the same file.
//
// Covers:
//   AC1 — each of the four actions applies through its existing authority and
//         records actor / transport / request-id / precondition / outcome.
//   AC2 — a replayed request-id returns the RECORDED outcome and re-applies
//         nothing (row counts / queueVersion / annotation count unchanged),
//         INCLUDING after closing and reopening the DB handle (restart).
//   AC3 — a stale queue expectedVersion, and an annotation against a superseded
//         ticket revision, each refuse with ZERO mutation and return the current
//         safe summary.
//   plus — the annotation cannot double-append on replay; a forced failure
//          between the mutation and the ledger write rolls BOTH back (atomicity).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { applyMigrations, setDbForTest, writeTransaction } from "./db.js";
import { SCHEMA_SQL } from "./schema.js";
import { upsertTicket, getTicket, type TicketRow } from "./tickets.js";
import { queueVersion, queueView } from "./queue.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";
import {
  applyRemotePlanningCommand,
  planningAnnotations,
  remotePlanningAudit,
  setLedgerWriteFailureHookForTest,
  type RemotePlanningCommand,
} from "./remote-planning.js";

const PK = "pk-remote-plan";
const OTHER_PK = "pk-other";
const NOW = "2026-09-08T00:00:00Z";
const ACTOR = "operator@ts.net";
const TRANSPORT = "tailscale";

// A body evaluateReadiness (FG-382) calls READY.
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

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let dir: string;
let dbPath: string;

function openOnDisk(path: string): DatabaseInstance {
  const d = new Database(path);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA_SQL);
  applyMigrations(d);
  return d;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fg783-plan-"));
  dbPath = join(dir, "forge.db");
  db = openOnDisk(dbPath);
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
  setLedgerWriteFailureHookForTest(null);
});

afterEach(() => {
  setLedgerWriteFailureHookForTest(null);
  setDbForTest(prev as DatabaseInstance);
  try {
    if (db.open) db.close();
  } catch {
    /* already closed by a restart-simulation test */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Close the live handle and reopen the SAME file, re-pointing the store at it —
 *  a durable simulation of a server restart. */
function restart(): void {
  db.close();
  db = openOnDisk(dbPath);
  setDbForTest(db);
  resetPublishBarrierForTest();
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

function seed(ids: string[], over: Partial<TicketRow> = {}): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id, over));
  });
}

function queuedIds(projectKey = PK): string[] {
  return queueView(projectKey)
    .filter((e) => e.queued)
    .map((e) => e.ticketId);
}

function ledgerCount(projectKey = PK): number {
  return remotePlanningAudit(projectKey).length;
}

function base(action: string, over: Partial<RemotePlanningCommand> = {}): RemotePlanningCommand {
  return {
    requestId: `req-${action}-${Math.floor(Math.random() * 1e9)}`,
    actor: ACTOR,
    transport: TRANSPORT,
    projectKey: PK,
    targetId: "FG-1",
    at: NOW,
    action,
    ...over,
  } as RemotePlanningCommand;
}

// ─── AC1: each action applies through its authority and is recorded ──────────

test("FG-783 AC1: enqueue applies through enqueueTicket and records the full envelope", () => {
  seed(["FG-1", "FG-2"]);
  const cmd = base("enqueue", { targetId: "FG-1", requestId: "req-enq-1" });
  const res = applyRemotePlanningCommand(cmd);

  assert.equal(res.outcome, "applied");
  assert.equal(res.replayed, false);
  assert.deepEqual(queuedIds(), ["FG-1"]);

  const audit = remotePlanningAudit(PK);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.requestId, "req-enq-1");
  assert.equal(audit[0]!.actor, ACTOR);
  assert.equal(audit[0]!.transport, TRANSPORT);
  assert.equal(audit[0]!.action, "enqueue");
  assert.equal(audit[0]!.targetId, "FG-1");
  assert.equal(audit[0]!.outcome, "applied");
  assert.equal(audit[0]!.precondition, "enqueue:readiness@current-revision");
});

test("FG-783 AC1: dequeue applies through dequeueTicket, retains rank, records outcome", () => {
  seed(["FG-1"]);
  applyRemotePlanningCommand(base("enqueue", { targetId: "FG-1", requestId: "e" }));
  const rankBefore = getTicket(PK, "FG-1")!.priorityRank;

  const res = applyRemotePlanningCommand(base("dequeue", { targetId: "FG-1", requestId: "d" }));
  assert.equal(res.outcome, "applied");
  assert.deepEqual(queuedIds(), []);
  // Dequeue retains rank — re-enqueue would return to the same slot.
  assert.equal(getTicket(PK, "FG-1")!.priorityRank, rankBefore);

  const row = remotePlanningAudit(PK).find((r) => r.action === "dequeue")!;
  assert.equal(row.outcome, "applied");
  assert.equal(row.precondition, null); // dequeue carries no version
});

test("FG-783 AC1: change-rank applies through moveQueuePosition under a queueVersion CAS", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2", "FG-3"]) {
    applyRemotePlanningCommand(base("enqueue", { targetId: id, requestId: `e-${id}` }));
  }
  assert.deepEqual(queuedIds(), ["FG-1", "FG-2", "FG-3"]);
  const v = queueVersion(PK);

  const res = applyRemotePlanningCommand(
    base("change-rank", { targetId: "FG-3", position: 1, expectedVersion: v, requestId: "cr" }),
  );
  assert.equal(res.outcome, "applied");
  assert.deepEqual(queuedIds(), ["FG-3", "FG-1", "FG-2"]);
  assert.equal(res.summary.position, 1);

  const row = remotePlanningAudit(PK).find((r) => r.action === "change-rank")!;
  assert.equal(row.outcome, "applied");
  assert.equal(row.precondition, `expectedVersion=${v}`);
});

test("FG-783 AC1: reorder-queue applies through setQueueOrder under a queueVersion CAS", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2", "FG-3"]) {
    applyRemotePlanningCommand(base("enqueue", { targetId: id, requestId: `e-${id}` }));
  }
  const v = queueVersion(PK);
  const res = applyRemotePlanningCommand(
    base("reorder-queue", {
      targetId: "FG-2",
      order: ["FG-2", "FG-3", "FG-1"],
      expectedVersion: v,
      requestId: "ro",
    }),
  );
  assert.equal(res.outcome, "applied");
  assert.deepEqual(queuedIds(), ["FG-2", "FG-3", "FG-1"]);
  const row = remotePlanningAudit(PK).find((r) => r.action === "reorder-queue")!;
  assert.equal(row.precondition, `expectedVersion=${v}`);
});

test("FG-783 AC1: append-annotation applies through the new primitive at the ticket revision", () => {
  seed(["FG-1"]);
  const rev = getTicket(PK, "FG-1")!.revision!;
  const res = applyRemotePlanningCommand(
    base("append-annotation", {
      targetId: "FG-1",
      body: "ship this before the demo",
      ticketRevision: rev,
      requestId: "an-1",
    }),
  );
  assert.equal(res.outcome, "applied");

  const annos = planningAnnotations(PK, "FG-1");
  assert.equal(annos.length, 1);
  assert.equal(annos[0]!.body, "ship this before the demo");
  assert.equal(annos[0]!.actor, ACTOR);
  assert.equal(annos[0]!.ticketRevision, rev);
  assert.equal(annos[0]!.requestId, "an-1");

  const row = remotePlanningAudit(PK).find((r) => r.action === "append-annotation")!;
  assert.equal(row.outcome, "applied");
  assert.equal(row.precondition, `ticketRevision=${rev}`);
});

// ─── AC2: replay returns the recorded outcome and re-applies nothing ─────────

test("FG-783 AC2: a replayed enqueue returns the recorded outcome and re-applies nothing", () => {
  seed(["FG-1", "FG-2"]);
  const cmd = base("enqueue", { targetId: "FG-1", requestId: "dup" });
  const first = applyRemotePlanningCommand(cmd);
  const vAfter = queueVersion(PK);
  const ledgerAfter = ledgerCount();

  const second = applyRemotePlanningCommand(cmd);
  assert.equal(second.replayed, true);
  assert.equal(second.outcome, first.outcome);
  assert.equal(second.targetId, first.targetId);
  // Nothing moved: same version, same ledger row count, same membership.
  assert.equal(queueVersion(PK), vAfter);
  assert.equal(ledgerCount(), ledgerAfter);
  assert.deepEqual(queuedIds(), ["FG-1"]);
});

test("FG-783 AC2: idempotency survives a server restart (reopened DB re-applies nothing)", () => {
  seed(["FG-1", "FG-2"]);
  const cmd = base("enqueue", { targetId: "FG-1", requestId: "survives-restart" });
  applyRemotePlanningCommand(cmd);
  const vAfter = queueVersion(PK);
  const ledgerAfter = ledgerCount();

  restart(); // close + reopen the SAME on-disk file

  const replay = applyRemotePlanningCommand(cmd);
  assert.equal(replay.replayed, true);
  assert.equal(replay.outcome, "applied");
  assert.equal(queueVersion(PK), vAfter);
  assert.equal(ledgerCount(), ledgerAfter);
  assert.deepEqual(queuedIds(), ["FG-1"]);
});

test("FG-783 AC2: a replayed annotation cannot double-append, including after restart", () => {
  seed(["FG-1"]);
  const rev = getTicket(PK, "FG-1")!.revision!;
  const cmd = base("append-annotation", {
    targetId: "FG-1",
    body: "once and only once",
    ticketRevision: rev,
    requestId: "anno-dup",
  });
  applyRemotePlanningCommand(cmd);
  assert.equal(planningAnnotations(PK, "FG-1").length, 1);

  // Same-process replay.
  const r2 = applyRemotePlanningCommand(cmd);
  assert.equal(r2.replayed, true);
  assert.equal(planningAnnotations(PK, "FG-1").length, 1);

  // Post-restart replay.
  restart();
  const r3 = applyRemotePlanningCommand(cmd);
  assert.equal(r3.replayed, true);
  assert.equal(planningAnnotations(PK, "FG-1").length, 1);
});

// ─── AC3: stale precondition refuses with zero mutation + safe summary ───────

test("FG-783 AC3: a stale queue expectedVersion refuses with zero mutation and a safe summary", () => {
  seed(["FG-1", "FG-2", "FG-3"]);
  for (const id of ["FG-1", "FG-2"]) {
    applyRemotePlanningCommand(base("enqueue", { targetId: id, requestId: `e-${id}` }));
  }
  const staleVersion = queueVersion(PK);
  // Move the queue underneath the caller: a third enqueue bumps the version.
  applyRemotePlanningCommand(base("enqueue", { targetId: "FG-3", requestId: "e-3" }));

  const currentVersion = queueVersion(PK);
  const orderBefore = queuedIds();
  assert.notEqual(staleVersion, currentVersion);

  const res = applyRemotePlanningCommand(
    base("change-rank", {
      targetId: "FG-1",
      position: 1,
      expectedVersion: staleVersion,
      requestId: "stale-cr",
    }),
  );

  assert.equal(res.outcome, "refused");
  // Zero mutation: order and version unchanged.
  assert.deepEqual(queuedIds(), orderBefore);
  assert.equal(queueVersion(PK), currentVersion);
  // The safe summary points the client at the current version to re-read.
  assert.equal(res.summary.queueVersion, currentVersion);
  assert.ok(res.summary.message.length > 0);

  // The refusal is recorded (auditable) with outcome 'refused'.
  const row = remotePlanningAudit(PK).find((r) => r.requestId === "stale-cr")!;
  assert.equal(row.outcome, "refused");
});

test("FG-783 AC3: an annotation against a superseded ticket revision refuses with zero mutation", () => {
  seed(["FG-1"]);
  const staleRev = getTicket(PK, "FG-1")!.revision!;
  // Supersede the ticket: an edit bumps the monotonic revision.
  writeTransaction(() => upsertTicket(ticket("FG-1", { body: READY_BODY + "\n- and more" })));
  const currentRev = getTicket(PK, "FG-1")!.revision!;
  assert.notEqual(staleRev, currentRev);

  const res = applyRemotePlanningCommand(
    base("append-annotation", {
      targetId: "FG-1",
      body: "stale note",
      ticketRevision: staleRev,
      requestId: "stale-anno",
    }),
  );

  assert.equal(res.outcome, "refused");
  // Zero mutation: no annotation row written.
  assert.equal(planningAnnotations(PK, "FG-1").length, 0);
  // The safe summary reports the current revision to re-read against.
  assert.equal(res.summary.ticketRevision, currentRev);

  const row = remotePlanningAudit(PK).find((r) => r.requestId === "stale-anno")!;
  assert.equal(row.outcome, "refused");
});

test("FG-783 AC3: a refused command is idempotent too — replay returns the recorded refusal", () => {
  seed(["FG-1"]);
  const staleRev = getTicket(PK, "FG-1")!.revision!;
  writeTransaction(() => upsertTicket(ticket("FG-1", { body: READY_BODY + "\n- more" })));

  const cmd = base("append-annotation", {
    targetId: "FG-1",
    body: "stale",
    ticketRevision: staleRev,
    requestId: "refused-replay",
  });
  const first = applyRemotePlanningCommand(cmd);
  assert.equal(first.outcome, "refused");

  const second = applyRemotePlanningCommand(cmd);
  assert.equal(second.replayed, true);
  assert.equal(second.outcome, "refused");
  assert.equal(planningAnnotations(PK, "FG-1").length, 0);
});

// ─── atomicity: a failure between the mutation and the ledger write ──────────

test("FG-783: a forced failure between the mutation and the ledger write rolls BOTH back", () => {
  seed(["FG-1", "FG-2"]);
  applyRemotePlanningCommand(base("enqueue", { targetId: "FG-1", requestId: "e-1" }));
  const vBefore = queueVersion(PK);
  const orderBefore = queuedIds();
  const ledgerBefore = ledgerCount();

  setLedgerWriteFailureHookForTest(() => {
    throw new Error("simulated crash between mutation and ledger write");
  });

  assert.throws(
    () => applyRemotePlanningCommand(base("enqueue", { targetId: "FG-2", requestId: "e-2" })),
    /simulated crash/,
  );

  setLedgerWriteFailureHookForTest(null);

  // The mutation (FG-2 enqueue) AND the ledger row both rolled back.
  assert.deepEqual(queuedIds(), orderBefore);
  assert.equal(queueVersion(PK), vBefore);
  assert.equal(ledgerCount(), ledgerBefore);
  assert.equal(
    remotePlanningAudit(PK).find((r) => r.requestId === "e-2"),
    undefined,
  );
});

// ─── same-project scope on the read accessors ────────────────────────────────

test("FG-783: the audit accessor is scoped to one project", () => {
  seed(["FG-1"]);
  writeTransaction(() => upsertTicket(ticket("OT-1", { projectKey: OTHER_PK })));

  applyRemotePlanningCommand(base("enqueue", { targetId: "FG-1", requestId: "mine" }));
  applyRemotePlanningCommand(
    base("enqueue", { projectKey: OTHER_PK, targetId: "OT-1", requestId: "theirs" }),
  );

  const mine = remotePlanningAudit(PK);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]!.requestId, "mine");
  assert.equal(mine[0]!.projectKey, PK);

  const theirs = remotePlanningAudit(OTHER_PK);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0]!.requestId, "theirs");
});

// ─── RF-1: the replay ledger is scoped to the committing project ──────────────

test("RF-1: a request-id collision across projects never replays the other project's outcome", () => {
  seed(["FG-1", "FG-2"]);
  writeTransaction(() => upsertTicket(ticket("OT-1", { projectKey: OTHER_PK })));

  const shared = "collision-id";
  const a = applyRemotePlanningCommand(base("enqueue", { targetId: "FG-1", requestId: shared }));
  assert.equal(a.outcome, "applied");
  assert.equal(a.replayed, false);

  // Project B submits its OWN command under the SAME request id. Keyed on request_id alone
  // (the pre-RF-1 defect) B would find A's row and replay A's FG-1 outcome — reading another
  // project's recorded command. Scoped to (project_key, request_id), B's lookup finds nothing
  // and its command applies fresh.
  const b = applyRemotePlanningCommand(
    base("enqueue", { projectKey: OTHER_PK, targetId: "OT-1", requestId: shared }),
  );
  assert.equal(b.replayed, false, "B's command is applied fresh, never replayed from A's row");
  assert.equal(b.targetId, "OT-1", "B never receives A's recorded target");
  assert.equal(b.outcome, "applied");

  // Each project owns exactly its own ledger row under the shared id.
  const auditA = remotePlanningAudit(PK);
  const auditB = remotePlanningAudit(OTHER_PK);
  assert.equal(auditA.length, 1);
  assert.equal(auditA[0]!.targetId, "FG-1");
  assert.equal(auditB.length, 1);
  assert.equal(auditB[0]!.targetId, "OT-1");

  // A genuine same-project redelivery still returns A's recorded outcome unchanged.
  const replayA = applyRemotePlanningCommand(base("enqueue", { targetId: "FG-1", requestId: shared }));
  assert.equal(replayA.replayed, true);
  assert.equal(replayA.targetId, "FG-1");
});

test("RF-1: a same-project request id reused for a DIFFERENT command is refused, not replayed", () => {
  seed(["FG-1", "FG-2"]);
  const id = "reused-id";
  const first = applyRemotePlanningCommand(base("enqueue", { targetId: "FG-1", requestId: id }));
  assert.equal(first.outcome, "applied");

  // Same id, different target. The stored row is FG-1's; returning it would apply nothing for
  // FG-2 while reporting FG-1's outcome — a silent suppression of B's command. It must refuse.
  const collide = applyRemotePlanningCommand(base("enqueue", { targetId: "FG-2", requestId: id }));
  assert.equal(collide.outcome, "refused");
  assert.equal(collide.replayed, false);
  assert.equal(collide.targetId, "FG-2", "the refusal names the caller's own target, never the stored one");
  assert.match(collide.summary.message, /reused/i);

  // Zero mutation: FG-2 was not enqueued and no second ledger row was written under the id.
  assert.deepEqual(queuedIds(), ["FG-1"]);
  assert.equal(remotePlanningAudit(PK).length, 1);
});
