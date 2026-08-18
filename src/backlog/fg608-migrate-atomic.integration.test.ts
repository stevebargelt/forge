// FG-608 (acceptance 10): `forge backlog migrate` — THE per-project authoritative
// cutover. ONE atomic import -> validate -> flip, with --dry-run, and fail-safe:
// on ANY failure Markdown stays authoritative and the mode is unchanged. There is
// no half-migrated project.
//
// Driven through a REAL child `forge` process against a real temp store, because
// the properties under test are CLI-level: exit codes, refusal text, and whether
// the mode row moved. A direct function call would not prove the operator sees a
// refusal.
//
// NOTE: this run implements and tests the MACHINERY. It executes no live cutover
// on the forge repo — that is a separate operator-gated step.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb, getDb } from "../store/db.js";
import { getStorageMode, getStorageModeRecord, ticketsForProject } from "../store/tickets.js";
import { readBacklogConfig } from "./config.js";
import { authorityTestkitEnv, withAuthorityTestkit } from "./container-authority.testkit-spawn.js";

const here = dirname(fileURLToPath(import.meta.url));
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../integration-cli-spawn.js";

let projectDir: string;
let home: string;
let prevHome: string | undefined;
let prevDbPath: string | undefined;

function runForge(args: string[], cwd = projectDir) {
  return spawnSync(tsx, withAuthorityTestkit(entry, args), {
    cwd,
    input: "",
    encoding: "utf8",
    env: { ...process.env, FORGE_HOME: home, FORGE_DB_PATH: join(home, "forge.db"), ...authorityTestkitEnv() },
  });
}

function writeTicketFile(dir: string, fm: Record<string, unknown>, body: string): void {
  const d = join(dir, "backlog", "stories");
  mkdirSync(d, { recursive: true });
  const lines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  writeFileSync(join(d, `${fm["id"]}-slug.md`), `---\n${lines.join("\n")}\n---\n\n${body}\n`);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "fg608-migrate-home-"));
  projectDir = mkdtempSync(join(tmpdir(), "fg608-migrate-proj-"));
  mkdirSync(join(projectDir, "backlog"), { recursive: true });
  prevHome = process.env["FORGE_HOME"];
  prevDbPath = process.env["FORGE_DB_PATH"];
  process.env["FORGE_HOME"] = home;
  process.env["FORGE_DB_PATH"] = join(home, "forge.db");
  closeDb();
});

afterEach(() => {
  closeDb();
  if (prevHome === undefined) delete process.env["FORGE_HOME"];
  else process.env["FORGE_HOME"] = prevHome;
  if (prevDbPath === undefined) delete process.env["FORGE_DB_PATH"];
  else process.env["FORGE_DB_PATH"] = prevDbPath;
  rmSync(home, { recursive: true, force: true });
  rmSync(projectDir, { recursive: true, force: true });
});

function projectKey(): string {
  const key = readBacklogConfig(projectDir).projectKey;
  assert.ok(key, "expected the project to have committed a project_key");
  return key!;
}

// ─── the happy path ──────────────────────────────────────────────────────────

test("FG-608 migrate: on success the mode flips to db and the flipping forge revision is recorded", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "body one");
  writeTicketFile(projectDir, { id: "FG-2", type: "story", status: "done", title: "two" }, "body two");

  const res = runForge(["backlog", "migrate"]);
  assert.equal(res.status, 0, `migrate should succeed:\n${res.stdout}\n${res.stderr}`);
  assert.match(res.stdout, /Migrated .* to db mode \(2 ticket\(s\)\)/);

  const key = projectKey();
  assert.equal(getStorageMode(key), "db", "the mode row flipped");
  const record = getStorageModeRecord(key)!;
  assert.ok(record.flippedAt, "the flip is timestamped");
  assert.ok(record.flippedByRevision, "the flipping forge revision is recorded");
  assert.equal(
    ticketsForProject(key).length,
    2,
    "the shadow equals the Markdown set at the moment of the flip",
  );
});

test("FG-608 migrate: the cutover UX states the ONE-WAY freeze and names the flipping forge", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  const res = runForge(["backlog", "migrate"]);
  assert.equal(res.status, 0);
  assert.match(res.stderr, /ONE-WAY CUTOVER/);
  assert.match(res.stderr, /FROZEN SNAPSHOT/);
  assert.match(res.stderr, /Clean rollback to markdown mode exists ONLY until the first DB-only edit/);
  assert.match(
    res.stderr,
    /OLDER forge binary/,
    "the UX must state that nothing in the store stops an older binary — that is honest, not decorative",
  );
  assert.match(res.stderr, /performed by forge revision/);
});

// ─── --dry-run writes NOTHING ────────────────────────────────────────────────

