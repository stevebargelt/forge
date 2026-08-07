// FG-591 (step 7 / D4): the claim EXECUTION lifecycle, against a real in-memory
// SQLite DB running the REAL store code.
//
// THE BAR THIS FILE HOLDS ITSELF TO, following fg610-queue-claims.test.ts and
// fg591-compatibility.test.ts:
//
//  * The "no planning verb releases a live claim" invariant is proven THREE ways —
//    over the module SOURCE (every releaseClaim call site is inside the one release
//    helper), over the module's EXPORT surface (no dequeue/unrank/defer verb exists
//    here at all), and BEHAVIOURALLY (a real dequeue, a real unrank and a real defer
//    against a real live claim, with the claim's launch and run identity intact
//    afterwards). A source-only proof would pass on a module that never releases
//    anything; a behavioural-only proof would pass on one that releases from a path
//    the fixture happens not to walk.
//
//  * The cancel ORDER is proven from inside the cancel seam itself: the seam records
//    whether the reservation was still LIVE at the instant the work was stopped. A
//    test that only checked the end state would be satisfied by the reversed order,
//    which is the duplicate-execution defect.
//
//  * Adoption is proven by a launcher seam that FAILS the test if it is called. "It
//    adopted" and "it also started a second container" are otherwise indistinguishable
//    from the claim row alone.
//
// STATED LIMIT: like every DB test in this repo this runs ONE process against ONE
// handle, so SQLite's BEGIN IMMEDIATE locking is inert here. The fencing CAS
// predicates are not — they are ordinary SQL and are what these tests exercise.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "../store/publications.js";
import { upsertTicket, type TicketRow } from "../store/tickets.js";
import { dequeueTicket, enqueueTicket, rankTicket, unrankTicket } from "../store/queue.js";
import {
  claimNextEligible,
  getClaim,
  liveClaims,
  recordClaimLaunch,
  MIN_LEASE_TTL_MS,
  TAKEOVER_OUTCOME,
  type ClaimNextResult,
  type QueueClaim,
} from "../store/queue-claims.js";
import { setDispatcherPolicy, getDispatcherPolicy } from "../store/dispatcher-policy.js";
import { evaluationsFor, latestEvaluation } from "../store/dispatcher-evidence.js";
import { getLaunchObservation, recordLaunchObservation, updateLaunchObservationStatus } from "../store/launch-observations.js";
import type { LaunchMeta } from "../v2/launch.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";
import {
  RELEASE_OUTCOMES,
  buildDispatchArgv,
  cancelClaimedTicket,
  claimDueForHeartbeat,
  discoverRunForClaim,
  heartbeatOwnedClaims,
  isReleaseOutcome,
  launchClaimedTicket,
  observeClaimExecution,
  reconcileClaimExecution,
  resolveDispatchTarget,
  supersedeUnlaunchedClaim,
  type ExecutionSeams,
} from "./dispatch-execution.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let CHECKOUT: string;

const PK = "pk-dispatch-exec";
const NOW = "2026-08-06T00:00:00Z";
/** One TTL for BOTH the claims the fixtures grant and the policy the dispatcher
 *  heartbeats with, so "due for a heartbeat" and "the lease lapsed" stay independent
 *  facts a test can move one at a time. Comfortably above the derived floor. */
const TTL = 60_000;
const HEARTBEAT_MS = 5_000;
const OWNER = "dispatcher@pk-dispatch-exec@instance-A";
const FORGE_BIN = ["/usr/bin/node", "/opt/forge/dist/cli/index.js"];

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
  CHECKOUT = mkdtempSync(join(tmpdir(), "fg591-checkout-"));
  registerDbProject(PK);
  setDispatcherPolicy({ leaseTtlMs: TTL, heartbeatMs: HEARTBEAT_MS, updatedBy: "fixture" });
  assert.ok(TTL >= MIN_LEASE_TTL_MS, "the fixture TTL must clear the derived floor");
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(CHECKOUT, { recursive: true, force: true });
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
    importedFrom: CHECKOUT,
    ...over,
  };
}

function seedQueued(ids: string[]): void {
  writeTransaction(() => {
    for (const id of ids) upsertTicket(ticket(id));
  });
  for (const id of ids) {
    rankTicket(PK, id);
    const res = enqueueTicket(PK, id);
    assert.equal(res.ok, true, `${id} must enqueue for the fixture to mean anything`);
  }
}

function claimNext(over: Partial<Parameters<typeof claimNextEligible>[0]> = {}): ClaimNextResult {
  return claimNextEligible({
    projectKey: PK,
    owner: OWNER,
    capacity: 10,
    capacityScope: "host",
    leaseTtlMs: TTL,
    ...over,
  });
}

function grant(ticketId: string, over: Partial<Parameters<typeof claimNextEligible>[0]> = {}): QueueClaim {
  const out = claimNext(over);
  assert.equal(out.reason, "granted", `the fixture needs a grant, got ${out.reason}`);
  assert.equal(out.claimed?.ticketId, ticketId, "the fixture claimed a different ticket than expected");
  return out.claimed as QueueClaim;
}

function fakeMeta(id: string, over: { cwd?: string; startedAt?: string; command?: string[] } = {}): LaunchMeta {
  return {
    id,
    command: over.command ?? ["env", "forge", "new"],
    tmuxSession: `forge-${id}`,
    launcherPid: process.pid,
    ownerPid: null,
    startedAt: over.startedAt ?? "2026-08-06T00:00:00.000Z",
    logPath: `/tmp/${id}/out.log`,
    cwd: over.cwd ?? CHECKOUT,
  };
}

