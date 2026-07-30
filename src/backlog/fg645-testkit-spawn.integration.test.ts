// FG-645: the seam module itself — src/backlog/container-authority.testkit-spawn.ts.
//
// 27 spawn helpers now depend on this one module getting three things right: clear
// the snapshot pointer, repoint the compiled-in probe at an empty directory, and —
// for children launched through bin/forge, which builds its own node argv — deliver
// the preload through NODE_OPTIONS with the tsx loader registered FIRST. Each of
// those is a silent failure inside an agent container and a no-op everywhere else,
// which is precisely why they get asserted here rather than trusted.
//
// The ordering arm is adversarial on purpose: it runs the WRONG order and proves the
// child dies, so "tsx before the TypeScript preload" is recorded as load-bearing
// rather than as a comment.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import { publishSnapshotOnce, SNAPSHOT_DB_BASENAME } from "./snapshot.js";
import {
  AUTHORITY_MARKER_BASENAME,
  CONTAINER_AUTHORITY_MOUNT,
  SNAPSHOT_DIR_ENV,
  writeAuthorityMarker,
} from "./container-authority.js";
import {
  AUTHORITY_TESTKIT_URL,
  authorityTestkitBinEnv,
  authorityTestkitEnv,
  neutralAuthorityMount,
  withAuthorityTestkit,
} from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const BIN_FORGE = resolve(REPO_ROOT, "bin", "forge");
const LOADER_URL = pathToFileURL(resolve(REPO_ROOT, "bin", "forge-loader.mjs")).href;
const READER = resolve(REPO_ROOT, "docker", "forge-backlog-reader.mjs");
const SHIPPED_READER_SUITE = resolve(here, "fg608-shipped-reader.integration.test.ts");

const KEY = "pk-fg645-seam";
const NOW = "2026-07-30T00:00:00Z";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
const dirs: string[] = [];

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

function setupFixture(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const base = join(projectDir, "backlog");
  for (const sub of ["ideas", "epics", "stories", "done"]) mkdirSync(join(base, sub), { recursive: true });
  writeFileSync(
    join(base, "stories", "FG-7-fixture-story.md"),
    "---\nid: FG-7\ntype: story\nstatus: active\ntitle: Fixture story\ncreated: '2026-02-01'\n---\n\nbody\n",
  );
}

/** A published, marked authority holding tickets that are NOT the fixture's. */
function foreignAuthority(dir = newDir("fg645-seam-foreign-")): string {
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    upsertTicket({
      projectKey: KEY, ticketId: "FG-901", type: "story", status: "active",
      title: "a foreign authority's ticket", body: "not the fixture", importedAt: NOW,
    });
  });
  setStorageMode(KEY, "db", NOW);
  publishSnapshotOnce(KEY, dir);
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-foreign" });
  return dir;
}

function ids(stdout: string): string[] {
  return (JSON.parse(stdout) as { id: string }[]).map((t) => t.id).sort();
}

/** The authority an UNSEAMED child resolves. Inside an agent container that is the
 *  COMPILED-IN mount and not the pointer — the marker is probed first and the
 *  environment is never consulted, which is exactly why the seam is a preload. */
