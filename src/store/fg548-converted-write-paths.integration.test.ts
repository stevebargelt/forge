// FG-548, part 2: the write paths the first integration test does NOT cover.
//
// fg548-immediate-write-txn.integration.test.ts pins ONE converted path
// (runs.ts's completeRun CAS, via finalizeRunIfSettled) against two real forge
// processes. The fix converted seven more modules, and each of them is reachable
// from two processes at once in normal operation (`forge gate` while `forge next`
// drives another run; `forge campaign retry` while a campaign runs; `forge sweep`
// from a second terminal). This file drives THOSE paths — gate, v2/reconcile,
// the campaign-item CAS, the sweep, the usage-row batch — through real subprocess
// contention, plus three properties the path-by-path harness cannot show:
//
//   1. The harness is NON-VACUOUS and the helper is what fixes it: a DETERMINISTIC
//      snapshot-upgrade reproduction (test 1). Two processes, an enforced
//      read→other-commits→write interleave. Deferred: SQLITE_BUSY, every time, not
//      1-in-N. Through writeTransaction(): clean. This is the control experiment
//      the probabilistic hammer tests lean on — if a future change to db.ts stops
//      taking the write lock up front, THIS test goes red first and says why.
//   2. Reads were not swept into the fix. BEGIN IMMEDIATE on a read path is a
//      pessimization, not a fix — it would serialize `forge status` behind every
//      writer. Test 6 holds the write lock in one process and proves the read paths
//      still return promptly (and from their own snapshot) in another.
//   3. Rollback still works THROUGH the helper on a real path, and a partial
//      transaction is never visible to a second connection (test 7).
//
// NO RETRY SHIM, anywhere: no driver catches SQLITE_BUSY. One is a hard failure.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { getDb } from "./db.js";
import { insertRun, getRun } from "./runs.js";
import { insertTask, getTask, tasksForRun } from "./tasks.js";
import { logEvent, eventsForTask } from "./events.js";
import { gatesForTask } from "./gates.js";
import {
  createCampaign,
  addCampaignItem,
  updateCampaignItem,
  updateCampaignStatus,
  getCampaignItem,
  listCampaignItems,
} from "./campaigns.js";
import { gate } from "../v2/gate.js";
import { setCrashHookForTest } from "../v2/crash-points.js";
import { DB_PATH } from "../util/paths.js";
import { nowIso } from "../util/ids.js";
import type { Task } from "../types/index.js";

const STORE_DIR = dirname(fileURLToPath(import.meta.url));
const SRC = join(STORE_DIR, "..");
const REPO = join(SRC, "..");

// Barrier-synchronized rounds per contended path. Raise to hammer:
// FG548_PATH_ITERS=500 npm run test:integration.
const ITERATIONS = Number(process.env["FG548_PATH_ITERS"] ?? 60);
// The sweep contends through the real CLI, so each round is a process launch.
const SWEEP_ROUNDS = Number(process.env["FG548_SWEEP_ROUNDS"] ?? 4);

const WORKFLOW = "fg548-gate";

// ── shared subprocess harness ────────────────────────────────────────────────

type DriverResult = { code: number; stdout: string; stderr: string };

function runNode(args: string[], opts: { cwd?: string } = {}): Promise<DriverResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: opts.cwd ?? REPO,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
    child.on("exit", (code) => resolve({ code: code ?? -1, stdout, stderr }));
    child.on("error", reject);
  });
}

const BUSY = /database is locked|SQLITE_BUSY/;

function assertNoBusy(label: string, res: DriverResult): void {
  assert.doesNotMatch(
    res.stderr,
    BUSY,
    `${label} hit SQLITE_BUSY — this write path is not taking the write lock up front:\n${res.stderr}`,
  );
}

function lastJson(stdout: string): Record<string, unknown> {
  const line = stdout.trim().split("\n").pop() ?? "{}";
  return JSON.parse(line) as Record<string, unknown>;
}

function tmpDirs(): { work: string; barrier: string; cleanup: () => void } {
  const work = mkdtempSync(join(tmpdir(), "fg548p-"));
  const barrier = mkdtempSync(join(tmpdir(), "fg548p-barrier-"));
  return { work, barrier, cleanup: () => {
    rmSync(work, { recursive: true, force: true });
    rmSync(barrier, { recursive: true, force: true });
  } };
}

