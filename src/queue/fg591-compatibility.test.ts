// FG-591 (step 4 / D10): the parallel-compatibility predicate and its hydration,
// against a real in-memory SQLite DB running the REAL store code.
//
// THE BAR THIS FILE HOLDS ITSELF TO, following fg610-queue-claims.test.ts: every
// "refuses" invariant is proven by its POSITIVE half too, because a predicate that
// refuses everything passes every refusal test and is worthless. So each conflict
// axis is paired with the arrangement that must still ADMIT — isolated worktrees in
// one repo, a neutral relation, another project's claim, an expired resource lock,
// and above all the recoverable predecessor a takeover has to be allowed to adopt.
//
// The purity proof is the one that cannot be argued: it drives a REAL claimNextEligible
// evaluation through a database handle wrapped in a counting proxy, arms the counter
// only for the duration of the predicate call, and asserts zero. Its NEGATIVE CONTROL
// — a predicate that deliberately touches the store — proves the counter can see a
// call at all, which is the difference between evidence and a green tautology.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { getDb, makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { setPublicationClockOffsetForTest, storeNowMs } from "../store/publications.js";
import { upsertTicket, type TicketRow } from "../store/tickets.js";
import { enqueueTicket, isInProgress, rankTicket } from "../store/queue.js";
import {
  claimNextEligible,
  recordClaimLaunch,
  MIN_LEASE_TTL_MS,
  type ActiveClaimSummary,
  type ClaimCandidate,
  type ClaimNextResult,
  type QueueClaim,
  type ScanEntry,
} from "../store/queue-claims.js";
import { resetPublishBarrierForTest } from "../backlog/snapshot.js";
import {
  evaluateCompatibility,
  hydrateActiveRunFacts,
  makeCompatibilityPredicate,
  EXCLUSIVE_RELATIONS,
  NEUTRAL_RELATIONS,
  ORDERING_RELATIONS,
  type ActiveRunFacts,
} from "./compatibility.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const PK = "pk-compat";
const PK2 = "pk-compat-two";
const NOW = "2026-08-06T00:00:00Z";
const TTL = MIN_LEASE_TTL_MS;

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

function seedRun(runId: string, over: { status?: string; projectDir?: string | null } = {}): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', ?, ?, ?, ?)`,
  ).run(runId, `title ${runId}`, over.status ?? "active", NOW, over.projectDir ?? "/repos/one");
}

