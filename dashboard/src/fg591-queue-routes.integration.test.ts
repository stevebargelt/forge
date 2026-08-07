// FG-591 — GET /api/queue, end to end against a store the FORGE STORE MODULES wrote.
//
// Nothing about the queue is hand-seeded here. Ranks come from rankTicket,
// membership from enqueueTicket (which re-evaluates readiness on the CURRENT
// revision and would refuse a not-ready ticket), blockers from
// upsertBlockerEvidence, execution evidence from recordDispatchEvidence,
// reservations from claimNextEligible + recordClaimLaunch, and the dispatcher's
// policy / lease / evaluation records from their own modules. The dashboard reads
// whatever that produced, through its own read-only handle and its own hardcoded
// SQL — which is the only way this proves anything: a suite that wrote the rows it
// reads would stay green through any drift between the two sides.
//
// The only direct INSERTs are the `runs` rows and the project_identity mapping —
// the dashboard's own registry input, not queue truth (the fg608 precedent).

import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";

const TEST_PORT = 18799;
const BASE = `http://127.0.0.1:${TEST_PORT}`;

// --- env before ANY forge module is evaluated: both the store handle and the
// dashboard's read-only handle resolve FORGE_HOME per call, and both must land on
// this test's private store. ---
const tmpHome = mkdtempSync(join(tmpdir(), "fg591-queue-rt-"));
process.env.FORGE_HOME = tmpHome;
process.env.FORGE_PROJECT_SCAN_ROOTS = mkdtempSync(join(tmpdir(), "fg591-queue-scan-"));
process.env.PORT = String(TEST_PORT);
process.env.HOST = "127.0.0.1";

const { getDb, writeTransaction } = await import("../../src/store/db.js");
const { upsertTicket, setStorageMode, recordDispatchEvidence, upsertBlockerEvidence } = await import(
  "../../src/store/tickets.js"
);
const { rankTicket, enqueueTicket, dequeueTicket } = await import("../../src/store/queue.js");
const { claimNextEligible, recordClaimLaunch } = await import("../../src/store/queue-claims.js");
const { setDispatcherPolicy, acquireDispatcherLease, DEFAULT_LEASE_TTL_MS } = await import(
  "../../src/store/dispatcher-policy.js"
);
const { listWakes, recordEvaluation, recordWake } = await import("../../src/store/dispatcher-evidence.js");
const { repositoryCheckoutIdentity } = await import("../../src/util/repository-identity.js");

const PK_A = "pk-fg591-board";
const PK_B = "pk-fg591-other";
const AT = "2026-08-06T09:00:00Z";

// A body evaluateReadiness (FG-382) calls READY: Problem, Goal, bulleted AC.
const READY_BODY = ["## Problem", "It hurts.", "", "## Goal", "Stop it.", "", "## Acceptance Criteria", "- it works"].join("\n");

function fixtureCheckout(name: string, remote: string): string {
  const dir = mkdtempSync(join(tmpdir(), `fg591-${name}-`));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir, stdio: "ignore" });
  return dir;
}

const dirA = fixtureCheckout("board", "git@github.com:stevebargelt/fg591-board.git");
const dirB = fixtureCheckout("other", "git@github.com:stevebargelt/fg591-other.git");

function seedTicket(projectKey: string, id: string, over: { status?: string; body?: string } = {}): void {
  upsertTicket({
    projectKey,
    ticketId: id,
    type: "story",
    status: over.status ?? "active",
    title: `title ${id}`,
    body: over.body ?? READY_BODY,
    created: "2026-01-01",
    closed: null,
    closedCommit: null,
    epic: null,
    frontmatter: null,
    importedAt: AT,
    importedFrom: null,
  } as never);
}

