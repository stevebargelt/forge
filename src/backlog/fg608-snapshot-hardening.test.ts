// FG-608 reds F7, F12, F13 — three ways the publisher's failure handling was
// wrong, each asserted at the behaviour that was wrong rather than at the code.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import {
  PUBLISH_BACKOFF_MS,
  PUBLISH_MAX_ATTEMPTS,
  SNAPSHOT_DB_BASENAME,
  UNKNOWN_TARGET_SWEEP_MS,
  describeStalePublications,
  liveSnapshotTargets,
  publicationStates,
  publishSnapshotOnce,
  publishToLiveTargets,
  registerSnapshotTarget,
  releaseFinishedTargets,
  releaseSnapshotTarget,
} from "./snapshot.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];
const KEY = "pk-hardening";
const NOW = "2026-07-29T00:00:00Z";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fg608-hard-"));
  dirs.push(d);
  return d;
}

function seed(id: string, body: string): void {
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    upsertTicket({
      projectKey: KEY, ticketId: id, type: "story", status: "active",
      title: `title ${id}`, body, importedAt: NOW,
    });
  });
  setStorageMode(KEY, "db", NOW);
}

function snapshotBody(dir: string, id: string): string | undefined {
  const snap = new Database(join(dir, SNAPSHOT_DB_BASENAME), { readonly: true });
  try {
    return (snap.prepare(`SELECT body FROM tickets WHERE ticket_id = ?`).get(id) as { body: string } | undefined)?.body;
  } finally {
    snap.close();
  }
}

function publicationOrdinal(): number {
  return (
    (db.prepare(`SELECT ordinal FROM backlog_publication_ordinal WHERE project_key = ?`).get(KEY) as
      | { ordinal: number }
      | undefined)?.ordinal ?? 0
  );
}

function setPublicationOrdinal(ordinal: number): void {
  db.prepare(`UPDATE backlog_publication_ordinal SET ordinal = ? WHERE project_key = ?`).run(ordinal, KEY);
}

function snapshotMaxRevision(dir: string): number {
  const snap = new Database(join(dir, SNAPSHOT_DB_BASENAME), { readonly: true });
  try {
    return (snap.prepare(`SELECT max_revision FROM snapshot_meta`).get() as { max_revision: number }).max_revision;
  } finally {
    snap.close();
  }
}

// ─── F7: ordering ───────────────────────────────────────────────────────────

test("FG-608 F7: an OLDER build does not rename over a strictly newer published one", () => {
  const dir = newDir();
  seed("FG-1", "v1");
  seed("FG-1", "v2");
  seed("FG-1", "v3"); // revision 3
  publishSnapshotOnce(KEY, dir);
  assert.equal(snapshotMaxRevision(dir), 3);
  assert.equal(snapshotBody(dir, "FG-1"), "v3");

  // Simulate the losing half of the race: a publisher whose SOURCE state is older
  // than what is already on disk. rename(2) is atomic but unordered, so without the
  // stamp comparison this call would strand a running container on stale truth and
  // record it as 'ok'.
  db.prepare(`UPDATE tickets SET revision = 2, body = 'STALE' WHERE ticket_id = 'FG-1'`).run();
  publishSnapshotOnce(KEY, dir);

  assert.equal(snapshotMaxRevision(dir), 3, "the newer artifact survives");
  assert.equal(snapshotBody(dir, "FG-1"), "v3");
  assert.deepEqual(
    // and no temp file was left behind by the declined rename
    [...new Set([existsSync(join(dir, SNAPSHOT_DB_BASENAME))])],
    [true],
  );
});

