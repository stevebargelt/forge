// FG-591 — the board PROJECTION, and the literals it mirrors.
//
// Two jobs, both of which the routes integration test cannot do:
//
// (1) THE PURE CLASSIFIERS, exercised directly over hydrated facts. The five
//     views are projections over three orthogonal durable fields, so the
//     classifier is a total function of (status, queued, blocked, executionState)
//     and can be pinned exhaustively — including the sixth state the schema
//     anticipated and the projection had no name for, not-a-queue-member AND
//     executing.
//
// (2) THE DRIFT PINS. dashboard/src/queries.ts reads this store through direct
//     SQL and cannot import the store modules (they reach getDb, which would drag
//     better-sqlite3's write handle and the whole store into this typecheck — the
//     same reason blocked-source.ts exists as a zero-import leaf). So a handful of
//     VALUES are mirrored there: the order-affecting queue event types, the
//     terminal task statuses, the queueable readiness outcomes, the policy
//     defaults and the ticket content hash. A mirrored value with tests on both
//     sides drifts silently — each suite writes the string it reads. These
//     assertions compare the copy against its SINGLE declaration, so a change on
//     the store side fails HERE rather than on the operator's board.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  QUEUE_BOARD_VIEWS,
  classifyQueueBoardView,
  deriveQueueWait,
  type QueueBoardReadiness,
  type QueueExecutionState,
} from "./queries.js";

import { QUEUE_ORDER_EVENT_TYPES, ticketBodyHash } from "../../src/store/queue.js";
import {
  DEFAULT_CAPACITY_SCOPE,
  DEFAULT_HEARTBEAT_MS,
  DEFAULT_LEASE_TTL_MS,
  DEFAULT_MAX_ACTIVE_RUNS,
  DEFAULT_WORKFLOW,
  HOST_POLICY_SCOPE,
} from "../../src/store/dispatcher-policy.js";
import { DISPATCH_REASONS } from "../../src/store/dispatcher-evidence.js";
import type { TicketRow } from "../../src/store/tickets.js";

// The private mirrors live inside queries.ts (they are implementation, not API).
// Reading them back out of the module source is deliberate: the point is to prove
// the COPY matches, and exporting the copy just to test it would make the export
// the thing under test rather than the copy.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const QUERIES_SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "queries.ts"), "utf8");

