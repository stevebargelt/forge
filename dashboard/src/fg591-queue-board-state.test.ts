// FG-591 step 13 — the Kanban board's DECISIONS, pinned without a browser.
//
// The board's real claims are not "it renders": they are that the five views are
// projections it groups by rather than statuses it re-derives, that a genuine blocker
// and a temporary scheduling wait are two visibly different things, that a dequeued-
// but-executing item is a first-class state rather than a gap, that a reorder submits
// RELATIVE intent plus the version the board loaded, and that a refusal is surfaced
// rather than silently reloaded over. Each of those is a pure function in
// client/queue-board-state.js, so each is asserted here — same shape as
// backlog-state.test.ts and view-routing.test.ts.

import assert from "node:assert/strict";
import test from "node:test";
import {
  BOARD_COLUMNS,
  BOARD_VIEWS,
  DISPATCH_CONTROL_NOTICE,
  queueBoardState,
  waitBadge,
  isBlockerWait,
  isSchedulingWait,
  dispatcherSummary,
  planRelativeMove,
  previewMove,
  rankRequest,
  enqueueRequest,
  dequeueRequest,
  mutationOutcome,
} from "../client/queue-board-state.js";
import { QUEUE_BOARD_VIEWS } from "./queries.js";
import { hashForView, initialView } from "../client/view-routing.js";

// ─── fixtures ────────────────────────────────────────────────────────────────

function row(overrides: Record<string, unknown> = {}) {
  return {
    ticketId: "FG-1",
    title: "a ticket",
    type: "story",
    status: "active",
    rank: 1,
    queued: false,
    enqueuedAt: null,
    enqueuedBy: null,
    note: null,
    blocked: false,
    blockers: [],
    inProgress: false,
    executionState: "idle",
    reservation: null,
    readiness: null,
    view: "backlog",
    wait: null,
    scanReason: null,
    scanDetail: null,
    ...overrides,
  };
}

function panel(overrides: Record<string, unknown> = {}) {
  return {
    armed: false,
    configured: false,
    maxActiveRuns: 1,
    capacityScope: "host",
    leaseTtlMs: 900_000,
    heartbeatMs: 300_000,
    defaultWorkflow: "feature",
    updatedAt: null,
    updatedBy: null,
    lease: null,
    leaseLive: false,
    leaseExpired: false,
    msSinceHeartbeatMs: null,
    lastEvaluation: null,
    nextWatchdogAtMs: null,
    pendingWakes: 0,
    state: "disarmed",
    stateDetail: "autonomous dispatch is disarmed.",
    controlSurface: "cli-only",
    ...overrides,
  };
}

function board(rows: Array<ReturnType<typeof row>>, overrides: Record<string, unknown> = {}) {
  const views: Record<string, string[]> = {
    backlog: [],
    queued: [],
    in_progress: [],
    blocked: [],
    done: [],
    executing_not_queued: [],
  };
  for (const r of rows) views[r.view as string]!.push(r.ticketId);
  return {
    projectKey: "pk-a",
    storageMode: "db",
    queueAvailable: true,
    unavailableReason: null,
    version: 42,
    rows,
    views,
    dispatcher: panel(),
    capacity: {
      scope: "host",
      limit: 1,
      queueOwnedActive: 0,
      holders: [],
      otherProjectHolders: 0,
      notCounted: { activeTasks: 0, policy: "the ceiling bounds queue-owned runs only." },
      lastRefusal: null,
    },
    nowMs: 1_000_000,
    degraded: [],
    ...overrides,
  };
}

// ─── the tab routes ──────────────────────────────────────────────────────────

test("the board is a deep-linkable view through the existing view-routing module", () => {
  // The queue tab goes through view-routing like every other tab rather than
  // inventing a second routing path — "the queue is stalled, look" is a link.
  assert.equal(initialView("#queue"), "queue");
  assert.equal(hashForView("queue"), "#queue");
  // And the existing routes are untouched: adding a view must not steal the
  // hashless route or shadow a sibling.
  assert.equal(initialView(""), "home");
  assert.equal(initialView("#unknown"), "home");
  assert.equal(initialView("#reviews"), "reviews");
  assert.equal(hashForView("home"), "");
});

