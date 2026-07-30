// FG-645 AC 5: the six strengthened a2 assertions are LOAD-BEARING.
//
// Shape a2 was the dangerous one. A read verb inside an agent container answered from
// the host's mounted snapshot, EXIT 0, and any suite asserting only on exit status —
// or on `match(/FG-10/)`, which every real forge backlog satisfies — went green
// against the wrong store. The sweep replaced six such predicates with fixture-content
// assertions. A strengthened assertion that would ALSO pass under redirection is worth
// nothing, so each arm below runs the same CLI command twice:
//
//   armed      — the seam in place: the post-FG-645 predicate must HOLD.
//   redirected — the child's compiled-in probe aimed at a FOREIGN marked authority:
//                the pre-FG-645 predicate must still hold (the vacuity, reproduced)
//                while the post-FG-645 predicate must FAIL.
//
// TECHNIQUE. The redirect uses the testkit preload with FORGE_TEST_AUTHORITY_MOUNT
// pointed at an authority this suite PUBLISHES, rather than at the ambient
// /forge-backlog. That is the same mechanism the engineer used to re-arm the seam at
// the real container mount, made deterministic: the foreign ids are chosen (they
// OVERLAP the fixture's, the way a real host backlog overlaps any low-numbered
// fixture), so the arms mean the same thing on a host as in a container. The ambient
// mount is exercised too, in the last test, where a container is available.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, writeTransaction } from "../store/db.js";
import { ensureStorageMode, setStorageMode, upsertTicket } from "../store/tickets.js";
import { publishSnapshotOnce } from "./snapshot.js";
import {
  AUTHORITY_MARKER_BASENAME,
  CONTAINER_AUTHORITY_MOUNT,
  SNAPSHOT_DIR_ENV,
  writeAuthorityMarker,
} from "./container-authority.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..", "..");
const entry = resolve(REPO_ROOT, "src", "cli", "index.ts");
const localTsx = resolve(REPO_ROOT, "node_modules", ".bin", "tsx");
const tsx = existsSync(localTsx) ? localTsx : "tsx";

const KEY = "pk-fg645-a2";
const NOW = "2026-07-30T00:00:00Z";

/** The foreign authority's inventory. Chosen so that EVERY pre-FG-645 predicate is
 *  satisfied by it: FG-10/FG-20/FG-30 exist (so `match(/FG-10/)` and `/FG-/` pass),
 *  FG-30 and FG-96 are `done` (so status-only assertions pass), and FG-345 is the
 *  extra ticket that makes any EXACT-SET assertion fail. */
const FOREIGN: { id: string; status: "active" | "done"; title: string }[] = [
  { id: "FG-10", status: "active", title: "host ten" },
  { id: "FG-20", status: "active", title: "host twenty" },
  { id: "FG-30", status: "done", title: "Host thirty, not the fixture's" },
  { id: "FG-96", status: "done", title: "Host ninety-six, not the planted ghost" },
  { id: "FG-345", status: "active", title: "a real host ticket" },
];
const FOREIGN_IDS = FOREIGN.map((t) => t.id).sort();

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let projectDir: string;
let foreign: string;
const dirs: string[] = [];

function newDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** The structured fixture the four strengthened structured.integration tests use. */
function setupStructuredFixture(): void {
  mkdirSync(join(projectDir, ".forge"), { recursive: true });
  writeFileSync(join(projectDir, ".forge", "config.yml"), "backlog:\n  prefix: FG\n");
  const base = join(projectDir, "backlog");
  for (const sub of ["ideas", "epics", "stories", "done"]) mkdirSync(join(base, sub), { recursive: true });
  writeFileSync(
    join(base, "ideas", "FG-10-improve-docs.md"),
    "---\nid: FG-10\ntype: idea\nstatus: active\ntitle: Improve docs\ncreated: '2026-01-01'\n---\n\nWe should improve the documentation.\n",
  );
  writeFileSync(
    join(base, "epics", "FG-20-big-feature.md"),
    "---\nid: FG-20\ntype: epic\nstatus: active\ntitle: Big feature\ncreated: '2026-01-10'\n---\n\nThe big feature epic body.\n",
  );
  writeFileSync(
    join(base, "stories", "FG-30-implement-thing.md"),
    "---\nid: FG-30\ntype: story\nstatus: active\ntitle: Implement thing\ncreated: '2026-02-01'\n---\n\nThe story for implementing the thing.\n",
  );
  writeFileSync(
    join(base, "done", "FG-5-already-done.md"),
    "---\nid: FG-5\ntype: story\nstatus: done\ntitle: Already done\ncreated: '2025-12-01'\nclosed: '2026-01-05'\n---\n\nThis ticket was already completed.\n",
  );
}