// ── the fixture, written through the real store ──────────────────────────────
{
  // Registry input (the dashboard's own resolution path), then storage mode
  // through the store module that owns it.
  const database = getDb();
  const identity = database.prepare(
    `INSERT INTO project_identity (project_key, repo_evidence_key, repo_evidence_source, created_at) VALUES (?,?,?,?)`,
  );
  writeTransaction(() => {
    identity.run(PK_A, repositoryCheckoutIdentity(dirA).key, "remote", AT);
    identity.run(PK_B, repositoryCheckoutIdentity(dirB).key, "remote", AT);
    const run = database.prepare(
      `INSERT INTO runs (id,workflow,title,status,created_at,project_dir) VALUES (?,?,?,?,?,?)`,
    );
    run.run("run-fg591-a", "feature", "board fixture", "complete", AT, dirA);
    run.run("run-fg591-b", "feature", "other fixture", "complete", AT, dirB);
  });
  setStorageMode(PK_A, "db", AT);
  setStorageMode(PK_B, "db", AT);

  // FG-201 queued and ready — the compatibility-wait case.
  // FG-202 queued and EXECUTING — in progress, derived from dispatch evidence.
  // FG-203 queued and BLOCKED — derived from blocker evidence, keeps its rank.
  // FG-204 claimed and launched, then DEQUEUED — the sixth state.
  // FG-205 ranked only, never queued — plain backlog.
  // FG-206 done, and the queue knows it — the Done column.
  for (const id of ["FG-201", "FG-202", "FG-203", "FG-204", "FG-205"]) seedTicket(PK_A, id);
  seedTicket(PK_A, "FG-206");
  for (const id of ["FG-201", "FG-202", "FG-203", "FG-204", "FG-205", "FG-206"]) {
    rankTicket(PK_A, id, undefined, AT);
  }
  for (const id of ["FG-201", "FG-202", "FG-203", "FG-204", "FG-206"]) {
    const result = enqueueTicket(PK_A, id, { by: "operator" }, AT);
    assert.ok(result.ok, `enqueue ${id} refused: ${result.ok ? "" : result.reason}`);
  }

  // FG-202 is IN PROGRESS: a task that has not reached a terminal disposition,
  // plus the dispatch evidence binding it to the ticket. No column says so.
  writeTransaction(() => {
    getDb()
      .prepare(
        `INSERT INTO tasks (id,run_id,phase,agent_role,status,task_package,created_at,started_at)
         VALUES (?,?,?,?,?,'{}',?,?)`,
      )
      .run("task-fg591-202", "run-fg591-a", "build", "engineer", "running", AT, AT);
  });
  recordDispatchEvidence({
    taskId: "task-fg591-202",
    projectKey: PK_A,
    ticketId: "FG-202",
    revision: 1,
    bodyHash: "hash-202",
    dispatchedAt: AT,
  } as never);

  // FG-203 is BLOCKED: enriched dependency evidence whose queue projection blocks.
  // Its rank and membership are untouched by that — the whole point of AC6.
  upsertBlockerEvidence({
    projectKey: PK_A,
    ticketId: "FG-203",
    source: "queue-dependency:FG-9",
    kind: "dependency",
    reason: "FG-9 must ship first",
    detail: null,
    bodyHash: null,
    queueProjection: "blocked",
    createdAt: AT,
  } as never);

  // FG-204: a real claim through the real primitive, its launch stamped BEFORE any
  // physical launch — then an operator DEQUEUE, which must never release it (D4).
  const claim204 = claimNextEligible({
    projectKey: PK_A,
    owner: "dispatcher-a",
    capacity: 4,
    capacityScope: "host",
    leaseTtlMs: DEFAULT_LEASE_TTL_MS,
    isCompatible: (candidate) => (candidate.ticketId === "FG-204" ? { compatible: true } : { compatible: false, reason: "fixture" }),
  });
  assert.ok(claim204.claimed, `fixture claim refused: ${claim204.reason}`);
  recordClaimLaunch({
    projectKey: PK_A,
    claimId: claim204.claimed.id,
    owner: "dispatcher-a",
    generation: claim204.claimed.generation,
    launchId: "launch-fg591-204",
  });
  dequeueTicket(PK_A, "FG-204", AT);

  // FG-206 is done. It keeps its rank and membership; the queue ran it.
  writeTransaction(() => {
    getDb().prepare(`UPDATE tickets SET status = 'done' WHERE project_key = ? AND ticket_id = ?`).run(PK_A, "FG-206");
  });

  // THE OTHER PROJECT holds a host-scope capacity slot. Under a host-scoped
  // ceiling this is what makes project A's board otherwise unreadable: nothing of
  // A's is running and A's queue is stalled.
  seedTicket(PK_B, "FG-777");
  rankTicket(PK_B, "FG-777", undefined, AT);
  assert.ok(enqueueTicket(PK_B, "FG-777", { by: "operator" }, AT).ok);
  const claimB = claimNextEligible({
    projectKey: PK_B,
    owner: "dispatcher-b",
    capacity: 4,
    capacityScope: "host",
    leaseTtlMs: DEFAULT_LEASE_TTL_MS,
  });
  assert.ok(claimB.claimed, "the other project's fixture claim was refused");

  // Policy, identity and the durable evidence trail.
  setDispatcherPolicy({ armed: true, maxActiveRuns: 2, capacityScope: "host", updatedBy: "operator@test" });
  const lease = acquireDispatcherLease({ projectKey: PK_A, owner: "dispatcher-a", ttlMs: DEFAULT_LEASE_TTL_MS, host: "testhost", pid: 4242 });
  assert.ok(lease.granted);

  // Pass 1: the ceiling refused, naming who held the slots — including the OTHER
  // project's claim, recorded as it was at refusal time.
  recordEvaluation({
    projectKey: PK_A,
    dispatcherOwner: "dispatcher-a",
    dispatcherGeneration: 1,
    reason: "no_capacity",
    detail: "2/2 live claims in host scope",
    capacityScope: "host",
    capacityLimit: 2,
    capacityUsed: 2,
    capacityHolders: [
      { claimId: claimB.claimed.id, projectKey: PK_B, ticketId: "FG-777", owner: "dispatcher-b", launchId: null, runId: null },
      { claimId: claim204.claimed.id, projectKey: PK_A, ticketId: "FG-204", owner: "dispatcher-a", launchId: "launch-fg591-204", runId: null },
    ],
    scanEvidence: [{ ticketId: "FG-201", rank: 1, reason: "capacity", detail: "2/2 live claims in host scope" }],
  });

  // Pass 2 (the latest): a pure SCHEDULING wait. FG-201 is ready, unblocked and
  // unclaimed, and simply cannot overlap what is running.
  recordEvaluation({
    projectKey: PK_A,
    dispatcherOwner: "dispatcher-a",
    dispatcherGeneration: 1,
    reason: "incompatible_only",
    detail: "the only eligible candidate cannot overlap the active set",
    capacityScope: "host",
    capacityLimit: 2,
    capacityUsed: 1,
    wakeKind: "run_terminal",
    nextWatchdogAtMs: 1_780_000_000_000,
    scanEvidence: [
      { ticketId: "FG-201", rank: 1, reason: "incompatible", detail: "waiting for FG-204 to finish" },
      { ticketId: "FG-203", rank: 3, reason: "queue_blocked", detail: "FG-9 must ship first" },
    ],
  });
  recordWake({ projectKey: PK_A, kind: "queue_changed", wakeKey: "FG-201" });
}