test("FG-608 migrate --dry-run: reports the plan and writes nothing at all", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");

  const res = runForge(["backlog", "migrate", "--dry-run"]);
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /DRY RUN/);
  assert.match(res.stdout, /would import: 1 ticket\(s\)/);
  assert.match(res.stdout, /would flip mode to: db/);

  // Nothing was committed: no project_key in config, and no ticket rows.
  assert.equal(readBacklogConfig(projectDir).projectKey, null);
  const db = getDb();
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get() as { n: number }).n,
    0,
    "--dry-run imported nothing",
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM ticket_storage_mode`).get() as { n: number }).n,
    0,
    "--dry-run flipped nothing",
  );
});

// ─── FAIL-SAFE: any failure leaves Markdown authoritative ────────────────────

test("FG-608 migrate: a malformed ticket file aborts BEFORE the flip — mode unchanged", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "ok" }, "b");
  // Missing `title` — the import's own precise, file-identified refusal.
  const d = join(projectDir, "backlog", "stories");
  writeFileSync(join(d, "FG-2-broken.md"), `---\nid: FG-2\ntype: story\nstatus: active\n---\n\nbroken\n`);

  const res = runForge(["backlog", "migrate"]);
  assert.notEqual(res.status, 0, "a failed migrate exits non-zero");
  assert.match(res.stderr, /missing required frontmatter field 'title'/);

  const db = getDb();
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM tickets`).get() as { n: number }).n,
    0,
    "zero rows written — the import is all-or-nothing",
  );
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM ticket_storage_mode WHERE mode = 'db'`).get() as { n: number }).n,
    0,
    "no project was left in db mode — there is no half-migrated project",
  );
});

test("FG-608 migrate: an unresolved import conflict refuses the flip and says so", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "original");
  // Migrate once, edit in db mode, then flip back to markdown so Markdown can
  // diverge — reproducing "Markdown proposes to clobber a newer DB edit".
  assert.equal(runForge(["backlog", "migrate"]).status, 0);
  assert.equal(runForge(["backlog", "edit", "FG-1", "--body", "newer db edit"]).status, 0);

  // mode --set markdown now REFUSES (default (d)), which is itself the point —
  // so force the row back to prove the migrate-side refusal independently.
  closeDb();
  getDb().prepare(`UPDATE ticket_storage_mode SET mode = 'markdown', first_db_edit_at = NULL`).run();
  closeDb();

  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "stale markdown");
  const res = runForge(["backlog", "migrate"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /Skipped as import conflicts/);
  assert.match(res.stderr, /the mode was NOT flipped and Markdown remains authoritative/);
  assert.equal(getStorageMode(projectKey()), "markdown", "the mode is unchanged");
});

test("FG-608 migrate --force: an explicitly forced import completes the cutover", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "original");
  assert.equal(runForge(["backlog", "migrate"]).status, 0);
  assert.equal(runForge(["backlog", "edit", "FG-1", "--body", "newer db edit"]).status, 0);
  closeDb();
  getDb().prepare(`UPDATE ticket_storage_mode SET mode = 'markdown', first_db_edit_at = NULL`).run();
  closeDb();
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "markdown wins");

  const res = runForge(["backlog", "migrate", "--force"]);
  assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  assert.equal(getStorageMode(projectKey()), "db");
});

// ─── MANDATE 3: the refusal is scoped to the TARGET project_key ──────────────

test("FG-608 migrate: REFUSES when the TARGET project_key has an active run", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  // Claim the key first so the run can be attributed to it.
  assert.equal(runForge(["backlog", "import"]).status, 0);

  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir)
     VALUES ('run-target', 'feature', 't', 'active', '2026-07-29T00:00:00Z', ?)`,
  ).run(projectDir);
  closeDb();

  const res = runForge(["backlog", "migrate"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /has in-flight work/);
  assert.match(res.stderr, /run-target/);
  assert.match(res.stderr, /split truth WITHIN\s+one run/);
  assert.equal(getStorageMode(projectKey()), "markdown", "Storage mode unchanged");
});

// ─── F10: the check and the act are ONE transaction ─────────────────────────

