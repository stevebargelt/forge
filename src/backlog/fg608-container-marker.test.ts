// FG-608 red F1 + F2: THE AUTHORITY GATE IS NOT THE AGENT'S ENVIRONMENT.
//
// The two findings are one mechanism, so they are tested together:
//
//   F1 — an absent snapshot pointer fell through to the ordinary backlog resolver.
//        Inside a container that resolver reaches /home/agent/.forge/forge.db, the
//        SHARED forge-claude-oauth volume, which already carries a full ticket
//        schema for unrelated projects. The read SUCCEEDS and is wrong.
//   F2 — the only thing making a process "a container" was a non-empty env var that
//        the container itself owns. `unset` walked out of the gate; pointing it at
//        an agent-authored directory walked into a different one.
//
// The fix is a MARKER FILE written by the host into the directory it binds `:ro`,
// resolved from a COMPILED-IN path first. These tests exercise the marker's own
// rules on the host (the compiled-in-path PRECEDENCE, which needs a real mount, is
// asserted in the worktree tier against a real container).

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import { publishSnapshotOnce } from "./snapshot.js";
import {
  assertNoHostStoreInContainer,
  closeContainerAuthorityForTest,
  containerReadTicket,
  containerListTickets,
  hasContainerBacklogAuthority,
  inContainerBacklogMode,
  writeAuthorityMarker,
  AUTHORITY_MARKER_BASENAME,
  CONTAINER_AUTHORITY_MOUNT,
  ContainerAuthorityUnavailable,
  SNAPSHOT_DIR_ENV,
} from "./container-authority.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];
const KEY = "pk-marker";
const OTHER = "pk-someone-else";
const NOW = "2026-07-29T00:00:00Z";

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  delete process.env[SNAPSHOT_DIR_ENV];
});

afterEach(() => {
  closeContainerAuthorityForTest();
  delete process.env[SNAPSHOT_DIR_ENV];
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function newDir(): string {
  const d = mkdtempSync(join(tmpdir(), "fg608-marker-"));
  dirs.push(d);
  return d;
}

function seed(projectKey: string, id: string, body: string): void {
  writeTransaction(() => {
    ensureStorageMode(projectKey, NOW);
    upsertTicket({
      projectKey, ticketId: id, type: "story", status: "active",
      title: `title ${id}`, body, importedAt: NOW,
    });
  });
  setStorageMode(projectKey, "db", NOW);
}

test("FG-608 F1: a db marker with NO published snapshot REFUSES — it never falls back to a resolver", () => {
  const dir = newDir();
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-1" });
  process.env[SNAPSHOT_DIR_ENV] = dir;

  assert.equal(inContainerBacklogMode(), true, "the marker alone establishes container mode");
  assert.equal(hasContainerBacklogAuthority(), true, "and it says the authority is a mounted snapshot");
  assert.throws(
    () => containerReadTicket("FG-1"),
    (e: Error) => e instanceof ContainerAuthorityUnavailable && /does not exist/.test(e.message),
    "no snapshot means REFUSE — answering from anywhere else answers from the shared oauth volume",
  );
  assert.throws(() => containerListTickets(), ContainerAuthorityUnavailable);
});

test("FG-608 F1: under a NON-db marker, a db-mode store resolution is refused rather than opened", () => {
  const dir = newDir();
  writeAuthorityMarker(dir, { mode: "markdown", projectKey: KEY, taskId: "task-1" });
  process.env[SNAPSHOT_DIR_ENV] = dir;

  assert.equal(inContainerBacklogMode(), true);
  assert.equal(hasContainerBacklogAuthority(), false, "no snapshot was dispatched, so no snapshot is read");
  assert.doesNotThrow(
    () => assertNoHostStoreInContainer("markdown"),
    "a markdown dispatch reading the mounted checkout's backlog/*.md is the normal case",
  );
  assert.throws(
    () => assertNoHostStoreInContainer("db"),
    (e: Error) => e instanceof ContainerAuthorityUnavailable && /shared named volume/.test(e.message),
    "the ONLY db store reachable from a container is the shared volume's — refuse it",
  );
});

test("FG-608 F1: on the host (no marker anywhere) nothing is refused", () => {
  assert.equal(inContainerBacklogMode(), false);
  assert.equal(hasContainerBacklogAuthority(), false);
  assert.doesNotThrow(() => assertNoHostStoreInContainer("db"));
});

test("FG-608 F2: the marker path is COMPILED IN — an agent cannot relocate the gate", () => {
  // The env var is the host-side test seam only. The resolver checks this exact
  // absolute path FIRST and, when it finds a marker there, never consults the
  // environment at all — which is what makes `unset` and repointing both inert
  // inside a real container. (The precedence itself is exercised in a real
  // container in the worktree tier; here we pin the constant it depends on.)
  assert.equal(CONTAINER_AUTHORITY_MOUNT, "/forge-backlog");
  assert.equal(AUTHORITY_MARKER_BASENAME, "authority.json");
});

test("FG-608 F2: a snapshot published for ANOTHER project_key is refused, not answered", () => {
  const dir = newDir();
  seed(OTHER, "FG-99", "another project's ticket");
  publishSnapshotOnce(OTHER, dir);
  // The marker records what the HOST dispatched; the artifact is someone else's.
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-1" });
  process.env[SNAPSHOT_DIR_ENV] = dir;

  assert.throws(
    () => containerReadTicket("FG-99"),
    (e: Error) => e instanceof ContainerAuthorityUnavailable && /was published for project_key/.test(e.message),
    "opening is not the same as being this task's authority",
  );
});

test("FG-608 F2: a matching snapshot IS read — the gate is a gate, not a wall", () => {
  const dir = newDir();
  seed(KEY, "FG-1", "mounted body");
  publishSnapshotOnce(KEY, dir);
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-1" });
  process.env[SNAPSHOT_DIR_ENV] = dir;

  assert.equal(containerReadTicket("FG-1").body, "mounted body");
  assert.deepEqual(containerListTickets().map((t) => t.id), ["FG-1"]);
});

test("FG-608 F2: a malformed marker REFUSES — a broken dispatch is not a licence to guess", () => {
  const dir = newDir();
  seed(KEY, "FG-1", "b");
  publishSnapshotOnce(KEY, dir);
  writeFileSync(join(dir, AUTHORITY_MARKER_BASENAME), "{ not json");
  process.env[SNAPSHOT_DIR_ENV] = dir;

  assert.throws(() => containerReadTicket("FG-1"), ContainerAuthorityUnavailable);
});