// ── the outbound-call instrumentation ────────────────────────────────────────
//
// Executable shims first on PATH observe the EFFECT of a subprocess through
// whatever API a caller used (a module-level spy cannot: a builtin's ESM
// namespace is frozen and named imports bind at link time); the fetch wrapper
// observes outbound HTTP. The negative control in the test below proves the shim
// channel is LIVE, or "zero calls" would be unfalsifiable.
//
// `git` is shimmed as a PASSTHROUGH rather than a stub, because it is the one
// binary this route legitimately reaches: resolving "which project is this
// request about" goes through the dashboard's shared project registry, whose
// discovery "executes bounded Git commands for every observed checkout"
// (dashboard/src/queries.ts, 30s cached). /api/backlog and /api/projects have
// always done exactly this, and /api/queue asks the same question and MUST get
// the same answer — a board that resolved projects differently from the backlog
// panel beside it would be worse than one that shells `git rev-parse`. That is a
// pre-existing, recorded property of the registry, not something this route
// introduces, which is why the FG-679 BD-7 guard is scoped to its own three paths
// and is neither widened to cover this one nor narrowed to excuse it. What this
// test proves is the part that IS this route's: the board's own reads spawn
// nothing at all and make no outbound request.
const RIG = mkdtempSync(join(tmpdir(), "fg591-guard-"));
const CALL_LOG = join(RIG, "calls.log");
writeFileSync(CALL_LOG, "");
const SHIM_DIR = join(RIG, "bin");
mkdirSync(SHIM_DIR, { recursive: true });
const REAL_GIT = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
for (const bin of ["docker", "gh", "tmux", "forge", "forge-dev"]) {
  const shim = join(SHIM_DIR, bin);
  writeFileSync(shim, `#!/bin/sh\nprintf '%s %s\\n' "shim:${bin}" "$*" >> "${CALL_LOG}"\nexit 0\n`);
  chmodSync(shim, 0o755);
}
writeFileSync(
  join(SHIM_DIR, "git"),
  `#!/bin/sh\nprintf '%s %s\\n' "shim:git" "$*" >> "${CALL_LOG}"\nexec ${REAL_GIT} "$@"\n`,
);
chmodSync(join(SHIM_DIR, "git"), 0o755);
process.env.PATH = `${SHIM_DIR}:${process.env.PATH ?? ""}`;