test("FG-608 F7: an older build of a NON-MAX ticket is skipped even though max_revision is EQUAL", () => {
  const dir = newDir();
  // FG-HIGH is and stays the project's highest-revision ticket, so every edit to
  // FG-1 below leaves max_revision pinned at 3. That is the ordinary case — most
  // tickets are not the max one — and it is exactly where the first F7 fix did
  // nothing: two racing builds carried EQUAL stamps, the strict `>` never fired,
  // and the older build renamed over the newer one and was recorded 'ok'.
  seed("FG-HIGH", "h1");
  seed("FG-HIGH", "h2");
  seed("FG-HIGH", "h3"); // revision 3 — the project-wide max, from here on
  seed("FG-1", "v1"); // revision 1

  // The state the SLOWER publisher read before it stalled.
  const olderTickets = db.prepare(`SELECT ticket_id, revision, body FROM tickets`).all() as {
    ticket_id: string; revision: number; body: string;
  }[];
  const olderOrdinal = publicationOrdinal();

  seed("FG-1", "v2"); // revision 2 — still not the max
  publishSnapshotOnce(KEY, dir); // the FASTER publisher lands first
  assert.equal(snapshotBody(dir, "FG-1"), "v2");
  assert.equal(snapshotMaxRevision(dir), 3);

  // Now the slower publisher finally builds and attempts its rename. Restoring the
  // ticket rows AND the ordinal is what a concurrent process's read view actually
  // was — it observed the whole earlier state, not half of it.
  for (const t of olderTickets) {
    db.prepare(`UPDATE tickets SET revision = ?, body = ? WHERE ticket_id = ?`).run(t.revision, t.body, t.ticket_id);
  }
  setPublicationOrdinal(olderOrdinal);
  publishSnapshotOnce(KEY, dir);

  assert.equal(snapshotMaxRevision(dir), 3, "both builds carry the SAME max revision — that is the point");
  assert.equal(
    snapshotBody(dir, "FG-1"),
    "v2",
    "the older build must decline the rename; overwriting here strands a running agent on a ticket " +
      "amendment that was already superseded, and records it as 'ok'",
  );
  assert.deepEqual(readdirSync(dir), [SNAPSHOT_DB_BASENAME], "and it leaves no temp file behind");
});

test("FG-608 F7: an equal-or-newer build DOES publish (the guard is ordering, not a freeze)", () => {
  const dir = newDir();
  seed("FG-1", "v1");
  publishSnapshotOnce(KEY, dir);
  seed("FG-1", "v2");
  publishSnapshotOnce(KEY, dir);
  assert.equal(snapshotBody(dir, "FG-1"), "v2");
  // Same revision, different content (a relation/evidence-only change publishes at
  // an unchanged max revision) — must still land.
  db.prepare(`UPDATE tickets SET body = 'v2-amended' WHERE ticket_id = 'FG-1'`).run();
  publishSnapshotOnce(KEY, dir);
  assert.equal(snapshotBody(dir, "FG-1"), "v2-amended");
});

// ─── F12: releasing a target must not delete a LIVE mount source ────────────

test("FG-608 F12: an UNKNOWN task never deletes the artifact — it is a live :ro mount source", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-the-store-has-not-seen");
  seed("FG-1", "b");
  assert.equal(existsSync(join(dir, SNAPSHOT_DB_BASENAME)), true);

  const released = releaseFinishedTargets(KEY, () => "unknown");
  assert.deepEqual(released, [], "an unresolvable task is not a finished one");
  assert.equal(liveSnapshotTargets(KEY).length, 1, "and its fan-out continues");
  assert.equal(
    existsSync(join(dir, SNAPSHOT_DB_BASENAME)),
    true,
    "rm -rf on a running container's mount source strands that agent for the rest of its task",
  );
});

test("FG-608 F12: an unknown target AGES OUT — the row is released, the bytes are not deleted", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-orphaned");
  seed("FG-1", "b");

  const released = releaseFinishedTargets(KEY, () => "unknown", Date.now() + UNKNOWN_TARGET_SWEEP_MS + 1000);
  assert.deepEqual(released, [dir], "the sweep bounds unbounded fan-out");
  assert.equal(liveSnapshotTargets(KEY).length, 0);
  assert.equal(existsSync(join(dir, SNAPSHOT_DB_BASENAME)), true, "still not our bytes to delete");
});

test("FG-608 F12: a task known FINISHED releases the row AND reclaims the directory", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-done");
  seed("FG-1", "b");

  assert.deepEqual(releaseFinishedTargets(KEY, () => "finished"), [dir]);
  assert.equal(liveSnapshotTargets(KEY).length, 0);
  assert.equal(existsSync(dir), false, "positive knowledge of the end is what licenses the delete");
});

test("FG-608 F12: releasing a row directly keeps the artifact by default", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-x");
  seed("FG-1", "b");

  releaseSnapshotTarget(KEY, dir);
  assert.equal(liveSnapshotTargets(KEY).length, 0, "the row is released unconditionally");
  assert.equal(existsSync(join(dir, SNAPSHOT_DB_BASENAME)), true);
});

// ─── N2: a released target's stale publication is reclaimed, not warned forever ──

