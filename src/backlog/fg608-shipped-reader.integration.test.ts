// FG-608 red F3: the SHIPPED reader — docker/forge-backlog-reader.mjs — executed
// as the artifact it is.
//
// The container tests that run it inside a real container skip when no daemon is
// reachable, and a surface that is only ever exercised behind a skip is how this
// finding happened in the first place. This file runs the EXACT file the image
// COPYs and buildDockerArgs binds, as a child `node` process, against a real
// published snapshot — no docker, no /forge-src, no TypeScript.
//
// It cannot assert the `:ro` mount (that is the kernel's half, and it needs a
// container), and it does not try to: what it proves is that the shipped file
// reads, refuses, and reports as claimed.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import { publishSnapshotOnce } from "./snapshot.js";
import {
  writeAuthorityMarker,
  AUTHORITY_MARKER_BASENAME,
  DISPATCHED_TICKET_ENV,
  SNAPSHOT_DIR_ENV,
} from "./container-authority.js";

const here = dirname(fileURLToPath(import.meta.url));
const READER = resolve(here, "..", "..", "docker", "forge-backlog-reader.mjs");
const BIN = resolve(here, "..", "..", "docker", "forge-backlog-bin.sh");

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const dirs: string[] = [];
const KEY = "pk-shipped-reader";
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
  const d = mkdtempSync(join(tmpdir(), "fg608-reader-"));
  dirs.push(d);
  return d;
}

function seed(id: string, body: string, title = "readable"): void {
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    upsertTicket({
      projectKey: KEY, ticketId: id, type: "story", status: "active",
      title, body, importedAt: NOW,
    });
  });
  setStorageMode(KEY, "db", NOW);
}

// FG-645: the reader's mount root is a COMPILED-IN CONSTANT with no runtime seam,
// deliberately — this file is the entire forge surface a container has, and a
// preload- or env-reachable override on it would be one NODE_OPTIONS away from the
// agent, i.e. exactly the F2 bypass the constant exists to prevent. src/backlog's
// TypeScript equivalent can afford setAuthorityMountForTest; this cannot.
//
// So the seam is applied to a COPY instead, and the only edit is that one line —
// asserted below, so the shipped bytes remain what every other line of this suite
// exercises. Inside an agent container the original would resolve THAT container's
// /forge-backlog marker and answer every test from the host's snapshot, silently
// and with exit 0.
const REDIRECTED_READER_MOUNT = join(tmpdir(), "forge-shipped-reader-no-mount");

function redirectedReader(): string {
  const shipped = readFileSync(READER, "utf8");
  const patched = shipped.replace(
    /^const MOUNT = "\/forge-backlog";$/m,
    `const MOUNT = ${JSON.stringify(REDIRECTED_READER_MOUNT)};`,
  );
  assert.notEqual(patched, shipped, "the shipped reader's compiled-in MOUNT line moved — retarget this seam");
  const shippedLines = shipped.split("\n");
  const changed = patched.split("\n").filter((l, i) => l !== shippedLines[i]);
  assert.equal(changed.length, 1, "the copy must differ from the shipped reader in exactly one line");
  const copy = join(newDir(), "forge-backlog-reader.mjs");
  writeFileSync(copy, patched);
  return copy;
}

function runReader(args: string[], env: Record<string, string> = {}) {
  return spawnSync("node", ["--no-warnings", redirectedReader(), ...args], {
    encoding: "utf8",
    env: { ...process.env, [SNAPSHOT_DIR_ENV]: "", ...env },
  });
}

/** A published, marked authority directory — what spawn.ts binds `:ro`. */
function authorityDir(mode: "db" | "markdown" | "unknown" = "db", projectKey: string | null = KEY): string {
  const dir = newDir();
  if (mode === "db") publishSnapshotOnce(KEY, dir);
  writeAuthorityMarker(dir, { mode, projectKey, taskId: "task-reader" });
  return dir;
}

test("FG-608 F3: the shipped reader ships — both files exist where the image COPYs from", () => {
  assert.equal(existsSync(READER), true, "docker/forge-backlog-reader.mjs is the mounted + COPYd reader");
  assert.equal(existsSync(BIN), true, "docker/forge-backlog-bin.sh is `forge` on the container's PATH");
});

