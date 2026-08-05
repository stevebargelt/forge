// FG-679 (BD-2 / BD-15): THE REGRESSION THIS TICKET TURNS ON.
//
// FG-492 records that long-lived agent processes carry conversation text in their
// argv and logs, which false-matches unrelated role and ticket names. `extractForgeIds`
// regexes `run-…` / `task-…` straight out of raw LOG TEXT and publishes the result as
// `forgeIds` on every `LaunchView`, so the inference BD-2 forbids is already sitting
// in the record. This suite drives `startLaunch` for real (fake tmux, real launch
// directory, real store) and proves that a launch whose NAME, ARGV and LOG BODY all
// name a run and a task it was never associated with is NOT attributed to them — and
// that `forgeIds` may still be present without deciding anything.

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest, getDb } from "../store/db.js";
import { getLaunchObservation, recordLaunchStart } from "../store/launch-observations.js";
import { LAUNCHES_DIR, extractForgeIds, readLaunch, startLaunch, type TmuxRunner } from "./launch.js";
import { deriveCurrentActivity } from "./current-activity.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const NOW = new Date("2026-08-05T12:00:00.000Z");

/** A tmux stub — the launch directory and the store write are real; only the tmux
 *  server is substituted, exactly as the FG-552 suites do. */
function tmuxStub(): TmuxRunner {
  const alive = new Set<string>();
  return (args) => {
    if (args[0] === "has-session" && !alive.has(args[2]!)) throw new Error("no such session");
    if (args[0] === "new-session") alive.add(args[args.indexOf("-s") + 1]!);
    if (args[0] === "kill-session") alive.delete(args[args.indexOf("-t") + 1]!);
    if (args[0] === "display-message") {
      if (args.includes("#{pane_dead}")) return "0\n";
      return "4242\n";
    }
    return "";
  };
}

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

// The literal id text the ticket's acceptance criterion names.
const DECOY_RUN = "run-abc123";
const DECOY_TASK = "task-plan-51d71e";