/** A recording launcher seam. Writes a REAL launch observation through the store's
 *  own writer, so run discovery and orphan discovery read production rows. */
function recordingSeams(
  over: {
    onStartLaunch?: (argv: string[]) => void;
    throwOnLaunch?: string;
    /** Return THIS id instead of the pre-stamped one — the misbehaving-launcher case. */
    launchId?: string;
    observe?: boolean;
  } = {},
): ExecutionSeams & {
  launches: { argv: string[]; cwd: string; name: string; id: string }[];
  removed: string[];
  stampedWhenObserved: (string | null)[];
} {
  const launches: { argv: string[]; cwd: string; name: string; id: string }[] = [];
  const removed: string[] = [];
  const stampedWhenObserved: (string | null)[] = [];
  return {
    launches,
    removed,
    stampedWhenObserved,
    startLaunch: (argv, opts) => {
      over.onStartLaunch?.(argv);
      if (over.throwOnLaunch) throw new Error(over.throwOnLaunch);
      launches.push({ argv, cwd: opts.cwd, name: opts.name, id: opts.id });
      return fakeMeta(over.launchId ?? opts.id, { cwd: opts.cwd, command: argv });
    },
    recordLaunchStart: (meta, association) => {
      // Prove the ORDER: by the time the observation is written, the durable claim
      // stamp must already carry this launch id.
      const claim = liveClaims(PK).find((c) => c.ticketId === association.ticketId);
      stampedWhenObserved.push(claim?.launchId ?? null);
      if (over.observe === false) return false;
      recordLaunchObservation({
        launchId: meta.id,
        name: meta.id,
        command: meta.command,
        cwd: meta.cwd,
        projectDir: meta.cwd,
        association: { ticketId: association.ticketId },
        startedAt: meta.startedAt,
        observedAt: meta.startedAt,
        status: { state: "running" },
      });
      return true;
    },
    removeLaunch: (id) => {
      removed.push(id);
    },
    promoteLaunchObservations: () => 0,
    cancelWork: () => {
      throw new Error("cancelWork must not be reached by this fixture");
    },
  };
}