test("FG-608 F3: `backlog show` reads the mounted snapshot with no forge source present", () => {
  seed("FG-1", "MOUNTED-BODY");
  const dir = authorityDir();

  const res = runReader(["backlog", "show", "FG-1"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /MOUNTED-BODY/);
  assert.match(res.stdout, /revision 1/);
  assert.match(res.stderr, /store: db snapshot \(project_key=pk-shipped-reader/, "the store banner names the MOUNT");
});

test("FG-608 F3: `backlog list --json` emits machine-clean stdout", () => {
  seed("FG-1", "one");
  seed("FG-2", "two", "second");
  const dir = authorityDir();

  const res = runReader(["backlog", "list", "--json"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.equal(res.status, 0, res.stderr);
  assert.deepEqual(
    (JSON.parse(res.stdout) as { id: string }[]).map((t) => t.id),
    ["FG-1", "FG-2"],
    "the banner stays on stderr so --json stays pipeable",
  );
});

test("FG-608 F3: the reader surfaces revision DRIFT — both records, neither overwriting the other", () => {
  seed("FG-1", "v1");
  const dispatched = db
    .prepare(`SELECT revision, body_hash FROM tickets WHERE ticket_id = 'FG-1'`)
    .get() as { revision: number; body_hash: string };
  seed("FG-1", "v2-amended");
  const dir = authorityDir();

  const res = runReader(["backlog", "show", "FG-1"], {
    [SNAPSHOT_DIR_ENV]: dir,
    [DISPATCHED_TICKET_ENV]: `FG-1:${dispatched.revision}:${dispatched.body_hash}`,
  });
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /v2-amended/, "the current authority");
  assert.match(res.stderr, /dispatched revision 1/);
  assert.match(res.stderr, /current revision 2/);
});

test("FG-608 F1: a db marker with NO snapshot refuses — non-zero, and names the reason", () => {
  const dir = newDir();
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-reader" });

  const res = runReader(["backlog", "show", "FG-1"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /refusing to read the backlog/);
  assert.match(res.stderr, /does not exist/);
  assert.equal(res.stdout.trim(), "", "a refusal writes nothing to stdout");
});

test("FG-608 F2: a snapshot for another project_key is refused by the SHIPPED reader too", () => {
  seed("FG-1", "mine");
  const dir = authorityDir("db", "pk-a-different-project");

  const res = runReader(["backlog", "show", "FG-1"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /was published for project_key/);
});

test("FG-608 F2: a malformed marker refuses rather than falling through", () => {
  seed("FG-1", "mine");
  const dir = authorityDir();
  writeFileSync(join(dir, AUTHORITY_MARKER_BASENAME), "not json at all");

  const res = runReader(["backlog", "show", "FG-1"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /not readable JSON|not a forge authority marker/);
});

test("FG-608: every mutating verb refuses in the shipped reader, non-zero, no local write", () => {
  seed("FG-1", "mine");
  const dir = authorityDir();

  for (const args of [
    ["backlog", "file", "new ticket"],
    ["backlog", "edit", "FG-1", "--body", "x"],
    ["backlog", "close", "FG-1"],
    ["backlog", "move", "FG-1", "epic"],
    ["backlog", "retitle", "FG-1", "x"],
    ["backlog", "import"],
    ["backlog", "mode", "--set", "markdown"],
  ]) {
    const res = runReader(args, { [SNAPSHOT_DIR_ENV]: dir });
    assert.notEqual(res.status, 0, `${args.join(" ")} must exit non-zero`);
    assert.match(res.stderr, /refusing/, `${args.join(" ")} must refuse EXPLICITLY, not silently no-op`);
    assert.match(res.stderr, /READ-ONLY mounted|host/, `${args.join(" ")} must say where writes happen`);
  }
});

test("FG-608: a markdown-mode dispatch is told where its tickets are, not answered from a store", () => {
  const dir = authorityDir("markdown", KEY);
  const res = runReader(["backlog", "show", "FG-1"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /has not cut over/);
  assert.match(res.stderr, /\/project\/backlog/, "the operator-facing answer points at the mounted checkout");
});

test("FG-608: the reader is honest about being a READER — other forge commands are not faked", () => {
  const dir = authorityDir();
  const res = runReader(["status"], { [SNAPSHOT_DIR_ENV]: dir });
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /backlog READER only/);
});
