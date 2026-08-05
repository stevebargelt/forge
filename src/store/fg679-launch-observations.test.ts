// FG-679 (BD-12/BD-2/BD-4): the durable launch-observation store.
//
// The load-bearing property here is that the STATUS VOCABULARY SURVIVES THE ROUND
// TRIP as four distinct facts. A store that flattened `signaled` and
// `terminated_unattributed` into one column, or that lost the signal name, would
// make BD-4 unenforceable on every downstream surface no matter how carefully the
// renderer was written.
//
// Real store code against a real in-memory SQLite DB (makeInMemoryDb) — never
// ~/.forge/forge.db.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "./db.js";
import {
  LAUNCH_OBSERVATION_STATES,
  associationKindFor,
  decodeLaunchStatus,
  encodeLaunchStatus,
  getLaunchObservation,
  isTerminalObservationState,
  listLaunchObservations,
  listOpenLaunchObservations,
  recordLaunchObservation,
  resolveRegisteredProjectDir,
  updateLaunchObservationStatus,
} from "./launch-observations.js";
import { isTerminalStatus, statusLine, type LaunchStatus } from "../v2/launch.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

/** One instance of every state in the canonical vocabulary. */
const EVERY_STATUS: LaunchStatus[] = [
  { state: "running" },
  { state: "exited_ok", code: 0 },
  { state: "exited_error", code: 1 },
  { state: "signaled", signal: "SIGTERM", sender: "unrecorded" },
  { state: "terminated_unattributed", code: 143 },
  { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" },
  { state: "unknown" },
];

describe("FG-679 launch_observations — the status codec", () => {
  test("every canonical LaunchStatus round-trips through the columns unchanged", () => {
    for (const status of EVERY_STATUS) {
      const cols = encodeLaunchStatus(status);
      assert.deepEqual(decodeLaunchStatus(cols.state, cols.exitCode, cols.signal), status, `round trip for ${status.state}`);
    }
  });

  test("the round trip preserves FOUR DISTINCT statusLine renderings — no state collapses into another (BD-4)", () => {
    const four: LaunchStatus[] = [
      { state: "signaled", signal: "SIGTERM", sender: "unrecorded" },
      { state: "terminated_unattributed", code: 143 },
      { state: "owner_gone", cause: "unrecorded", sender: "unrecorded" },
      { state: "unknown" },
    ];
    const rendered = four.map((s) => {
      const c = encodeLaunchStatus(s);
      return statusLine(decodeLaunchStatus(c.state, c.exitCode, c.signal));
    });
    assert.equal(new Set(rendered).size, 4, `four distinct renderings, got: ${JSON.stringify(rendered)}`);
    // None of the four is a generic `failed` STATUS. (owner_gone's own sentence
    // contains the word "failed" inside the clause "or failed before recording",
    // which is the honest indeterminacy it exists to state — the prohibition is on
    // the STATUS collapsing to a generic failure, not on the word appearing in an
    // explanation.)
    for (const line of rendered) {
      assert.notEqual(line.trim().toLowerCase(), "failed", `a status must never render as a bare generic failure: ${line}`);
      assert.doesNotMatch(line, /^\s*failed\b/i, `a status must never LEAD with a generic failure verdict: ${line}`);
    }
    // And the exact bytes, so a later "tidy-up" of statusLine reddens here.
    assert.deepEqual(rendered, [
      "terminated by SIGTERM (signal sender not recorded — origin unknown)",
      "exited 143 (signal-range code, no signal evidence — origin unknown)",
      "owner gone without an exit record (wrapper killed, or failed before recording — cause and sender not recorded)",
      "unknown (no exit record, owner gone — e.g. host reboot)",
    ]);
  });

  test("terminality agrees with the ONE canonical classifier for every state (no second vocabulary)", () => {
    for (const status of EVERY_STATUS) {
      assert.equal(
        isTerminalObservationState(status.state),
        isTerminalStatus(status),
        `terminality for ${status.state} must match src/v2/launch.ts's isTerminalStatus`,
      );
    }
    assert.deepEqual([...LAUNCH_OBSERVATION_STATES].sort(), EVERY_STATUS.map((s) => s.state).sort());
  });

  test("a state outside the vocabulary decodes to `unknown` — never a fabricated `running` and never a terminal claim", () => {
    assert.deepEqual(decodeLaunchStatus("a_state_from_a_newer_binary", null, null), { state: "unknown" });
    // A `signaled` row with no signal name is not evidence of a signal.
    assert.deepEqual(decodeLaunchStatus("signaled", null, null), { state: "unknown" });
    // A signal-range claim with no code is not evidence of a code.
    assert.deepEqual(decodeLaunchStatus("terminated_unattributed", null, null), { state: "unknown" });
  });
});

describe("FG-679 launch_observations — placement authority (BD-2/BD-3/BD-14)", () => {
  test("explicit submission metadata is the only thing that yields `explicit`", () => {
    // The published submission vocabulary (invariant 22): --run / --task / --ticket.
    assert.equal(associationKindFor({ runId: "run-abc" }, null), "explicit");
    assert.equal(associationKindFor({ taskId: "task-plan-51d71e" }, null), "explicit");
    assert.equal(associationKindFor({ ticketId: "FG-679" }, null), "explicit");
    assert.equal(associationKindFor(undefined, "/repos/forge"), "cwd");
    assert.equal(associationKindFor({}, "/repos/forge"), "cwd");
    assert.equal(associationKindFor(undefined, null), "none");
    assert.equal(associationKindFor({}, null), "none");
  });

  test("campaign/item identity is PROVENANCE, not placement authority — it never renders a run-less launch as associated", () => {
    // The campaign drive-item launcher records campaign + item precisely BECAUSE no
    // run exists yet, and documents that such a launch is labeled `unassociated`.
    // Classifying that identity as `explicit` contradicted the launcher's own record.
    assert.equal(associationKindFor({ campaignId: "camp-1", itemId: "item-1" }, "/repos/forge"), "cwd");
    assert.equal(associationKindFor({ campaignId: "camp-1", itemId: "item-1" }, null), "none");
    // …and it is still RECORDED in full: provenance demoted, not discarded.
    recordLaunchObservation({
      launchId: "launch-campaign-drive-item1-aaaaaa",
      name: "campaign-drive-item-1",
      command: ["forge", "campaign", "drive-item", "camp-1", "item-1"],
      cwd: "/repos/forge",
      projectDir: "/repos/forge",
      association: { campaignId: "camp-1", itemId: "item-1" },
      startedAt: "2026-08-05T10:00:00.000Z",
      observedAt: "2026-08-05T10:00:00.000Z",
      status: { state: "running" },
    });
    const obs = getLaunchObservation("launch-campaign-drive-item1-aaaaaa");
    assert.ok(obs);
    assert.equal(obs.associationKind, "cwd");
    assert.equal(obs.campaignId, "camp-1");
    assert.equal(obs.itemId, "item-1");
    assert.equal(obs.runId, null, "no run was ever declared, and none is manufactured");
  });

  test("a launch recorded with NO association keeps run_id null even when its name and argv are full of ids (BD-15)", () => {
    recordLaunchObservation({
      launchId: "launch-run-abc123-fg679-plan-aaaaaa",
      name: "launch-run-abc123-fg679-plan",
      command: ["npm", "run", "test:worktree", "--", "run-abc123", "task-plan-51d71e"],
      cwd: "/home/op/.forge/worktrees/run-abc123/task-plan-51d71e",
      projectDir: null,
      startedAt: "2026-08-05T10:00:00.000Z",
      observedAt: "2026-08-05T10:00:00.000Z",
      status: { state: "running" },
    });
    const obs = getLaunchObservation("launch-run-abc123-fg679-plan-aaaaaa");
    assert.ok(obs);
    assert.equal(obs.associationKind, "none");
    assert.equal(obs.runId, null, "a run id in the NAME and ARGV must not become an association");
    assert.equal(obs.taskId, null);
    assert.equal(obs.projectDir, null, "no registered project home -> host-level bucket");
  });

  test("an explicitly associated launch records its run/task/ticket verbatim", () => {
    recordLaunchObservation({
      launchId: "launch-worktree-bbbbbb",
      name: "worktree",
      command: ["npm", "run", "test:worktree"],
      cwd: "/repos/forge",
      projectDir: "/repos/forge",
      association: { runId: "run-real", taskId: "task-real", ticketId: "FG-679" },
      startedAt: "2026-08-05T10:00:00.000Z",
      observedAt: "2026-08-05T10:00:00.000Z",
      status: { state: "running" },
    });
    const obs = getLaunchObservation("launch-worktree-bbbbbb");
    assert.ok(obs);
    assert.equal(obs.associationKind, "explicit");
    assert.equal(obs.runId, "run-real");
    assert.equal(obs.taskId, "task-real");
    assert.equal(obs.ticketId, "FG-679");
    assert.deepEqual(obs.command, ["npm", "run", "test:worktree"]);
  });
});

describe("FG-679 launch_observations — writing and promoting", () => {
  test("exactly one MUTABLE row per launch: re-recording the same id replaces rather than appends", () => {
    const base = {
      launchId: "launch-x-cccccc",
      command: ["npm", "test"],
      cwd: "/repos/forge",
      startedAt: "2026-08-05T10:00:00.000Z",
      observedAt: "2026-08-05T10:00:00.000Z",
      status: { state: "running" } as LaunchStatus,
    };
    recordLaunchObservation(base);
    recordLaunchObservation({ ...base, observedAt: "2026-08-05T10:05:00.000Z" });
    assert.equal(listLaunchObservations().length, 1);
    assert.equal(getLaunchObservation("launch-x-cccccc")?.observedAt, "2026-08-05T10:05:00.000Z");
  });

  test("a promoted terminal row leaves the OPEN set — the in-flight surface empties without fabricating anything (BD-16)", () => {
    recordLaunchObservation({
      launchId: "launch-y-dddddd",
      command: ["npm", "test"],
      cwd: "/repos/forge",
      startedAt: "2026-08-05T10:00:00.000Z",
      observedAt: "2026-08-05T10:00:00.000Z",
      status: { state: "running" },
    });
    assert.equal(listOpenLaunchObservations().length, 1);

    const promoted = updateLaunchObservationStatus(
      "launch-y-dddddd",
      { state: "signaled", signal: "SIGTERM", sender: "unrecorded" },
      "2026-08-05T10:09:00.000Z",
    );
    assert.equal(promoted, true);
    assert.equal(listOpenLaunchObservations().length, 0);

    const obs = getLaunchObservation("launch-y-dddddd");
    assert.equal(obs?.terminal, true);
    assert.deepEqual(obs?.status, { state: "signaled", signal: "SIGTERM", sender: "unrecorded" });
    assert.equal(statusLine(obs!.status), "terminated by SIGTERM (signal sender not recorded — origin unknown)");
  });

  test("promoting a launch that was never recorded creates nothing — the promoter does not invent rows", () => {
    assert.equal(updateLaunchObservationStatus("launch-never-eeeeee", { state: "exited_ok", code: 0 }, "2026-08-05T10:00:00.000Z"), false);
    assert.equal(listLaunchObservations().length, 0);
  });
});

describe("FG-679 launch_observations — cwd -> registered project home", () => {
  beforeEach(() => {
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', 't', 'active', '2026-08-05T00:00:00.000Z', ?)`)
      .run("run-1", "/repos/forge");
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', 't', 'active', '2026-08-05T00:00:00.000Z', ?)`)
      .run("run-2", "/repos/forge/packages/inner");
  });

  test("an exact match and a nested cwd both resolve; the LONGEST registered home wins", () => {
    assert.equal(resolveRegisteredProjectDir("/repos/forge"), "/repos/forge");
    assert.equal(resolveRegisteredProjectDir("/repos/forge/src/store"), "/repos/forge");
    assert.equal(resolveRegisteredProjectDir("/repos/forge/packages/inner/src"), "/repos/forge/packages/inner");
  });

  test("a per-task worktree under ~/.forge/worktrees matches NO registered home — the ticket's own motivating case (BD-14)", () => {
    assert.equal(resolveRegisteredProjectDir("/home/op/.forge/worktrees/run-abc123/task-plan-51d71e"), null);
  });

  test("a sibling directory whose path merely SHARES A PREFIX is not a match", () => {
    assert.equal(resolveRegisteredProjectDir("/repos/forge-other"), null);
  });
});