/** The ghost the two ghost tests plant: the same id active in stories/ AND done in done/. */
function plantGhost(): void {
  const base = join(projectDir, "backlog");
  writeFileSync(
    join(base, "stories", "FG-96-ghost.md"),
    "---\nid: FG-96\ntype: story\nstatus: active\ntitle: Ghost ticket\ncreated: '2026-03-01'\n---\n\nghost body\n",
  );
  writeFileSync(
    join(base, "done", "FG-96-ghost.md"),
    "---\nid: FG-96\ntype: story\nstatus: done\ntitle: Ghost ticket\ncreated: '2026-03-01'\nclosed: '2026-03-02'\n---\n\nghost body\n",
  );
}

function foreignAuthority(): string {
  writeTransaction(() => {
    ensureStorageMode(KEY, NOW);
    for (const t of FOREIGN) {
      upsertTicket({
        projectKey: KEY, ticketId: t.id, type: "story", status: t.status,
        title: t.title, body: "a host ticket body", importedAt: NOW,
        ...(t.status === "done" ? { closed: NOW } : {}),
      });
    }
  });
  setStorageMode(KEY, "db", NOW);
  const dir = newDir("fg645-a2-foreign-");
  publishSnapshotOnce(KEY, dir);
  writeAuthorityMarker(dir, { mode: "db", projectKey: KEY, taskId: "task-a2-foreign" });
  return dir;
}

type Res = { status: number | null; stdout: string; stderr: string };

/** The seam as the repaired suites arm it: cleared pointer, neutral compiled-in probe. */
function armed(args: string[]): Res {
  const res = spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, ...authorityTestkitEnv() },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/** The same child, its compiled-in probe re-aimed at `mount` — the a2 redirect. */
function redirectedTo(mount: string, args: string[]): Res {
  const res = spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd: projectDir,
    encoding: "utf8",
    env: { ...process.env, [SNAPSHOT_DIR_ENV]: "", FORGE_TEST_AUTHORITY_MOUNT: mount },
  });
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

const redirected = (args: string[]): Res => redirectedTo(foreign, args);

function ids(stdout: string): string[] {
  return (JSON.parse(stdout) as { id: string }[]).map((t) => t.id).sort();
}

function ticket(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout) as Record<string, unknown>;
}

/** Ticket ids present as files on disk, by filename prefix. */
function idsOnDisk(): string[] {
  const base = join(projectDir, "backlog");
  const found = new Set<string>();
  for (const sub of ["ideas", "epics", "stories", "done"]) {
    const d = join(base, sub);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) found.add(f.split("-").slice(0, 2).join("-"));
  }
  return [...found].sort();
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  projectDir = newDir("fg645-a2-proj-");
  setupStructuredFixture();
  foreign = foreignAuthority();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ─── structured.integration.test.ts — 4 strengthened predicates ──────────────