// ─── the five projections ────────────────────────────────────────────────────

test("the board's columns ARE the server's projection set — no sixth vocabulary in the browser", () => {
  assert.deepEqual(
    [...BOARD_VIEWS].sort(),
    [...QUEUE_BOARD_VIEWS].sort(),
    "the client column set and queries.ts's QUEUE_BOARD_VIEWS must stay the same set: a column the server " +
      "never partitions into is a status this board invented.",
  );
});

test("the five projections group by the server's partition, in its order", () => {
  const rows = [
    row({ ticketId: "FG-1", rank: 1, view: "backlog" }),
    row({ ticketId: "FG-2", rank: 2, queued: true, view: "queued" }),
    row({ ticketId: "FG-3", rank: 3, queued: true, executionState: "running", inProgress: true, view: "in_progress" }),
    row({ ticketId: "FG-4", rank: 4, queued: true, blocked: true, view: "blocked" }),
    row({ ticketId: "FG-5", rank: null, status: "done", view: "done" }),
  ];
  const state = queueBoardState(board(rows));

  assert.equal(state.kind, "board");
  const byView = Object.fromEntries(state.columns.map((c) => [c.view, c.rows.map((r: any) => r.ticketId)]));
  assert.deepEqual(byView["backlog"], ["FG-1"]);
  assert.deepEqual(byView["queued"], ["FG-2"]);
  assert.deepEqual(byView["in_progress"], ["FG-3"]);
  assert.deepEqual(byView["blocked"], ["FG-4"]);
  assert.deepEqual(byView["done"], ["FG-5"]);
});

test("In progress, Blocked and Done are labelled DERIVED; Backlog and Queued are not", () => {
  const derived = Object.fromEntries(BOARD_COLUMNS.map((c) => [c.view, c.derived]));
  assert.equal(derived["in_progress"], true);
  assert.equal(derived["blocked"], true);
  assert.equal(derived["done"], true);
  assert.equal(derived["executing_not_queued"], true);
  assert.equal(derived["backlog"], false, "membership and rank are operator-set durable facts, not derivations");
  assert.equal(derived["queued"], false);
});

test("a blocked queue member keeps its rank while it sits in the derived Blocked column", () => {
  const state = queueBoardState(board([row({ ticketId: "FG-9", rank: 3, queued: true, blocked: true, view: "blocked" })]));
  const blocked = state.columns.find((c) => c.view === "blocked")!;
  assert.equal(blocked.rows[0].rank, 3, "the Blocked view is a projection — it never unranks the item");
  assert.equal(blocked.rows[0].queued, true, "and never removes it from the queue");
});

test("dequeued-but-still-executing renders as its own first-class state, never as a gap", () => {
  const rows = [
    row({
      ticketId: "FG-7",
      rank: 2,
      queued: false,
      executionState: "running",
      inProgress: true,
      view: "executing_not_queued",
      reservation: {
        claimId: "c1",
        owner: "dispatcher-a",
        generation: 1,
        ticketRevision: 4,
        launchId: "L1",
        runId: "R1",
        leaseExpiresAtMs: 2_000_000,
        heartbeatAtMs: 999_000,
        leaseExpired: false,
        claimedAt: "2026-08-06T00:00:00Z",
      },
    }),
  ];
  const state = queueBoardState(board(rows));

  const column = state.columns.find((c) => c.view === "executing_not_queued")!;
  assert.equal(column.count, 1, "a dequeue is a planning act and never releases a live claim — this state is reachable");
  assert.equal(column.rows[0].ticketId, "FG-7");
  assert.equal(
    state.columns.find((c) => c.view === "in_progress")!.count,
    0,
    "it is NOT folded into In progress: In progress is the operator's queue running, and this item is not a member",
  );
  assert.match(column.hint, /never releases a live claim/i);
});

test("an id partitioned into a column but absent from rows is reported, not rendered blank", () => {
  const payload = board([row({ ticketId: "FG-1", view: "backlog" })]);
  payload.views["queued"] = ["FG-404"];
  const state = queueBoardState(payload);
  const queued = state.columns.find((c) => c.view === "queued")!;
  assert.deepEqual(queued.missing, ["FG-404"]);
  assert.equal(queued.rows.length, 0);
});