function ambientIds(pointed: string): string[] {
  const dir = existsSync(join(CONTAINER_AUTHORITY_MOUNT, AUTHORITY_MARKER_BASENAME))
    ? CONTAINER_AUTHORITY_MOUNT
    : pointed;
  const handle = new Database(join(dir, SNAPSHOT_DB_BASENAME), { readonly: true, fileMustExist: true });
  try {
    return (handle.prepare(`SELECT ticket_id FROM tickets`).all() as { ticket_id: string }[])
      .map((r) => r.ticket_id)
      .sort();
  } finally {
    handle.close();
  }
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = newDir("fg645-seam-proj-");
  setupFixture();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─── env composition ────────────────────────────────────────────────────────

test("integ FG-645: authorityTestkitEnv clears the pointer and aims the probe at an EMPTY unmarked dir", () => {
  const env = authorityTestkitEnv();
  assert.deepEqual(
    Object.keys(env).sort(),
    ["FORGE_TEST_AUTHORITY_MOUNT", SNAPSHOT_DIR_ENV].sort(),
    "both keys are required in a task container; a partial overlay fails only there",
  );
  assert.equal(env[SNAPSHOT_DIR_ENV], "", "the container's fallback pointer must be CLEARED, not left inherited");

  const mount = env["FORGE_TEST_AUTHORITY_MOUNT"]!;
  assert.ok(statSync(mount).isDirectory(), "the mount must EXIST — existsSync on a missing dir is the same 'no marker', by luck");
  assert.deepEqual(readdirSync(mount), [], "and be empty: one stray authority.json would re-arm the gate");
  assert.equal(existsSync(join(mount, AUTHORITY_MARKER_BASENAME)), false);
  assert.notEqual(resolve(mount), resolve(CONTAINER_AUTHORITY_MOUNT), "never the real mount root");
});

test("integ FG-645: the neutral mount is created ONCE per test process, not once per spawn", () => {
  const first = neutralAuthorityMount();
  assert.equal(neutralAuthorityMount(), first);
  assert.equal(authorityTestkitEnv()["FORGE_TEST_AUTHORITY_MOUNT"], first);
  assert.equal(authorityTestkitBinEnv()["FORGE_TEST_AUTHORITY_MOUNT"], first, "the bin overlay shares it");
});

test("integ FG-645: withAuthorityTestkit puts the preload BEFORE the entry point", () => {
  const argv = withAuthorityTestkit("/x/entry.ts", ["backlog", "list", "--json"]);
  assert.deepEqual(argv, ["--import", AUTHORITY_TESTKIT_URL, "/x/entry.ts", "backlog", "list", "--json"]);
  assert.ok(
    argv.indexOf("--import") < argv.indexOf("/x/entry.ts"),
    "an --import after the entry is an argument TO the CLI, not a node flag",
  );

  const preload = fileURLToPath(AUTHORITY_TESTKIT_URL);
  assert.equal(existsSync(preload), true, "the preload the whole sweep names must exist");
  assert.equal(basename(preload), "container-authority.testkit.ts");
});

// ─── the NODE_OPTIONS path (bin/forge builds its own argv) ───────────────────

test("integ FG-645: authorityTestkitBinEnv names the tsx loader BEFORE the testkit and keeps existing NODE_OPTIONS", () => {
  const previous = process.env["NODE_OPTIONS"];
  process.env["NODE_OPTIONS"] = "--max-old-space-size=512";
  try {
    const env = authorityTestkitBinEnv();
    assert.equal(env[SNAPSHOT_DIR_ENV], "", "the bin overlay carries the base seam too");
    const opts = env["NODE_OPTIONS"]!;
    assert.ok(
      opts.startsWith("--max-old-space-size=512 "),
      `an inherited NODE_OPTIONS must be preserved, not clobbered: ${opts}`,
    );
    assert.ok(opts.includes(`--import ${LOADER_URL}`), "the tsx loader must be named");
    assert.ok(opts.includes(`--import ${AUTHORITY_TESTKIT_URL}`), "and the preload");
    assert.ok(
      opts.indexOf(LOADER_URL) < opts.indexOf(AUTHORITY_TESTKIT_URL),
      `tsx must register before a TypeScript preload is parsed: ${opts}`,
    );
    assert.equal(existsSync(fileURLToPath(LOADER_URL)), true);
  } finally {
    if (previous === undefined) delete process.env["NODE_OPTIONS"];
    else process.env["NODE_OPTIONS"] = previous;
  }
});

test("integ FG-645: the loader-before-preload ordering is LOAD-BEARING, not cosmetic", () => {
  const probe = ["-e", "process.exit(0)"];
  const base = { ...process.env, FORGE_TEST_AUTHORITY_MOUNT: "" };

  const shipped = spawnSync(process.execPath, probe, {
    encoding: "utf8",
    env: { ...base, NODE_OPTIONS: `--import ${LOADER_URL} --import ${AUTHORITY_TESTKIT_URL}` },
  });
  assert.equal(shipped.status, 0, `the shipped ordering must load: ${shipped.stderr}`);

  const reversed = spawnSync(process.execPath, probe, {
    encoding: "utf8",
    env: { ...base, NODE_OPTIONS: `--import ${AUTHORITY_TESTKIT_URL} --import ${LOADER_URL}` },
  });
  assert.notEqual(reversed.status, 0, "a TypeScript preload ahead of the tsx loader has nothing to parse it");
  assert.match(reversed.stderr, /ERR_UNKNOWN_FILE_EXTENSION|Unknown file extension|SyntaxError|Cannot find/);
});

test("integ FG-645: bin/forge takes the seam through NODE_OPTIONS — reads answer the FIXTURE", () => {
  const foreign = foreignAuthority();

  const bare = spawnSync(BIN_FORGE, ["backlog", "list", "--json", "--project", projectDir], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, [SNAPSHOT_DIR_ENV]: foreign },
  });
  assert.equal(bare.status, 0, `bin/forge must run: ${bare.stderr}`);
  assert.deepEqual(
    ids(bare.stdout),
    ambientIds(foreign),
    "unseamed, bin/forge answers from whatever authority this process resolves",
  );
  assert.notDeepEqual(ids(bare.stdout), ["FG-7"], "and not from the fixture --project names");

  const seamed = spawnSync(BIN_FORGE, ["backlog", "list", "--json", "--project", projectDir], {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, [SNAPSHOT_DIR_ENV]: foreign, ...authorityTestkitBinEnv() },
  });
  assert.equal(seamed.status, 0, `the seamed bin child must run: ${seamed.stderr}`);
  assert.deepEqual(ids(seamed.stdout), ["FG-7"], "seamed, it answers from THIS fixture");
});