// ── fixtures ─────────────────────────────────────────────────────────────────

function ensureGateWorkflow(): void {
  const dir = join(process.env["FORGE_HOME"]!, "workflows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${WORKFLOW}.yml`),
    `name: ${WORKFLOW}\ndescription: FG-548 contention fixture\ninputs: []\nsteps:\n  - id: verify\n    agent: engineer\n    gate: human\n`,
  );
}

function mkTask(id: string, runId: string, status: Task["status"]): Task {
  return {
    id,
    runId,
    phase: "verify",
    agentRole: "engineer",
    status,
    taskPackage: { taskId: id, runId, phase: "verify", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    result: { status: "complete" },
    createdAt: nowIso(),
    startedAt: nowIso(),
  };
}

/** One awaiting_gate task per (side, round) — each side gates only its OWN rows,
 *  so the two processes contend over the WAL write lock, never over a row. */
function seedGate(sides: string[]): Record<string, { taskId: string }[]> {
  ensureGateWorkflow();
  const manifest: Record<string, { taskId: string }[]> = {};
  for (const side of sides) {
    manifest[side] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const runId = `run-fg548-gate-${side}-${i}`;
      const taskId = `task-fg548-gate-${side}-${i}`;
      insertRun({ id: runId, workflow: WORKFLOW, title: `gate ${side} ${i}`, status: "active", createdAt: nowIso() });
      insertTask(mkTask(taskId, runId, "awaiting_gate"));
      manifest[side]!.push({ taskId });
    }
  }
  return manifest;
}

/** A paused campaign per (side, round) whose single item is failed+blocked on a
 *  retryable (infrastructure) blocker — the precondition retryCampaignItem's CAS
 *  demands. */
function seedCampaign(sides: string[]): Record<string, { campaignId: string; ticketId: string; itemId: string }[]> {
  const manifest: Record<string, { campaignId: string; ticketId: string; itemId: string }[]> = {};
  for (const side of sides) {
    manifest[side] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const campaign = createCampaign({
        sourceKind: "list",
        sourceInput: { ticketIds: [`FG-548-${side}-${i}`] },
        mode: "sequential",
        projectDir: "/tmp/test-project",
      });
      const ticketId = `FG-548-${side}-${i}`;
      const item = addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId });
      updateCampaignStatus(campaign.id, "running");
      updateCampaignStatus(campaign.id, "paused");
      updateCampaignItem(item.id, {
        lifecycleStatus: "failed",
        outcome: "blocked",
        blockerKind: "infrastructure",
        reason: "host docker daemon died",
      });
      manifest[side]!.push({ campaignId: campaign.id, ticketId, itemId: item.id });
    }
  }
  return manifest;
}

/** A running, containerized task with no result — reconcileRun's orphan-fail
 *  write transaction (markTaskFailed + task.failed + task.reconciled). */
function seedReconcile(sides: string[]): Record<string, { runId: string; taskId: string }[]> {
  const manifest: Record<string, { runId: string; taskId: string }[]> = {};
  for (const side of sides) {
    manifest[side] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const runId = `run-fg548-rec-${side}-${i}`;
      const taskId = `task-fg548-rec-${side}-${i}`;
      insertRun({ id: runId, workflow: "invoke", title: `rec ${side} ${i}`, status: "active", createdAt: nowIso() });
      insertTask(mkTask(taskId, runId, "running"));
      logEvent("container.started", { runId, taskId, payload: { containerName: `forge-${taskId}` } });
      manifest[side]!.push({ runId, taskId });
    }
  }
  return manifest;
}

/** A task per (side, round) to hang usage rows off (model_calls.task_id is a FK). */
function seedUsage(sides: string[]): Record<string, { taskId: string }[]> {
  const manifest: Record<string, { taskId: string }[]> = {};
  for (const side of sides) {
    manifest[side] = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const runId = `run-fg548-usage-${side}-${i}`;
      const taskId = `task-fg548-usage-${side}-${i}`;
      insertRun({ id: runId, workflow: "invoke", title: `usage ${side} ${i}`, status: "active", createdAt: nowIso() });
      insertTask(mkTask(taskId, runId, "complete"));
      manifest[side]!.push({ taskId });
    }
  }
  return manifest;
}