// ─── the two waiting labels ──────────────────────────────────────────────────

test("a genuine blocker and a temporary scheduling wait are two visibly different things", () => {
  const blocker = waitBadge(
    row({
      wait: { kind: "blocker", reason: "waiting on an upstream decision", source: "blocker_evidence", observedAt: null },
    }),
  )!;
  const scheduling = waitBadge(
    row({
      wait: {
        kind: "scheduling",
        reason: "waiting for FG-123 to finish",
        source: "dispatcher_evaluation",
        observedAt: "2026-08-06T12:00:00Z",
      },
    }),
  )!;

  assert.notEqual(blocker.label, scheduling.label, "the LABELS differ — colour is never the only channel");
  assert.notEqual(blocker.tone, scheduling.tone);
  assert.equal(blocker.label, "Blocked");
  assert.equal(scheduling.label, "Waiting to overlap");
  assert.equal(blocker.durability, "durable");
  assert.equal(scheduling.durability, "temporary", "a scheduling wait evaporates when the active set changes");
  assert.equal(blocker.evidence, "durable");
  assert.equal(scheduling.evidence, "per-evaluation");
  assert.match(scheduling.reason, /FG-123/, "the dispatcher's own concrete reason is shown, not a bare boolean");
  assert.equal(scheduling.observedAt, "2026-08-06T12:00:00Z");
});

test("a scheduling wait stays in the QUEUED column and is never labelled Blocked", () => {
  const waiting = row({
    ticketId: "FG-5",
    rank: 2,
    queued: true,
    blocked: false,
    view: "queued",
    scanReason: "incompatible",
    scanDetail: "waiting for FG-123 to finish",
    wait: {
      kind: "scheduling",
      reason: "waiting for FG-123 to finish",
      source: "dispatcher_evaluation",
      observedAt: "2026-08-06T12:00:00Z",
    },
  });
  const state = queueBoardState(board([waiting]));

  assert.deepEqual(state.columns.find((c) => c.view === "queued")!.rows.map((r: any) => r.ticketId), ["FG-5"]);
  assert.equal(state.columns.find((c) => c.view === "blocked")!.count, 0);
  assert.equal(isSchedulingWait(waiting), true);
  assert.equal(isBlockerWait(waiting), false);
  assert.notEqual(waitBadge(waiting)!.label, "Blocked");
});

test("every wait kind the server can emit has its own presentation — none falls through unlabelled", () => {
  const kinds = ["blocker", "scheduling", "capacity", "readiness", "unranked", "deferred", "claimed", "disarmed", "not_evaluated"];
  const labels = new Set<string>();
  for (const kind of kinds) {
    const badge = waitBadge(row({ wait: { kind, reason: "r", source: "queue_state", observedAt: null } }))!;
    assert.ok(badge, `${kind} produced no badge`);
    assert.notEqual(badge.label, "Unknown", `${kind} fell through to the unknown presentation`);
    labels.add(badge.label);
  }
  assert.equal(labels.size, kinds.length, "each kind reads differently — collapsing two is how a wait gets mislabelled");
});

test("an unrecognised wait kind is shown verbatim rather than dropped", () => {
  const badge = waitBadge(row({ wait: { kind: "something_new", reason: "the dispatcher said so", source: "dispatcher_evaluation", observedAt: null } }))!;
  assert.equal(badge.label, "Unknown");
  assert.equal(badge.reason, "the dispatcher said so");
});

test("a row that is not waiting on anything has no badge", () => {
  assert.equal(waitBadge(row({ wait: null })), null);
  assert.equal(waitBadge(undefined as any), null);
});

// ─── the four not-a-board situations ─────────────────────────────────────────

test("no project selected is not an empty queue", () => {
  const state = queueBoardState(null, { projectSelected: false });
  assert.equal(state.kind, "no-project");
  assert.equal(state.columns.length, BOARD_COLUMNS.length, "the columns still exist and are empty — no crash, no gap");
  assert.equal(state.version, 0);
});

