// FG-608 N1: prepareBacklogSnapshotMount's "NEVER throws" contract, tested at the
// one input that broke it — a marker directory the host cannot write.
//
// The regression: writeAuthorityMarker sat OUTSIDE any try on the markdown and
// unknown branches, so a marker-write failure aborted the whole dispatch. That took
// out markdown-mode projects too, which never had any dependency on this path.
//
// FORGE_HOME is read at module load (util/paths.ts), and backlogSnapshotHostDir is
// derived from it — so this file sets it to a scratch dir BEFORE importing anything
// that reaches paths.ts. Static imports are hoisted and would run first; only
// node builtins may be imported statically here.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forgeHome = mkdtempSync(join(tmpdir(), "fg608-marker-home-"));
const projectDir = mkdtempSync(join(tmpdir(), "fg608-marker-project-"));
process.env.FORGE_HOME = forgeHome;

const { prepareBacklogSnapshotMount, backlogSnapshotHostDir } = await import("./spawn.js");
const { makeInMemoryDb, setDbForTest } = await import("../store/db.js");
const { eventsForTask } = await import("../store/events.js");
const { AUTHORITY_MARKER_BASENAME } = await import("../backlog/container-authority.js");

type Db = ReturnType<typeof makeInMemoryDb>;

let db: Db;
let prev: Db | null;

before(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

after(() => {
  setDbForTest(prev as Db);
  db.close();
  try {
    chmodSync(join(forgeHome, "backlog-snapshots"), 0o755);
  } catch {
    /* already writable or gone */
  }
  rmSync(forgeHome, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

test("FG-608 N1: an unwritable marker directory does NOT abort the dispatch", (t) => {
  const taskId = "task-marker-unwritable";
  // Make the parent of this task's mount source read-only: mkdirSync of the task
  // dir and the marker write both fail, deterministically.
  const snapshotsRoot = join(forgeHome, "backlog-snapshots");
  mkdirSync(snapshotsRoot, { recursive: true });
  chmodSync(snapshotsRoot, 0o555);
  // Root ignores the mode bits, so under a root test runner this input cannot
  // express the failure at all. Say so rather than pass vacuously.
  try {
    mkdirSync(join(snapshotsRoot, ".writability-probe"));
    rmSync(join(snapshotsRoot, ".writability-probe"), { recursive: true, force: true });
    chmodSync(snapshotsRoot, 0o755);
    t.skip("running with write access to a 0555 directory (root) — cannot make the marker write fail");
    return;
  } catch {
    /* unwritable, as required */
  }

  let mount: ReturnType<typeof prepareBacklogSnapshotMount>;
  try {
    // The contract. Throwing here means every dispatch on this host dies —
    // including markdown-mode projects that need no snapshot at all.
    assert.doesNotThrow(() => {
      mount = prepareBacklogSnapshotMount(projectDir, taskId);
    });
  } finally {
    chmodSync(snapshotsRoot, 0o755);
  }

  // The project is markdown-mode (a scratch checkout, no forge.db, no config), so
  // before N1 this was the branch with no try at all around the marker write — a
  // project that needs no snapshot could not be dispatched at all.
  assert.equal(mount!.hostDir, backlogSnapshotHostDir(taskId));
  assert.equal(mount!.projectKey, null);
  // A marker that was not written asserts nothing, so the dispatched authority is
  // `unknown` — never `markdown`, which would claim a marker a container will not
  // find. The container consequently REFUSES backlog reads; that is the fail-safe
  // degradation, and it is still not a fallback to the shared oauth volume.
  assert.equal(mount!.mode, "unknown", "no marker was written, so no authority is claimed");

  // The failure is DURABLE, not just a thrown-away catch: an operator can see why a
  // container came up with no ticket authority.
  assert.ok(mount!.markerError, "the failure is reported to the dispatch path");
  const events = eventsForTask(taskId).filter(
    (e) => e.eventType === "container.backlog_authority_marker_failed",
  );
  assert.equal(events.length, 1, "the marker failure is recorded once, durably");
  const payload = events[0]!.payload as { hostDir: string; error: string; mode: string };
  assert.equal(payload.hostDir, mount!.hostDir);
  assert.equal(payload.mode, "markdown", "the marker it FAILED to write is named, not the degraded result");
  assert.ok(payload.error, "the reason is durable, not a boolean");
});

test("FG-608 N1: a writable marker directory still writes the marker (the trap is not a bypass)", () => {
  const taskId = "task-marker-writable";
  const mount = prepareBacklogSnapshotMount(projectDir, taskId);

  assert.equal(mount.mode, "markdown");
  assert.equal(mount.markerError, undefined);
  assert.deepEqual(readdirSync(mount.hostDir), [AUTHORITY_MARKER_BASENAME]);
  assert.deepEqual(
    eventsForTask(taskId).filter((e) => e.eventType === "container.backlog_authority_marker_failed"),
    [],
  );
});
