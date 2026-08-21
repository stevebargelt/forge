// FG-590: the boundary + falsification regression. Creates terminal launches and retained
// terminal containers across success / failure / unknown states, advances a fake clock
// past each retention boundary, and proves only eligible resources are removed — then
// walks all five falsification cases.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest, closeDb } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { eventsForTask } from "../store/events.js";
import { recordLaunchObservation } from "../store/launch-observations.js";
import { getContainerCausalEvidenceFromEvents } from "./failure-kind.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import type { ContainerReap, ContainerLister, ContainerListEntry } from "./reconcile.js";
import type { ContainerExitInfo } from "./failure-kind.js";
import { LAUNCHES_DIR, type TmuxRunner } from "./launch.js";
import { performAutomaticCleanup } from "../cli/commands/ops.js";
import type { RetentionPolicy } from "./retention-policy.js";

const PROJECT = "/tmp/test-project";
const POLICY: RetentionPolicy = { success: 1000, failureAmbiguous: 10_000 };
const T0 = 1_700_000_000_000;

afterEach(() => closeDb());

function mkRun(id: string, status: RunStatus): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z", projectDir: PROJECT };
}
function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

/** A mutable "docker world": reap removes a container from disk truth, so a later pass
 *  genuinely no longer lists it — the crash-convergence property is modeled, not faked. */
function dockerWorld(initial: ContainerListEntry[]) {
  const world = new Map(initial.map((c) => [c.name, c]));
  const list: ContainerLister = () => [...world.values()];
  const reap: ContainerReap = (name) => {
    if (!world.has(name)) return "not_found";
    world.delete(name);
    return "killed";
  };
  return { list, reap, world };
}
const exitInfo: ContainerExitInfo = () => ({ exitCode: 137, oomKilled: true, signal: "SIGKILL" });

function resetLaunches(): void {
  rmSync(LAUNCHES_DIR, { recursive: true, force: true });
  mkdirSync(LAUNCHES_DIR, { recursive: true });
}
function makeLaunch(id: string, opts: { exit?: { code: number | null; signal: string | null } } = {}): void {
  const dir = join(LAUNCHES_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, command: ["x"], tmuxSession: `forge-${id}`, launcherPid: 999999, ownerPid: null, startedAt: "2026-01-01T00:00:00.000Z", logPath: join(dir, "out.log"), cwd: "/tmp" }));
  if (opts.exit) writeFileSync(join(dir, "exit"), JSON.stringify(opts.exit));
}
function fakeTmux(sets: { running?: Set<string>; deadPane?: Set<string> } = {}): TmuxRunner {
  const running = sets.running ?? new Set<string>();
  const deadPane = sets.deadPane ?? new Set<string>();
  return (args: string[]) => {
    if (args[0] === "-V") return "tmux 3.4";
    const tIdx = args.indexOf("-t");
    const sess = (tIdx >= 0 ? String(args[tIdx + 1] ?? "") : "").replace(/:$/, "");
    const alive = running.has(sess) || deadPane.has(sess);
    if (args[0] === "has-session") { if (alive) return ""; throw new Error("no session"); }
    if (args[0] === "display-message") {
      if (args.includes("#{pane_dead}")) return deadPane.has(sess) ? "1" : "0";
      return "12345";
    }
    if (args[0] === "kill-session") { running.delete(sess); deadPane.delete(sess); return ""; }
    return "";
  };
}
const iso = (ms: number) => new Date(ms).toISOString();