// ── the contention driver ────────────────────────────────────────────────────
//
// One driver, four paths. Both sides sit on a file barrier at every round, so
// each round puts both processes inside the other's transaction window by
// construction rather than by luck.

function writeContentionDriver(dir: string): string {
  const path = join(dir, "contend.mjs");
  writeFileSync(
    path,
    `
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getDb } from ${JSON.stringify(join(SRC, "store", "db.ts"))};
import { insertUsageRows } from ${JSON.stringify(join(SRC, "store", "model-calls.ts"))};
import { gate } from ${JSON.stringify(join(SRC, "v2", "gate.ts"))};
import { reconcileRun } from ${JSON.stringify(join(SRC, "v2", "reconcile.ts"))};
import { retryCampaignItem } from ${JSON.stringify(join(SRC, "campaign", "executor.ts"))};

const [pathName, side, other, barrierDir, iters] = process.argv.slice(2);
const n = Number(iters);
const rounds = JSON.parse(readFileSync(join(barrierDir, "manifest.json"), "utf8"))[side];

getDb();

// reconcileRun's container probes: the container is gone, nothing to reap, no
// docker in the loop. The DB write is what's under test.
const GONE = () => false;
const NO_REAP = () => "not_found";
const NO_EXIT = () => ({});

async function applyRound(i) {
  const r = rounds[i];
  switch (pathName) {
    case "gate": {
      const res = await gate(r.taskId, "advance", undefined, {});
      return res.task.status === "complete";
    }
    case "campaign-item-cas": {
      const res = retryCampaignItem(r.campaignId, r.ticketId);
      if (!res.ok) throw new Error("retryCampaignItem refused round " + i + ": " + res.reason);
      return true;
    }
    case "reconcile": {
      const res = reconcileRun(r.runId, GONE, NO_REAP, NO_EXIT);
      return res.taskChanges.some((c) => c.taskId === r.taskId && c.to === "failed");
    }
    case "usage-rows": {
      insertUsageRows([
        { taskId: r.taskId, requestId: "req-" + side + "-" + i, model: "m", alias: null,
          inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0, createdAt: new Date().toISOString() },
      ]);
      return true;
    }
    default:
      throw new Error("unknown path " + pathName);
  }
}

let applied = 0;
for (let i = 0; i < n; i++) {
  writeFileSync(join(barrierDir, side + "-" + i), "");
  const deadline = Date.now() + 20_000;
  while (!existsSync(join(barrierDir, other + "-" + i))) {
    if (Date.now() > deadline) throw new Error(side + ": barrier timeout at round " + i);
  }
  // No try/catch. A SQLITE_BUSY here must kill the process — no retry shim.
  if (await applyRound(i)) applied++;
}
process.stdout.write(JSON.stringify({ side, applied }) + "\\n");
process.exit(0);
`,
  );
  return path;
}

async function contend(pathName: string, barrier: string, driver: string): Promise<void> {
  const [a, b] = await Promise.all([
    runNode([driver, pathName, "a", "b", barrier, String(ITERATIONS)]),
    runNode([driver, pathName, "b", "a", barrier, String(ITERATIONS)]),
  ]);
  for (const [side, res] of [["a", a], ["b", b]] as const) {
    assertNoBusy(`${pathName} driver ${side}`, res);
    assert.equal(res.code, 0, `${pathName} driver ${side} exited ${res.code}:\n${res.stderr}`);
    assert.equal(
      lastJson(res.stdout)["applied"],
      ITERATIONS,
      `${pathName} driver ${side} applied fewer than ${ITERATIONS} writes:\n${res.stdout}\n${res.stderr}`,
    );
  }
}

// ── 1. the control experiment: deterministic, not probabilistic ──────────────