function observedCalls(): string[] {
  return readFileSync(CALL_LOG, "utf8").split("\n").filter((l) => l.trim() !== "");
}

const realFetch = globalThis.fetch;
const outbound: string[] = [];
globalThis.fetch = ((input: Parameters<typeof realFetch>[0], init?: Parameters<typeof realFetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
  if (!url.startsWith(BASE)) outbound.push(url);
  return realFetch(input, init);
}) as typeof realFetch;

const { server } = await import("./server.js");

after(() => {
  globalThis.fetch = realFetch;
  server.closeAllConnections?.();
  server.close();
});

async function waitForServer(ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      await realFetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 40));
    }
  }
  throw new Error(`Server on port ${TEST_PORT} did not start within ${ms}ms`);
}

await waitForServer();

type BoardRow = {
  ticketId: string;
  status: string;
  rank: number | null;
  queued: boolean;
  blocked: boolean;
  inProgress: boolean;
  executionState: string;
  view: string;
  wait: { kind: string; reason: string; source: string } | null;
  reservation: { claimId: string; launchId: string | null; owner: string } | null;
  readiness: { outcome: string; stale: boolean; queueable: boolean } | null;
  blockers: Array<{ source: string; blocking: boolean }>;
};

type Board = {
  projectKey: string | null;
  storageMode: string | null;
  queueAvailable: boolean;
  version: number;
  rows: BoardRow[];
  views: Record<string, string[]>;
  dispatcher: Record<string, unknown> & { state: string; stateDetail: string; armed: boolean; controlSurface: string };
  capacity: {
    scope: string;
    limit: number;
    queueOwnedActive: number;
    otherProjectHolders: number;
    holders: Array<{ projectKey: string; ticketId: string; thisProject: boolean; projectLabel: string | null }>;
    notCounted: { activeTasks: number; policy: string };
    lastRefusal: { holders: Array<{ projectKey: string; ticketId: string; thisProject: boolean }> } | null;
  };
  degraded: string[];
};

async function board(query = `?projectDir=${encodeURIComponent(dirA)}`): Promise<Board> {
  const res = await fetch(`${BASE}/api/queue${query}`);
  assert.equal(res.status, 200);
  const body = (await res.json()) as Board & { error?: string };
  assert.equal(body.error, undefined, `board read failed: ${body.error ?? ""}`);
  return body;
}

function row(b: Board, id: string): BoardRow {
  const found = b.rows.find((r) => r.ticketId === id);
  assert.ok(found, `${id} is missing from the board`);
  return found;
}

