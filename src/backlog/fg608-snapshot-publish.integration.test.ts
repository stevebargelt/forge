// FG-608 (acceptance 2 + 3): the SNAPSHOT PUBLISHER's host-side properties.
//
// MANDATE 5 requires two SEPARATELY-tested properties, and this file is
// deliberately only the FIRST:
//
//   (i)  ATOMIC SNAPSHOT REPLACEMENT — rename atomicity, no torn reads, under a
//        STRESS LOOP rather than a single green run. That is what this file tests.
//   (ii) ACTUAL END-TO-END DELIVERY — an authoritative host write reaching an
//        ALREADY-RUNNING container's next read through the production fan-out.
//        That is src/v2/fg608-container-amendment.worktree.test.ts and it needs a
//        real container. NOTHING HERE COUNTS AS EVIDENCE FOR IT.
//
// Integration tier: real on-disk snapshot files, real SQLite opens, real renames.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import {
  publishSnapshotOnce,
  publishToLiveTargets,
  registerSnapshotTarget,
  releaseSnapshotTarget,
  releaseFinishedTargets,
  liveSnapshotTargets,
  publicationStates,
  describeStalePublications,
  resetPublishBarrierForTest,
  SNAPSHOT_DB_BASENAME,
  PUBLISH_MAX_ATTEMPTS,
} from "./snapshot.js";
import { upsertTicket, upsertBlockerEvidence, upsertTicketRelation } from "../store/tickets.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  resetPublishBarrierForTest();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) {
    try {
      chmodSync(d, 0o755);
    } catch {
      /* already gone */
    }
    rmSync(d, { recursive: true, force: true });
  }
  resetPublishBarrierForTest();
});

const KEY = "pk-test";
const NOW = "2026-07-29T00:00:00Z";

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fg608-snap-"));
  dirs.push(d);
  return d;
}

function seedTicket(id: string, body: string): void {
  writeTransaction(() =>
    upsertTicket({
      projectKey: KEY,
      ticketId: id,
      type: "story",
      status: "active",
      title: `title ${id}`,
      body,
      importedAt: NOW,
    }),
  );
}

function readSnapshot(dir: string): DatabaseInstance {
  return new Database(join(dir, SNAPSHOT_DB_BASENAME), { readonly: true, fileMustExist: true });
}

// ─── the artifact's forced shape ─────────────────────────────────────────────

test("FG-608: the published artifact is NON-WAL (a WAL db cannot be opened from a read-only mount)", () => {
  seedTicket("FG-1", "b");
  const dir = newDir();
  publishSnapshotOnce(KEY, dir);

  const snap = readSnapshot(dir);
  try {
    const mode = snap.pragma("journal_mode", { simple: true });
    assert.notEqual(mode, "wal", "a WAL snapshot would fail SQLITE_READONLY_DIRECTORY under a :ro mount");
  } finally {
    snap.close();
  }
  // No -wal / -shm sidecars either: their presence is what a read-only directory
  // cannot support.
  const entries = readdirSync(dir);
  assert.deepEqual(entries.filter((e) => e.endsWith("-wal") || e.endsWith("-shm")), []);
});

test("FG-608: publication is write-temp + rename INSIDE the mounted directory", () => {
  seedTicket("FG-1", "b");
  const dir = newDir();
  publishSnapshotOnce(KEY, dir);
  // Exactly the final artifact — no temp leftovers. The temp file must live in the
  // SAME directory, because rename(2) is only atomic within one filesystem, and
  // the directory is what is mounted.
  assert.deepEqual(readdirSync(dir), [SNAPSHOT_DB_BASENAME]);
});

// ─── PROJECT ISOLATION is structural ─────────────────────────────────────────

