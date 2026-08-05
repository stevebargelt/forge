// FG-679 (BD-16): opportunistic terminal promotion, against the REAL launch
// directory on the REAL filesystem.
//
// The architect's objection at the second gate was that "a terminal launch stops
// appearing as in-flight" and "never fabricated as terminal" are jointly satisfiable
// only by leaving hand-run launches permanently `unobserved-since`. That dilemma is
// false, and the evidence is in the wrapper: `buildWrapperCommand` embeds a recorder
// whose LAST act writes the exit record, so the terminal disposition is ALREADY
// durable on disk with no waiter at all. The only missing step is promoting it.
//
// The two halves that must BOTH hold:
//   - an exit record on disk IS promoted, and the launch leaves the in-flight set;
//   - NO exit record on disk leaves the row EXACTLY as it was. Nothing is fabricated,
//     and tmux is never consulted (this suite runs with no tmux server at all).
//
// Crosses the real filesystem → integration tier.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { getLaunchObservation, listOpenLaunchObservations, promoteLaunchObservations, recordLaunchObservation } from "../store/launch-observations.js";
import { LAUNCHES_DIR, statusLine } from "./launch.js";
import { deriveCurrentActivity } from "./current-activity.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const NOW = new Date("2026-08-05T12:00:00.000Z");

beforeEach(() => {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
});

function seed(id: string, exitRecord?: string): void {
  recordLaunchObservation({
    launchId: id,
    name: id,
    command: ["npm", "run", "test:worktree"],
    cwd: "/repos/forge",
    projectDir: "/repos/forge",
    startedAt: "2026-08-05T11:50:00.000Z",
    observedAt: "2026-08-05T11:51:00.000Z",
    status: { state: "running" },
  });
  const dir = join(LAUNCHES_DIR, id);
  mkdirSync(dir, { recursive: true });
  if (exitRecord !== undefined) writeFileSync(join(dir, "exit"), exitRecord);
}

describe("FG-679 BD-16 — opportunistic promotion, no daemon", () => {
  test("a launch whose on-disk exit record is terminal is promoted and STOPS appearing as in-flight", () => {
    seed("launch-done-aaaaaa", JSON.stringify({ code: 0, signal: null }));
    assert.equal(listOpenLaunchObservations().length, 1);

    const promoted = promoteLaunchObservations({ now: NOW });
    assert.equal(promoted, 1);
    assert.equal(listOpenLaunchObservations().length, 0);
    assert.deepEqual(getLaunchObservation("launch-done-aaaaaa")?.status, { state: "exited_ok", code: 0 });
    assert.equal(deriveCurrentActivity(db, { now: NOW }).hostVerification.length, 0);
  });

  test("promotion COPIES the OS-reported record — a SIGTERM stays a SIGTERM and a bare 143 stays unattributed (BD-4 through the promoter)", () => {
    seed("launch-sig-bbbbbb", JSON.stringify({ code: null, signal: "SIGTERM" }));
    seed("launch-143-cccccc", JSON.stringify({ code: 143, signal: null }));
    promoteLaunchObservations({ now: NOW });

    const sig = getLaunchObservation("launch-sig-bbbbbb")!;
    const bare = getLaunchObservation("launch-143-cccccc")!;
    assert.deepEqual(sig.status, { state: "signaled", signal: "SIGTERM", sender: "unrecorded" });
    assert.deepEqual(bare.status, { state: "terminated_unattributed", code: 143 });
    assert.notEqual(statusLine(sig.status), statusLine(bare.status), "exit 143 alone is never proof of a signal");
  });

  test("a launch with NO exit record on disk is left EXACTLY as it was — never promoted, never fabricated", () => {
    seed("launch-live-dddddd");
    const before = getLaunchObservation("launch-live-dddddd")!;

    assert.equal(promoteLaunchObservations({ now: NOW }), 0);

    const after = getLaunchObservation("launch-live-dddddd")!;
    assert.deepEqual(after, before, "the row is byte-for-byte what it was — including observed_at");
    assert.equal(after.terminal, false);
    assert.equal(listOpenLaunchObservations().length, 1);
  });

  test("a launch whose directory does not exist at all is left alone (a reaped record is not a terminal claim)", () => {
    recordLaunchObservation({
      launchId: "launch-gone-eeeeee",
      name: "gone",
      command: ["npm", "test"],
      cwd: "/repos/forge",
      projectDir: "/repos/forge",
      startedAt: "2026-08-05T11:50:00.000Z",
      observedAt: "2026-08-05T11:51:00.000Z",
      status: { state: "running" },
    });
    assert.equal(promoteLaunchObservations({ now: NOW }), 0);
    assert.equal(getLaunchObservation("launch-gone-eeeeee")?.status.state, "running");
  });

  test("a half-written / unreadable exit record is NOT terminal evidence — the row waits for committed bytes (FG-552)", () => {
    seed("launch-torn-ffffff", "{\"code\":");
    assert.equal(promoteLaunchObservations({ now: NOW }), 0);
    assert.equal(getLaunchObservation("launch-torn-ffffff")?.terminal, false);

    // …and once the record is committed, the very next sweep promotes it.
    writeFileSync(join(LAUNCHES_DIR, "launch-torn-ffffff", "exit"), JSON.stringify({ code: 1, signal: null }));
    assert.equal(promoteLaunchObservations({ now: NOW }), 1);
    assert.deepEqual(getLaunchObservation("launch-torn-ffffff")?.status, { state: "exited_error", code: 1 });
  });

  test("a stale unpromotable row renders `unobserved since <t>` rather than being promoted to a terminal it never had", () => {
    recordLaunchObservation({
      launchId: "launch-old-gggggg",
      name: "old",
      command: ["npm", "test"],
      cwd: "/repos/forge",
      projectDir: "/repos/forge",
      startedAt: "2026-08-05T06:00:00.000Z",
      observedAt: "2026-08-05T06:00:00.000Z",
      status: { state: "running" },
    });
    promoteLaunchObservations({ now: NOW });
    const entry = deriveCurrentActivity(db, { now: NOW }).hostVerification[0]!;
    assert.equal(entry.statusLabel, "unobserved since 2026-08-05T06:00:00.000Z");
    assert.equal(entry.observation, "unobserved");
  });

  test("the sweep never throws out of a bad row — one unreadable launch does not stop the rest", () => {
    seed("launch-good-hhhhhh", JSON.stringify({ code: 0, signal: null }));
    // A row whose id could never pass the launchDir charset guard (written directly,
    // as a corrupt/foreign writer might). It must be skipped, not thrown on.
    db.prepare(`INSERT INTO launch_observations (launch_id, name, command, cwd, project_dir, association_kind, started_at, observed_at, state, terminal)
                VALUES ('../escape', NULL, '[]', '/x', NULL, 'none', ?, ?, 'running', 0)`)
      .run("2026-08-05T11:00:00.000Z", "2026-08-05T11:00:00.000Z");

    assert.equal(promoteLaunchObservations({ now: NOW }), 1);
    assert.equal(getLaunchObservation("launch-good-hhhhhh")?.terminal, true);
  });
});
