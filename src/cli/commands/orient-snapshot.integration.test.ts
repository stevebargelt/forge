// FG-588 integration: `forge orient snapshot --json` exercised through the REAL
// CLI subprocess. Proves what the unit tier cannot: commander wiring, a valid JSON
// shape over a real on-disk store, handoff-field extraction from the project's real
// notes.md, stale detection, the bounded/no-bulk contract, and that generation is
// READ-ONLY (it never rewrites the notes it read).
//
// The EXACT active/closed/missing ref resolution is proven at the unit tier
// (snapshot.test.ts): inside an agent container backlog reads resolve against the
// read-only authority mount rather than the test's project dir, so ticket contents
// are not controllable here. Everything asserted below is independent of the
// backlog store's contents; ops is deterministic because it reads the test's own
// isolated (empty) FORGE_HOME store.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";
import { ACTIVE_TICKET_IDS_CAP, type OrientSnapshot } from "../../orient/snapshot.js";
import { NODE_EXEC as tsx, BUILT_CLI_ENTRY as entry } from "../../integration-cli-spawn.js";

let forgeHome: string;
let db: DatabaseInstance;
const tmpDirs: string[] = [];

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg588-home-"));
  db = new Database(join(forgeHome, "forge.db"));
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runForge(args: string[], opts: { cwd?: string } = {}) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true" },
  });
}

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg588-project-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  tmpDirs.push(dir);
  return dir;
}

test("emits a valid, bounded, bulk-free snapshot and extracts bounded handoff fields", () => {
  const dir = makeProjectDir();
  mkdirSync(join(dir, "backlog"), { recursive: true });
  const notesPath = join(dir, "backlog", "notes.md");
  const notes = [
    "**Last session ended 2026-08-21.**",
    "",
    "**Where we left off:** mid-way through the snapshot work.",
    "",
    "**Picked up next:** finish FG-1, revisit FG-3, and check FG-404.",
    "",
    "**Shipped (for reference):** FG-2.",
    "",
  ].join("\n");
  writeFileSync(notesPath, notes);
  const before = readFileSync(notesPath, "utf8");

  const res = runForge(["orient", "snapshot", "--json"], { cwd: dir });
  assert.equal(res.status, 0, `snapshot failed: ${res.stderr}`);
  const snap = JSON.parse(res.stdout) as OrientSnapshot;

  assert.equal(snap.schema, "forge.orient.snapshot");
  assert.equal(snap.version, 1);

  // Handoff extraction — bounded fields, not the whole block. Independent of the
  // backlog store: notes.md is read straight from the project dir.
  assert.equal(snap.handoff.present, true);
  assert.equal(snap.handoff.whereWeLeftOff?.text, "mid-way through the snapshot work.");
  assert.match(snap.handoff.pickedUpNext?.text ?? "", /finish FG-1/);
  assert.ok(!/Shipped/.test(snap.handoff.pickedUpNext?.text ?? ""), "Picked up next bled into the Shipped section");
  assert.equal(snap.handoff.stale, false);

  // The identity set is capped — never an unbounded dump of every active title.
  assert.ok(snap.activeTickets.ids.length <= ACTIVE_TICKET_IDS_CAP);
  assert.equal(typeof snap.activeTickets.count, "number");

  // Ops reads the test's isolated (empty) store — deterministically empty, and the
  // ordinary snapshot carries counts + a bounded identity set only.
  assert.deepEqual(snap.ops, { total: 0, bySeverity: { high: 0, medium: 0, low: 0 }, highestSeverity: [], truncated: false });
  assert.ok(!/"evidence"/.test(res.stdout), "incident evidence leaked into the snapshot");
  assert.ok(!/"recommendedAction"/.test(res.stdout), "recommended-action prose leaked into the snapshot");

  // READ-ONLY: the notes it read are byte-for-byte unchanged.
  assert.equal(readFileSync(notesPath, "utf8"), before, "snapshot rewrote the notes — it must be read-only");
});

test("a handoff with no Picked up next is reported stale, with no referenced tickets", () => {
  const dir = makeProjectDir();
  mkdirSync(join(dir, "backlog"), { recursive: true });
  writeFileSync(join(dir, "backlog", "notes.md"), "**Where we left off:** nothing queued.\n");

  const res = runForge(["orient", "snapshot", "--json"], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  const snap = JSON.parse(res.stdout) as OrientSnapshot;
  assert.equal(snap.handoff.present, true);
  assert.equal(snap.handoff.pickedUpNext, null);
  assert.equal(snap.handoff.stale, true);
  assert.deepEqual(snap.referencedTickets, { count: 0, refs: [], truncated: false });
});

test("no notes at all: a fresh project reports an absent handoff without erroring", () => {
  const dir = makeProjectDir();
  const res = runForge(["orient", "snapshot", "--json"], { cwd: dir });
  assert.equal(res.status, 0, res.stderr);
  const snap = JSON.parse(res.stdout) as OrientSnapshot;
  assert.equal(snap.handoff.present, false);
  assert.equal(snap.handoff.stale, false);
});