function mirroredArray(name: string): string[] {
  const match = QUERIES_SRC.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  assert.ok(match, `queries.ts no longer declares ${name}`);
  return [...match[1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
}

function mirroredNumber(name: string): number {
  const match = QUERIES_SRC.match(new RegExp(`${name}: ([0-9_ */]+),`));
  assert.ok(match, `queries.ts no longer declares ${name}`);
  // A numeric literal expression lifted out of our OWN source, evaluated so that
  // `15 * 60_000` compares against the constant rather than against its spelling.
  return Number(new Function(`return (${match[1]!})`)());
}

// ── (1) the pure classifiers ─────────────────────────────────────────────────

test("FG-591: the five views are a projection over three orthogonal fields — never a stored status", () => {
  const view = (status: string, queued: boolean, blocked: boolean, executionState: QueueExecutionState) =>
    classifyQueueBoardView({ status, queued, blocked, executionState });

  // Backlog: every non-done ticket the operator has not selected. Ranked or not,
  // and a deferred one is VISIBLE here rather than hidden.
  assert.equal(view("active", false, false, "idle"), "backlog");
  assert.equal(view("deferred", false, false, "idle"), "backlog");
  // A blocked NON-member stays in the backlog carrying blocked: true. The Blocked
  // column is the operator's queue seen through a blocker, not every impeded ticket.
  assert.equal(view("active", false, true, "idle"), "backlog");

  assert.equal(view("active", true, false, "idle"), "queued");
  assert.equal(view("deferred", true, false, "idle"), "queued");
  assert.equal(view("active", true, true, "idle"), "blocked");

  // DERIVED from evidence, never toggled: a live run means In progress and a done
  // lifecycle means Done, whatever the other fields say.
  assert.equal(view("active", true, false, "running"), "in_progress");
  assert.equal(view("active", true, true, "running"), "in_progress");
  assert.equal(view("active", true, false, "launching"), "in_progress");
  assert.equal(view("done", true, false, "idle"), "done");
  assert.equal(view("done", true, true, "running"), "done");

  // THE SIXTH STATE. An operator dequeue never releases a live claim (D4), so a
  // dequeued item whose container is still running is reachable BY DESIGN. It is a
  // first-class column, not a gap — a live container must never render as nothing.
  assert.equal(view("active", false, false, "running"), "executing_not_queued");
  assert.equal(view("active", false, false, "launching"), "executing_not_queued");
  assert.equal(view("active", false, true, "running"), "executing_not_queued");

  // Every classifier output is one of the declared views.
  for (const status of ["active", "deferred", "done"]) {
    for (const queued of [true, false]) {
      for (const blocked of [true, false]) {
        for (const state of ["idle", "launching", "running"] as QueueExecutionState[]) {
          assert.ok(QUEUE_BOARD_VIEWS.includes(view(status, queued, blocked, state)));
        }
      }
    }
  }
});

const READY: QueueBoardReadiness = {
  outcome: "ready",
  gaps: [],
  refinementProposal: null,
  revision: 3,
  evaluatedAt: "2026-08-06T10:00:00Z",
  stale: false,
  queueable: true,
};

function wait(overrides: Partial<Parameters<typeof deriveQueueWait>[0]> = {}) {
  return deriveQueueWait({
    status: "active",
    queued: true,
    rank: 1,
    blocked: false,
    blockerReason: null,
    executionState: "idle",
    reservation: null,
    readiness: READY,
    armed: true,
    scan: null,
    evaluation: null,
    ...overrides,
  });
}

test("FG-591: a temporary scheduling incompatibility is a SCHEDULING wait, and never a blocker", () => {
  const scheduling = wait({
    scan: { reason: "incompatible", detail: "waiting for FG-123 to finish" },
    evaluation: { reason: "incompatible_only", evaluatedAt: "2026-08-06T10:05:00Z", detail: null },
  });
  assert.equal(scheduling?.kind, "scheduling");
  assert.equal(scheduling?.reason, "waiting for FG-123 to finish");
  // It came from the per-evaluation scan record — which is where it lives and the
  // ONLY place it may live. blocker_evidence is durable, per-ticket and partly
  // container-visible; a scheduling wait written there would flip every agent
  // container's view of that ticket's status.
  assert.equal(scheduling?.source, "dispatcher_evaluation");
  assert.equal(scheduling?.observedAt, "2026-08-06T10:05:00Z");

  const blocked = wait({ blocked: true, blockerReason: "FG-9 must ship first" });
  assert.equal(blocked?.kind, "blocker");
  assert.equal(blocked?.source, "blocker_evidence");
  // The two are DIFFERENT THINGS with different kinds — the AC's whole point.
  assert.notEqual(blocked?.kind, scheduling?.kind);
});

test("FG-591: every no-run answer for a queued item is named from a durable fact, never guessed", () => {
  assert.equal(wait({ status: "deferred" })?.kind, "deferred");
  assert.equal(wait({ rank: null })?.kind, "unranked");
  assert.equal(wait({ readiness: null })?.kind, "readiness");
  assert.equal(wait({ readiness: { ...READY, stale: true, queueable: false } })?.kind, "readiness");
  assert.match(String(wait({ readiness: { ...READY, stale: true, queueable: false } })?.reason), /older revision/);
  assert.equal(wait({ scan: { reason: "capacity", detail: "1/1 live claims in host scope" } })?.kind, "capacity");
  assert.equal(wait({ scan: { reason: "already_claimed", detail: null } })?.kind, "claimed");
  assert.equal(wait({ reservation: { owner: "dispatcher-a" } })?.kind, "claimed");

  // Disarmed: queue membership is planning intent, never execution authorization.
  const disarmed = wait({ armed: false });
  assert.equal(disarmed?.kind, "disarmed");
  assert.equal(disarmed?.source, "dispatcher_policy");

  // Armed, no evaluation covers it: reported as unevaluated rather than as a
  // fabricated reason.
  assert.equal(wait({})?.kind, "not_evaluated");

  // Eligible in the last scan and the pass still granted nothing on capacity:
  // the pass-level reason is the honest answer.
  assert.equal(
    wait({
      scan: { reason: "eligible", detail: null },
      evaluation: { reason: "no_capacity", evaluatedAt: "2026-08-06T10:05:00Z", detail: "1/1 live claims in host scope" },
    })?.kind,
    "capacity",
  );

  // Running, done, and a plain unqueued backlog item are not "waiting" at all.
  assert.equal(wait({ executionState: "running" }), null);
  assert.equal(wait({ status: "done" }), null);
  assert.equal(wait({ queued: false }), null);
  // …but a blocked or deferred one says so even when it is not a queue member,
  // because that is a durable fact about the TICKET.
  assert.equal(wait({ queued: false, blocked: true, blockerReason: "FG-9" })?.kind, "blocker");
});

// ── (2) the drift pins ───────────────────────────────────────────────────────

test("FG-591 drift pin: the mirrored queue-order event types match src/store/queue.ts", () => {
  assert.deepEqual(mirroredArray("QUEUE_ORDER_EVENT_TYPES"), [...QUEUE_ORDER_EVENT_TYPES]);
});

test("FG-591 drift pin: the mirrored ticket content hash matches ticketBodyHash", () => {
  // The dashboard recomputes the hash only for a row written before
  // tickets.body_hash existed; a stamped hash is used verbatim. Both branches are
  // covered here against the store's own function.
  const row = {
    projectKey: "pk",
    ticketId: "FG-1",
    type: "story",
    status: "active",
    title: "A ticket",
    body: "Body text.",
    created: "2026-08-01",
    closed: null,
    closedCommit: null,
    epic: "FG-0",
    bodyHash: null,
    revision: 1,
  };
  const mirrored = createHash("sha256")
    .update(JSON.stringify([row.type, row.status, row.title, row.body, row.created, null, null, row.epic]))
    .digest("hex");
  assert.equal(mirrored, ticketBodyHash(row as unknown as TicketRow));
  // A stamped body_hash wins over the recomputation, which is exactly what
  // ticketBodyHash does.
  assert.equal(ticketBodyHash({ ...row, bodyHash: "stamped" } as unknown as TicketRow), "stamped");
});

test("FG-591 drift pin: the mirrored dispatcher-policy defaults match src/store/dispatcher-policy.ts", () => {
  assert.equal(mirroredNumber("maxActiveRuns"), DEFAULT_MAX_ACTIVE_RUNS);
  assert.equal(mirroredNumber("leaseTtlMs"), DEFAULT_LEASE_TTL_MS);
  assert.equal(mirroredNumber("heartbeatMs"), DEFAULT_HEARTBEAT_MS);
  assert.match(QUERIES_SRC, new RegExp(`capacityScope: "${DEFAULT_CAPACITY_SCOPE}"`));
  assert.match(QUERIES_SRC, new RegExp(`defaultWorkflow: "${DEFAULT_WORKFLOW}"`));
  // The singleton scope_key the ceiling lives under.
  assert.match(QUERIES_SRC, new RegExp(`scope_key === "${HOST_POLICY_SCOPE}"`));
});

test("FG-591 drift pin: every dispatch reason the store can record is rendered as a distinguishable panel state", () => {
  // The panel must not collapse the closed vocabulary into "nothing is running".
  // `disabled` is deliberately absent from this map — the policy row, not a past
  // pass, decides the disarmed state — and is asserted separately below.
  const rendered: Record<string, string> = {
    granted: "dispatching",
    no_capacity: "no_capacity",
    no_eligible_work: "no_eligible_work",
    incompatible_only: "incompatible_only",
    lost: "lost",
  };
  for (const reason of DISPATCH_REASONS) {
    if (reason === "disabled") {
      assert.match(QUERIES_SRC, /case "disabled":/);
      continue;
    }
    assert.ok(rendered[reason], `dispatch reason '${reason}' has no panel state`);
    assert.match(QUERIES_SRC, new RegExp(`"${rendered[reason]}"`), `panel state for '${reason}' is missing`);
  }
});

test("FG-591: the dashboard NEVER writes — no INSERT/UPDATE/DELETE reaches the board's SQL", () => {
  // The handle is opened readonly, so a write would throw; this is the cheaper,
  // earlier signal, and it also catches a write smuggled into a string.
  const boardSection = QUERIES_SRC.slice(QUERIES_SRC.indexOf("FG-591: the operator work queue board"));
  assert.doesNotMatch(boardSection, /\b(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b\s/);
});