test("a project with no ticket truth renders its own message, not 'nothing queued'", () => {
  const state = queueBoardState({
    projectKey: null,
    storageMode: null,
    queueAvailable: false,
    unavailableReason: "this repository has no ticket truth in the host store — it has never been imported.",
    version: 0,
    rows: [],
    views: {},
    dispatcher: panel(),
    capacity: null,
    nowMs: 1,
    degraded: [],
  });
  assert.equal(state.kind, "no-truth");
  assert.match(state.message!, /never been imported/);
});

test("a markdown-mode project has no operator queue and says so", () => {
  const state = queueBoardState({
    projectKey: "pk-a",
    storageMode: "markdown",
    queueAvailable: false,
    unavailableReason: "the operator queue is a DB-store concept and this project's ticket truth is still Markdown.",
    version: 0,
    rows: [],
    views: {},
    dispatcher: panel(),
    capacity: null,
    nowMs: 1,
    degraded: [],
  });
  assert.equal(state.kind, "unavailable");
  assert.match(state.message!, /Markdown/);
});

test("a failed read is an ERROR — the row count is unknown, never zero", () => {
  const state = queueBoardState({ error: "SQLITE_CORRUPT: database disk image is malformed" });
  assert.equal(state.kind, "error");
  assert.match(state.error!, /SQLITE_CORRUPT/);
});

test("a registered project with zero rows is genuinely empty, and distinct from all of the above", () => {
  const state = queueBoardState(board([]));
  assert.equal(state.kind, "empty");
});

test("a partial payload degrades without throwing", () => {
  const state = queueBoardState({ queueAvailable: true, projectKey: "pk-a" });
  assert.equal(state.kind, "empty");
  assert.equal(state.columns.length, BOARD_COLUMNS.length);
  assert.deepEqual(state.queuedIds, []);
});

// ─── the reorder: relative intent + the loaded version ───────────────────────

test("moving UP submits rank-before the row currently at the target", () => {
  const move = planRelativeMove(["FG-1", "FG-2", "FG-3"], "FG-3", 0);
  assert.deepEqual(move, { ticketId: "FG-3", reference: "FG-1", placement: "before" });
});

test("moving DOWN submits rank-after the row currently at the target", () => {
  const move = planRelativeMove(["FG-1", "FG-2", "FG-3"], "FG-1", 2);
  assert.deepEqual(move, { ticketId: "FG-1", reference: "FG-3", placement: "after" });
});

test("a no-op move and an unknown ticket submit nothing at all", () => {
  assert.equal(planRelativeMove(["FG-1", "FG-2"], "FG-1", 0), null);
  assert.equal(planRelativeMove(["FG-1", "FG-2"], "FG-9", 1), null);
  assert.equal(planRelativeMove(["FG-1"], "FG-1", 0), null);
  assert.equal(planRelativeMove([], "FG-1", 0), null);
});

test("an out-of-range target clamps to a real neighbour rather than inventing one", () => {
  assert.deepEqual(planRelativeMove(["FG-1", "FG-2", "FG-3"], "FG-1", 99), {
    ticketId: "FG-1",
    reference: "FG-3",
    placement: "after",
  });
  assert.deepEqual(planRelativeMove(["FG-1", "FG-2", "FG-3"], "FG-3", -5), {
    ticketId: "FG-3",
    reference: "FG-1",
    placement: "before",
  });
});

test("the submission is RELATIVE INTENT plus the loaded version — never a replayed full ordering", () => {
  const state = queueBoardState(
    board([
      row({ ticketId: "FG-1", rank: 1, queued: true, view: "queued" }),
      row({ ticketId: "FG-2", rank: 2, queued: true, view: "queued" }),
      row({ ticketId: "FG-3", rank: 3, queued: true, view: "queued" }),
    ]),
  );
  const move = planRelativeMove(state.queuedIds, "FG-3", 0)!;
  const request = rankRequest(move, state.version)!;

  assert.equal(request.path, "/api/queue/rank");
  assert.deepEqual(request.body, { ticketId: "FG-3", reference: "FG-1", placement: "before", expectVersion: 42 });
  assert.ok(!("order" in request.body), "a full ordering would silently overwrite positions the operator never touched");
});