function writeSnapshotDriver(dir: string): string {
  const path = join(dir, "snapshot.mjs");
  writeFileSync(
    path,
    `
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, writeTransaction } from ${JSON.stringify(join(SRC, "store", "db.ts"))};

const [mode, role, barrierDir] = process.argv.slice(2);
const db = getDb();
const flag = (name) => join(barrierDir, name);
const wait = (name) => {
  const deadline = Date.now() + 30_000;
  while (!existsSync(flag(name))) {
    if (Date.now() > deadline) throw new Error(role + ": timed out waiting for " + name);
  }
};

const readTitle = () => db.prepare("SELECT title FROM runs WHERE id = 'ctl-reader'").get().title;
const writeTitle = (t) => db.prepare("UPDATE runs SET title = ? WHERE id = 'ctl-writer'").run(t);

if (role === "reader") {
  // The read-modify-write. In DEFERRED form its snapshot is taken at the SELECT
  // and the UPDATE tries to upgrade it — after the other process has committed,
  // which is the FG-548 crash. In IMMEDIATE form (writeTransaction) the write
  // lock is already held at BEGIN, so there is no snapshot to upgrade.
  const body = () => {
    const seen = readTitle();
    writeFileSync(flag("reader-has-snapshot"), "");
    if (mode === "deferred") wait("writer-committed"); // force the stale window
    db.prepare("UPDATE runs SET title = ? WHERE id = 'ctl-reader'").run("rmw:" + seen);
    return seen;
  };
  if (mode === "deferred") db.transaction(body)();   // the pre-FG-548 shape
  else writeTransaction(body);                       // the FG-548 shape
  process.stdout.write(JSON.stringify({ role, ok: true }) + "\\n");
} else {
  wait("reader-has-snapshot");
  // In immediate mode the reader holds the write lock, so this queues on
  // busy_timeout instead of failing — that is the whole point of the fix.
  writeTitle("writer-committed");
  writeFileSync(flag("writer-committed"), "");
  process.stdout.write(JSON.stringify({ role, ok: true }) + "\\n");
}
process.exit(0);
`,
  );
  return path;
}

test("FG-548 (control): a DEFERRED read-modify-write dies of SQLITE_BUSY on this harness; the same interleave through writeTransaction() does not", { timeout: 300_000 }, async () => {
  const { work, barrier, cleanup } = tmpDirs();
  try {
    getDb();
    for (const id of ["ctl-reader", "ctl-writer"]) {
      insertRun({ id, workflow: "invoke", title: "pre", status: "active", createdAt: nowIso() });
    }
    const driver = writeSnapshotDriver(work);

    // (a) deferred — the bug. Deterministic: the writer commits INSIDE the
    // reader's read→write window every time, so this is not a 1-in-N hammer.
    const deferredBarrier = mkdtempSync(join(barrier, "deferred-"));
    const [reader, writer] = await Promise.all([
      runNode([driver, "deferred", "reader", deferredBarrier]),
      runNode([driver, "deferred", "writer", deferredBarrier]),
    ]);
    assert.equal(writer.code, 0, `the plain writer must always succeed:\n${writer.stderr}`);
    assert.notEqual(reader.code, 0, "a deferred read-modify-write whose snapshot went stale must NOT succeed — if it did, this harness proves nothing about the fix");
    assert.match(
      reader.stderr,
      BUSY,
      `the deferred reader must die of SQLITE_BUSY (that IS FG-548). It failed some other way:\n${reader.stderr}`,
    );
    // The bug is a lost write, not just noise: the read-modify-write never landed.
    assert.equal(getRun("ctl-reader")?.title, "pre", "the deferred RMW must have rolled back");

    // (b) immediate, via the shipped helper — same interleave, no crash.
    getDb().prepare(`UPDATE runs SET title = 'pre' WHERE id IN ('ctl-reader','ctl-writer')`).run();
    const immediateBarrier = mkdtempSync(join(barrier, "immediate-"));
    const [reader2, writer2] = await Promise.all([
      runNode([driver, "immediate", "reader", immediateBarrier]),
      runNode([driver, "immediate", "writer", immediateBarrier]),
    ]);
    for (const [role, res] of [["reader", reader2], ["writer", writer2]] as const) {
      assertNoBusy(`immediate ${role}`, res);
      assert.equal(res.code, 0, `immediate ${role} exited ${res.code}:\n${res.stderr}`);
    }
    // Both writes landed: the contending writer queued on busy_timeout behind the
    // write lock the helper took at BEGIN, then committed.
    assert.equal(getRun("ctl-reader")?.title, "rmw:pre", "the helper's read-modify-write must commit");
    assert.equal(getRun("ctl-writer")?.title, "writer-committed", "the contending writer must commit too");
  } finally {
    cleanup();
  }
});