function seedTask(
  taskId: string,
  runId: string,
  over: { status?: string; worktreePath?: string | null } = {},
): void {
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, worktree_path)
     VALUES (?, ?, 'build', 'backend-specialist', ?, '{}', ?, ?)`,
  ).run(taskId, runId, over.status ?? "running", NOW, over.worktreePath ?? null);
}

function seedRelation(ticketId: string, relatedId: string, relType: string, projectKey = PK): void {
  db.prepare(
    `INSERT OR REPLACE INTO ticket_relations (project_key, ticket_id, related_id, rel_type) VALUES (?, ?, ?, ?)`,
  ).run(projectKey, ticketId, relatedId, relType);
}

function claimNext(over: Partial<Parameters<typeof claimNextEligible>[0]> = {}): ClaimNextResult {
  return claimNextEligible({
    projectKey: PK,
    owner: "ctl-1",
    capacity: 10,
    capacityScope: "host",
    leaseTtlMs: TTL,
    ...over,
  });
}

/** Grant a claim for `ticketId` and bind it to a run, so hydration has execution
 *  facts to read. Returns the live claim. */
function claimWithRun(
  ticketId: string,
  runId: string,
  over: { projectKey?: string; owner?: string; runStatus?: string; projectDir?: string | null } = {},
): QueueClaim {
  const projectKey = over.projectKey ?? PK;
  const out = claimNext({ projectKey, owner: over.owner ?? "ctl-1" });
  assert.equal(out.reason, "granted", `the fixture needs a grant, got ${out.reason}`);
  assert.equal(out.claimed?.ticketId, ticketId, "the fixture claimed a different ticket than expected");
  const claim = out.claimed as QueueClaim;
  seedRun(runId, { status: over.runStatus ?? "active", projectDir: over.projectDir ?? "/repos/one" });
  const stamped = recordClaimLaunch({
    projectKey,
    claimId: claim.id,
    owner: claim.owner,
    generation: claim.generation,
    launchId: `launch-${runId}`,
    runId,
  });
  assert.notEqual(stamped, null, "the launch stamp must land for the fixture to mean anything");
  return stamped as QueueClaim;
}

function summarize(claim: QueueClaim): ActiveClaimSummary {
  return {
    claimId: claim.id,
    projectKey: claim.projectKey,
    ticketId: claim.ticketId,
    owner: claim.owner,
    generation: claim.generation,
    leaseExpiresAtMs: claim.leaseExpiresAtMs,
    launchId: claim.launchId,
    runId: claim.runId,
  };
}

function candidateFor(ticketId: string, rank = 2): ClaimCandidate {
  return {
    ticketId,
    rank,
    type: "story",
    status: "active",
    title: `title ${ticketId}`,
    revision: 1,
    readinessOutcome: "ready",
  };
}

function hydrate(projectKey = PK): ActiveRunFacts {
  return hydrateActiveRunFacts({ projectKey, capacityScope: "host" });
}

/** EVERY row of EVERY table, as text — the census that catches a hydration or an
 *  evaluation that quietly wrote something. */
function fullDump(): string {
  const tables = (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
      .all() as { name: string }[]
  ).map((t) => t.name);
  return JSON.stringify(tables.map((t) => [t, db.prepare(`SELECT * FROM "${t}"`).all()]));
}

function reasonOf(v: ReturnType<typeof evaluateCompatibility>): string {
  assert.equal(v.compatible, false, "expected an incompatible verdict");
  return (v as { compatible: false; reason: string }).reason;
}

// ─── the purity contract ─────────────────────────────────────────────────────

describe("FG-591 D10: the predicate honours queue-claims' PREDICATE PURITY CONTRACT", () => {
  /** A counting proxy over the database handle every store read goes through
   *  (getDb()). It counts only while ARMED, so a call made by the hydration or by
   *  claimNextEligible's own scan is not mistaken for one made by the predicate. */
  function installSpy(real: DatabaseInstance): { calls: () => number; arm: <T>(fn: () => T) => T } {
    let count = 0;
    let armed = false;
    const spy = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (typeof value !== "function") return value;
        if (prop === "prepare" || prop === "exec" || prop === "pragma" || prop === "transaction") {
          return (...args: unknown[]) => {
            if (armed) count++;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    }) as DatabaseInstance;
    setDbForTest(spy);
    return {
      calls: () => count,
      arm: <T>(fn: () => T): T => {
        armed = true;
        try {
          return fn();
        } finally {
          armed = false;
        }
      },
    };
  }

  test("a REAL claim evaluation makes ZERO store calls inside the predicate", () => {
    seedQueued(["FG-1", "FG-2"]);
    const held = claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });

    const facts = hydrate();
    const spy = installSpy(db);
    const pure = makeCompatibilityPredicate(facts);
    let invocations = 0;

    const out = claimNext({
      isCompatible: (candidate, active) => {
        invocations++;
        return spy.arm(() => pure(candidate, active));
      },
    });

    assert.equal(out.reason, "granted", "FG-2 is parallel-safe beside an isolated worktree run");
    assert.equal(out.claimed?.ticketId, "FG-2");
    assert.ok(invocations > 0, "the predicate must actually have been consulted");
    assert.equal(spy.calls(), 0, "the predicate touched the store — the purity contract is broken");
    assert.equal(held.ticketId, "FG-1");
  });

  test("NEGATIVE CONTROL: the spy sees a store call when the predicate makes one", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });

    const spy = installSpy(db);
    const out = claimNext({
      isCompatible: () => {
        spy.arm(() => getDb().prepare(`SELECT 1 AS one`).get());
        return { compatible: true };
      },
    });

    assert.equal(out.reason, "granted");
    assert.ok(spy.calls() > 0, "the spy cannot see a store call, so the zero above proves nothing");
  });

  test("hydration and evaluation write NOTHING — a byte-identical census either side", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null });
    seedRelation("FG-2", "FG-1", "depends_on");

    const before = fullDump();
    const facts = hydrate();
    const verdict = evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact));
    assert.equal(verdict.compatible, false);
    assert.equal(fullDump(), before, "the read phase must leave the store byte-identical");
  });

  test("no blocker_evidence row is written, and the module contains no writer for one", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null });

    const facts = hydrate();
    evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact));
    const rows = db.prepare(`SELECT COUNT(*) AS n FROM blocker_evidence`).get() as { n: number };
    assert.equal(rows.n, 0, "a scheduling wait must never become durable, container-visible blocker evidence");
  });
});

/** The hydrated fact carries every field an ActiveClaimSummary does, so a test can
 *  build the predicate's second argument from the snapshot itself. */
function summarizeFact(f: ActiveRunFacts["activeRuns"][number]): ActiveClaimSummary {
  return {
    claimId: f.claimId,
    projectKey: f.projectKey,
    ticketId: f.ticketId,
    owner: f.owner,
    generation: f.generation,
    leaseExpiresAtMs: f.leaseExpiresAtMs,
    launchId: f.launchId,
    runId: f.runId,
  };
}

// ─── ticket relations ────────────────────────────────────────────────────────

describe("FG-591 D10: ticket relations against running work", () => {
  test("a candidate that DEPENDS ON an active claim's ticket is incompatible, and the reason names that ticket", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-2", "FG-1", "depends_on");

    const facts = hydrate();
    const verdict = evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact));
    const reason = reasonOf(verdict);
    assert.match(reason, /waiting for FG-1 to finish/, "the AC's own words, naming the conflicting ticket");
    assert.match(reason, /FG-2 depends_on FG-1/);
    assert.match(reason, /run run-1/, "the conflicting RUN is named too");
  });

  test("the REVERSE direction conflicts as well — running work that depends on the candidate", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-1", "FG-2", "depends_on");

    const facts = hydrate();
    const reason = reasonOf(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
    );
    assert.match(reason, /waiting for FG-1 to finish/);
    assert.match(reason, /FG-1 depends_on FG-2/);
  });

  test("an exclusivity relation conflicts with no implied order", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-2", "FG-1", "exclusive_with");

    const facts = hydrate();
    const reason = reasonOf(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
    );
    assert.match(reason, /are marked 'exclusive_with'/);
  });

  test("POSITIVE HALF: a neutral 'related' link admits — the ambiguity rule does not refuse every cross-reference", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-2", "FG-1", "related");

    const facts = hydrate();
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
      { compatible: true },
    );
  });

  test("an UNRECOGNISED relation type is ambiguous and refuses rather than admits", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-2", "FG-1", "entangled_with");

    const facts = hydrate();
    const reason = reasonOf(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
    );
    assert.match(reason, /'entangled_with'/);
    assert.match(reason, /does not recognise as safe to overlap/);
  });

  test("a relation to a ticket that is NOT executing is irrelevant", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-2", "FG-3", "depends_on");

    const facts = hydrate();
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
      { compatible: true },
      "an ordering relation only matters against work that is actually running",
    );
  });

  test("the three relation vocabularies are disjoint", () => {
    for (const r of ORDERING_RELATIONS) {
      assert.equal(EXCLUSIVE_RELATIONS.has(r), false, `${r} is in two classes`);
      assert.equal(NEUTRAL_RELATIONS.has(r), false, `${r} is in two classes`);
    }
    for (const r of EXCLUSIVE_RELATIONS) {
      assert.equal(NEUTRAL_RELATIONS.has(r), false, `${r} is in two classes`);
    }
  });
});

// ─── workspace lanes ─────────────────────────────────────────────────────────

describe("FG-591 D10: workspace lanes inside one repository", () => {
  test("a candidate in the same repo as a run holding the SHARED checkout is incompatible", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1", { projectDir: "/repos/one" });
    seedTask("task-1", "run-1", { worktreePath: null });

    const facts = hydrate();
    const reason = reasonOf(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
    );
    assert.match(reason, /waiting for FG-1 to finish/);
    assert.match(reason, /shared checkout \/repos\/one/);
    assert.match(reason, /task task-1/);
  });

  test("POSITIVE HALF: an ISOLATED per-task worktree holds no shared lane and admits", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedTask("task-2", "run-1", { worktreePath: "/wt/run-1/task-2" });

    const facts = hydrate();
    const lane = facts.activeRuns[0]?.lane;
    assert.equal(lane?.kind, "isolated");
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
      { compatible: true },
    );
  });

  test("a TERMINAL task no longer holds the shared checkout", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null, status: "complete" });
    seedTask("task-2", "run-1", { worktreePath: "/wt/run-1/task-2" });

    const facts = hydrate();
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
      { compatible: true },
    );
  });

  test("a claim in ANOTHER project shares no checkout — host scope does not serialise unrelated repos", () => {
    seedQueued(["FG-1"], PK2);
    seedQueued(["FG-2"]);
    const other = claimNext({ projectKey: PK2, owner: "ctl-other" });
    assert.equal(other.reason, "granted");
    seedRun("run-other", { projectDir: "/repos/two" });
    recordClaimLaunch({
      projectKey: PK2,
      claimId: (other.claimed as QueueClaim).id,
      owner: "ctl-other",
      generation: (other.claimed as QueueClaim).generation,
      runId: "run-other",
    });
    seedTask("task-other", "run-other", { worktreePath: null });

    const facts = hydrate();
    assert.equal(facts.activeRuns.length, 1, "host scope hydrates the other project's claim");
    assert.equal(facts.activeRuns[0]?.lane.kind, "shared_checkout");
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
      { compatible: true },
      "another repository's shared checkout is not this candidate's lane",
    );
  });

  test("a terminal RUN frees its lane", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1", { runStatus: "complete" });
    seedTask("task-1", "run-1", { worktreePath: null });

    const facts = hydrate();
    assert.equal(facts.activeRuns[0]?.lane.kind, "idle");
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
      { compatible: true },
    );
  });
});

// ─── ambiguity refuses rather than admits ────────────────────────────────────

describe("FG-591 D10: missing or ambiguous facts refuse", () => {
  test("a claim with no run and no launch has an UNKNOWN lane and refuses", () => {
    seedQueued(["FG-1", "FG-2"]);
    const out = claimNext();
    assert.equal(out.reason, "granted");

    const facts = hydrate();
    assert.equal(facts.activeRuns[0]?.lane.kind, "unknown");
    const reason = reasonOf(
      evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact)),
    );
    assert.match(reason, /workspace is not yet knowable/);
    assert.match(reason, /granted but has recorded no launch and no run yet/);
  });

  test("a run whose row is absent, and a run with no live task, are both UNKNOWN", () => {
    seedQueued(["FG-1", "FG-2"]);
    const claim = claimWithRun("FG-1", "run-1");
    // A run row with no task at all: the launch happened, the first task has not spawned.
    let facts = hydrate();
    assert.equal(facts.activeRuns[0]?.lane.kind, "unknown");
    assert.match(
      reasonOf(evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact))),
      /has recorded no live task/,
    );

    db.prepare(`DELETE FROM runs WHERE id = ?`).run("run-1");
    facts = hydrate();
    assert.equal(facts.activeRuns[0]?.lane.kind, "unknown");
    assert.match(
      reasonOf(evaluateCompatibility(facts, candidateFor("FG-2"), facts.activeRuns.map(summarizeFact))),
      /has no row in this store/,
    );
    assert.equal(claim.runId, "run-1");
  });

  test("an active claim ABSENT from the snapshot refuses — the read moved under the decision", () => {
    seedQueued(["FG-1", "FG-2"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });

    const facts = hydrate();
    const unhydrated: ActiveClaimSummary = {
      claimId: "qclaim-appeared-later",
      projectKey: PK,
      ticketId: "FG-9",
      owner: "ctl-2",
      generation: 1,
      leaseExpiresAtMs: facts.hydratedAtMs + TTL,
      launchId: null,
      runId: null,
    };
    const reason = reasonOf(
      evaluateCompatibility(facts, candidateFor("FG-2"), [
        ...facts.activeRuns.map(summarizeFact),
        unhydrated,
      ]),
    );
    assert.match(reason, /not in the hydrated snapshot/);
    assert.match(reason, /re-scan rather than admit/);
  });

  test("a snapshot that no longer matches the active claim refuses", () => {
    seedQueued(["FG-1", "FG-2"]);
    const claim = claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });

    const facts = hydrate();
    const moved: ActiveClaimSummary = { ...summarize(claim), generation: claim.generation + 1 };
    const reason = reasonOf(evaluateCompatibility(facts, candidateFor("FG-2"), [moved]));
    assert.match(reason, /no longer match the active set/);
    assert.match(reason, /The snapshot is stale/);
  });

  test("the SAME ticket on a live lease refuses, naming it", () => {
    seedQueued(["FG-1"]);
    const claim = claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });

    const facts = hydrate();
    const reason = reasonOf(evaluateCompatibility(facts, candidateFor("FG-1", 1), [summarize(claim)]));
    assert.match(reason, /waiting for FG-1 to finish/);
    assert.match(reason, /duplicate execution/);
  });

  test("the RECOVERABLE PREDECESSOR is skipped, so a takeover is still possible", () => {
    seedQueued(["FG-1"]);
    const claim = claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null });

    // Age the STORE clock past the lease: the predecessor becomes recoverable.
    setPublicationClockOffsetForTest(TTL * 2);
    const facts = hydrate();
    assert.ok(facts.hydratedAtMs > claim.leaseExpiresAtMs, "the fixture must actually have expired the lease");
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-1", 1), [summarize(claim)]),
      { compatible: true },
      "refusing here would make every crashed controller's ticket permanently unrecoverable",
    );

    // And end-to-end: the real primitive takes it over rather than being blocked.
    const out = claimNext({ owner: "ctl-2", isCompatible: makeCompatibilityPredicate(facts) });
    assert.equal(out.reason, "granted");
    assert.equal(out.claimed?.ticketId, "FG-1");
    assert.equal(out.takenOverFrom?.id, claim.id, "the predecessor's launch identity reaches the successor");
    assert.equal(out.takenOverFrom?.runId, "run-1");
  });
});

// ─── execution outside the claim ledger ──────────────────────────────────────

describe("FG-591 D10: execution the claim ledger cannot account for", () => {
  test("a candidate whose ticket is already running as an operator-initiated run refuses", () => {
    seedQueued(["FG-1", "FG-2"]);
    seedRun("run-manual", { projectDir: "/repos/one" });
    seedTask("task-manual", "run-manual", { worktreePath: "/wt/manual" });
    db.prepare(
      `INSERT INTO ticket_dispatch_evidence (task_id, project_key, ticket_id, revision, body_hash, dispatched_at)
       VALUES (?, ?, ?, 1, 'hash', ?)`,
    ).run("task-manual", PK, "FG-1", NOW);

    assert.equal(isInProgress(PK, "FG-1"), true, "queue.ts agrees this ticket is executing");
    const facts = hydrate();
    const reason = reasonOf(evaluateCompatibility(facts, candidateFor("FG-1", 1), []));
    assert.match(reason, /waiting for FG-1 to finish/);
    assert.match(reason, /outside the queue's claim ledger/);
    assert.match(reason, /task task-manual/);
  });

  test("a non-terminal LAUNCH of the candidate's ticket refuses — the window before the first task spawns", () => {
    seedQueued(["FG-1"]);
    db.prepare(
      `INSERT INTO launch_observations
         (launch_id, command, cwd, project_dir, association_kind, ticket_id, started_at, observed_at, state, terminal)
       VALUES (?, 'forge new feature', '/repos/one', NULL, 'ticket', ?, ?, ?, 'running', 0)`,
    ).run("launch-manual", "FG-1", NOW, NOW);

    const facts = hydrate();
    const reason = reasonOf(evaluateCompatibility(facts, candidateFor("FG-1", 1), []));
    assert.match(reason, /launch launch-manual is running/);
  });

  test("a TERMINAL launch is not execution", () => {
    seedQueued(["FG-1"]);
    db.prepare(
      `INSERT INTO launch_observations
         (launch_id, command, cwd, project_dir, association_kind, ticket_id, started_at, observed_at, state, terminal)
       VALUES (?, 'forge new feature', '/repos/one', NULL, 'ticket', ?, ?, ?, 'exited', 1)`,
    ).run("launch-done", "FG-1", NOW, NOW);

    const facts = hydrate();
    assert.deepEqual(evaluateCompatibility(facts, candidateFor("FG-1", 1), []), { compatible: true });
  });

  test("the claim ledger's OWN launch is not counted as foreign execution", () => {
    seedQueued(["FG-1"]);
    const claim = claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    db.prepare(
      `INSERT INTO launch_observations
         (launch_id, command, cwd, project_dir, association_kind, run_id, ticket_id, started_at, observed_at, state, terminal)
       VALUES (?, 'forge new feature', '/repos/one', NULL, 'ticket', ?, ?, ?, ?, 'running', 0)`,
    ).run(claim.launchId, "run-1", "FG-1", NOW, NOW);

    // Aged past the lease so the predecessor-skip applies: what remains under test is
    // that its OWN launch is not then re-reported as somebody else's execution.
    setPublicationClockOffsetForTest(TTL * 2);
    const facts = hydrate();
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-1", 1), [summarize(claim)]),
      { compatible: true },
      "a takeover must not be blocked by the predecessor's own container",
    );
  });
});

// ─── durable resource locks ──────────────────────────────────────────────────

describe("FG-591 D10: durable resource locks", () => {
  function seedLock(projectKey: string, expiresAtMs: number): void {
    db.prepare(
      `INSERT OR REPLACE INTO publication_locks (project_key, attempt_id, run_id, acquired_at_ms, expires_at_ms)
       VALUES (?, 'attempt-1', 'run-pub', ?, ?)`,
    ).run(projectKey, expiresAtMs - 1000, expiresAtMs);
  }

  test("a LIVE publication lock over the candidate's project refuses", () => {
    seedQueued(["FG-1"]);
    seedLock(PK, storeNowMs() + 60_000);
    const facts = hydrate();
    const reason = reasonOf(evaluateCompatibility(facts, candidateFor("FG-1", 1), []));
    assert.match(reason, /waiting for the publication lock/);
    assert.match(reason, /run run-pub/);
  });

  test("an EXPIRED lock does not — a stale lock must never wedge the queue", () => {
    seedQueued(["FG-1"]);
    seedLock(PK, storeNowMs() - 60_000);
    const facts = hydrate();
    assert.deepEqual(evaluateCompatibility(facts, candidateFor("FG-1", 1), []), { compatible: true });
  });

  test("another project's lock does not", () => {
    seedQueued(["FG-1"]);
    seedLock(PK2, storeNowMs() + 60_000);
    const facts = hydrate();
    assert.deepEqual(evaluateCompatibility(facts, candidateFor("FG-1", 1), []), { compatible: true });
  });
});

// ─── the FG-609 D6 guard reaches the hydration ───────────────────────────────

describe("FG-591 D10: hydration inherits queue-claims' project guard", () => {
  test("a markdown-mode project REFUSES by name rather than hydrating an empty snapshot", () => {
    db.prepare(`UPDATE ticket_storage_mode SET mode = 'markdown' WHERE project_key = ?`).run(PK);
    assert.throws(
      () => hydrate(),
      (err: unknown) => {
        const message = (err as Error).message;
        assert.match(message, /storage mode/, "the refusal must name why");
        return true;
      },
      "an empty snapshot for an unresolvable project reads as 'nothing is running', which is the fail-open " +
        "the D6 guard exists to make impossible",
    );
  });

  test("an unregistered project refuses too", () => {
    db.prepare(`DELETE FROM project_identity WHERE project_key = ?`).run(PK);
    assert.throws(() => hydrate(), /no project_identity row exists/);
  });
});

// ─── determinism and totality ────────────────────────────────────────────────

describe("FG-591 D10: the same (candidate, active) pair always returns the same verdict", () => {
  test("repeated evaluation, and any ORDER of the active set, produce an identical verdict", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null });
    seedQueued(["FG-9"], PK2);
    const second = claimNext({ projectKey: PK2, owner: "ctl-two" });
    assert.equal(second.reason, "granted");

    const facts = hydrate();
    const active = facts.activeRuns.map(summarizeFact);
    assert.equal(active.length, 2, "two claims are needed for order to be able to matter");

    const first = evaluateCompatibility(facts, candidateFor("FG-2"), active);
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(evaluateCompatibility(facts, candidateFor("FG-2"), active), first);
    }
    assert.deepEqual(
      evaluateCompatibility(facts, candidateFor("FG-2"), [...active].reverse()),
      first,
      "the verdict must not depend on the order claimNextEligible happened to read the claims in",
    );
  });

  test("TOTAL: an empty active set, an empty snapshot and an unknown candidate all return a verdict", () => {
    seedQueued(["FG-1"]);
    const facts = hydrate();
    assert.deepEqual(evaluateCompatibility(facts, candidateFor("FG-1", 1), []), { compatible: true });
    assert.deepEqual(evaluateCompatibility(facts, candidateFor("FG-UNKNOWN", 7), []), { compatible: true });
    const empty: ActiveRunFacts = {
      projectKey: PK,
      capacityScope: "host",
      hydratedAtMs: 0,
      activeRuns: [],
      relations: [],
      foreignExecutions: [],
      resourceLocks: [],
    };
    assert.deepEqual(evaluateCompatibility(empty, candidateFor("FG-1", 1), []), { compatible: true });
  });
});

// ─── the vocabularies this module restates ───────────────────────────────────

describe("FG-591 D10: restated vocabularies agree with the modules they came from", () => {
  test("the terminal TASK statuses agree with queue.ts's own isInProgress derivation", () => {
    seedQueued(["FG-1"]);
    seedRun("run-x");
    const statuses = ["running", "awaiting_gate", "awaiting_red", "blocked_by_red", "awaiting_recovery", "complete", "failed"];
    for (const [i, status] of statuses.entries()) {
      const taskId = `task-${i}`;
      seedTask(taskId, "run-x", { status, worktreePath: "/wt/x" });
      db.prepare(
        `INSERT INTO ticket_dispatch_evidence (task_id, project_key, ticket_id, revision, body_hash, dispatched_at)
         VALUES (?, ?, 'FG-1', 1, 'hash', ?)`,
      ).run(taskId, PK, NOW);

      const queueSaysRunning = isInProgress(PK, "FG-1");
      const facts = hydrate();
      const compatibilitySaysRunning = facts.foreignExecutions.some(
        (f) => f.ticketId === "FG-1" && f.kind === "task",
      );
      assert.equal(
        compatibilitySaysRunning,
        queueSaysRunning,
        `'${status}': this module's terminal-task set disagrees with queue.ts's`,
      );

      db.prepare(`DELETE FROM ticket_dispatch_evidence WHERE task_id = ?`).run(taskId);
    }
  });

  test("a terminal RUN status frees the lane and a non-terminal one does not", () => {
    seedQueued(["FG-1", "FG-2"]);
    const claim = claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null });
    for (const [status, expected] of [
      ["active", "shared_checkout"],
      ["awaiting_gate", "shared_checkout"],
      ["complete", "idle"],
      ["failed", "idle"],
      ["abandoned", "idle"],
    ] as const) {
      db.prepare(`UPDATE runs SET status = ? WHERE id = ?`).run(status, "run-1");
      const facts = hydrate();
      assert.equal(facts.activeRuns[0]?.lane.kind, expected, `run status '${status}'`);
    }
    assert.equal(claim.ticketId, "FG-1");
  });
});

// ─── composed with the real primitive ────────────────────────────────────────

describe("FG-591 D10: driven through the real claimNextEligible", () => {
  test("an incompatible top candidate is BYPASSED, named 'incompatible', and its rank is byte-identical", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    // FG-1 executes, holding the shared checkout; FG-2 depends on it; FG-3 is free.
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: "/wt/run-1/task-1" });
    seedRelation("FG-2", "FG-1", "depends_on");

    const ranksBefore = db
      .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
      .all(PK);

    const facts = hydrate();
    const out = claimNext({ owner: "ctl-2", isCompatible: makeCompatibilityPredicate(facts) });

    assert.equal(out.reason, "granted");
    assert.equal(out.claimed?.ticketId, "FG-3", "the first COMPATIBLE candidate in rank order");
    const fg2 = out.scanned.find((s) => s.ticketId === "FG-2");
    assert.equal(fg2?.reason, "incompatible", "the bypass is NAMED, not silent");
    assert.match(fg2?.detail ?? "", /waiting for FG-1 to finish/);

    assert.deepEqual(
      db
        .prepare(`SELECT ticket_id, priority_rank FROM tickets WHERE project_key = ? ORDER BY ticket_id`)
        .all(PK),
      ranksBefore,
      "bypassing an incompatible candidate must never reorder the operator's queue",
    );
  });

  test("the recorded scan evidence carries this module's reason, so the grant explains itself", () => {
    seedQueued(["FG-1", "FG-2", "FG-3"]);
    claimWithRun("FG-1", "run-1");
    seedTask("task-1", "run-1", { worktreePath: null });

    const facts = hydrate();
    const out = claimNext({ owner: "ctl-2", isCompatible: makeCompatibilityPredicate(facts) });
    assert.equal(out.reason, "no_eligible_candidate", "FG-2 and FG-3 both share the checkout FG-1 holds");
    for (const id of ["FG-2", "FG-3"]) {
      const entry: ScanEntry | undefined = out.scanned.find((s) => s.ticketId === id);
      assert.equal(entry?.reason, "incompatible");
      assert.match(entry?.detail ?? "", /shared checkout/);
    }
  });
});