test("a board with no loaded version cannot submit a reorder at all", () => {
  const move = { ticketId: "FG-1", reference: "FG-2", placement: "after" as const };
  assert.equal(rankRequest(move, Number.NaN as unknown as number), null);
  assert.equal(rankRequest(move, -1), null);
  assert.equal(rankRequest(null, 3), null);
});

test("the optimistic preview matches the intent that was submitted", () => {
  const ids = ["FG-1", "FG-2", "FG-3"];
  assert.deepEqual(previewMove(ids, planRelativeMove(ids, "FG-3", 0)), ["FG-3", "FG-1", "FG-2"]);
  assert.deepEqual(previewMove(ids, planRelativeMove(ids, "FG-1", 2)), ["FG-2", "FG-3", "FG-1"]);
  assert.deepEqual(previewMove(ids, null), ids, "no move, no reordering");
});

// ─── enqueue / dequeue ───────────────────────────────────────────────────────

test("enqueue and dequeue post exactly their own named routes", () => {
  assert.deepEqual(enqueueRequest("FG-4"), { path: "/api/queue/enqueue", body: { ticketId: "FG-4" } });
  assert.deepEqual(enqueueRequest("FG-4", "  because  "), {
    path: "/api/queue/enqueue",
    body: { ticketId: "FG-4", note: "because" },
  });
  assert.deepEqual(enqueueRequest("FG-4", "   "), { path: "/api/queue/enqueue", body: { ticketId: "FG-4" } });
  assert.deepEqual(dequeueRequest("FG-4"), { path: "/api/queue/dequeue", body: { ticketId: "FG-4" } });
});

test("no board action can arm dispatch or set capacity — those stay CLI-only (D2)", () => {
  const paths = [
    enqueueRequest("FG-1").path,
    dequeueRequest("FG-1").path,
    rankRequest({ ticketId: "FG-1", reference: "FG-2", placement: "after" }, 1)!.path,
  ];
  for (const path of paths) {
    assert.match(path, /^\/api\/queue\/(enqueue|dequeue|rank)$/);
  }
  assert.match(DISPATCH_CONTROL_NOTICE, /forge queue dispatcher arm/);
  assert.match(DISPATCH_CONTROL_NOTICE, /max_active_runs/);
  assert.equal(dispatcherSummary(panel(), 1).controlSurface, "cli-only");
});

// ─── what came back: a refusal is SURFACED, never reloaded over ──────────────

test("a stale-version refusal surfaces the refusal and does NOT silently re-apply", () => {
  const outcome = mutationOutcome({
    status: 409,
    payload: {
      ok: false,
      verb: "rank-before",
      exitCode: 1,
      error: "refusing to reorder: --expect-version 42 is stale; the queue is now at version 47.",
    },
  });

  assert.equal(outcome.ok, false);
  assert.equal(outcome.kind, "stale_version");
  assert.equal(outcome.blocking, true, "the message stays on screen — the operator is told their move did not apply");
  assert.match(outcome.message!, /expect-version 42 is stale/, "the CLI's own concrete refusal is passed through");
  assert.match(outcome.hint!, /not applied/i);
});

test("a non-version refusal is surfaced concretely and asks for no reload", () => {
  const outcome = mutationOutcome({
    status: 409,
    payload: { ok: false, verb: "enqueue", error: "FG-9 is not ready: add acceptance criteria for the failure path." },
  });
  assert.equal(outcome.kind, "refused");
  assert.equal(outcome.needsReload, false);
  assert.match(outcome.message!, /add acceptance criteria/, "the refinement proposal reaches the operator verbatim");
});

test("a guard rejection and a transport failure are distinguishable from a refusal", () => {
  assert.equal(mutationOutcome({ status: 415, payload: { error: "Content-Type must be application/json" } }).kind, "rejected");
  assert.equal(mutationOutcome({ status: 403, payload: { error: "cross-origin request refused" } }).kind, "rejected");
  const dead = mutationOutcome({ status: 0, payload: null });
  assert.equal(dead.kind, "error");
  assert.match(dead.message!, /could not reach the server/);
});

test("an applied mutation is the ONLY outcome that asks the board to re-read", () => {
  const applied = mutationOutcome({ status: 200, payload: { ok: true, verb: "rank-before", result: {} } });
  assert.equal(applied.ok, true);
  assert.equal(applied.needsReload, true);
  assert.equal(applied.blocking, false);
});