// ── 2–5. the OTHER converted paths, under real cross-process contention ──────

test("FG-548: gate() decision writes from two real processes never hit SQLITE_BUSY", { timeout: 600_000 }, async () => {
  const { work, barrier, cleanup } = tmpDirs();
  try {
    getDb();
    const manifest = seedGate(["a", "b"]);
    writeFileSync(join(barrier, "manifest.json"), JSON.stringify(manifest));

    await contend("gate", barrier, writeContentionDriver(work));

    for (const side of ["a", "b"]) {
      for (let i = 0; i < ITERATIONS; i++) {
        const taskId = `task-fg548-gate-${side}-${i}`;
        assert.equal(getTask(taskId)?.status, "complete", `${taskId} did not advance`);
        // The gate's write transaction is gates-row + gate.decided event. Both
        // must be there — a partially applied decision is the atomicity failure
        // FG-427 exists to prevent, and it must survive the conversion.
        assert.equal(gatesForTask(taskId).length, 1, `${taskId} has no gate row`);
        assert.ok(
          eventsForTask(taskId).some((e) => e.eventType === "gate.decided"),
          `${taskId} has a gate row but no gate.decided event`,
        );
      }
    }
  } finally {
    cleanup();
  }
});

test("FG-548: the campaign-item CAS (retryCampaignItem) survives two real processes retrying items concurrently", { timeout: 600_000 }, async () => {
  const { work, barrier, cleanup } = tmpDirs();
  try {
    getDb();
    const manifest = seedCampaign(["a", "b"]);
    writeFileSync(join(barrier, "manifest.json"), JSON.stringify(manifest));

    await contend("campaign-item-cas", barrier, writeContentionDriver(work));

    for (const side of ["a", "b"]) {
      for (const round of manifest[side]!) {
        const item = getCampaignItem(round.itemId)!;
        assert.equal(item.lifecycleStatus, "pending", `${round.itemId} was not reset`);
        assert.equal(item.outcome, undefined, `${round.itemId} kept its blocked outcome`);
        assert.equal(item.blockerKind, undefined, `${round.itemId} kept its blockerKind`);
      }
    }
  } finally {
    cleanup();
  }
});

test("FG-548: reconcileRun's orphan-fail write transaction survives two real processes reconciling concurrently", { timeout: 600_000 }, async () => {
  const { work, barrier, cleanup } = tmpDirs();
  try {
    getDb();
    const manifest = seedReconcile(["a", "b"]);
    writeFileSync(join(barrier, "manifest.json"), JSON.stringify(manifest));

    await contend("reconcile", barrier, writeContentionDriver(work));

    for (const side of ["a", "b"]) {
      for (const round of manifest[side]!) {
        assert.equal(getTask(round.taskId)?.status, "failed", `${round.taskId} was not failed`);
        const kinds = eventsForTask(round.taskId).map((e) => e.eventType);
        // markTaskFailed + task.failed + task.reconciled are ONE transaction
        // (FG-463). All three or none — never a status with no audit trail.
        assert.ok(kinds.includes("task.failed"), `${round.taskId} failed with no task.failed event`);
        assert.ok(kinds.includes("task.reconciled"), `${round.taskId} failed with no task.reconciled event`);
      }
    }
  } finally {
    cleanup();
  }
});

test("FG-548: the usage-row batch (insertUsageRows) survives two real processes capturing usage concurrently", { timeout: 600_000 }, async () => {
  const { work, barrier, cleanup } = tmpDirs();
  try {
    getDb();
    const manifest = seedUsage(["a", "b"]);
    writeFileSync(join(barrier, "manifest.json"), JSON.stringify(manifest));

    await contend("usage-rows", barrier, writeContentionDriver(work));

    const rows = getDb()
      .prepare(`SELECT task_id FROM model_calls WHERE task_id LIKE 'task-fg548-usage-%'`)
      .all() as { task_id: string }[];
    assert.equal(rows.length, ITERATIONS * 2, "every usage row from both processes must have landed");
  } finally {
    cleanup();
  }
});