test("integ FG-645 AC5 (1/6): 'list with no filter returns all tickets' — the exact set is load-bearing", () => {
  const ok = armed(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ids(ok.stdout), ["FG-10", "FG-20", "FG-30", "FG-5"], "the FG-645 predicate holds with the seam");

  const bad = redirected(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(bad.status, 0, "the redirect is SILENT — exit zero, which is what made the old form vacuous");
  assert.match(bad.stdout, /FG-10/, "PRE-FG-645 predicate: satisfied by the foreign store");
  assert.match(bad.stdout, /FG-20/, "PRE-FG-645 predicate: satisfied by the foreign store");
  assert.match(bad.stdout, /FG-30/, "PRE-FG-645 predicate: satisfied by the foreign store");
  assert.throws(
    () => assert.deepEqual(ids(bad.stdout), ["FG-10", "FG-20", "FG-30", "FG-5"]),
    /Expected values to be strictly deep-equal/,
    "POST-FG-645 predicate must FAIL under redirection",
  );
  assert.deepEqual(ids(bad.stdout), FOREIGN_IDS, "and what it actually answered with was the foreign inventory");
});

test("integ FG-645 AC5 (2/6): 'show returns done copy for ghost' — the title is load-bearing", () => {
  plantGhost();

  const ok = armed(["backlog", "show", "FG-96", "--json", "--project", projectDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ticket(ok.stdout)["status"], "done");
  assert.equal(ticket(ok.stdout)["title"], "Ghost ticket", "the FG-645 predicate holds with the seam");

  const bad = redirected(["backlog", "show", "FG-96", "--json", "--project", projectDir]);
  assert.equal(bad.status, 0, "the redirect is silent");
  assert.equal(ticket(bad.stdout)["status"], "done", "PRE-FG-645 predicate: still satisfied by a foreign FG-96");
  assert.throws(
    () => assert.equal(ticket(bad.stdout)["title"], "Ghost ticket"),
    /Expected values to be strictly equal/,
    "POST-FG-645 predicate must FAIL under redirection",
  );
});

test("integ FG-645 AC5 (3/6): 'list shows done status for ghost' — the fixture-plus-ghost set is load-bearing", () => {
  plantGhost();

  const ok = armed(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(ok.status, 0, ok.stderr);
  const okGhost = (JSON.parse(ok.stdout) as { id: string; status: string }[]).filter((t) => t.id === "FG-96");
  assert.equal(okGhost.length, 1);
  assert.equal(okGhost[0]!.status, "done");
  assert.deepEqual(ids(ok.stdout), ["FG-10", "FG-20", "FG-30", "FG-5", "FG-96"], "the FG-645 predicate holds");

  const bad = redirected(["backlog", "list", "--json", "--project", projectDir]);
  const badGhost = (JSON.parse(bad.stdout) as { id: string; status: string }[]).filter((t) => t.id === "FG-96");
  assert.equal(badGhost.length, 1, "PRE-FG-645 predicate: the foreign store also has exactly one FG-96");
  assert.equal(badGhost[0]!.status, "done", "PRE-FG-645 predicate: and it is done");
  assert.throws(
    () => assert.deepEqual(ids(bad.stdout), ["FG-10", "FG-20", "FG-30", "FG-5", "FG-96"]),
    /Expected values to be strictly deep-equal/,
    "POST-FG-645 predicate must FAIL under redirection",
  );
});

test("integ FG-645 AC5 (4/6): 'close then show returns done' — both the close status and the title are load-bearing", () => {
  const closed = armed(["backlog", "close", "FG-30", "--project", projectDir]);
  assert.equal(closed.status, 0, closed.stderr);
  const ok = armed(["backlog", "show", "FG-30", "--json", "--project", projectDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(ticket(ok.stdout)["status"], "done");
  assert.equal(ticket(ok.stdout)["title"], "Implement thing", "the FG-645 predicate holds with the seam");

  // Fresh fixture state for the redirected arm: the close above really happened.
  rmSync(join(projectDir, "backlog"), { recursive: true, force: true });
  setupStructuredFixture();

  const refused = redirected(["backlog", "close", "FG-30", "--project", projectDir]);
  assert.notEqual(refused.status, 0, "under redirection the close REFUSES (shape a1) …");
  assert.match(refused.stderr, /refusing `backlog close`/);
  assert.throws(
    () => assert.equal(refused.status, 0),
    /Expected values to be strictly equal/,
    "POST-FG-645 predicate (the close must succeed) must FAIL under redirection",
  );

  const bad = redirected(["backlog", "show", "FG-30", "--json", "--project", projectDir]);
  assert.equal(bad.status, 0, "… while the show still exits zero");
  assert.equal(ticket(bad.stdout)["status"], "done", "PRE-FG-645 predicate: satisfied by a foreign done FG-30");
  assert.throws(
    () => assert.equal(ticket(bad.stdout)["title"], "Implement thing"),
    /Expected values to be strictly equal/,
    "POST-FG-645 predicate must FAIL under redirection",
  );
});

// ─── fg389-legacy-removal.integration.test.ts — 2 strengthened predicates ────

test("integ FG-645 AC5 (5/6): 'list ignores BACKLOG.md' — the exact set is load-bearing", () => {
  // The fg389 fixture shape: only FG-10 and FG-5, plus a legacy BACKLOG.md that would
  // yield different ids if it were read.
  rmSync(join(projectDir, "backlog", "epics", "FG-20-big-feature.md"));
  rmSync(join(projectDir, "backlog", "stories", "FG-30-implement-thing.md"));
  writeFileSync(
    join(projectDir, "BACKLOG.md"),
    "# Backlog\n\n## Active\n\n### #1 first active ticket\n\nbody\n\n### #116 another\n\nbody\n",
  );

  const ok = armed(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ids(ok.stdout), ["FG-10", "FG-5"], "the FG-645 predicate holds with the seam");

  const bad = redirected(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(bad.status, 0);
  assert.match(bad.stdout, /FG-10/, "PRE-FG-645 predicate: an FG-10 exists in the foreign store too");
  assert.doesNotMatch(bad.stdout, /#1\b.*first active ticket/, "PRE-FG-645 predicate: no legacy ids either");
  assert.throws(
    () => assert.deepEqual(ids(bad.stdout), ["FG-10", "FG-5"]),
    /Expected values to be strictly deep-equal/,
    "POST-FG-645 predicate must FAIL under redirection",
  );
});

test("integ FG-645 AC5 (6/6): 'list reports exactly the tickets on disk' — the disk comparison is load-bearing", () => {
  // The predicate the post-migrate test now uses: the listed ids must equal the ticket
  // FILES the project has. Its predecessor, `match(/FG-/)`, is satisfied by literally
  // any forge backlog output.
  const onDisk = idsOnDisk();
  assert.deepEqual(onDisk, ["FG-10", "FG-20", "FG-30", "FG-5"], "the fixture's files");

  const ok = armed(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.deepEqual(ids(ok.stdout), onDisk, "the FG-645 predicate holds with the seam");

  const bad = redirected(["backlog", "list", "--json", "--project", projectDir]);
  assert.equal(bad.status, 0);
  assert.match(bad.stdout, /FG-/, "PRE-FG-645 predicate: satisfied by any backlog anywhere");
  assert.throws(
    () => assert.deepEqual(ids(bad.stdout), onDisk),
    /Expected values to be strictly deep-equal/,
    "POST-FG-645 predicate must FAIL under redirection",
  );
});

// ─── the ambient mount, where there is one ──────────────────────────────────

test("integ FG-645 AC5: re-aimed at the REAL container mount, the strengthened predicate fails there too", () => {
  // The engineer's own technique, run as an assertion. Inside an agent container this
  // is the direct in-container proof: the child answers from the host's dispatched
  // snapshot. On a host there is no marker at that path, so the same child resolves no
  // authority and answers the fixture — which is the equivalence the seam exists to
  // preserve. Both branches assert.
  const res = redirectedTo(CONTAINER_AUTHORITY_MOUNT, ["backlog", "list", "--json", "--project", projectDir]);
  const fixtureIds = ["FG-10", "FG-20", "FG-30", "FG-5"];

  if (existsSync(join(CONTAINER_AUTHORITY_MOUNT, AUTHORITY_MARKER_BASENAME))) {
    assert.equal(res.status, 0, `the redirect answers, silently: ${res.stderr}`);
    assert.match(res.stderr, /store: db snapshot/, "and names the mount it read");
    assert.throws(
      () => assert.deepEqual(ids(res.stdout), fixtureIds),
      /Expected values to be strictly deep-equal/,
      "aimed at this container's real authority, the strengthened predicate must FAIL",
    );
    assert.ok(ids(res.stdout).length > fixtureIds.length, "it answered from a real, larger backlog");
  } else {
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(ids(res.stdout), fixtureIds, "no marker at that path: an ordinary host process, fixture answers");
  }
});