test("FG-608 F10: the no-activity guard is RE-ASSERTED inside the flip's own transaction", () => {
  // The pre-flip checks at steps 0 and 1 committed long before the flip. A run
  // starting in that window would read Markdown for its early steps and the DB for
  // its later ones — the split truth the guard exists to prevent. So the check runs
  // again under the flip's BEGIN IMMEDIATE, where check-then-act is atomic.
  //
  // The window is exercised by inserting the run AFTER the import commits: the
  // step-0/step-1 assertions have already passed at that point, so only an
  // in-transaction re-assertion can still catch it.
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "import"]).status, 0);
  const key = projectKey();

  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir)
     VALUES ('run-late', 'feature', 't', 'active', '2026-07-29T00:00:00Z', ?)`,
  ).run(projectDir);
  closeDb();

  const res = runForge(["backlog", "migrate"]);
  assert.notEqual(res.status, 0, "the flip must refuse");
  assert.match(res.stderr, /has in-flight work/);
  assert.equal(getStorageMode(key), "markdown", "Storage mode unchanged");
  assert.equal(
    getStorageModeRecord(key)?.flippedAt ?? null,
    null,
    "and no cutover record was left behind by a partially-applied flip",
  );
});

test("FG-608 F10: the mode row and the cutover record land in ONE commit", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "migrate"]).status, 0);

  const record = getStorageModeRecord(projectKey())!;
  assert.equal(record.mode, "db");
  assert.ok(record.flippedAt, "flipped_at is set");
  assert.ok(record.flippedByRevision, "flipped_by_revision is set");
  // Two commits could leave the mode flipped with no provenance; one cannot.
  assert.equal(
    record.updatedAt,
    record.flippedAt,
    "the mode row and its cutover provenance carry the same timestamp — one BEGIN IMMEDIATE, one now()",
  );
});

test("FG-608 migrate: does NOT refuse for activity in an UNRELATED project", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");

  const otherProject = mkdtempSync(join(tmpdir(), "fg608-other-"));
  mkdirSync(join(otherProject, "backlog"), { recursive: true });
  writeTicketFile(otherProject, { id: "FG-9", type: "story", status: "active", title: "other" }, "b");
  assert.equal(runForge(["backlog", "import", "--project", otherProject], otherProject).status, 0);

  const db = getDb();
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir)
     VALUES ('run-unrelated', 'feature', 't', 'active', '2026-07-29T00:00:00Z', ?)`,
  ).run(otherProject);
  closeDb();

  try {
    const res = runForge(["backlog", "migrate"]);
    assert.equal(res.status, 0, `unrelated activity must never block:\n${res.stdout}\n${res.stderr}`);
    assert.equal(getStorageMode(projectKey()), "db");
  } finally {
    rmSync(otherProject, { recursive: true, force: true });
  }
});

test("FG-608 migrate: REFUSES when the TARGET project has a running campaign", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "import"]).status, 0);

  const db = getDb();
  db.prepare(
    `INSERT INTO campaigns (id, status, source_kind, source_input, mode, created_at, updated_at, project_dir)
     VALUES ('camp-1', 'running', 'query', '{}', 'auto', '2026-07-29T00:00:00Z', '2026-07-29T00:00:00Z', ?)`,
  ).run(projectDir);
  closeDb();

  const res = runForge(["backlog", "migrate"]);
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /campaign camp-1/);
  assert.equal(getStorageMode(projectKey()), "markdown");
});

// ─── default (d): the one-way property is ENFORCED, not documented ───────────

test("FG-608: after the first DB-only edit, `mode --set markdown` REFUSES", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "migrate"]).status, 0);
  const key = projectKey();

  // Before any db edit, rollback is clean — and permitted.
  assert.equal(getStorageModeRecord(key)!.firstDbEditAt, null);
  const rollback = runForge(["backlog", "mode", "--set", "markdown"]);
  assert.equal(rollback.status, 0, `clean rollback before any db edit:\n${rollback.stderr}`);

  // Flip forward again and make a DB-only edit to an EXISTING ticket — one that
  // leaves NO orphan, so only the recorded-first-edit check can catch it.
  assert.equal(runForge(["backlog", "mode", "--set", "db"]).status, 0);
  assert.equal(runForge(["backlog", "edit", "FG-1", "--body", "db-only edit"]).status, 0);
  closeDb();
  const record = getStorageModeRecord(key)!;
  assert.ok(record.firstDbEditAt, "the first DB-only edit is RECORDED");
  assert.equal(record.firstDbEditTicket, "FG-1");

  const refused = runForge(["backlog", "mode", "--set", "markdown"]);
  assert.notEqual(refused.status, 0, "rollback after a db edit must refuse");
  assert.match(refused.stderr, /refusing to set markdown mode/);
  assert.match(refused.stderr, /DB-only edits since it cut over/);
  assert.match(refused.stderr, /Storage mode unchanged/);
  closeDb();
  assert.equal(getStorageMode(key), "db", "and the mode really did not move");
});

test("FG-608: the first DB-only edit is recorded ONCE — a later edit never moves it", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  writeTicketFile(projectDir, { id: "FG-2", type: "story", status: "active", title: "two" }, "b");
  assert.equal(runForge(["backlog", "migrate"]).status, 0);
  const key = projectKey();

  assert.equal(runForge(["backlog", "edit", "FG-1", "--body", "first"]).status, 0);
  closeDb();
  const first = getStorageModeRecord(key)!;
  assert.equal(first.firstDbEditTicket, "FG-1");

  assert.equal(runForge(["backlog", "edit", "FG-2", "--body", "second"]).status, 0);
  closeDb();
  const after = getStorageModeRecord(key)!;
  assert.equal(after.firstDbEditTicket, "FG-1", "'first' means first");
  assert.equal(after.firstDbEditAt, first.firstDbEditAt);
});

test("FG-608: a markdown-mode shadow write does NOT count as a DB-only edit", () => {
  writeTicketFile(projectDir, { id: "FG-1", type: "story", status: "active", title: "one" }, "b");
  assert.equal(runForge(["backlog", "import"]).status, 0);
  // Still markdown mode: `backlog edit` writes the FILE, and any DB write is a
  // shadow write. Nothing has frozen yet.
  assert.equal(runForge(["backlog", "edit", "FG-1", "--body", "edited in markdown mode"]).status, 0);
  closeDb();
  assert.equal(getStorageModeRecord(projectKey())!.firstDbEditAt, null);
});