test("FG-548: two real `forge sweep` processes racing over the SAME phantom runs close each run exactly once, with no SQLITE_BUSY", { timeout: 600_000 }, async () => {
  // Unlike the paths above, both processes here read and write the SAME rows:
  // sweep selects every phantom-active run, then closes them in one transaction.
  // The row-level CAS (`WHERE status = 'active'`) decides the winner; the write
  // transaction must not crash the loser.
  const PHANTOMS = 25;
  for (let round = 0; round < SWEEP_ROUNDS; round++) {
    const ids: string[] = [];
    for (let i = 0; i < PHANTOMS; i++) {
      const runId = `run-fg548-sweep-${round}-${i}`;
      const taskId = `task-fg548-sweep-${round}-${i}`;
      insertRun({ id: runId, workflow: "invoke", title: `sweep ${round} ${i}`, status: "active", createdAt: nowIso() });
      insertTask({ ...mkTask(taskId, runId, "complete"), completedAt: nowIso() });
      ids.push(runId);
    }

    const [x, y] = await Promise.all([
      runNode([join(SRC, "cli", "index.ts"), "sweep", "--json"]),
      runNode([join(SRC, "cli", "index.ts"), "sweep", "--json"]),
    ]);

    for (const [label, res] of [["sweep-1", x], ["sweep-2", y]] as const) {
      assertNoBusy(label, res);
      assert.equal(res.code, 0, `${label} exited ${res.code}:\n${res.stderr}`);
    }
    for (const id of ids) {
      assert.equal(getRun(id)?.status, "complete", `${id} was left active by the racing sweeps`);
      // Chronological honesty (#157) survives the conversion: completed_at is the
      // task's timestamp, not the sweep's clock.
      const task = tasksForRun(id)[0]!;
      assert.equal(
        (getDb().prepare(`SELECT completed_at FROM runs WHERE id = ?`).get(id) as { completed_at: string }).completed_at,
        task.completedAt,
      );
    }
  }
});

// ── 6. reads were NOT dragged into the write lock ────────────────────────────

function writeHoldDriver(dir: string): string {
  const path = join(dir, "hold.mjs");
  writeFileSync(
    path,
    `
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getDb, writeTransaction } from ${JSON.stringify(join(SRC, "store", "db.ts"))};

const [barrierDir, holdMs] = process.argv.slice(2);
getDb();
writeTransaction(() => {
  getDb().prepare("UPDATE runs SET title = 'held' WHERE id = 'hold-target'").run();
  writeFileSync(join(barrierDir, "lock-held"), "");
  const until = Date.now() + Number(holdMs);
  while (Date.now() < until) { /* hold the write lock */ }
});
process.stdout.write(JSON.stringify({ released: true }) + "\\n");
process.exit(0);
`,
  );
  return path;
}