test("FG-591 AC1: the board is the complete backlog, with rank, membership, readiness and lifecycle on every row", async () => {
  const b = await board();
  assert.equal(b.projectKey, PK_A);
  assert.equal(b.storageMode, "db");
  assert.equal(b.queueAvailable, true);
  assert.deepEqual(b.degraded, []);
  assert.deepEqual(
    b.rows.map((r) => r.ticketId),
    ["FG-201", "FG-202", "FG-203", "FG-204", "FG-205", "FG-206"],
    "canonical order is rank ASC then ticket id — the store's own total order",
  );
  // Rank is nullable and orthogonal to membership: FG-205 is ranked and NOT a
  // member, and a dequeue retained FG-204's rank.
  assert.equal(row(b, "FG-205").queued, false);
  assert.equal(typeof row(b, "FG-205").rank, "number");
  assert.equal(row(b, "FG-204").queued, false);
  assert.equal(row(b, "FG-204").rank, 4);
  assert.equal(row(b, "FG-201").readiness?.outcome, "ready");
  assert.equal(row(b, "FG-201").readiness?.stale, false);
  assert.equal(row(b, "FG-201").readiness?.queueable, true);
  // The version a reorder must carry (D11) moves with the queue, and is the
  // queue's own event id rather than a second counter.
  assert.ok(b.version > 0);
});

test("FG-591 AC6/AC7: In progress and Blocked are DERIVED from evidence — no column stores either", async () => {
  const b = await board();

  assert.equal(row(b, "FG-202").inProgress, true);
  assert.equal(row(b, "FG-202").executionState, "running");
  assert.equal(row(b, "FG-202").view, "in_progress");

  const blocked = row(b, "FG-203");
  assert.equal(blocked.blocked, true);
  assert.equal(blocked.view, "blocked");
  assert.equal(blocked.wait?.kind, "blocker");
  assert.equal(blocked.wait?.source, "blocker_evidence");
  assert.ok(blocked.blockers.some((e) => e.source === "queue-dependency:FG-9" && e.blocking));
  // AC6: it moved to the derived Blocked view WITHOUT losing rank or membership,
  // so clearing the blocker returns it to exactly its position.
  assert.equal(blocked.rank, 3);
  assert.equal(blocked.queued, true);

  // The proof that neither is stored: the ticket row has no such column to store
  // it in. A second mutable status vocabulary beside the lifecycle one is the
  // non-goal both FG-609 and FG-610 spent their slices not introducing.
  const columns = new Set(
    (new Database(join(tmpHome, "forge.db"), { readonly: true }).prepare(`PRAGMA table_info(tickets)`).all() as Array<{
      name: string;
    }>).map((c) => c.name),
  );
  assert.equal(columns.has("in_progress"), false);
  assert.equal(columns.has("blocked"), false);
  assert.equal(columns.has("queue_status"), false);
});

test("FG-591 AC10/AC14: a compatibility wait renders Queued WITH ITS EXPLANATION, and never Blocked", async () => {
  const b = await board();
  const waiting = row(b, "FG-201");

  assert.equal(waiting.view, "queued", "a scheduling wait is not a blocker and must not leave the Queued column");
  assert.equal(waiting.blocked, false);
  assert.equal(waiting.wait?.kind, "scheduling");
  assert.equal(waiting.wait?.reason, "waiting for FG-204 to finish");
  assert.equal(waiting.wait?.source, "dispatcher_evaluation");
  assert.ok(b.views.queued?.includes("FG-201"));
  assert.equal(b.views.blocked?.includes("FG-201"), false);

  // AC14: bypassing it did not reorder it — its durable rank is what the operator
  // set, and the dispatcher never touches the operator's queue.
  assert.equal(waiting.rank, 1);

  // The distinction is visible on the panel too, and reads as a self-clearing
  // scheduling state rather than "there is nothing to do".
  assert.equal(b.dispatcher.state, "incompatible_only");
  assert.match(b.dispatcher.stateDetail, /temporarily incompatible/);
});

test("FG-591 D4: a dequeued-but-still-executing item is its own first-class state, not a gap", async () => {
  const b = await board();
  const orphan = row(b, "FG-204");

  assert.equal(orphan.queued, false, "the operator dequeued it");
  assert.equal(orphan.view, "executing_not_queued");
  assert.deepEqual(b.views.executing_not_queued, ["FG-204"]);
  // The dequeue did NOT release the live claim — releasing one while a container
  // still runs is how a second dispatcher starts the same ticket.
  assert.equal(orphan.reservation?.owner, "dispatcher-a");
  assert.equal(orphan.reservation?.launchId, "launch-fg591-204");
  assert.equal(orphan.executionState, "launching");
  // LAUNCHING, not running: the reservation stamped a launch and no task has
  // spawned yet. Rendered as a container that is starting rather than as nothing.
  assert.equal(orphan.inProgress, false);
});

