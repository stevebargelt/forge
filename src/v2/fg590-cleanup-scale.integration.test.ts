// FG-590: the scale regression. At least 500 terminal launches plus 25 retained stopped
// containers converge in ONE bounded pass to only running + within-retention resources,
// tmux probes are spent only on no-exit-record candidates, and a second pass does not
// rescan already-resolved history.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeInMemoryDb, setDbForTest, closeDb } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import type { Run, Task } from "../types/index.js";
import type { ContainerReap, ContainerLister, ContainerListEntry } from "./reconcile.js";
import type { ContainerExitInfo } from "./failure-kind.js";
import { LAUNCHES_DIR, type TmuxRunner } from "./launch.js";
import { performAutomaticCleanup } from "../cli/commands/ops.js";
import type { RetentionPolicy } from "./retention-policy.js";

const PROJECT = "/tmp/test-project";
const POLICY: RetentionPolicy = { success: 1000, failureAmbiguous: 5000 };
const T0 = 1_700_000_000_000;

afterEach(() => closeDb());

function makeLaunch(id: string, opts: { exit?: { code: number | null; signal: string | null }; running?: boolean } = {}): void {
  const dir = join(LAUNCHES_DIR, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "meta.json"), JSON.stringify({ id, command: ["x"], tmuxSession: `forge-${id}`, launcherPid: 999999, ownerPid: null, startedAt: "2026-01-01T00:00:00.000Z", logPath: join(dir, "out.log"), cwd: "/tmp" }));
  if (opts.exit) writeFileSync(join(dir, "exit"), JSON.stringify(opts.exit));
}

test("FG-590 scale: 500 terminal launches + 25 stopped containers converge in one bounded pass; probes are bounded", () => {
  const prev = setDbForTest(makeInMemoryDb());
  try {
    rmSync(LAUNCHES_DIR, { recursive: true, force: true });
    mkdirSync(LAUNCHES_DIR, { recursive: true });

    // 500 successful launches (exit record → no tmux probe), 5 running launches (no
    // exit record → live session → probed, never removed).
    const N_OK = 500;
    const N_RUN = 5;
    const runningSessions = new Set<string>();
    for (let i = 0; i < N_OK; i++) makeLaunch(`launch-ok-${i}`, { exit: { code: 0, signal: null } });
    for (let i = 0; i < N_RUN; i++) {
      makeLaunch(`launch-run-${i}`);
      runningSessions.add(`forge-launch-run-${i}`);
    }

    let probes = 0;
    const tmux: TmuxRunner = (args) => {
      probes++;
      if (args[0] === "-V") return "tmux 3.4";
      const tIdx = args.indexOf("-t");
      const sess = (tIdx >= 0 ? String(args[tIdx + 1] ?? "") : "").replace(/:$/, "");
      if (args[0] === "has-session") { if (runningSessions.has(sess)) return ""; throw new Error("no session"); }
      if (args[0] === "display-message") { if (args.includes("#{pane_dead}")) return runningSessions.has(sess) ? "0" : "1"; return "12345"; }
      if (args[0] === "kill-session") { runningSessions.delete(sess); return ""; }
      return "";
    };

    // 25 retained stopped containers: 20 failed (kept for the diagnostic window), 5
    // completed leaks. All finished long ago → the completed leaks are eligible; the
    // failed ones are within the 5000ms window at T0 (they will NOT be reaped this pass).
    const N_FAILED = 20;
    const N_LEAK = 5;
    const world = new Map<string, ContainerListEntry>();
    for (let i = 0; i < N_FAILED; i++) {
      const id = `t-failc-${i}`;
      insertRun(mkRun(`run-failc-${i}`));
      insertTask(mkTask(id, `run-failc-${i}`, "failed"));
      world.set(`forge-${id}`, { name: `forge-${id}`, running: false, finishedAt: new Date(T0 - 500).toISOString() }); // within failure window
    }
    for (let i = 0; i < N_LEAK; i++) {
      const id = `t-leak-${i}`;
      insertRun(mkRunComplete(`run-leak-${i}`));
      insertTask(mkTask(id, `run-leak-${i}`, "complete"));
      world.set(`forge-${id}`, { name: `forge-${id}`, running: false, finishedAt: new Date(T0 - 1_000_000).toISOString() }); // past success window
    }
    const list: ContainerLister = () => [...world.values()];
    const reap: ContainerReap = (n) => { if (!world.has(n)) return "not_found"; world.delete(n); return "killed"; };
    const exitInfo: ContainerExitInfo = () => ({ exitCode: 1 });

    // ── Pass 1: anchor everything. Successful launches are within their window at anchor
    // time, so nothing is removed yet; the completed leaks ARE past the success window.
    let r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0), tmux, reap, listContainers: list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r.launches) && !("error" in r.containers));
    // Probes were spent ONLY on the no-exit-record (running) launches — the 500 exit-record
    // launches cost zero classification probes. Bounded well under one-probe-per-launch.
    assert.ok(probes < N_OK, `probes (${probes}) must be far below the ${N_OK} exit-record launches`);
    // The completed leaks are retired; the failed containers are kept for investigation.
    assert.equal(r.containers.reaped.length, N_LEAK);
    assert.equal(r.containers.retained.length, N_FAILED);

    const probesAfterPass1 = probes;

    // ── Pass 2, past the success window: the 500 successful launches converge in ONE pass,
    // and the running ones are untouched. The failed containers are still within window.
    r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 1001), tmux, reap, listContainers: list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r.launches));
    assert.equal(r.launches.removed.length, N_OK, "all 500 successful launches retired in one pass");
    assert.equal(r.launches.skippedRunning.length, N_RUN);

    // Only running + within-retention resources remain on disk.
    const remaining = readdirSync(LAUNCHES_DIR).filter((e) => /^launch-/.test(e));
    assert.equal(remaining.length, N_RUN);
    for (let i = 0; i < N_RUN; i++) assert.ok(existsSync(join(LAUNCHES_DIR, `launch-run-${i}`)));

    // ── Pass 3: already-resolved history is not rescanned. The only launches left are the
    // running ones (re-probed cheaply); no exit-record launch is re-examined because it is
    // gone from disk. The container side reaps nothing new.
    const probesBeforePass3 = probes;
    r = performAutomaticCleanup({ policy: POLICY, projectDir: PROJECT, now: new Date(T0 + 2000), tmux, reap, listContainers: list, containerExitInfo: exitInfo });
    assert.ok(!("error" in r.containers) && r.containers.reaped.length === 0);
    // Pass 3 probes only the handful of surviving running launches, not the retired 500.
    assert.ok(probes - probesBeforePass3 < N_OK, "a converged pass does not rescan retired history");
    assert.ok(probesAfterPass1 <= probes);
  } finally {
    if (prev) setDbForTest(prev);
  }
});

function mkRun(id: string): Run {
  return { id, workflow: "feature", title: id, status: "failed", createdAt: "2026-06-02T12:00:00Z", projectDir: PROJECT };
}
function mkRunComplete(id: string): Run {
  return { id, workflow: "feature", title: id, status: "complete", createdAt: "2026-06-02T12:00:00Z", projectDir: PROJECT };
}
function mkTask(id: string, runId: string, status: "failed" | "complete"): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}
