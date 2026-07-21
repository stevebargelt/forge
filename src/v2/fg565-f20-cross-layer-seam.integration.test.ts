// FG-565 (Slice 6 closeout) — F20 cross-layer seam. THE sharpest gap in the
// falsification matrix: there was zero F20 test in the tree. F20 is the seam no
// single slice owns — it spans BOTH durability boundaries at once:
//
//   the interactive session disappears
//     → the tmux-owned launch command CONTINUES and reaches a real terminal
//       record (FG-535 tmux ownership: the durable work never belonged to the
//       session that started it, BD-1/BD-2), AND
//     → the detached Docker agent container CONTINUES and lands its work EVEN
//       IF the Forge watcher ALSO dies (FG-536 detached execution: the in-process
//       watchdog dies with its watcher; the surviving reconcile bound finalizes
//       the container's real result).
//
// This test composes the two boundaries. They are NOT proven at the same fidelity,
// and the test does not pretend they are: boundary (a) runs on the REAL substrate (a
// real tmux-owned launch through the real CLI, classified by the real readLaunch);
// boundary (b) exercises the SURVIVING RECONCILE BOUND hermetically — the same
// reap/exit-info seams FG-536 uses, over a container-gone-result-present evidence
// row the test authors. Boundary (b) proves the reconcile-side recovery LOGIC (the
// surviving bound finalizes a detached row the dead watcher never landed); it does
// NOT run a Docker daemon and so does not, by itself, prove a live container
// lifecycle survived — no test in the reconcile family runs a real container; the
// tier is hermetic by design, and real container/daemon behavior is owned by the
// production reconcile path. The two boundaries, honestly scoped:
//
//   Boundary (a) — tmux ownership survives session death — is driven through the
//   REAL `forge launch run` CLI (the same real-launch substrate as
//   fg552-launch-wait-cli.integration.test.ts): a real tmux-owned short command is
//   started, its launching CLI process exits (the interactive session that started
//   the work is gone), yet the tmux-owned command runs to completion and writes its
//   REAL atomic exit record — which the REAL readLaunch (default, uninjected)
//   classifies when the surviving watchdog's observing consume advances the next
//   phase. No exit record is fixtured.
//
//   Boundary (b) — the surviving reconcile bound finalizes a detached container's
//   landed result after the Forge watcher's death — is driven through the REAL
//   reconcileRun exactly as fg536-idle-bound's start-callback-window test does: the
//   TEST authors a result.json on disk (modeling the detached container's landed
//   output — no container runs), the liveness probe reports the watcher/container
//   gone (aliveProbe false), and the surviving reconcile bound finalizes the row from
//   the ordinary container-gone-result-present evidence path. No Docker daemon is
//   touched — the reap/exit-info seams are hermetic, exactly as fg536 uses them, so
//   this proves the reconcile-side recovery LOGIC, not a live container lifecycle.
//
// RED BASELINE — INJECTION-BASED, NOT A PROD REVERT.  F20 is a COVERAGE hole, not a
// shippable defect: the production paths (the surviving watchdog consume + the
// surviving reconcile bound) already exist and are correct. There is nothing to
// `git revert` to redden this. So each arm first runs a MUTANT in which the surviving
// recovery is a NO-OP (the watcher died and NOTHING observes the terminal launch /
// reconciles the detached container) and asserts the seam STRANDS through the SAME
// factored assertion the real path greens: `assert.throws(() => assertSeamRecovered(...))`
// under the mutant, then `assertSeamRecovered(...)` passes after the real surviving
// path runs. The mutant reddens the very assertion the real path greens — a shipping
// reviewer should NOT expect a production-revert red here.