test("FG-591 AC9: a HOST-scoped capacity refusal names the OTHER project holding the slot", async () => {
  const b = await board();

  assert.equal(b.capacity.scope, "host");
  assert.equal(b.capacity.limit, 2);
  assert.equal(b.capacity.queueOwnedActive, 2);
  assert.equal(b.capacity.otherProjectHolders, 1);
  const other = b.capacity.holders.find((h) => !h.thisProject);
  assert.ok(other, "a host-scope holder from another project must be named, or the board cannot explain its own refusal");
  assert.equal(other.projectKey, PK_B);
  assert.equal(other.ticketId, "FG-777");
  assert.equal(other.projectLabel, "Fg591-other", "the holder is named in the operator's own vocabulary, not just by key");

  // The recorded refusal keeps the holder list AS IT WAS when the ceiling refused.
  const refusal = b.capacity.lastRefusal;
  assert.ok(refusal);
  assert.ok(refusal.holders.some((h) => h.projectKey === PK_B && h.ticketId === "FG-777" && !h.thisProject));

  // THE STATED CAPACITY POLICY, on the payload rather than in a doc alone: the
  // ceiling counts queue-owned claims, and other Forge work is reported beside it.
  assert.match(b.capacity.notCounted.policy, /QUEUE-OWNED/);
  assert.match(b.capacity.notCounted.policy, /never counted|rather than subtracted/);
  assert.equal(typeof b.capacity.notCounted.activeTasks, "number");
});

test("FG-591: the dispatcher panel answers 'why did nothing start' from the durable record", async () => {
  const b = await board();
  const panel = b.dispatcher as unknown as {
    armed: boolean;
    configured: boolean;
    maxActiveRuns: number;
    capacityScope: string;
    lease: { owner: string; generation: number; host: string | null; pid: number | null } | null;
    leaseLive: boolean;
    leaseExpired: boolean;
    msSinceHeartbeatMs: number | null;
    lastEvaluation: { reason: string; wakeKind: string | null; scannedCount: number | null } | null;
    nextWatchdogAtMs: number | null;
    pendingWakes: number;
    controlSurface: string;
    updatedBy: string | null;
  };
  assert.equal(panel.armed, true);
  assert.equal(panel.configured, true);
  assert.equal(panel.updatedBy, "operator@test", "arming records WHO, and the board shows it");
  assert.equal(panel.maxActiveRuns, 2);
  assert.equal(panel.capacityScope, "host");
  assert.equal(panel.lease?.owner, "dispatcher-a");
  assert.equal(panel.lease?.pid, 4242);
  assert.equal(panel.leaseLive, true);
  assert.equal(panel.leaseExpired, false);
  assert.ok((panel.msSinceHeartbeatMs ?? -1) >= 0);
  assert.equal(panel.lastEvaluation?.reason, "incompatible_only");
  assert.equal(panel.lastEvaluation?.wakeKind, "run_terminal");
  assert.equal(panel.lastEvaluation?.scannedCount, 2);
  assert.equal(panel.nextWatchdogAtMs, 1_780_000_000_000);
  // The explicitly recorded wake, PLUS one per ticket the fixture's own rank/enqueue
  // verbs moved: AC15's queue-change signal commits with the change (src/store/queue.ts),
  // so a fixture that builds a queue leaves the wakes that queue building produces.
  const wakeKeys = listWakes(PK_A).filter((w) => w.state === "pending").map((w) => w.wakeKey).sort();
  assert.deepEqual(wakeKeys, [
    "FG-201",
    "ticket:FG-201",
    "ticket:FG-202",
    "ticket:FG-203",
    "ticket:FG-204",
    "ticket:FG-205",
    "ticket:FG-206",
  ]);
  assert.equal(panel.pendingWakes, wakeKeys.length);
  // D2: arming and the ceiling stay CLI-only. The payload says so, so the board
  // renders an affordance instead of a disabled button.
  assert.equal(panel.controlSurface, "cli-only");
});