test("FG-608: the snapshot contains ONLY this project's backlog and no control-plane tables", () => {
  seedTicket("FG-1", "mine");
  writeTransaction(() =>
    upsertTicket({
      projectKey: "pk-other",
      ticketId: "FG-99",
      type: "story",
      status: "active",
      title: "another project",
      body: "not mine",
      importedAt: NOW,
    }),
  );
  writeTransaction(() =>
    upsertTicketRelation({ projectKey: KEY, ticketId: "FG-1", relatedId: "FG-2", relType: "related" }),
  );
  writeTransaction(() =>
    upsertBlockerEvidence({ projectKey: KEY, ticketId: "FG-1", source: "s", createdAt: NOW }),
  );

  const dir = newDir();
  publishSnapshotOnce(KEY, dir);
  const snap = readSnapshot(dir);
  try {
    const ids = (snap.prepare(`SELECT ticket_id FROM tickets`).all() as { ticket_id: string }[]).map(
      (r) => r.ticket_id,
    );
    assert.deepEqual(ids, ["FG-1"], "another project's tickets are not merely filtered — they are absent");

    const tables = new Set(
      (snap.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
        (t) => t.name,
      ),
    );
    assert.deepEqual(
      [...tables].sort(),
      ["blocker_evidence", "snapshot_meta", "ticket_relations", "tickets"],
      "backlog-only: no runs/tasks/events/gates/verdicts/campaigns tables exist to reach",
    );
    for (const forbidden of ["runs", "tasks", "events", "gates", "verdicts", "campaigns", "project_identity"]) {
      assert.equal(tables.has(forbidden), false, `${forbidden} must not exist in a published snapshot`);
    }
  } finally {
    snap.close();
  }
});

// ─── PROPERTY (i): ATOMIC REPLACEMENT, under a STRESS LOOP ───────────────────

test("FG-608 property (i): concurrent republish under a stress loop never yields a torn read", () => {
  const dir = newDir();
  seedTicket("FG-1", "v0");
  publishSnapshotOnce(KEY, dir);

  // Not a single green run: 60 republish/read pairs, with the ticket body growing
  // so a partially-written file would be both structurally invalid AND
  // content-detectable. A torn read would surface as an open failure, a malformed
  // database error, or a body that is neither the old nor the new value.
  const ITERATIONS = 60;
  let observedOld = 0;
  let observedNew = 0;
  for (let i = 1; i <= ITERATIONS; i++) {
    const previousBody = `v${i - 1}`.padEnd(i * 64, "x");
    const nextBody = `v${i}`.padEnd((i + 1) * 64, "y");
    seedTicket("FG-1", nextBody);
    publishSnapshotOnce(KEY, dir);

    const snap = readSnapshot(dir);
    try {
      assert.equal(
        snap.pragma("integrity_check", { simple: true }),
        "ok",
        `iteration ${i}: the artifact a reader opened is a structurally intact database`,
      );
      const body = (snap.prepare(`SELECT body FROM tickets WHERE ticket_id='FG-1'`).get() as {
        body: string;
      }).body;
      if (body === nextBody) observedNew++;
      else if (body === previousBody) observedOld++;
      else assert.fail(`iteration ${i}: torn read — body is neither the old nor the new value`);
    } finally {
      snap.close();
    }
    // No temp file is ever left where a reader could mistake it for the artifact.
    assert.deepEqual(readdirSync(dir), [SNAPSHOT_DB_BASENAME], `iteration ${i}: no torn/leftover files`);
  }
  assert.equal(observedOld + observedNew, ITERATIONS);
  assert.ok(observedNew > 0, "the stress loop actually observed republished content");
});