describe("FG-679 BD-2/BD-15 — name, argv and log text authorize NOTHING", () => {
  test("an unassociated launch whose --name, argv and log body all name run-abc123 / task-plan-51d71e is NOT attributed to them", () => {
    // A real run row for the decoy, so a false attribution would have somewhere to land.
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, 'feature', 'decoy', 'active', ?, ?)`)
      .run(DECOY_RUN, "2026-08-05T09:00:00.000Z", "/repos/forge");

    const tmux = tmuxStub();
    const meta = startLaunch(
      ["sh", "-c", `echo ${DECOY_RUN} ${DECOY_TASK}`],
      { name: `launch-${DECOY_RUN}-fg679-plan`, cwd: process.cwd(), tmux },
    );
    // Submitted with NO association — exactly as `forge launch run` records it.
    recordLaunchStart(meta);
    // And the log body carries them too — the third channel BD-2 names.
    writeFileSync(meta.logPath, `dispatching ${DECOY_RUN} phase plan for ${DECOY_TASK}\n`);

    const obs = getLaunchObservation(meta.id);
    assert.ok(obs, "the launch was observed");
    assert.equal(obs.runId, null, "a run id in the NAME did not become an association");
    assert.equal(obs.taskId, null, "a task id in the ARGV did not become an association");
    assert.equal(obs.associationKind, "none");

    // The id itself literally contains the decoy run id — proof the placement
    // decision is not reading the id either.
    assert.match(meta.id, new RegExp(DECOY_RUN));

    const onDecoyRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: DECOY_RUN } });
    assert.equal(onDecoyRun.hostVerification.length, 0, "the decoy run's surface must not claim this launch");

    // `forgeIds` is still PUBLISHED for compatibility and diagnostics (BD-15) — it
    // is quarantined, not removed — and it demonstrably contains the decoy ids that
    // the placement decision above ignored.
    const view = readLaunch(meta.id, tmux);
    assert.ok(view);
    assert.deepEqual(extractForgeIds(`dispatching ${DECOY_RUN} for ${DECOY_TASK}`), {
      runIds: [DECOY_RUN],
      taskIds: [DECOY_TASK],
    });
    assert.ok(view.forgeIds, "forgeIds stays on the LaunchView");
  });

  test("a launch explicitly associated via --run IS attributed to that run", () => {
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-real', 'feature', 'real', 'active', ?, ?)`)
      .run("2026-08-05T09:00:00.000Z", "/repos/forge");

    const meta = startLaunch(["sh", "-c", "true"], { name: "worktree", cwd: process.cwd(), tmux: tmuxStub() });
    recordLaunchStart(meta, { runId: "run-real", ticketId: "FG-679" });

    const obs = getLaunchObservation(meta.id);
    assert.equal(obs?.associationKind, "explicit");
    assert.equal(obs?.runId, "run-real");

    const activity = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-real" } });
    assert.deepEqual(activity.hostVerification.map((l) => l.launchId), [meta.id]);
    assert.equal(activity.hostVerification[0]!.unassociated, false);
  });

  test("an explicitly run-associated launch started from a PER-TASK WORKTREE appears on its run AND on its project", () => {
    // The ticket's own motivating shape: forge's own per-task worktrees live under
    // ~/.forge/worktrees, deliberately outside every registered project home, so the
    // cwd lookup yields NOTHING. Explicit metadata is the STRONGEST authority and must
    // not lose to a cwd lookup that happens to fail — the launch's project comes from
    // the run it declared.
    const PROJECT = "/repos/forge";
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-real', 'feature', 'real', 'active', ?, ?)`)
      .run("2026-08-05T09:00:00.000Z", PROJECT);
    // A real directory that is NOT under any registered project home.
    const worktree = mkdtempSync(join(tmpdir(), "fg679-worktree-"));

    const meta = startLaunch(["npm", "run", "test:worktree"], { name: "verify", cwd: worktree, tmux: tmuxStub() });
    recordLaunchStart(meta, { runId: "run-real", ticketId: "FG-679" });

    const obs = getLaunchObservation(meta.id);
    assert.equal(obs?.associationKind, "explicit");
    assert.equal(obs?.projectDir, PROJECT, "the declared run says which project this is");

    const onRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-real" } });
    assert.deepEqual(onRun.hostVerification.map((l) => l.launchId), [meta.id], "on its run");

    const onProject = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.deepEqual(onProject.hostVerification.map((l) => l.launchId), [meta.id], "and on its project");
    assert.equal(onProject.hostVerification[0]!.unassociated, false);

    // And it is NOT ALSO in the host-level bucket — placed is placed.
    const hostWide = deriveCurrentActivity(db, { now: NOW });
    assert.deepEqual(hostWide.unassociated, []);
    assert.deepEqual(hostWide.hostVerification.map((l) => l.launchId), [meta.id]);

    rmSync(worktree, { recursive: true, force: true });
  });

  test("FG-684: when the declared run and the cwd name DIFFERENT registered projects, the declaration decides", () => {
    // The orchestrator's own dispatch shape: `forge launch run --run <id>` is issued
    // from the forge checkout while the run belongs to a disposable clone. Both
    // resolve to a registered project, so this is a CONFLICT, not a fallback — and
    // the weaker channel used to win it, placing the launch under an unrelated
    // project. Explicit submission metadata is the strongest authority (BD-3).
    const PROJECT_A = "/repos/clone-of-run-real";
    const PROJECT_B = process.cwd();
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-real', 'feature', 'real', 'active', ?, ?)`)
      .run("2026-08-05T09:00:00.000Z", PROJECT_A);
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-elsewhere', 'feature', 'elsewhere', 'active', ?, ?)`)
      .run("2026-08-05T09:00:00.000Z", PROJECT_B);

    const meta = startLaunch(["npm", "run", "test:all"], { name: "verify", cwd: PROJECT_B, tmux: tmuxStub() });
    recordLaunchStart(meta, { runId: "run-real", ticketId: "FG-679" });

    const obs = getLaunchObservation(meta.id);
    assert.equal(obs?.projectDir, PROJECT_A, "the DECLARED run's project, not the one the cwd happens to sit in");
    assert.equal(obs?.associationKind, "explicit", "the label names the channel that actually decided the placement");

    const onRun = deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-real" } });
    assert.deepEqual(onRun.hostVerification.map((l) => l.launchId), [meta.id], "on its declared run");

    const onA = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT_A] } });
    assert.deepEqual(onA.hostVerification.map((l) => l.launchId), [meta.id], "and on that run's project");
    assert.equal(onA.hostVerification[0]!.unassociated, false);

    const onB = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT_B] } });
    assert.deepEqual(onB.hostVerification.map((l) => l.launchId), [], "and NOT on the unrelated project its cwd resolved to");
  });

  test("FG-684: an unregistered declared run falls back to its registered cwd project", () => {
    const PROJECT = process.cwd();
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-cwd-owner', 'feature', 'cwd owner', 'active', ?, ?)`)
      .run("2026-08-05T09:00:00.000Z", PROJECT);

    const meta = startLaunch(["npm", "run", "test:all"], { name: "verify", cwd: PROJECT, tmux: tmuxStub() });
    recordLaunchStart(meta, { runId: "run-unregistered", ticketId: "FG-679" });

    const obs = getLaunchObservation(meta.id);
    assert.equal(obs?.projectDir, PROJECT, "an unknown declared run does not discard a registered cwd fallback");
    assert.equal(obs?.associationKind, "explicit", "the submitted association remains provenance even when cwd supplies placement");

    const onProject = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.deepEqual(onProject.hostVerification.map((l) => l.launchId), [meta.id]);
    assert.equal(onProject.hostVerification[0]!.unassociated, false);
  });

  test("a campaign drive-item launch — campaign and item identity, no run — is labeled `unassociated` at project level", () => {
    // The campaign launcher supplies exactly what it knows: no run exists yet (the
    // drive-item child dispatches its own). Recording that identity must not render
    // the launch as ASSOCIATED, which is what the launcher's own comment promises.
    const PROJECT = process.cwd();
    getDb().prepare(`INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES ('run-other', 'feature', 'other', 'active', ?, ?)`)
      .run("2026-08-05T09:00:00.000Z", PROJECT);

    const meta = startLaunch(["forge", "campaign", "drive-item", "camp-1", "item-1"], { name: "campaign-drive-item-1", cwd: PROJECT, tmux: tmuxStub() });
    recordLaunchStart(meta, { campaignId: "camp-1", itemId: "item-1" });

    const obs = getLaunchObservation(meta.id);
    assert.equal(obs?.associationKind, "cwd", "campaign/item identity is provenance, not placement authority");
    assert.equal(obs?.campaignId, "camp-1", "…and it is still recorded");
    assert.equal(obs?.itemId, "item-1");
    assert.equal(obs?.runId, null);

    const onProject = deriveCurrentActivity(db, { now: NOW, scope: { projectDirs: [PROJECT] } });
    assert.deepEqual(onProject.hostVerification.map((l) => l.launchId), [meta.id], "project level, from its cwd");
    assert.equal(onProject.hostVerification[0]!.unassociated, true, "labeled `unassociated`, as the launcher documents");

    // And it never reaches a run surface, since it declared no run.
    assert.equal(deriveCurrentActivity(db, { now: NOW, scope: { runId: "run-other" } }).hostVerification.length, 0);
  });

  test("the observation write is BEST-EFFORT: an unwritable store leaves the launch RUNNING and merely unobserved", () => {
    // A store handle that throws on every statement — the "instrumentation must not
    // refuse the work" property. The launch must still be created and still be
    // readable from its own filesystem record.
    // `open: true` matters — getDb() forgets a CLOSED handle and would silently
    // open a real store, which would make this test pass for the wrong reason.
    const broken = {
      open: true,
      prepare() { throw new Error("store is unwritable"); },
      exec() { throw new Error("store is unwritable"); },
      transaction() { throw new Error("store is unwritable"); },
    } as unknown as DatabaseInstance;
    const tmux = tmuxStub();
    const restore = setDbForTest(broken);
    try {
      const meta = startLaunch(["sh", "-c", "true"], { name: "unwritable", cwd: process.cwd(), tmux });
      assert.equal(recordLaunchStart(meta), false, "the observation could not be written…");
      assert.ok(meta.id, "…and the launch was NOT refused by that store failure");
      const view = readLaunch(meta.id, tmux);
      assert.ok(view, "the launch record exists on disk regardless of the store");
      assert.equal(view.status.state, "running");
    } finally {
      setDbForTest(restore as DatabaseInstance);
    }
  });

  test("a launch whose cwd is under no registered project home lands in the host-level bucket, not on a project", () => {
    const meta = startLaunch(["sh", "-c", "true"], { name: "orphan", cwd: process.cwd(), tmux: tmuxStub() });
    recordLaunchStart(meta);
    // No runs row exists at all, so nothing maps this cwd to a project.
    assert.equal(getLaunchObservation(meta.id)?.projectDir, null);
    const activity = deriveCurrentActivity(db, { now: NOW });
    assert.deepEqual(activity.unassociated.map((l) => l.launchId), [meta.id]);
    assert.equal(activity.hostVerification.length, 0);
  });

  test("the launch dir stays under LAUNCHES_DIR even for a crafted --name (the charset chokepoint)", () => {
    const meta = startLaunch(["sh", "-c", "true"], { name: "../../etc/passwd", cwd: process.cwd(), tmux: tmuxStub() });
    assert.equal(join(LAUNCHES_DIR, meta.id).startsWith(`${LAUNCHES_DIR}/`), true);
    assert.doesNotMatch(meta.id, /\.\./);
  });
});