test("FG-590 lifecycle: only resources past their per-outcome boundary are removed, as a fake clock advances", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    // Launches: success (exit 0), failure (owner_gone), unknown (no session), running.
    resetLaunches();
    makeLaunch("l-ok", { exit: { code: 0, signal: null } });
    makeLaunch("l-fail"); // owner_gone via dead pane
    makeLaunch("l-unknown"); // no session
    makeLaunch("l-run"); // live session
    const tmux = fakeTmux({ running: new Set(["forge-l-run"]), deadPane: new Set(["forge-l-fail"]) });

    // Containers: a failed one and a complete leak.
    insertRun(mkRun("run-x", "failed"));
    insertTask(mkTask("t-failc", "run-x", "failed"));
    insertRun(mkRun("run-y", "complete"));
    insertTask(mkTask("t-okc", "run-y", "complete"));

    const call = (nowMs: number, world: ReturnType<typeof dockerWorld>) =>
      performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(nowMs), tmux, reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });

    // t0: everything anchored, all within window → nothing removed.
    let world = dockerWorld([
      { name: "forge-t-failc", running: false, finishedAt: iso(T0) },
      { name: "forge-t-okc", running: false, finishedAt: iso(T0) },
    ]);
    let r = call(T0, world);
    assert.ok(!("error" in r.launches) && r.launches.removed.length === 0, "nothing removed at t0");
    assert.ok(!("error" in r.containers) && r.containers.reaped.length === 0);

    // t0 + 1500ms: PAST the success window (1000) but within the failure window (10000).
    // Removed: the successful launch and the completed-leak container. Kept: failure/
    // unknown launches (within diagnostic window), the failed container, the running launch.
    world = dockerWorld([
      { name: "forge-t-failc", running: false, finishedAt: iso(T0) },
      { name: "forge-t-okc", running: false, finishedAt: iso(T0) },
    ]);
    r = call(T0 + 1500, world);
    assert.ok(!("error" in r.launches));
    assert.deepEqual(r.launches.removed, ["l-ok"]);
    assert.deepEqual(r.launches.skippedRunning, ["l-run"]);
    assert.ok(!existsSync(join(LAUNCHES_DIR, "l-ok")));
    assert.ok(existsSync(join(LAUNCHES_DIR, "l-fail")) && existsSync(join(LAUNCHES_DIR, "l-unknown")));
    assert.ok(!("error" in r.containers));
    assert.deepEqual(r.containers.reaped, ["forge-t-okc"]);
    assert.deepEqual(r.containers.retained, ["forge-t-failc"]);

    // t0 + 11000ms: PAST the failure window too. The failure + unknown launches and the
    // failed container are now retired; the running launch is STILL untouched.
    world = dockerWorld([{ name: "forge-t-failc", running: false, finishedAt: iso(T0) }]);
    r = call(T0 + 11_000, world);
    assert.ok(!("error" in r.launches));
    assert.deepEqual(r.launches.removed.sort(), ["l-fail", "l-unknown"]);
    assert.deepEqual(r.launches.skippedRunning, ["l-run"]);
    assert.ok(existsSync(join(LAUNCHES_DIR, "l-run")), "the running launch is NEVER removed");
    assert.ok(!("error" in r.containers));
    assert.deepEqual(r.containers.reaped, ["forge-t-failc"]);
    // Evidence was persisted before the failed container was destroyed.
    assert.ok(getContainerCausalEvidenceFromEvents(eventsForTask("t-failc")) !== undefined);
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 falsification #1: crash after tmux delete, before rmSync — next pass converges", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    resetLaunches();
    // Post-kill, pre-rmSync remains: dir + exit record + anchored marker, session gone.
    makeLaunch("l-crash", { exit: { code: 0, signal: null } });
    writeFileSync(join(LAUNCHES_DIR, "l-crash", "terminal.json"), JSON.stringify({ terminalAt: iso(T0), state: "exited_ok", cls: "success" }));
    const world = dockerWorld([]);
    const r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 5000), tmux: fakeTmux(), reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r.launches) && r.launches.removed.includes("l-crash"));
    assert.ok(!existsSync(join(LAUNCHES_DIR, "l-crash")));
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 falsification #2: crash after container delete, before resolution — disk truth converges, no sticky candidate", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    resetLaunches();
    insertRun(mkRun("run-z", "failed"));
    insertTask(mkTask("t-z", "run-z", "failed"));
    const world = dockerWorld([{ name: "forge-t-z", running: false, finishedAt: iso(T0 - 100_000) }]);

    // Pass 1 reaps it (removes it from disk). Simulate the crash by discarding the result.
    performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0), tmux: fakeTmux(), reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });
    assert.equal(world.world.has("forge-t-z"), false, "container gone from disk");

    // Pass 2: the container is absent from docker truth, so it is no longer a candidate —
    // convergence with no duplicate reap and no thrown error.
    const r2 = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 10), tmux: fakeTmux(), reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r2.containers));
    assert.deepEqual(r2.containers.reaped, []);
    assert.equal(r2.containers.scanned, 0);
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 falsification #3: a running resource is never removed under a race", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    resetLaunches();
    makeLaunch("l-live"); // live session
    insertRun(mkRun("run-live", "failed"));
    insertTask(mkTask("t-live", "run-live", "failed"));
    const world = dockerWorld([{ name: "forge-t-live", running: true, finishedAt: iso(T0 - 100_000) }]);
    const r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 1_000_000), tmux: fakeTmux({ running: new Set(["forge-l-live"]) }), reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r.launches) && r.launches.removed.length === 0);
    assert.ok(existsSync(join(LAUNCHES_DIR, "l-live")));
    assert.ok(!("error" in r.containers) && r.containers.reaped.length === 0);
    assert.equal(world.world.has("forge-t-live"), true, "running container never reaped");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 falsification #4: evidence persistence fails — the failed container remains and is surfaced", () => {
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    resetLaunches();
    insertRun(mkRun("run-fc", "failed"));
    insertTask(mkTask("t-fc", "run-fc", "failed"));
    db.exec("CREATE TRIGGER block_events BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT, 'blocked'); END;");
    const world = dockerWorld([{ name: "forge-t-fc", running: false, finishedAt: iso(T0 - 100_000) }]);
    const r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0), tmux: fakeTmux(), reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r.containers));
    assert.deepEqual(r.containers.evidenceFailed, ["forge-t-fc"]);
    assert.deepEqual(r.containers.reaped, []);
    assert.equal(world.world.has("forge-t-fc"), true, "the container remains — evidence was not destroyed");
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 falsification #5: repeated runs create no incident, no duplicate resolution, no degradation", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    resetLaunches();
    makeLaunch("l-ok2", { exit: { code: 0, signal: null } });
    insertRun(mkRun("run-r", "failed"));
    insertTask(mkTask("t-r", "run-r", "failed"));
    const world = dockerWorld([{ name: "forge-t-r", running: false, finishedAt: iso(T0 - 100_000) }]);
    const tmux = fakeTmux();

    // Three passes; the clock advances by more than the success window each time so an
    // anchored launch does age past its boundary (the marker is anchored on pass 1).
    let removedTotal = 0;
    let reapedTotal = 0;
    for (let i = 0; i < 3; i++) {
      const r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 100_000 + i * 5000), tmux, reap: world.reap, listContainers: world.list, containerExitInfo: exitInfo });
      assert.ok(!("error" in r.launches) && !("error" in r.containers));
      removedTotal += r.launches.removed.length;
      reapedTotal += r.containers.reaped.length;
    }
    // The launch was retired once; the container was reaped once; nothing recreated.
    assert.equal(removedTotal, 1);
    assert.equal(reapedTotal, 1);
    // Exactly one resolution (container.reaped) for the task — no duplicate ledger.
    const resolutions = eventsForTask("t-r").filter((e) => e.eventType === "container.reaped" && (e.payload as Record<string, unknown>)?.["outcome"] !== undefined);
    assert.equal(resolutions.length, 1);
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 RF-5: a project-scoped cleanup with a zero-window override never retires another project's launches", () => {
  const OTHER = "/tmp/test-project-other";
  mkdirSync(PROJECT, { recursive: true });
  mkdirSync(OTHER, { recursive: true });
  const prev = setDbForTest(makeInMemoryDb());
  try {
    resetLaunches();
    // Two terminal successful launches, both anchored long ago. One is OWNED BY ANOTHER
    // project (recorded in the observation store); the other is unowned/host-global.
    makeLaunch("l-other", { exit: { code: 0, signal: null } });
    makeLaunch("l-mine", { exit: { code: 0, signal: null } });
    writeFileSync(join(LAUNCHES_DIR, "l-other", "terminal.json"), JSON.stringify({ terminalAt: iso(T0), state: "exited_ok", cls: "success" }));
    writeFileSync(join(LAUNCHES_DIR, "l-mine", "terminal.json"), JSON.stringify({ terminalAt: iso(T0), state: "exited_ok", cls: "success" }));
    recordLaunchObservation({
      launchId: "l-other",
      command: ["x"],
      cwd: OTHER,
      projectDir: OTHER,
      startedAt: iso(T0),
      observedAt: iso(T0),
      status: { state: "exited_ok", code: 0 },
    });

    const cw = dockerWorld([]);
    // The caller is PROJECT with a ZERO success window — the aggressive override that would
    // purge every host-global launch if the sweep were not scoped to its own project.
    const r = performAutomaticCleanup({
      policy: { success: 0, failureAmbiguous: 0 },
      projectDir: PROJECT,
      now: new Date(T0 + 5000),
      tmux: fakeTmux(),
      reap: cw.reap,
      listContainers: cw.list,
      containerExitInfo: exitInfo,
    });

    assert.ok(!("error" in r.launches));
    // The unowned launch is in scope and retired; the OTHER project's launch is untouched —
    // never scanned, never removed.
    assert.ok(!existsSync(join(LAUNCHES_DIR, "l-mine")), "the caller's own/unowned launch is retired");
    assert.ok(existsSync(join(LAUNCHES_DIR, "l-other")), "another project's launch is NEVER retired by this project's override");
    if (!("error" in r.launches)) {
      assert.ok(!r.launches.removed.includes("l-other"));
      assert.deepEqual(r.launches.removed, ["l-mine"]);
    }
  } finally {
    if (prev) setDbForTest(prev);
  }
});