function seedRun(
  runId: string,
  over: { status?: string; projectDir?: string | null; ticketId?: string; createdAt?: string } = {},
): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, metadata, project_dir)
     VALUES (?, 'feature', ?, ?, ?, ?, ?)`,
  ).run(
    runId,
    `title ${runId}`,
    over.status ?? "active",
    over.createdAt ?? "2026-08-06T00:00:01.000Z",
    JSON.stringify(over.ticketId ? { ticketId: over.ticketId } : {}),
    over.projectDir === undefined ? CHECKOUT : over.projectDir,
  );
}

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const MODULE_SOURCE = readFileSync(join(MODULE_DIR, "dispatch-execution.ts"), "utf8");

// ─── the release vocabulary ──────────────────────────────────────────────────

describe("FG-591 step 7: the release vocabulary this ticket owns", () => {
  test("is a CLOSED exported set, pinned member by member", () => {
    assert.deepEqual(
      [...RELEASE_OUTCOMES],
      ["completed", "failed", "cancelled", "launch_failed", "superseded"],
      "the release vocabulary is FG-591's contract with every downstream surface; changing it is a deliberate act",
    );
    for (const outcome of RELEASE_OUTCOMES) assert.equal(isReleaseOutcome(outcome), true);
  });

  test("does not absorb FG-610's TAKEOVER_OUTCOME, and rejects work-status words", () => {
    assert.equal(
      isReleaseOutcome(TAKEOVER_OUTCOME),
      false,
      "the takeover outcome is the PRIMITIVE's, stamped by a takeover on the predecessor — beside this set, never inside it",
    );
    for (const notAnOutcome of ["done", "blocked", "in_progress", "complete", "abandoned", ""]) {
      assert.equal(isReleaseOutcome(notAnOutcome), false, `'${notAnOutcome}' describes WORK, not a reservation`);
    }
  });

  test("every outcome literal the module can write is a member of the set", () => {
    // The source is the audit: a new release site with a fresh string would be caught
    // here rather than discovered on a board months later.
    const literals = [...MODULE_SOURCE.matchAll(/releaseReservation\([^,]+,\s*"([a-z_]+)"\)/g)].map((m) => m[1] as string);
    assert.ok(literals.length >= 3, `expected several release sites, found ${literals.length}`);
    for (const literal of literals) {
      assert.equal(isReleaseOutcome(literal), true, `release site writes '${literal}', which is outside the closed set`);
    }
  });
});

// ─── the planning verbs never reach releaseClaim ─────────────────────────────

describe("FG-591 step 7 (D4): no dequeue, unrank or defer path reaches releaseClaim", () => {
  test("the module's whole export surface carries no planning verb", () => {
    const exported = [...MODULE_SOURCE.matchAll(/^export (?:function|const|type) (\w+)/gm)].map((m) => m[1] as string);
    assert.ok(exported.length > 0, "the surface scan must actually find exports");
    for (const name of exported) {
      assert.ok(
        !/dequeue|unrank|defer/i.test(name),
        `'${name}' is a planning verb living in the EXECUTION module — planning must never be able to retire a reservation`,
      );
    }
  });

  test("releaseClaim is called from exactly ONE place in this module", () => {
    const callSites = [...MODULE_SOURCE.matchAll(/\breleaseClaim\(/g)].length;
    assert.equal(
      callSites,
      1,
      "every release goes through releaseReservation, which reads owner+generation off the claim row itself — " +
        "a second call site could express an unfenced release",
    );
    const helper = MODULE_SOURCE.slice(
      MODULE_SOURCE.indexOf("function releaseReservation"),
      MODULE_SOURCE.indexOf("// ─── the seams"),
    );
    assert.ok(helper.includes("releaseClaim({"), "the one call site is inside releaseReservation");
  });

  test("the module that OWNS dequeue/unrank/defer cannot release a claim at all", () => {
    const queueSource = readFileSync(join(MODULE_DIR, "../store/queue.ts"), "utf8");
    assert.ok(queueSource.includes("export function dequeueTicket"), "precondition: queue.ts owns the planning verbs");
    assert.equal(
      queueSource.includes("releaseClaim"),
      false,
      "queue.ts must not name releaseClaim: a planning mutation that retired a reservation would re-admit a running ticket",
    );
    assert.equal(
      /from "\.\/queue-claims\.js"/.test(queueSource),
      false,
      "queue.ts must not import the claim primitive at all — the dependency runs the other way",
    );
  });

  test("a real dequeue, unrank and defer leave a live claim and its launch identity untouched", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const stamped = recordClaimLaunch({
      projectKey: PK,
      claimId: claim.id,
      owner: claim.owner,
      generation: claim.generation,
      launchId: "launch-planning",
      runId: "run-planning",
    });
    assert.notEqual(stamped, null);

    dequeueTicket(PK, "FG-1");
    unrankTicket(PK, "FG-1");
    writeTransaction(() => upsertTicket(ticket("FG-1", { status: "deferred" })));

    const after = getClaim(PK, claim.id);
    assert.equal(after?.state, "live", "the reservation survives every planning mutation");
    assert.equal(after?.outcome, null);
    assert.equal(after?.launchId, "launch-planning", "the pointer to a container that may still be running is untouched");
    assert.equal(after?.runId, "run-planning");
    assert.equal(liveClaims(PK).length, 1, "the capacity slot is still held — the container did not stop");
  });
});

// ─── the launch target ───────────────────────────────────────────────────────

describe("FG-591 step 7: resolving the launch target", () => {
  test("resolves the observed checkout and the policy workflow", () => {
    seedQueued(["FG-1"]);
    const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
    assert.equal(res.ok, true);
    if (!res.ok) return;
    assert.equal(res.target.projectDir, CHECKOUT);
    assert.equal(res.target.workflow, "feature", "the campaign planner's precedent is the default");
    assert.equal(res.target.title, "title FG-1");
  });

  test("a policy workflow override wins, host-wide", () => {
    seedQueued(["FG-1"]);
    setDispatcherPolicy({ defaultWorkflow: "bugfix", updatedBy: "steve" });
    const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
    assert.equal(res.ok && res.target.workflow, "bugfix");
  });

  test("two observed checkouts REFUSE by name rather than picking one", () => {
    const other = mkdtempSync(join(tmpdir(), "fg591-other-"));
    try {
      writeTransaction(() => {
        upsertTicket(ticket("FG-1"));
        upsertTicket(ticket("FG-2", { importedFrom: other }));
      });
      const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
      assert.equal(res.ok, false);
      if (res.ok) return;
      assert.equal(res.refusal.kind, "ambiguous_checkout");
      assert.match(res.refusal.message, /linked-worktree/);
      assert.match(res.refusal.message, new RegExp(other.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("an explicit checkout wins over an ambiguous store", () => {
    const other = mkdtempSync(join(tmpdir(), "fg591-other-"));
    try {
      writeTransaction(() => {
        upsertTicket(ticket("FG-1"));
        upsertTicket(ticket("FG-2", { importedFrom: other }));
      });
      const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1", projectDir: CHECKOUT });
      assert.equal(res.ok && res.target.projectDir, CHECKOUT);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("a checkout that no longer exists refuses HERE, not inside the pane", () => {
    const gone = mkdtempSync(join(tmpdir(), "fg591-gone-"));
    rmSync(gone, { recursive: true, force: true });
    writeTransaction(() => upsertTicket(ticket("FG-1", { importedFrom: gone })));
    const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.refusal.kind, "missing_checkout");
  });

  test("no observed checkout at all refuses by name", () => {
    writeTransaction(() => upsertTicket(ticket("FG-1", { importedFrom: null })));
    const res = resolveDispatchTarget({ projectKey: PK, ticketId: "FG-1" });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.refusal.kind, "no_checkout");
  });
});

// ─── the launch itself ───────────────────────────────────────────────────────

describe("FG-591 step 7: launching a claimed ticket", () => {
  test("the argv is the ORDINARY single-ticket run path, with no campaign verb in it", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams();
    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launched");
    if (res.kind !== "launched") return;

    const argv = res.argv;
    assert.equal(seams.launches.length, 1, "exactly one container");
    assert.deepEqual(seams.launches[0]?.argv, argv);
    assert.equal(seams.launches[0]?.cwd, CHECKOUT, "the run is launched IN the project checkout");

    const verbIndex = argv.indexOf("new");
    assert.ok(verbIndex > 0, "the verb is `new`");
    assert.equal(argv[verbIndex + 1], "feature");
    assert.equal(argv[verbIndex + 2], "title FG-1");
    assert.equal(argv[argv.indexOf("--ticket") + 1], "FG-1");
    assert.equal(argv[argv.indexOf("--project") + 1], CHECKOUT);
    for (const forbidden of ["campaign", "drive-item", "plan", "invoke"]) {
      assert.equal(argv.includes(forbidden), false, `'${forbidden}' must never appear — a claim launches an ordinary run`);
    }
    assert.equal(argv[0], "env", "FORGE_HOME/FORGE_DB_PATH are pinned so the child shares this store");
    assert.ok(argv.some((a) => a.startsWith("FORGE_DB_PATH=")));
    assert.deepEqual(buildDispatchArgv(FORGE_BIN, { projectKey: PK, ticketId: "FG-1", title: "title FG-1", workflow: "feature", projectDir: CHECKOUT }), argv);
  });

  test("the durable stamp lands BEFORE the physical launch, and before the observation", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const stampedWhenLaunched: (string | null)[] = [];
    const seams = recordingSeams({
      onStartLaunch: () => stampedWhenLaunched.push(liveClaims(PK).find((c) => c.ticketId === "FG-1")?.launchId ?? null),
    });
    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launched");
    if (res.kind !== "launched") return;

    assert.deepEqual(
      stampedWhenLaunched,
      [res.launchId],
      "the launcher is called with an identity the claim ALREADY carries — a crash here leaves a stamp to adopt",
    );
    assert.equal(seams.launches[0]?.id, res.launchId, "the container is started UNDER the stamped identity");
    assert.deepEqual(seams.stampedWhenObserved, [res.launchId]);
    assert.equal(getClaim(PK, claim.id)?.launchId, res.launchId);
  });

  test("a stamp the fence refuses starts NOTHING — there is no container to orphan", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    // The successor's takeover bumped our generation: our stamp can no longer land.
    const superseded = { ...claim, generation: claim.generation + 7 } as QueueClaim;
    const seams = recordingSeams({ onStartLaunch: () => assert.fail("an unstampable claim must never start a container") });

    const res = launchClaimedTicket({ claim: superseded, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launch_failed");
    assert.equal(seams.launches.length, 0);
    assert.equal(seams.removed.length, 0, "nothing was started, so nothing is killed");
    assert.equal(getClaim(PK, claim.id)?.launchId, null, "no identity was stamped under a superseded generation");
    assert.match(latestEvaluation(PK)?.detail ?? "", /NOTHING was started/);
  });

  test("a launcher that returns a DIFFERENT id records the ticket association BEFORE removing the stray", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams({ launchId: "launch-not-the-stamped-one" });

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launch_failed");
    assert.deepEqual(seams.removed, ["launch-not-the-stamped-one"], "the stray container is removed");
    // The observation is written FIRST, so a removal that had FAILED would still have
    // left a container a successor can discover through its declared ticket.
    assert.equal(
      getLaunchObservation("launch-not-the-stamped-one")?.ticketId,
      "FG-1",
      "an unstampable container is made discoverable before any attempt to kill it",
    );
    assert.equal(liveClaims(PK).length, 0, "the stray is provably gone, so the slot is returned");
  });

  test("a stray container that could NOT be killed holds the reservation rather than re-admitting the ticket", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams({ launchId: "launch-unkillable" });
    seams.removeLaunch = () => {
      throw new Error("tmux: no server running");
    };

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launch_failed");
    if (res.kind !== "launch_failed") return;
    assert.equal(res.released, null, "nothing may be released over a container that may still be running");
    assert.equal(liveClaims(PK).length, 1, "the ticket is NOT re-claimable while an unkilled container may hold it");
    assert.equal(
      getLaunchObservation("launch-unkillable")?.ticketId,
      "FG-1",
      "and the container it could not kill is discoverable, never untracked",
    );
  });

  test("a launch that THROWS releases the claim 'launch_failed' and the ticket is immediately re-claimable", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams({ throwOnLaunch: "tmux failed to start the session" });
    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });

    assert.equal(res.kind, "launch_failed");
    if (res.kind !== "launch_failed") return;
    assert.match(res.error, /tmux failed/);
    assert.equal(res.released?.state, "released");
    assert.equal(res.released?.outcome, "launch_failed", "no container was ever started — that is not the same fact as 'failed'");
    assert.equal(liveClaims(PK).length, 0, "the capacity slot is returned");

    const again = claimNext();
    assert.equal(again.reason, "granted", "the ticket is re-claimable at once — nothing is stranded");
    assert.equal(again.claimed?.ticketId, "FG-1");
  });

  test("an unresolvable checkout releases 'launch_failed' and RECORDS the named reason, never a silent no-op", () => {
    writeTransaction(() => upsertTicket(ticket("FG-1", { importedFrom: null })));
    rankTicket(PK, "FG-1");
    assert.equal(enqueueTicket(PK, "FG-1").ok, true);
    const claim = grant("FG-1");
    const seams = recordingSeams();

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams, dispatcherOwner: OWNER, dispatcherGeneration: 3 });
    assert.equal(res.kind, "refused");
    if (res.kind !== "refused") return;
    assert.equal(res.refusal.kind, "no_checkout");
    assert.equal(res.released?.outcome, "launch_failed");
    assert.equal(seams.launches.length, 0, "nothing was started");

    const evaluation = latestEvaluation(PK);
    assert.ok(evaluation, "an unresolvable launch target leaves the operator a durable answer");
    assert.equal(evaluation?.dispatcherOwner, OWNER);
    assert.equal(evaluation?.dispatcherGeneration, 3);
    assert.match(evaluation?.detail ?? "", /no checkout directory has ever been observed/);
    assert.equal(evaluation?.claimId, null, "a refusal row carries no claim — the reservation was released before it was written");
    assert.equal(evaluationsFor(PK).length, 1);
  });
});

// ─── adoption ────────────────────────────────────────────────────────────────

describe("FG-591 step 7: a takeover ADOPTS the prior launch rather than starting a second container", () => {
  /** Grant, stamp, then age the store clock past the lease so the next claim is a
   *  takeover carrying the predecessor's identity. */
  function takeoverOf(over: { launchId?: string | null; runId?: string | null }): {
    claim: QueueClaim;
    predecessor: QueueClaim;
  } {
    seedQueued(["FG-1"]);
    const first = grant("FG-1");
    const stamp: { launchId?: string; runId?: string } = {};
    if (over.launchId) stamp.launchId = over.launchId;
    if (over.runId) stamp.runId = over.runId;
    if (Object.keys(stamp).length > 0) {
      const stamped = recordClaimLaunch({ projectKey: PK, claimId: first.id, owner: first.owner, generation: first.generation, ...stamp });
      assert.notEqual(stamped, null, "the predecessor's stamp must land for the fixture to mean anything");
    }
    setPublicationClockOffsetForTest(TTL + 5_000);
    const out = claimNext({ owner: "dispatcher@pk-dispatch-exec@instance-B" });
    assert.equal(out.reason, "granted");
    assert.equal(out.takenOverFrom?.outcome, TAKEOVER_OUTCOME, "this must be a real takeover");
    return { claim: out.claimed as QueueClaim, predecessor: out.takenOverFrom as QueueClaim };
  }

  test("a predecessor carrying a launchId is adopted — the launcher is never called", () => {
    recordLaunchObservation({
      launchId: "launch-prior",
      name: "launch-prior",
      command: ["env", "forge", "new"],
      cwd: CHECKOUT,
      projectDir: CHECKOUT,
      association: { ticketId: "FG-1" },
      startedAt: "2026-08-06T00:00:00.000Z",
      observedAt: "2026-08-06T00:00:00.000Z",
      status: { state: "running" },
    });
    const { claim, predecessor } = takeoverOf({ launchId: "launch-prior" });
    const seams = recordingSeams({
      onStartLaunch: () => assert.fail("a takeover must ADOPT the prior launch, never start a second container"),
    });

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, takenOverFrom: predecessor, seams });
    assert.equal(res.kind, "adopted");
    if (res.kind !== "adopted") return;
    assert.equal(res.launchId, "launch-prior");
    assert.equal(getClaim(PK, claim.id)?.launchId, "launch-prior", "the successor's own generation now points at the SAME container");
    assert.equal(seams.launches.length, 0);
  });

  test("a predecessor whose RUN is still active is adopted, launch id and all", () => {
    seedRun("run-prior", { status: "active", ticketId: "FG-1" });
    const { claim, predecessor } = takeoverOf({ launchId: "launch-prior", runId: "run-prior" });
    const seams = recordingSeams({ onStartLaunch: () => assert.fail("an active run must never be duplicated") });

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, takenOverFrom: predecessor, seams });
    assert.equal(res.kind, "adopted");
    if (res.kind !== "adopted") return;
    assert.equal(res.runId, "run-prior");
    const after = getClaim(PK, claim.id);
    assert.equal(after?.runId, "run-prior");
    assert.equal(after?.launchId, "launch-prior");
  });

  test("a predecessor whose run already reached terminal RETIRES the reservation instead of re-running it", () => {
    seedRun("run-prior", { status: "complete", ticketId: "FG-1" });
    const { claim, predecessor } = takeoverOf({ launchId: "launch-prior", runId: "run-prior" });
    const seams = recordingSeams({ onStartLaunch: () => assert.fail("finished work must not be re-run by a takeover") });

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, takenOverFrom: predecessor, seams });
    assert.equal(res.kind, "already_terminal");
    if (res.kind !== "already_terminal") return;
    assert.equal(res.outcome, "completed");
    assert.equal(res.released?.state, "released");
    assert.equal(liveClaims(PK).length, 0);
  });

  test("a claim already carrying its OWN stamp is never relaunched (a retry after a crashed ack)", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const stamped = recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: claim.owner, generation: claim.generation, launchId: "launch-mine" });
    const seams = recordingSeams({ onStartLaunch: () => assert.fail("an already-stamped claim must not launch twice") });

    const res = launchClaimedTicket({ claim: stamped as QueueClaim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "adopted");
    if (res.kind === "adopted") assert.equal(res.launchId, "launch-mine");
  });

  test("an ORPHANED container from the stamp window is adopted through its declared ticket association", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    // The crash shape: startLaunch returned, the observation was written with the
    // submitter's declared ticket, and the claim stamp never committed.
    recordLaunchObservation({
      launchId: "launch-orphan",
      name: "launch-orphan",
      command: ["env", "forge", "new"],
      cwd: CHECKOUT,
      projectDir: CHECKOUT,
      association: { ticketId: "FG-1" },
      startedAt: new Date(storeNowMs() + 1).toISOString(),
      observedAt: new Date(storeNowMs() + 1).toISOString(),
      status: { state: "running" },
    });
    const seams = recordingSeams({ onStartLaunch: () => assert.fail("an orphaned live container must be adopted, not duplicated") });

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "adopted");
    if (res.kind === "adopted") assert.equal(res.launchId, "launch-orphan");
  });

  test("a launch that PREDATES the reservation is not adopted — it is somebody else's", () => {
    recordLaunchObservation({
      launchId: "launch-older",
      name: "launch-older",
      command: ["env", "forge", "new"],
      cwd: CHECKOUT,
      projectDir: CHECKOUT,
      association: { ticketId: "FG-1" },
      startedAt: "2020-01-01T00:00:00.000Z",
      observedAt: "2020-01-01T00:00:00.000Z",
      status: { state: "running" },
    });
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams();

    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launched");
    if (res.kind === "launched") assert.notEqual(res.launchId, "launch-older", "a fresh container was started, not the old one adopted");
  });
});

// ─── heartbeat ───────────────────────────────────────────────────────────────

describe("FG-591 step 7: heartbeating live claims on the policy cadence", () => {
  test("renews only the claims that are DUE, and reports each result", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const policy = getDispatcherPolicy(PK);

    assert.equal(policy.heartbeatMs, HEARTBEAT_MS, "the fixture policy is what the dispatcher paces on");
    assert.equal(claimDueForHeartbeat(claim, policy, storeNowMs()), false, "a claim just granted is not yet due");
    assert.deepEqual(heartbeatOwnedClaims({ projectKey: PK, owner: OWNER }), [], "an undue claim writes nothing");

    setPublicationClockOffsetForTest(policy.heartbeatMs);
    const results = heartbeatOwnedClaims({ projectKey: PK, owner: OWNER });
    assert.deepEqual(results, [{ claimId: claim.id, ticketId: "FG-1", renewed: true }]);
    const after = getClaim(PK, claim.id) as QueueClaim;
    assert.ok(after.leaseExpiresAtMs > claim.leaseExpiresAtMs, "the lease moved forward");
  });

  test("another owner's claims are never touched, and a lapsed lease reports renewed=false", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    assert.deepEqual(heartbeatOwnedClaims({ projectKey: PK, owner: "someone-else", force: true }), [], "not ours, not renewed");

    setPublicationClockOffsetForTest(TTL + 5_000);
    const results = heartbeatOwnedClaims({ projectKey: PK, owner: OWNER, force: true });
    assert.deepEqual(results, [{ claimId: claim.id, ticketId: "FG-1", renewed: false }], "a STRICTLY expired lease is not renewable — the owner has lost it");
  });

  test("a DISARMED policy still renews the leases already held (D5)", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    setDispatcherPolicy({ armed: false, updatedBy: "steve" });
    setPublicationClockOffsetForTest(getDispatcherPolicy(PK).heartbeatMs);

    const results = heartbeatOwnedClaims({ projectKey: PK, owner: OWNER });
    assert.deepEqual(results, [{ claimId: claim.id, ticketId: "FG-1", renewed: true }], "disarm blocks NEW claims; a lapsed lease over a running container would invite a duplicate");
    assert.equal(getClaim(PK, claim.id)?.state, "live");
  });
});

// ─── observing execution and retiring the reservation ────────────────────────

describe("FG-591 step 7: the reservation and the execution are read separately", () => {
  function launched(ticketId = "FG-1"): { claim: QueueClaim; launchId: string } {
    seedQueued([ticketId]);
    const claim = grant(ticketId);
    const seams = recordingSeams();
    const res = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(res.kind, "launched");
    return { claim: getClaim(PK, claim.id) as QueueClaim, launchId: (res as { launchId: string }).launchId };
  }

  test("a live launch with no run yet is RUNNING — never a reason to release", () => {
    const { claim } = launched();
    const view = observeClaimExecution({ projectKey: PK, claimId: claim.id });
    assert.equal(view.verdict.kind, "running");
    assert.equal(view.reservation?.leaseLive, true);
    assert.equal(view.execution.runId, null);

    const res = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
    assert.equal(res.released, null);
    assert.equal(getClaim(PK, claim.id)?.state, "live");
  });

  test("reconcile BINDS the run our launch created, from the ticket stamped in run metadata", () => {
    const { claim } = launched();
    seedRun("run-bound", { ticketId: "FG-1", status: "active" });

    const discovery = discoverRunForClaim(claim);
    assert.deepEqual(discovery, { kind: "found", runId: "run-bound" });

    const res = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
    assert.equal(res.bound, "run-bound");
    assert.equal(res.released, null, "an active run is not a terminal reservation");
    assert.equal(getClaim(PK, claim.id)?.runId, "run-bound");
    assert.equal(res.view.verdict.kind, "running");
  });

  test("a run for the same ticket in ANOTHER checkout, or from before the launch, is not bound", () => {
    const { claim } = launched();
    seedRun("run-elsewhere", { ticketId: "FG-1", projectDir: "/some/other/repo" });
    seedRun("run-older", { ticketId: "FG-1", createdAt: "2020-01-01T00:00:00.000Z" });
    assert.equal(discoverRunForClaim(claim).kind, "none", "a bare 'some run mentions this ticket' match would bind work we never started");
  });

  test("TWO candidate runs refuse to bind and hold the reservation rather than guessing", () => {
    const { claim, launchId } = launched();
    seedRun("run-a", { ticketId: "FG-1" });
    seedRun("run-b", { ticketId: "FG-1", createdAt: "2026-08-06T00:00:02.000Z" });
    const discovery = discoverRunForClaim(claim);
    assert.equal(discovery.kind, "ambiguous");

    updateLaunchObservationStatus(launchId, { state: "exited_ok", code: 0 }, "2026-08-06T00:01:00.000Z");
    const res = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
    assert.equal(res.view.verdict.kind, "unresolved");
    assert.equal(res.released, null, "releasing here would re-admit a ticket whose container may still be working");
    assert.equal(getClaim(PK, claim.id)?.state, "live");
  });

  for (const [runStatus, outcome] of [
    ["complete", "completed"],
    ["failed", "failed"],
    ["abandoned", "cancelled"],
  ] as const) {
    test(`a run that reached '${runStatus}' retires the reservation as '${outcome}'`, () => {
      const { claim } = launched();
      seedRun("run-term", { ticketId: "FG-1", status: runStatus });
      const res = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
      assert.equal(res.bound, "run-term");
      assert.equal(res.released?.outcome, outcome);
      assert.equal(res.releaseRefused, null);
      assert.equal(liveClaims(PK).length, 0, "the capacity slot is returned when the EXECUTION ends, not before");
    });
  }

  test("a terminal launch that created NO run is 'launch_failed', not 'failed'", () => {
    const { claim, launchId } = launched();
    updateLaunchObservationStatus(launchId, { state: "exited_error", code: 1 }, "2026-08-06T00:01:00.000Z");
    const res = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
    assert.equal(res.released?.outcome, "launch_failed", "a never-launched ticket must not read on the board like a failed one");
    assert.match(res.view.verdict.kind === "terminal" ? res.view.verdict.detail : "", /without creating a run/);
  });

  test("an expired owner cannot retire its own claim, and the refusal is SURFACED", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: claim.owner, generation: claim.generation, runId: "run-term" });
    seedRun("run-term", { ticketId: "FG-1", status: "complete" });
    // The lease lapses before anyone observes the terminal.
    setPublicationClockOffsetForTest(TTL + 5_000);

    const res = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
    assert.equal(res.view.verdict.kind, "terminal");
    assert.equal(res.released, null);
    assert.match(res.releaseRefused ?? "", /expired owner cannot retire its own claim/);
    assert.equal(getClaim(PK, claim.id)?.state, "live", "the recovery record survives — a successor still finds the launch identity");
  });

  test("a run id stamped on the claim with no row in this store is UNRESOLVED, never terminal", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: claim.owner, generation: claim.generation, runId: "run-missing" });
    const view = observeClaimExecution({ projectKey: PK, claimId: claim.id });
    assert.equal(view.verdict.kind, "unresolved");
    assert.equal(view.execution.runStatus, null, "the EXECUTION half is read on its own and reports what it has");
    assert.equal(view.reservation?.runId, "run-missing", "the RESERVATION half is not derived from it");
  });
});

// ─── cancel ──────────────────────────────────────────────────────────────────

describe("FG-591 step 7 (D4): cancel stops the work FIRST, then the LEASE OWNER releases", () => {
  function launchedWithRun(): QueueClaim {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams();
    assert.equal(launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams }).kind, "launched");
    seedRun("run-cancel", { ticketId: "FG-1", status: "active" });
    const bound = reconcileClaimExecution({ projectKey: PK, claimId: claim.id, seams: recordingSeams() });
    assert.equal(bound.bound, "run-cancel");
    return getClaim(PK, claim.id) as QueueClaim;
  }

  test("the reservation is still LIVE at the instant the work is stopped, and released after", () => {
    const claim = launchedWithRun();
    const order: string[] = [];
    let liveWhenStopped: boolean | null = null;

    const res = cancelClaimedTicket({
      projectKey: PK,
      ticketId: "FG-1",
      seams: {
        promoteLaunchObservations: () => 0,
        removeLaunch: (id) => {
          order.push(`remove:${id}`);
        },
        cancelWork: (target) => {
          order.push(`cancel:${target.runId}`);
          liveWhenStopped = getClaim(PK, claim.id)?.state === "live";
          return { kind: "run-cancelled", runId: target.runId, tasksKilled: ["t1"], runAbandoned: target.abandonRun, runAbandonRefused: false };
        },
      },
    });

    assert.equal(
      liveWhenStopped,
      true,
      "the release must come AFTER the stop: releasing first re-admits the ticket while its container still runs",
    );
    assert.deepEqual(
      order,
      ["cancel:run-cancel", `remove:${claim.launchId}`],
      "the work is stopped, then its launch, then the reservation",
    );
    assert.equal(res.kind, "cancelled");
    if (res.kind !== "cancelled") return;
    assert.equal(res.released?.outcome, "cancelled");
    assert.equal(res.launchRemoved, claim.launchId);
    assert.equal(res.releaseRefused, null);
    assert.equal(liveClaims(PK).length, 0);
  });

  test("the release is issued by the owner+generation that HOLDS the lease", () => {
    const claim = launchedWithRun();
    const res = cancelClaimedTicket({
      projectKey: PK,
      ticketId: "FG-1",
      seams: {
        removeLaunch: () => undefined,
        promoteLaunchObservations: () => 0,
        cancelWork: (t) => ({ kind: "run-cancelled", runId: t.runId, tasksKilled: [], runAbandoned: true, runAbandonRefused: false }),
      },
    });
    assert.equal(res.kind, "cancelled");
    if (res.kind !== "cancelled") return;
    assert.equal(res.released?.owner, claim.owner);
    assert.equal(res.released?.generation, claim.generation);
    // The event trail names the same identity — the reservation's history, not the work's.
    const events = db
      .prepare(`SELECT payload FROM queue_events WHERE project_key = ? AND event_type = 'release' ORDER BY id DESC LIMIT 1`)
      .get(PK) as { payload: string } | undefined;
    const payload = JSON.parse(events?.payload ?? "{}") as { owner?: string; generation?: number; outcome?: string };
    assert.equal(payload.outcome, "cancelled");
    assert.equal(payload.owner, claim.owner);
    assert.equal(payload.generation, claim.generation);
  });

  test("the work is stopped even when the reservation can no longer be retired by this owner", () => {
    const claim = launchedWithRun();
    setPublicationClockOffsetForTest(TTL + 5_000);
    let stopped = false;
    const res = cancelClaimedTicket({
      projectKey: PK,
      ticketId: "FG-1",
      seams: {
        removeLaunch: () => undefined,
        promoteLaunchObservations: () => 0,
        cancelWork: (t) => {
          stopped = true;
          return { kind: "run-cancelled", runId: t.runId, tasksKilled: [], runAbandoned: true, runAbandonRefused: false };
        },
      },
    });
    assert.equal(stopped, true, "stopping the work never depends on the fence");
    assert.equal(res.kind, "cancelled");
    if (res.kind !== "cancelled") return;
    assert.equal(res.released, null);
    assert.match(res.releaseRefused ?? "", /could not be retired/);
    assert.equal(getClaim(PK, claim.id)?.state, "live", "the recovery record survives for the successor");
  });

  test("a ticket with no live claim releases NOTHING and says so", () => {
    seedQueued(["FG-1"]);
    const res = cancelClaimedTicket({
      projectKey: PK,
      ticketId: "FG-1",
      seams: { cancelWork: () => assert.fail("nothing to stop") },
    });
    assert.equal(res.kind, "no_live_claim");
    if (res.kind === "no_live_claim") assert.match(res.detail, /planning intent/);
  });

  test("a reservation with no run yet still stops its launch and retires cleanly", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const seams = recordingSeams();
    const launch = launchClaimedTicket({ claim, forgeBin: FORGE_BIN, seams });
    assert.equal(launch.kind, "launched");
    const removed: string[] = [];

    const res = cancelClaimedTicket({
      projectKey: PK,
      ticketId: "FG-1",
      seams: {
        promoteLaunchObservations: () => 0,
        removeLaunch: (id) => {
          removed.push(id);
        },
        cancelWork: () => assert.fail("there is no run to cancel in the pre-run window"),
      },
    });
    assert.equal(res.kind, "cancelled");
    if (res.kind !== "cancelled") return;
    assert.equal(res.cancelOutcome, null);
    assert.deepEqual(removed, [(launch as { launchId: string }).launchId]);
    assert.equal(res.released?.outcome, "cancelled");
  });

  test("a launch that CANNOT be removed holds the reservation rather than releasing over live work", () => {
    const claim = launchedWithRun();
    let stopped = false;

    const res = cancelClaimedTicket({
      projectKey: PK,
      ticketId: "FG-1",
      seams: {
        promoteLaunchObservations: () => 0,
        removeLaunch: () => {
          throw new Error("tmux: no server running on /tmp/tmux-501/default");
        },
        cancelWork: (t) => {
          stopped = true;
          return { kind: "run-cancelled", runId: t.runId, tasksKilled: [], runAbandoned: true, runAbandonRefused: false };
        },
      },
    });

    assert.equal(stopped, true, "the stop is still attempted first");
    assert.equal(res.kind, "stop_failed");
    if (res.kind !== "stop_failed") return;
    assert.equal(res.launchId, claim.launchId);
    assert.match(res.detail, /HELD rather than released/);
    assert.equal(
      getClaim(PK, claim.id)?.state,
      "live",
      "D4: a reservation released over a launch that is still running re-admits the ticket to a second dispatcher",
    );
    assert.equal(liveClaims(PK).length, 1, "the ticket is NOT re-claimable while its container may be alive");
  });
});

// ─── superseding a reservation that never became execution ───────────────────

describe("FG-591 step 7: superseding an unlaunched reservation is guarded hard", () => {
  test("refuses while the claim points at any execution", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    recordClaimLaunch({ projectKey: PK, claimId: claim.id, owner: claim.owner, generation: claim.generation, launchId: "launch-x" });
    const res = supersedeUnlaunchedClaim({ projectKey: PK, claimId: claim.id, minAgeMs: 0 });
    assert.equal(res.kind, "refused");
    if (res.kind === "refused") assert.equal(res.reason, "has_execution");
    assert.equal(getClaim(PK, claim.id)?.state, "live");
  });

  test("refuses while the claim is younger than the floor — its container may be starting right now", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    const res = supersedeUnlaunchedClaim({ projectKey: PK, claimId: claim.id, minAgeMs: 60_000 });
    assert.equal(res.kind, "refused");
    if (res.kind === "refused") assert.equal(res.reason, "too_young");
  });

  test("refuses when an orphaned container declaring this ticket is still live", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    recordLaunchObservation({
      launchId: "launch-orphan",
      name: "launch-orphan",
      command: ["env", "forge", "new"],
      cwd: CHECKOUT,
      projectDir: CHECKOUT,
      association: { ticketId: "FG-1" },
      startedAt: new Date(storeNowMs() + 1).toISOString(),
      observedAt: new Date(storeNowMs() + 1).toISOString(),
      status: { state: "running" },
    });
    const res = supersedeUnlaunchedClaim({ projectKey: PK, claimId: claim.id, minAgeMs: 0 });
    assert.equal(res.kind, "refused");
    if (res.kind === "refused") assert.equal(res.reason, "has_execution");
  });

  test("retires an old, unlaunched, unobserved reservation as 'superseded'", () => {
    seedQueued(["FG-1"]);
    const claim = grant("FG-1");
    // Old enough to retire, and still inside its lease — an expired owner could not
    // release at all, which is a DIFFERENT refusal and not what this test is about.
    setPublicationClockOffsetForTest(30_000);
    const res = supersedeUnlaunchedClaim({ projectKey: PK, claimId: claim.id, minAgeMs: 10_000 });
    assert.equal(res.kind, "superseded");
    if (res.kind === "superseded") assert.equal(res.released?.outcome, "superseded");
    assert.equal(liveClaims(PK).length, 0);
  });
});