import { test, before, beforeEach, afterEach, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { setPublicationClockOffsetForTest } from "../store/publications.js";
import { insertRun, getRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import { taskDir, runDir } from "../util/paths.js";
import {
  recordContinuation,
  getContinuation,
  type NextAction,
} from "../store/continuations.js";
import {
  consumeContinuation,
  type ContinuationIdentity,
  type PhysicalDispatch,
} from "./continuation-consumer.js";
import { LAUNCHES_DIR } from "./launch.js";
import { WorkflowSchema, type Workflow } from "./schema.js";
import { startRun } from "./startRun.js";
import { reconcileRun } from "./reconcile.js";
import type { Run, Task } from "../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});

afterEach(() => {
  setPublicationClockOffsetForTest(0);
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

const NEXT: NextAction = { kind: "start_run", workflow: "feature", title: "next phase" };

function identity(over: Partial<ContinuationIdentity> = {}): ContinuationIdentity {
  return {
    continuationId: "cont-f20",
    sourceLaunchId: "launch-f20",
    consumerKind: "orchestrator",
    currentPhase: "build",
    nextAction: NEXT,
    ...over,
  };
}

// ── the REAL forge launch CLI (mirrors fg552-launch-wait-cli.integration.test.ts) ──
// Exec the actual bin/forge entry: one node process, tsx loaded in-process via
// --import forge-loader.mjs, then src/cli/index.ts — byte-for-byte what bin/forge
// exec's. The launch record it writes is the REAL atomic exit record read by the
// REAL readLaunch; NOTHING here fixtures a launch record.
const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const loader = resolve(here, "..", "..", "bin", "forge-loader.mjs");
const hasTmux = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const startedLaunches: string[] = [];

// The F20 tmux/composite seam is a REQUIRED tier, not an optional one: a missing
// tmux must FAIL it, never silently green it. A per-test `if (!hasTmux) return;`
// records success on a tmux-less host — the exact false-pass this guards. So the
// precondition lives in a file-wide `before` hook that hard-fails the whole tier
// (same discipline as launch-cli.integration.test.ts / FG-551). tmux is present
// wherever the integration tier runs (ubuntu-latest / the agent image).
before(() => {
  assert.ok(hasTmux, "the F20 tmux/composite seam requires tmux — install it (apt install tmux / brew install tmux); a tmux-less host must FAIL this tier, never skip to green");
});

function forge(args: string[]) {
  // Defensive bound: a launch subcommand that never returns is SIGKILLed so the test
  // fails fast instead of wedging the suite (mirrors fg552's forge() bound).
  return spawnSync("node", ["--import", loader, entry, ...args], {
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
}

/** Start a launch through the REAL `forge launch run` CLI and return its meta. */
function launchRun(command: string[], name: string): { id: string; tmuxSession: string } {
  const res = forge(["launch", "run", "--json", "--name", name, "--", ...command]);
  assert.equal(res.status, 0, `forge launch run failed: ${res.stderr}`);
  const meta = JSON.parse(res.stdout) as { id: string; tmuxSession: string };
  startedLaunches.push(meta.id);
  return meta;
}

async function waitFor(what: string, cond: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(`timed out after ${timeoutMs}ms waiting for: ${what}`);
}

const exitFile = (id: string) => join(LAUNCHES_DIR, id, "exit");

after(() => {
  for (const id of startedLaunches) {
    try { execFileSync("tmux", ["kill-session", "-t", `forge-${id}`], { stdio: "ignore" }); } catch { /* gone */ }
    try { rmSync(join(LAUNCHES_DIR, id), { recursive: true, force: true }); } catch { /* absent */ }
  }
});

// A schema-valid workflow so the REAL run-creation path (startRun) is exercised
// for real when the next phase dispatches — not a fabricated run row.
const TEST_WORKFLOW: Workflow = WorkflowSchema.parse({
  name: "feature",
  description: "fg565 F20 cross-layer seam workflow",
  steps: [{ id: "build", agent: "engineer" }],
});

/** The REAL run-creation dispatch (startRun stamps the F17 receipt), counting its
 *  real invocations — proof the next phase physically dispatched. */
function realDispatcher() {
  const runIds: string[] = [];
  const fn: PhysicalDispatch = (args) => {
    const { runId } = startRun({
      workflow: TEST_WORKFLOW,
      title: "next phase",
      inputs: {},
      projectDir: "/tmp/p",
      dispatchKey: args.dispatchKey,
    });
    runIds.push(runId);
    return { runId };
  };
  return { fn, runIds };
}

/** The tmux-boundary seam assertion (arm A / composite): the tmux-owned completion
 *  was observed and the next phase physically dispatched exactly once. The MUTANT
 *  reddens THIS; the real surviving watchdog greens it. */
function assertTmuxSeamRecovered(continuationId: string, runIds: string[]): void {
  assert.equal(getContinuation(continuationId)?.state, "advanced", "the tmux-owned completion advanced the continuation");
  assert.equal(runIds.length, 1, "the next phase physically dispatched exactly once");
}

// ── detached-container reconcile fixture: an invoke run modeling a detached ──
// container that ran on after the watcher died and left a result.json. The row and
// its result.json are AUTHORED BY THE TEST (no Docker daemon), exactly as FG-536's
// start-callback-window test does — this exercises the reconcile bound, not a live
// container.
const INVOKE_RUN: Run = { id: "run-f20-inv", workflow: "invoke", title: "f20 detached", status: "active", createdAt: "2026-07-21T00:00:00Z" };

function insertDetachedContainerTask(id: string): void {
  const t: Task = {
    id, runId: INVOKE_RUN.id, phase: "task", agentRole: "engineer", status: "running",
    taskPackage: {
      taskId: id, runId: INVOKE_RUN.id, phase: "task", role: "engineer",
      inputs: {}, composedSystemPrompt: "", dispatchSource: "invoke",
    },
    createdAt: "2026-07-21T00:00:00Z", startedAt: "2026-07-21T00:00:01Z",
  };
  insertTask(t);
  // The detached container was launched (docker run -d) before the watcher died.
  logEvent("container.started", { runId: INVOKE_RUN.id, taskId: id, payload: { containerName: `forge-${id}` } });
}

function writeContainerResult(taskId: string, result: unknown): void {
  const dir = taskDir(INVOKE_RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
}

/** The detached-container seam assertion (arm B / composite): the surviving reconcile
 *  bound landed the detached row's on-disk result. The MUTANT reddens THIS; the real
 *  reconcileRun greens it. */
function assertDetachedContainerFinalized(taskId: string, expected: unknown): void {
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete", "the detached row's completion is landed by the surviving reconcile bound");
  assert.deepEqual(t.result, expected, "the result reconcile read from the row's on-disk result.json — not one synthesized by reconcile");
}

// The Forge watcher is DEAD: the container liveness probe reports it gone (it has
// since exited, leaving its result), and the reap/exit-info seams are hermetic
// fakes so the test never touches a real docker daemon.
const WATCHER_DEAD = () => false;
const NO_REAP = () => "not_found" as const;
const NO_EXIT_INFO = () => ({});

// ─────────────────────────────────────────────────────────────────────────────
// F20 arm A — the tmux boundary survives the interactive session's death.
// Driven through the REAL forge launch CLI + the REAL readLaunch.
// ─────────────────────────────────────────────────────────────────────────────
test("F20 (tmux boundary): a REAL tmux-owned launch completes after its launching session is gone; the SURVIVING watchdog observes its REAL exit record and advances — a no-op watchdog strands the SAME assertion (RED)", async () => {
  // A REAL tmux-owned command. `forge launch run` detaches into tmux and returns —
  // the launching CLI process (the interactive session that started the work) is
  // GONE the moment launchRun returns, yet the tmux-owned command runs to completion
  // and writes its REAL atomic exit record. The delivery signal that session would
  // have carried is therefore LOST.
  const meta = launchRun(["sh", "-c", "sleep 0.4; exit 0"], "f20arma");
  await waitFor("the REAL exit record", () => existsSync(exitFile(meta.id)));

  recordContinuation({ continuationId: "cont-f20", consumerKind: "orchestrator", sourceLaunchId: meta.id, currentPhase: "build", nextAction: NEXT });

  // MUTANT: the Forge watchdog died with the session — NOTHING observes the terminal
  // launch. Injection-based red (no prod revert): under a no-op watchdog the seam
  // strands. The SAME assertion the real path greens fails here (nothing advanced,
  // nothing dispatched).
  const mutantRunIds: string[] = [];
  assert.throws(
    () => assertTmuxSeamRecovered("cont-f20", mutantRunIds),
    "RED: a no-op surviving watchdog must strand the tmux-owned completion — the SAME assertion the real path greens",
  );

  // GREEN: the SURVIVING watchdog (the cross-layer recovery FG-563 owns) runs the
  // REAL observing consume. It re-reads the AUTHORITATIVE launch record through the
  // REAL, uninjected readLaunch, sees the tmux-owned command's real terminal exit,
  // and advances — the interactive session's death did not lose the work.
  const d = realDispatcher();
  const out = consumeContinuation(identity({ sourceLaunchId: meta.id }), { owner: "wd-surviving", trigger: "watchdog", dispatch: d.fn });
  assert.equal(out.kind, "advanced", "the tmux-owned command's completion is recovered by the surviving watchdog");
  assert.equal(out.kind === "advanced" ? out.lostSignalRecovered : false, true, "recovered as a lost signal — the session's delivery was lost, the watchdog caught it");
  assertTmuxSeamRecovered("cont-f20", d.runIds); // the SAME assertion, now green
});

// ─────────────────────────────────────────────────────────────────────────────
// F20 arm B — the SURVIVING reconcile bound finalizes a detached container's landed
// result after the Forge watcher's death. Driven through the REAL reconcileRun over
// a test-authored container-gone-result-present row (fg536-idle-bound's start-callback
// window) — HERMETIC, no Docker daemon; this proves the reconcile-side recovery, not a
// live container lifecycle.
// ─────────────────────────────────────────────────────────────────────────────
test("F20 (detached-container reconcile seam, hermetic): a container-gone-result-present row a detached container left is finalized by the SURVIVING reconcile bound even though the Forge watcher ALSO died — a no-op reconcile strands the SAME assertion (RED). No Docker daemon, like fg536: proves the reconcile-side recovery, not a live container lifecycle", () => {
  insertRun(INVOKE_RUN);
  insertDetachedContainerTask("task-f20-detached");
  // Model the detached container's landed output: the test writes the result.json the
  // container would have left (no Docker daemon — hermetic, per fg536).
  writeContainerResult("task-f20-detached", { status: "complete", answer: 42 });

  try {
    // MUTANT: the Forge watcher died and NO reconcile bound runs. Injection-based red
    // (no prod revert): the detached container's landed work strands `running`. The
    // SAME assertion the real path greens fails here.
    assert.throws(
      () => assertDetachedContainerFinalized("task-f20-detached", { status: "complete", answer: 42 }),
      "RED: with no surviving reconcile the detached container's real result is never finalized — the row strands `running`",
    );

    // GREEN: the SURVIVING reconcile bound (FG-536) finalizes the detached
    // detached row's on-disk result even with the watcher reported dead (aliveProbe false).
    const r = reconcileRun(INVOKE_RUN.id, WATCHER_DEAD, NO_REAP, NO_EXIT_INFO);
    assertDetachedContainerFinalized("task-f20-detached", { status: "complete", answer: 42 }); // SAME assertion, now green
    assert.ok(
      r.taskChanges.some((c) => c.taskId === "task-f20-detached" && c.to === "complete" && c.reason === "container_gone_result_present"),
      "landed through the ordinary container-gone evidence path, watcher dead",
    );
  } finally {
    try { rmSync(runDir(INVOKE_RUN.id), { recursive: true, force: true }); } catch { /* absent */ }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// F20 composite — the WHOLE cross-layer seam in one scenario: the interactive
// session disappears AND the Forge watcher dies together. The mutant (no-op
// reconcile + watchdog) strands BOTH boundaries through the SAME two assertions; the
// real surviving paths recover BOTH. This is the seam no single slice owns.
// ─────────────────────────────────────────────────────────────────────────────
test("F20 composite: session gone AND watcher gone — a REAL tmux launch is recovered AND the surviving reconcile bound finalizes a detached container's landed result (hermetic); the no-op reconcile+watchdog mutant strands BOTH (RED)", async () => {
  // Boundary 1: a REAL tmux-owned launch that reached its next-phase handoff.
  const meta = launchRun(["sh", "-c", "sleep 0.4; exit 0"], "f20comp");
  await waitFor("the REAL exit record", () => existsSync(exitFile(meta.id)));
  recordContinuation({ continuationId: "cont-f20", consumerKind: "orchestrator", sourceLaunchId: meta.id, currentPhase: "build", nextAction: NEXT });

  // Boundary 2 (hermetic): a test-authored container-gone-result-present row — the
  // detached container's landed result.json, written by the test, no Docker daemon.
  insertRun(INVOKE_RUN);
  insertDetachedContainerTask("task-f20-detached");
  writeContainerResult("task-f20-detached", { status: "complete", answer: 7 });

  try {
    // MUTANT — no-op reconcile + no-op watchdog: the session's delivery is lost AND
    // the Forge watcher is dead, so under the mutant NOTHING drives either boundary.
    // Both SAME assertions the real paths green fail here.
    const mutantRunIds: string[] = [];
    assert.throws(
      () => assertTmuxSeamRecovered("cont-f20", mutantRunIds),
      "RED: mutant no-op watchdog — the tmux-owned next phase strands",
    );
    assert.throws(
      () => assertDetachedContainerFinalized("task-f20-detached", { status: "complete", answer: 7 }),
      "RED: mutant no-op reconcile — the detached container's landed work strands",
    );

    // GREEN — the two SURVIVING cross-layer recoveries run and both boundaries land.
    const d = realDispatcher();
    const advanced = consumeContinuation(identity({ sourceLaunchId: meta.id }), { owner: "wd-surviving", trigger: "watchdog", dispatch: d.fn });
    assert.equal(advanced.kind, "advanced", "the tmux-owned command continued and its completion was recovered");
    assertTmuxSeamRecovered("cont-f20", d.runIds); // SAME assertion, now green

    reconcileRun(INVOKE_RUN.id, WATCHER_DEAD, NO_REAP, NO_EXIT_INFO);
    assertDetachedContainerFinalized("task-f20-detached", { status: "complete", answer: 7 }); // SAME assertion, now green

    // The composite property: NEITHER boundary depended on the interactive session
    // or the in-process watcher — both survived the double failure, the seam holds.
    assert.ok(getRun(INVOKE_RUN.id), "the detached run still exists and was reconciled, not lost with its watcher");
  } finally {
    try { rmSync(runDir(INVOKE_RUN.id), { recursive: true, force: true }); } catch { /* absent */ }
  }
});