// ─── the shipped reader's COPY seam ─────────────────────────────────────────

// The same patch the shipped-reader suite applies, with its two assertions, so what
// is proved below is that suite's mechanism and not a paraphrase of it.
const MOUNT_LINE = /^const MOUNT = "\/forge-backlog";$/m;

function applySeam(source: string, target: string): string {
  const patched = source.replace(MOUNT_LINE, `const MOUNT = ${JSON.stringify(target)};`);
  assert.notEqual(patched, source, "the shipped reader's compiled-in MOUNT line moved — retarget this seam");
  const sourceLines = source.split("\n");
  const changed = patched.split("\n").filter((l, i) => l !== sourceLines[i]);
  assert.equal(changed.length, 1, "the copy must differ from the shipped reader in exactly one line");
  return patched;
}

test("integ FG-645: the copy seam is still ATTACHED to the shipped reader's real MOUNT declaration", () => {
  const shipped = readFileSync(READER, "utf8");
  const target = join(tmpdir(), "fg645-nowhere");
  const patched = applySeam(shipped, target);
  assert.ok(patched.includes(`const MOUNT = ${JSON.stringify(target)};`));

  // And the suite that owns the seam still carries both guards, so a change there
  // cannot quietly leave the shipped bytes running inside a container.
  const suite = readFileSync(SHIPPED_READER_SUITE, "utf8");
  assert.match(suite, /retarget this seam/, "the anchor guard must stay");
  assert.match(suite, /differ from the shipped reader in exactly one line/, "as must the line-count guard");
});

test("integ FG-645: MUTATE the reader and the seam FAILS LOUDLY rather than running shipped bytes", () => {
  const shipped = readFileSync(READER, "utf8");

  // Reformatted declaration — single quotes. A reader change no one would think of as
  // breaking a test.
  const requoted = shipped.replace(MOUNT_LINE, `const MOUNT = '/forge-backlog';`);
  assert.notEqual(requoted, shipped, "the mutation itself must have landed");
  assert.throws(
    () => applySeam(requoted, join(tmpdir(), "fg645-nowhere")),
    /retarget this seam/,
    "an unanchored MOUNT line must break the seam, not silently skip the redirect",
  );

  // Declaration split across two lines — same value, no single-line match.
  const wrapped = shipped.replace(MOUNT_LINE, `const MOUNT =\n  "/forge-backlog";`);
  assert.throws(
    () => applySeam(wrapped, join(tmpdir(), "fg645-nowhere")),
    /retarget this seam/,
    "a wrapped declaration must break the seam too",
  );
});

test("integ FG-645: in the SHIPPED reader the compiled-in MOUNT OUTRANKS the env pointer", () => {
  // This is what the copy seam exists for, demonstrated on the artifact: patch MOUNT
  // to a marked foreign authority, point the env pointer at a DIFFERENT one, and the
  // compiled-in path is what answers. In a container that foreign authority is the
  // host's real snapshot and the env pointer is the test's own fixture — the silent
  // a2 redirect, exactly.
  const compiledIn = foreignAuthority();
  const viaEnv = newDir("fg645-seam-env-");
  writeTransaction(() => {
    ensureStorageMode("pk-fg645-env", NOW);
    upsertTicket({
      projectKey: "pk-fg645-env", ticketId: "FG-2", type: "story", status: "active",
      title: "the pointed-at authority", body: "b", importedAt: NOW,
    });
  });
  setStorageMode("pk-fg645-env", "db", NOW);
  publishSnapshotOnce("pk-fg645-env", viaEnv);
  writeAuthorityMarker(viaEnv, { mode: "db", projectKey: "pk-fg645-env", taskId: "task-env" });

  const copy = join(newDir("fg645-reader-copy-"), "forge-backlog-reader.mjs");
  writeFileSync(copy, applySeam(readFileSync(READER, "utf8"), compiledIn));

  const res = spawnSync("node", ["--no-warnings", copy, "backlog", "list", "--json"], {
    encoding: "utf8",
    env: { ...process.env, [SNAPSHOT_DIR_ENV]: viaEnv },
  });
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.deepEqual(
    ids(res.stdout),
    ["FG-901"],
    "the compiled-in mount wins — which is why the reader's suite must patch it, not set an env var",
  );
});
