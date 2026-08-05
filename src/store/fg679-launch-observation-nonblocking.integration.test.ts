// FG-679 (BD-12): recording an observation can never REFUSE, DELAY, BLOCK or
// UN-START a launch.
//
// "Cannot refuse" was already proved (an unwritable store leaves the launch running
// and merely unobserved). "Cannot DELAY" is a different property and needs real
// contention to prove: `recordLaunchStart` runs on the launch-RETURN path, after the
// workload is already running, and it takes an IMMEDIATE SQLite transaction against a
// store this host runs several forge processes against (FG-29). Under the writable
// handle's 5-second busy timeout a concurrent writer could hold up `forge launch run`
// returning control — long after the work itself started.
//
// So: a REAL file-backed store, a REAL second connection holding the write lock, and
// the assertion that the record path gives up quickly and reports itself unobserved.
// Two connections to one database file → integration tier.

import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database, { type Database as DatabaseInstance } from "better-sqlite3";
import { closeDb, getDb, setDbForTest } from "./db.js";
import { getLaunchObservation, recordLaunchStart } from "./launch-observations.js";
import type { LaunchMeta } from "../v2/launch.js";

const meta = (id: string): LaunchMeta => ({
  id,
  command: ["npm", "run", "test:worktree"],
  tmuxSession: `forge-${id}`,
  launcherPid: process.pid,
  ownerPid: 4242,
  startedAt: "2026-08-05T12:00:00.000Z",
  logPath: `/tmp/${id}/out.log`,
  cwd: "/tmp",
});

let home: string | null = null;
let priorHome: string | undefined;
let prev: DatabaseInstance | null = null;
let contender: DatabaseInstance | null = null;

afterEach(() => {
  try { contender?.exec("ROLLBACK"); } catch { /* already rolled back */ }
  contender?.close();
  contender = null;
  closeDb();
  if (prev) setDbForTest(prev);
  prev = null;
  if (priorHome === undefined) delete process.env["FORGE_HOME"];
  else process.env["FORGE_HOME"] = priorHome;
  if (home) rmSync(home, { recursive: true, force: true });
  home = null;
});

describe("FG-679 BD-12 — the observation write cannot DELAY the launch-return path", () => {
  test("a store whose write lock is HELD by another connection leaves the launch unobserved in well under the store's 5s busy timeout", () => {
    home = mkdtempSync(join(tmpdir(), "fg679-busy-"));
    priorHome = process.env["FORGE_HOME"];
    process.env["FORGE_HOME"] = home;
    closeDb();
    const db = getDb();
    prev = setDbForTest(db);
    // The host default the launch path must NOT inherit for this write.
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);

    // A second, real connection to the same file, holding the write lock.
    contender = new Database(join(home, "forge.db"));
    contender.pragma("busy_timeout = 0");
    contender.exec("BEGIN IMMEDIATE");

    const started = Date.now();
    const recorded = recordLaunchStart(meta("launch-contended-aaaaaa"), { runId: "run-1" });
    const elapsed = Date.now() - started;

    assert.equal(recorded, false, "the observation could not be written under contention…");
    assert.ok(elapsed < 2000, `…and it did not hold up the launch-return path (waited ${elapsed}ms)`);

    contender.exec("ROLLBACK");
    // The store is intact and its busy timeout is RESTORED — the bound is scoped to
    // this write, not a permanent narrowing for every later caller on this handle.
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);
    assert.equal(getLaunchObservation("launch-contended-aaaaaa"), undefined, "unobserved, not half-written");

    // And once the contention clears, the same call records normally.
    assert.equal(recordLaunchStart(meta("launch-contended-aaaaaa")), true);
    assert.ok(getLaunchObservation("launch-contended-aaaaaa"));
  });
});