test("FG-548: a held write lock does not block the read paths — the fix did not make reads immediate", { timeout: 300_000 }, async () => {
  const HOLD_MS = 2500;
  const { work, barrier, cleanup } = tmpDirs();
  try {
    getDb();
    insertRun({ id: "hold-target", workflow: "invoke", title: "pre", status: "active", createdAt: nowIso() });
    insertRun({ id: "hold-other", workflow: "invoke", title: "other", status: "active", createdAt: nowIso() });
    insertTask(mkTask("task-hold", "hold-target", "complete"));
    const campaign = createCampaign({ sourceKind: "list", sourceInput: {}, mode: "sequential", projectDir: "/tmp/test-project" });
    addCampaignItem({ campaignId: campaign.id, itemOrder: 0, ticketId: "FG-548-hold" });

    const holder = runNode([writeHoldDriver(work), barrier, String(HOLD_MS)]);
    const deadline = Date.now() + 30_000;
    while (!existsSync(join(barrier, "lock-held"))) {
      if (Date.now() > deadline) throw new Error("the holder never took the write lock");
      await new Promise((r) => setTimeout(r, 5));
    }

    // Another process is holding the write lock. Every read path must still
    // answer immediately, from its own WAL snapshot — if any of them had been
    // "fixed" into a BEGIN IMMEDIATE, it would queue here for the full hold.
    const started = Date.now();
    const run = getRun("hold-target");
    const tasks = tasksForRun("hold-target");
    const items = listCampaignItems(campaign.id);
    const events = eventsForTask("task-hold");
    const elapsed = Date.now() - started;

    assert.ok(
      elapsed < HOLD_MS / 3,
      `the read paths took ${elapsed}ms while another process held the write lock (hold: ${HOLD_MS}ms) — a read path is taking the write lock`,
    );
    assert.equal(run?.title, "pre", "a reader must see its own snapshot, not the writer's uncommitted row");
    assert.equal(tasks.length, 1);
    assert.equal(items.length, 1);
    assert.equal(events.length, 0);

    // Control for the assertion above: the lock really WAS held. A write from this
    // process queues on busy_timeout for the rest of the hold, then succeeds — so
    // the fast reads above are evidence about reads, not about an absent lock.
    const writeStarted = Date.now();
    getDb().prepare(`UPDATE runs SET title = 'queued-behind-the-lock' WHERE id = 'hold-other'`).run();
    const writeElapsed = Date.now() - writeStarted;
    assert.ok(
      writeElapsed > HOLD_MS / 4,
      `a concurrent WRITE returned in ${writeElapsed}ms — the holder was not actually holding the write lock, so this test proves nothing`,
    );

    const res = await holder;
    assertNoBusy("hold driver", res);
    assert.equal(res.code, 0, `hold driver exited ${res.code}:\n${res.stderr}`);
    assert.equal(getRun("hold-target")?.title, "held", "the holder's write must be visible once it commits");
    assert.equal(getRun("hold-other")?.title, "queued-behind-the-lock");
  } finally {
    cleanup();
  }
});

// ── 7. rollback through the helper, on a real path ──────────────────────────

test("FG-548: a throw inside gate()'s write transaction rolls BOTH writes back, and no second connection ever sees the partial state", async () => {
  ensureGateWorkflow();
  const runId = "run-fg548-rollback";
  const taskId = "task-fg548-rollback";
  insertRun({ id: runId, workflow: WORKFLOW, title: "rollback", status: "active", createdAt: nowIso() });
  insertTask(mkTask(taskId, runId, "awaiting_gate"));

  // gate:inside-decision-write-txn fires BETWEEN insertGate and the gate.decided
  // event — the exact window a crash would leave a gate row with no audit event.
  setCrashHookForTest((point) => {
    if (point === "gate:inside-decision-write-txn") throw new Error("crash inside the gate's write txn");
  });
  try {
    await assert.rejects(() => gate(taskId, "advance", "rollback probe", {}), /crash inside the gate's write txn/);
  } finally {
    setCrashHookForTest(undefined);
  }

  assert.equal(gatesForTask(taskId).length, 0, "the gate row must have rolled back");
  assert.equal(eventsForTask(taskId).length, 0, "the gate.decided event must have rolled back");
  assert.equal(getTask(taskId)?.status, "awaiting_gate", "the task must not have advanced");

  // A SECOND connection (what another forge process is) must see the same thing:
  // BEGIN IMMEDIATE must not have leaked a partial write into the WAL.
  const other = new Database(DB_PATH, { readonly: true });
  try {
    const gates = other.prepare(`SELECT COUNT(*) AS n FROM gates WHERE task_id = ?`).get(taskId) as { n: number };
    const events = other.prepare(`SELECT COUNT(*) AS n FROM events WHERE task_id = ?`).get(taskId) as { n: number };
    assert.equal(gates.n, 0, "another process must not see the rolled-back gate row");
    assert.equal(events.n, 0, "another process must not see the rolled-back gate.decided event");
  } finally {
    other.close();
  }

  // And the path still works once the crash hook is gone — the rollback left no
  // wedged transaction behind on the connection.
  const res = await gate(taskId, "advance", "for real this time", {});
  assert.equal(res.task.status, "complete");
  assert.equal(gatesForTask(taskId).length, 1);
  assert.ok(eventsForTask(taskId).some((e) => e.eventType === "gate.decided"));
});