test("FG-608 property (i): a reader holding an OPEN handle across a republish is never corrupted", () => {
  const dir = newDir();
  seedTicket("FG-1", "before");
  publishSnapshotOnce(KEY, dir);

  // rename() replaces the directory entry, not the inode the reader holds. The
  // open handle keeps serving the OLD file intact — which is precisely why the
  // container-side reader must RE-OPEN to see an amendment (see
  // container-authority.ts), and why a FILE bind-mount could never work.
  const held = readSnapshot(dir);
  try {
    seedTicket("FG-1", "after");
    publishSnapshotOnce(KEY, dir);
    const stillOld = (held.prepare(`SELECT body FROM tickets WHERE ticket_id='FG-1'`).get() as {
      body: string;
    }).body;
    assert.equal(stillOld, "before", "the held inode is intact, not torn — it is simply the old one");

    const reopened = readSnapshot(dir);
    try {
      assert.equal(
        (reopened.prepare(`SELECT body FROM tickets WHERE ticket_id='FG-1'`).get() as { body: string }).body,
        "after",
        "a fresh open sees the replacement",
      );
    } finally {
      reopened.close();
    }
  } finally {
    held.close();
  }
});

// ─── fan-out, retry, and the durable stale marker ────────────────────────────

test("FG-608: a host ticket write fans out to EVERY live target for that project_key", () => {
  const a = newDir();
  const b = newDir();
  const otherProject = newDir();
  registerSnapshotTarget(KEY, a, "task-a");
  registerSnapshotTarget(KEY, b, "task-b");
  registerSnapshotTarget("pk-other", otherProject, "task-c");

  // Through the PRODUCTION choke point: an ordinary store write, nothing rigged.
  seedTicket("FG-1", "fanned out");

  for (const dir of [a, b]) {
    const snap = readSnapshot(dir);
    try {
      assert.equal(
        (snap.prepare(`SELECT body FROM tickets WHERE ticket_id='FG-1'`).get() as { body: string }).body,
        "fanned out",
        `${dir} received the write`,
      );
    } finally {
      snap.close();
    }
  }
  assert.equal(
    existsSync(join(otherProject, SNAPSHOT_DB_BASENAME)),
    false,
    "another project's target is not published to",
  );
});

test("FG-608: a released target stops receiving publications and its artifact is removed", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  seedTicket("FG-1", "first");
  assert.equal(existsSync(join(dir, SNAPSHOT_DB_BASENAME)), true);

  releaseSnapshotTarget(KEY, dir);
  assert.deepEqual(liveSnapshotTargets(KEY), []);
  assert.equal(existsSync(dir), false, "the derived artifact is cleaned up with the target");

  // And a later write neither republishes it nor recreates the directory.
  seedTicket("FG-1", "second");
  assert.equal(existsSync(dir), false, "a released target is never published to again");
});

test("FG-608: finished tasks' targets are released, so fan-out cannot grow unbounded", () => {
  const finished = newDir();
  const live = newDir();
  registerSnapshotTarget(KEY, finished, "task-done");
  registerSnapshotTarget(KEY, live, "task-running");
  seedTicket("FG-1", "b");
  assert.equal(liveSnapshotTargets(KEY).length, 2);

  const released = releaseFinishedTargets(KEY, (id) => id === "task-running");
  assert.deepEqual(released, [finished]);
  assert.deepEqual(
    liveSnapshotTargets(KEY).map((t) => t.targetDir),
    [live],
    "only the finished task's target is retired",
  );

  seedTicket("FG-1", "after");
  const snap = readSnapshot(live);
  try {
    assert.equal(
      (snap.prepare(`SELECT body FROM tickets WHERE ticket_id='FG-1'`).get() as { body: string }).body,
      "after",
      "the still-running task keeps receiving publications",
    );
  } finally {
    snap.close();
  }
});

test("FG-608: a target with no owning task is NEVER auto-released (no liveness signal to act on)", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir);
  assert.deepEqual(releaseFinishedTargets(KEY, () => false), []);
  assert.equal(liveSnapshotTargets(KEY).length, 1);
});

test("FG-608: publication failure NEVER fails or rolls back the authoritative host write", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  // Make the target unpublishable: a read-only directory cannot host the temp file.
  chmodSync(dir, 0o555);

  // The host write must succeed anyway. The DB is truth; the snapshot is derived.
  assert.doesNotThrow(() => seedTicket("FG-1", "committed despite an unpublishable target"));
  assert.equal(
    db.prepare(`SELECT body FROM tickets WHERE project_key=? AND ticket_id='FG-1'`).get(KEY) !== undefined,
    true,
    "the authoritative row is committed",
  );
});