// ─── the dispatcher panel ────────────────────────────────────────────────────

test("the six no-run answers stay distinguishable rather than collapsing into 'nothing is running'", () => {
  const states = ["disarmed", "no_capacity", "no_eligible_work", "incompatible_only", "lost", "stale_dispatcher"];
  const labels = states.map((state) => dispatcherSummary(panel({ state }), 1).label);
  assert.equal(new Set(labels).size, states.length, `two of ${labels.join(" / ")} read the same`);
});

test("a dead dispatcher does not read as 'nothing to do' — staleness is its own number", () => {
  const summary = dispatcherSummary(
    panel({
      state: "stale_dispatcher",
      lease: { owner: "dispatcher-a", generation: 3, leaseExpiresAtMs: 5, heartbeatAtMs: 5, host: "h", pid: 1, createdAt: "c", updatedAt: "u" },
      leaseLive: false,
      leaseExpired: true,
      msSinceHeartbeatMs: 4 * 3_600_000,
      stateDetail: "the lease expired 4h ago.",
    }),
    1_000_000,
  );
  assert.equal(summary.label, "Dispatcher stale");
  assert.equal(summary.tone, "err");
  assert.equal(summary.leaseExpired, true);
  assert.equal(summary.leaseStaleness, 4 * 3_600_000);
});

test("the panel reports 'never configured' rather than presenting a default as an operator choice", () => {
  const summary = dispatcherSummary(panel({ configured: false, maxActiveRuns: 1 }), 1);
  assert.equal(summary.configured, false);
  assert.equal(summary.armed, false, "armed is fail-closed — an absent policy row never reads as armed");
});

test("last-evaluation age and the next watchdog deadline are relative to the STORE clock in the payload", () => {
  const summary = dispatcherSummary(
    panel({
      state: "no_eligible_work",
      lastEvaluation: {
        reason: "no_eligible_work",
        detail: "0 candidates",
        evaluatedAt: "2026-08-06T12:00:00Z",
        evaluatedAtMs: 900_000,
        wakeKind: "queue_change",
        claimedTicketId: null,
        capacityScope: "host",
        capacityLimit: 1,
        capacityUsed: 0,
        scannedCount: 0,
      },
      nextWatchdogAtMs: 1_060_000,
    }),
    1_000_000,
  );
  assert.equal(summary.lastEvaluationAgeMs, 100_000);
  assert.equal(summary.nextWatchdogInMs, 60_000);
});

test("an absent dispatcher panel degrades to an honest unknown rather than a false 'disarmed'", () => {
  const summary = dispatcherSummary(undefined, null);
  assert.equal(summary.present, false);
  assert.equal(summary.state, "not_evaluated");
  assert.equal(summary.controlSurface, "cli-only");
});

// ─── the host-scoped capacity context ────────────────────────────────────────

test("a host-scoped refusal names the OTHER project holding the slot", () => {
  const state = queueBoardState(
    board([row({ ticketId: "FG-1", queued: true, view: "queued" })], {
      capacity: {
        scope: "host",
        limit: 1,
        queueOwnedActive: 1,
        holders: [
          { claimId: "c1", projectKey: "pk-b", projectLabel: "other-project", ticketId: "OT-3", owner: "d-b", launchId: "L", runId: "R", thisProject: false },
        ],
        otherProjectHolders: 1,
        notCounted: { activeTasks: 2, policy: "reported, never counted." },
        lastRefusal: null,
      },
    }),
  );
  assert.equal(state.capacity.scope, "host");
  assert.equal(state.capacity.otherProjectHolders, 1);
  assert.equal(state.capacity.holders[0].projectLabel, "other-project");
  assert.equal(state.capacity.notCounted!.activeTasks, 2, "other Forge work is REPORTED beside the ceiling, never subtracted from it");
});

test("degraded reads are carried through as UNKNOWN sections rather than dropped", () => {
  const state = queueBoardState(board([row({})], { degraded: ["dispatcher_leases", "dispatcher_wakes"] }));
  assert.deepEqual(state.degraded, ["dispatcher_leases", "dispatcher_wakes"]);
});