test("FG-590 RF-5: when cross-project ownership cannot be read, the sweep FAILS CLOSED — removes nothing and reports the failure", () => {
  mkdirSync(PROJECT, { recursive: true });
  const db = makeInMemoryDb();
  const prev = setDbForTest(db);
  try {
    resetLaunches();
    // Two terminal launches on disk, anchored long ago and eligible under a zero window.
    makeLaunch("l-other", { exit: { code: 0, signal: null } });
    makeLaunch("l-mine", { exit: { code: 0, signal: null } });
    writeFileSync(join(LAUNCHES_DIR, "l-other", "terminal.json"), JSON.stringify({ terminalAt: iso(T0), state: "exited_ok", cls: "success" }));
    writeFileSync(join(LAUNCHES_DIR, "l-mine", "terminal.json"), JSON.stringify({ terminalAt: iso(T0), state: "exited_ok", cls: "success" }));

    // Force the ownership query to FAIL: drop the table launchIdsOwnedByOtherProjects reads.
    // A store present but unreadable is exactly the fail-open hole — ownership cannot be
    // established, so the sweep must not proceed to purge.
    db.exec("DROP TABLE launch_observations");

    const cw = dockerWorld([]);
    const r = performAutomaticCleanup({
      policy: { success: 0, failureAmbiguous: 0 },
      projectDir: PROJECT,
      now: new Date(T0 + 5000),
      tmux: fakeTmux(),
      reap: cw.reap,
      listContainers: cw.list,
      containerExitInfo: exitInfo,
    });

    // The failure is surfaced, not swallowed into a wider deletion scope.
    assert.ok("error" in r.launches, "the launch sweep reports the ownership-read failure");
    // Fail closed: NOTHING is retired — not the other project's launch, not even the caller's own.
    assert.ok(existsSync(join(LAUNCHES_DIR, "l-other")), "another project's launch is never retired when ownership cannot be read");
    assert.ok(existsSync(join(LAUNCHES_DIR, "l-mine")), "the sweep retires nothing at all rather than widen scope on unread ownership");
  } finally {
    if (prev) setDbForTest(prev);
  }
});