test("FG-608: retry is bounded and exhaustion sets a DURABLE stale marker, surfaced to the operator", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  chmodSync(dir, 0o555);

  seedTicket("FG-1", "b");

  const states = publicationStates(KEY);
  assert.equal(states.length, 1);
  assert.equal(states[0]!.state, "stale", "exhausted retry marks the target stale, not silently continues");
  assert.equal(states[0]!.attempts, PUBLISH_MAX_ATTEMPTS, "retry is bounded, and the bound is recorded");
  assert.ok(states[0]!.lastError, "the failure reason is durable, not just a boolean");

  const described = describeStalePublications(KEY);
  assert.ok(described, "a stale publication is surfaced in `forge backlog` output");
  assert.match(described!, /STALE/);
  assert.match(described!, /may be reading an older ticket/);
});

test("FG-608: a target that recovers is marked ok again and stops being surfaced as stale", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  chmodSync(dir, 0o555);
  seedTicket("FG-1", "b");
  assert.equal(publicationStates(KEY)[0]!.state, "stale");

  chmodSync(dir, 0o755);
  publishToLiveTargets(KEY);

  assert.equal(publicationStates(KEY)[0]!.state, "ok");
  assert.ok(publicationStates(KEY)[0]!.lastOkAt);
  assert.equal(describeStalePublications(KEY), null, "nothing stale left to warn about");
});

test("FG-608: an up-to-date project surfaces NO stale warning (no false positives)", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  seedTicket("FG-1", "b");
  assert.equal(describeStalePublications(KEY), null);
});

// ─── the barrier: publication is POST-COMMIT ─────────────────────────────────

test("FG-608: a rolled-back transaction publishes NOTHING", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  seedTicket("FG-1", "committed");

  assert.throws(() =>
    writeTransaction(() => {
      upsertTicket({
        projectKey: KEY,
        ticketId: "FG-2",
        type: "story",
        status: "active",
        title: "will roll back",
        body: "never durable",
        importedAt: NOW,
      });
      throw new Error("boom");
    }),
  );

  const snap = readSnapshot(dir);
  try {
    const ids = (snap.prepare(`SELECT ticket_id FROM tickets`).all() as { ticket_id: string }[]).map(
      (r) => r.ticket_id,
    );
    assert.deepEqual(ids, ["FG-1"], "the rolled-back ticket was never published — nothing was durable");
  } finally {
    snap.close();
  }
});

test("FG-608: a multi-write transaction publishes ONCE, after commit, with the final state", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");

  writeTransaction(() => {
    for (const id of ["FG-1", "FG-2", "FG-3"]) {
      upsertTicket({
        projectKey: KEY,
        ticketId: id,
        type: "story",
        status: "active",
        title: id,
        body: "b",
        importedAt: NOW,
      });
    }
  });

  const snap = readSnapshot(dir);
  try {
    assert.deepEqual(
      (snap.prepare(`SELECT ticket_id FROM tickets ORDER BY ticket_id`).all() as { ticket_id: string }[]).map(
        (r) => r.ticket_id,
      ),
      ["FG-1", "FG-2", "FG-3"],
      "the published artifact reflects the committed end state, not a mid-transaction one",
    );
  } finally {
    snap.close();
  }
});

test("FG-608: snapshot_meta carries the project_key and the max revision", () => {
  seedTicket("FG-1", "b");
  seedTicket("FG-1", "b2"); // revision 2
  const dir = newDir();
  publishSnapshotOnce(KEY, dir);
  const snap = readSnapshot(dir);
  try {
    const meta = snap.prepare(`SELECT project_key, max_revision FROM snapshot_meta`).get() as {
      project_key: string;
      max_revision: number;
    };
    assert.equal(meta.project_key, KEY);
    assert.equal(meta.max_revision, 2);
  } finally {
    snap.close();
  }
});