test("FG-591: an unresolvable or markdown-mode project is refused BY NAME, never rendered as an empty queue", async () => {
  const none = await board("?projectDir=/definitely/not/a/registered/checkout");
  assert.equal(none.projectKey, null);
  assert.equal(none.queueAvailable, false);
  assert.match(String((none as unknown as { unavailableReason: string }).unavailableReason), /never been imported/);
  assert.deepEqual(none.rows, []);
  // The host-wide facts are still answerable without a project.
  assert.equal(none.dispatcher.armed, true);
});

test("FG-591 BD-7: the board's own reads spawn NOTHING, make no outbound request, and write nothing", async () => {
  writeFileSync(CALL_LOG, "");
  outbound.length = 0;
  const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM queue_events`).get() as { n: number }).n;

  // Polled the way the client polls it, so a per-request lazy probe cannot hide
  // behind a first-call cache.
  for (let i = 0; i < 3; i++) await board();

  // The ONLY binary this route may reach is the shared project registry's bounded
  // `git` evidence read — the same one /api/backlog performs, cached for 30s.
  // Anything else is this route shelling out, which it must never do.
  const notGit = observedCalls().filter((c) => !c.startsWith("shim:git "));
  assert.deepEqual(notGit, [], `the queue route spawned a process of its own: ${notGit.join(", ")}`);
  for (const call of observedCalls()) {
    assert.match(
      call,
      /^shim:git -C \S+ (symbolic-ref|rev-parse|remote|config|for-each-ref)/,
      `an unexpected git invocation reached the serving path: ${call}`,
    );
  }
  assert.deepEqual(outbound, [], `the queue route made an outbound request: ${outbound.join(", ")}`);

  // A READ SURFACE WRITES NOTHING — not a queue event, not a claim, not an
  // evaluation. The handle is opened read-only, so a write would throw; this
  // catches the subtler failure of a read path that "helpfully" records something.
  const after = (getDb().prepare(`SELECT COUNT(*) AS n FROM queue_events`).get() as { n: number }).n;
  assert.equal(after, before, "a read surface appended queue history");
  assert.equal(
    (getDb().prepare(`SELECT COUNT(*) AS n FROM dispatcher_evaluations`).get() as { n: number }).n,
    2,
    "a read surface recorded an evaluation",
  );

  // NEGATIVE CONTROL — without it, "zero calls" is unfalsifiable: the shim channel
  // must be able to SEE a real subprocess.
  writeFileSync(CALL_LOG, "");
  execFileSync("docker", ["inspect", "fg591-control"], { stdio: "ignore" });
  assert.ok(observedCalls().some((c) => c.startsWith("shim:docker inspect")), "the PATH-shim channel is live");
});

test("FG-591: a DEAD dispatcher reads as dead — never as 'nothing to do'", async () => {
  // Runs last: it expires the lease in place. An expired lease means nobody is
  // looking at this queue at all, and the last evaluation — however reasonable it
  // reads — describes a pass that happened before the owner stopped. A board that
  // reported the old evaluation here would hide a dead controller behind a
  // plausible answer, which is the operator blindness this ticket exists to close.
  writeTransaction(() => {
    getDb()
      .prepare(`UPDATE dispatcher_leases SET lease_expires_at_ms = 1, heartbeat_at_ms = 1 WHERE project_key = ?`)
      .run(PK_A);
  });
  const b = await board();
  assert.equal(b.dispatcher.state, "stale_dispatcher");
  assert.notEqual(b.dispatcher.state, "no_eligible_work");
  assert.match(b.dispatcher.stateDetail, /dispatcher-a/);
  assert.equal((b.dispatcher as unknown as { leaseExpired: boolean }).leaseExpired, true);
  // And the work itself is untouched: a stale lease reports a recovery need, it
  // does not retire a claim or a running container.
  assert.equal(row(b, "FG-202").inProgress, true);
  assert.equal(row(b, "FG-204").reservation?.launchId, "launch-fg591-204");
});