test("FG-608 N2: releasing a stale target stops the warning; a LIVE stale target still warns", () => {
  const parent = newDir();
  const gone = join(parent, "gone");
  const stillRunning = join(parent, "still-running");
  writeFileSync(gone, "a file where the target dir should be — unpublishable");
  writeFileSync(stillRunning, "likewise");
  registerSnapshotTarget(KEY, gone, "task-gone");
  registerSnapshotTarget(KEY, stillRunning, "task-live");

  seed("FG-1", "b");
  assert.deepEqual(
    publicationStates(KEY).filter((p) => p.state === "stale").map((p) => p.targetDir).sort(),
    [gone, stillRunning].sort(),
    "both targets failed to publish and both are surfaced",
  );

  // The container behind `gone` finished. Its publication row describes a container
  // that no longer exists: nothing can act on it, and nothing else will ever clear
  // it, so left in place it warns on EVERY `forge backlog` command forever.
  releaseSnapshotTarget(KEY, gone);

  const remaining = publicationStates(KEY).filter((p) => p.state === "stale");
  assert.deepEqual(remaining.map((p) => p.targetDir), [stillRunning], "only the live target still warns");
  const warning = describeStalePublications(KEY);
  assert.ok(warning, "a genuinely stale LIVE target must still warn — this is not a mute button");
  assert.match(warning!, /still-running/);
  assert.equal(warning!.includes(gone), false, "the retired target is gone from the warning");

  // And when the last live stale target is released too, the warning clears entirely.
  releaseSnapshotTarget(KEY, stillRunning);
  assert.equal(describeStalePublications(KEY), null);
});

test("FG-608 N2: a re-registered target starts from a clean publication record", () => {
  const parent = newDir();
  const dir = join(parent, "target");
  writeFileSync(dir, "unpublishable");
  registerSnapshotTarget(KEY, dir, "task-a");
  seed("FG-1", "b");
  assert.equal(publicationStates(KEY)[0]!.state, "stale");

  releaseSnapshotTarget(KEY, dir);
  // A LATER task legitimately reuses the path. It inherits no verdict from the
  // container that died there.
  registerSnapshotTarget(KEY, dir, "task-b");
  assert.deepEqual(publicationStates(KEY), [], "the reclaimed row does not resurrect with the path");
});

// ─── F13: a bookkeeping failure is not a delivery failure ───────────────────

test("FG-608 F13: a FAILED success-record does not republish, and does not mark a current artifact stale", () => {
  const dir = newDir();
  registerSnapshotTarget(KEY, dir, "task-a");
  seed("FG-1", "delivered");
  assert.equal(snapshotBody(dir, "FG-1"), "delivered");

  // Break ONLY the bookkeeping table. Inside the publish try (the bug), this made a
  // successful publish look like a failed one: the loop republished an artifact that
  // was already current, up to the ceiling, and then marked it STALE.
  db.prepare(`DROP TABLE backlog_snapshot_publications`).run();
  db.prepare(`UPDATE tickets SET body = 'delivered-again' WHERE ticket_id = 'FG-1'`).run();

  assert.doesNotThrow(() => publishToLiveTargets(KEY));
  assert.equal(snapshotBody(dir, "FG-1"), "delivered-again", "the bytes were delivered");

  db.exec(`CREATE TABLE backlog_snapshot_publications (
    project_key TEXT NOT NULL, target_dir TEXT NOT NULL, state TEXT NOT NULL,
    attempts INTEGER NOT NULL, last_ok_at TEXT, last_error TEXT, updated_at TEXT NOT NULL,
    PRIMARY KEY (project_key, target_dir))`);
  assert.deepEqual(
    publicationStates(KEY).filter((p) => p.state === "stale"),
    [],
    "a current artifact was never marked stale by a bookkeeping failure",
  );
});

test("FG-608 F13: a real publish failure still exhausts the bounded retry — WITH backoff between attempts", () => {
  // A FILE where the target directory should be: mkdirSync and the temp write both
  // fail, every attempt, deterministically.
  const parent = newDir();
  const blocked = join(parent, "target");
  writeFileSync(blocked, "not a directory");
  registerSnapshotTarget(KEY, blocked, "task-b");

  const started = Date.now();
  seed("FG-1", "b");
  const elapsed = Date.now() - started;

  const state = publicationStates(KEY).find((p) => p.targetDir === blocked);
  assert.equal(state?.state, "stale", "exhaustion is durable and operator-visible");
  assert.equal(state?.attempts, PUBLISH_MAX_ATTEMPTS);
  // Attempts 1 and 2 back off (1x and 2x); the last failure does not sleep.
  const minimum = PUBLISH_BACKOFF_MS * 3;
  assert.ok(
    elapsed >= minimum,
    `retries must pause between attempts (elapsed ${elapsed}ms, expected >= ${minimum}ms) — three instant ` +
      `retries against the same transiently-busy filesystem are one attempt wearing a bound`,
  );
});
