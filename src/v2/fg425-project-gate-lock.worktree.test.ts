// FG-425 end-to-end concurrency regression: two REAL runs dispatched
// concurrently against ONE projectDir must never execute their merge →
// integration gate → finalize windows at the same time — and runs against
// DIFFERENT projectDirs must still overlap freely.
//
// The proof is a gate script that journals `start`/`end` timestamps to a log
// OUTSIDE the repo: interleaved starts (start,start,end,end) mean two runs
// were inside the protected window at once — exactly the FG-425 bug. On
// pre-FG-425 code this test fails; with the per-projectDir lock the windows
// serialize (start,end,start,end).
//
// Design note: mergeWorktreeBranch is --ff-only by design (races become
// detectable failures, FG-352). The second run's agent therefore commits NO
// files — its branch merge resolves "already up to date" whatever order the
// runs land in, so BOTH runs reach the integration gate and the serialization
// claim is exercised on the gate window itself.
//
// Platform: worktree mode is faked to darwin the way every other
// *.worktree.test.ts suite does — preflightWorktreeGate hard-fails on Linux and
// that gate is FG-358, not this ticket. The in-process test patches its own
// process; the cross-process drivers are fresh node processes, so the driver
// script patches itself before importing anything that reads the platform.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawn } from "node:child_process";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { tasksForRun } from "../store/tasks.js";
import { startRun } from "./startRun.js";
import { runNext, type DockerExecFn } from "./runNext.js";
import type { Workflow } from "./schema.js";

const WORKFLOW: Workflow = {
  name: "fg425-gate-lock-test",
  description: "FG-425 concurrency regression: single step, no reds",
  inputs: [],
  steps: [
    { id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "fg425-gate-lock-test", reds: [] },
  ],
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
const tmpDirs: string[] = [];

const ENV_VARS = ["FORGE_WORKTREES", "FORGE_NO_WORKTREES", "FORGE_WORKTREE_IGNORE_DIRTY", "FORGE_WORKTREES_EPHEMERAL", "ANTHROPIC_API_KEY"] as const;
const savedEnv: Partial<Record<(typeof ENV_VARS)[number], string>> = {};

const realPlatform = process.platform;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  for (const k of ENV_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  process.env.ANTHROPIC_API_KEY = "sk-stub";
  setPlatform("darwin");
  ensureRuntimeStub();
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const k of ENV_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
  setPlatform(realPlatform);
  for (const dir of tmpDirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

function setPlatform(p: string): void {
  Object.defineProperty(process, "platform", { value: p, configurable: true });
}

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg425-e2e-"));
  tmpDirs.push(dir);
  return dir;
}

/** Git repo whose test:unit journals `<tag> start/end <ms>` to `logPath`
 *  (outside the repo) around a deliberate hold — a visible gate window. */
function initGitRepoWithJournalingGate(dir: string, logPath: string, tag: string, holdMs: number): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@forge.test"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Forge Test"], { cwd: dir, stdio: "ignore" });
  writeFileSync(join(dir, "README.md"), "# fg425\n");
  const script =
    `node -e "const f=require('fs');` +
    `f.appendFileSync('${logPath}','${tag} start '+Date.now()+'\\n');` +
    `setTimeout(()=>f.appendFileSync('${logPath}','${tag} end '+Date.now()+'\\n'),${holdMs})"`;
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "fg425-fake-project", private: true, scripts: { "test:unit": script },
  }));
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
}

function ensureRuntimeStub(): void {
  const p = join(process.env.FORGE_HOME!, "runtimes", "fg425-gate-lock-test.yml");
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, `name: fg425-gate-lock-test
description: FG-425 test runtime stub
image: test-image:latest
models:
  default: test-model
auth:
  mode: apikey
env: {}
mounts:
  - host: "\${TASK_DIR}"
    container: /task
    mode: rw
  - host: "\${PROJECT_DIR}"
    container: /project
    mode: "\${PROJECT_MODE:-rw}"
invocation:
  command: echo
  args: ["stub"]
container:
  name: "forge-\${TASK_ID}"
  remove_on_exit: true
result:
  file: /task/result.json
`);
}

function findProjectMountHost(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v") {
      const [host, container] = (args[i + 1] ?? "").split(":");
      if (container?.startsWith("/project")) return host;
    }
  }
  return undefined;
}

function writeTaskResult(stdoutPath: string, result: unknown): void {
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
}

/** Agent stub that commits `fileName` on the worktree branch (or commits
 *  nothing when fileName is undefined — the "already up to date" merge). */
function makeExec(fileName?: string): DockerExecFn {
  return async ({ args, stdoutPath, stderrPath }) => {
    const worktreePath = findProjectMountHost(args);
    assert.ok(worktreePath, "stub: /project mount must be in docker args");
    writeFileSync(stderrPath, "");
    if (fileName) {
      writeFileSync(join(worktreePath!, fileName), "export const x = 1;\n");
      execFileSync("git", ["add", "."], { cwd: worktreePath!, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "task output"], { cwd: worktreePath!, stdio: "ignore" });
    }
    writeTaskResult(stdoutPath, {
      status: "complete", tests_run: 1,
      ...(fileName ? { files_modified: [fileName] } : {}),
    });
    return 0;
  };
}

type Window = { tag: string; start: number; end: number };

function parseWindows(logPath: string): Window[] {
  const events = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((l) => {
    const [tag, kind, ts] = l.split(" ");
    return { tag: tag!, kind: kind as "start" | "end", ts: Number(ts) };
  });
  const open = new Map<string, number[]>();
  const windows: Window[] = [];
  for (const e of events) {
    if (e.kind === "start") {
      open.set(e.tag, [...(open.get(e.tag) ?? []), e.ts]);
    } else {
      const starts = open.get(e.tag) ?? [];
      const start = starts.shift();
      assert.notEqual(start, undefined, `end without start for ${e.tag}`);
      windows.push({ tag: e.tag, start: start!, end: e.ts });
    }
  }
  return windows;
}

function overlaps(a: Window, b: Window): boolean {
  return a.start < b.end && b.start < a.end;
}

test("FG-425 e2e (in-process): two concurrent runs on ONE projectDir both complete green — no deadlock, windows serialized", async () => {
  process.env.FORGE_WORKTREES = "1";
  process.env.FORGE_WORKTREE_IGNORE_DIRTY = "1";

  const repo = makeTmpDir();
  const logDir = makeTmpDir();
  const logPath = join(logDir, "gate.log");
  initGitRepoWithJournalingGate(repo, logPath, "P", 200);

  const runA = startRun({ workflow: WORKFLOW, title: "fg425 run A", inputs: {}, projectDir: repo });
  const runB = startRun({ workflow: WORKFLOW, title: "fg425 run B", inputs: {}, projectDir: repo });

  const [waveA, waveB] = await Promise.all([
    runNext({ runId: runA.runId, workflow: WORKFLOW, dockerExec: makeExec("a.ts") }),
    runNext({ runId: runB.runId, workflow: WORKFLOW, dockerExec: makeExec(undefined) }),
  ]);

  // NOTE: within ONE process the gate (execFileSync) blocks the event loop,
  // so in-process windows serialize with or without the FG-425 lock — the
  // cross-process test below is the real mutual-exclusion regression. What
  // this test pins is that the lock introduces no self-deadlock or wedging
  // when two same-project runs interleave in one process.
  assert.deepEqual(waveA.failedSteps, [], `run A failed: ${JSON.stringify(tasksForRun(runA.runId).map((t) => t.error))}`);
  assert.deepEqual(waveB.failedSteps, [], `run B failed: ${JSON.stringify(tasksForRun(runB.runId).map((t) => t.error))}`);
  assert.deepEqual(waveA.completedSteps, ["build"]);
  assert.deepEqual(waveB.completedSteps, ["build"]);
  assert.ok(existsSync(join(repo, "a.ts")), "run A's merge landed");
  const windows = parseWindows(logPath);
  assert.equal(windows.length, 2, `expected exactly two gate executions, got: ${readFileSync(logPath, "utf8")}`);
  assert.equal(overlaps(windows[0]!, windows[1]!), false);
});

// ── Cross-process — the REAL FG-425 race ────────────────────────────────────
// Each `forge next` is its own OS process; only there can two gate windows
// genuinely overlap. Each driver child runs startRun+runNext against a SHARED
// file-backed DB and the shared FORGE_HOME runtime stub, with its own in-child
// docker stub. Pre-FG-425 the same-project journals interleave
// (start,start,end,end); with the lock they serialize.

function writeDriverScript(dir: string): string {
  const repoRoot = process.cwd();
  const p = join(dir, "fg425-driver.mjs");
  writeFileSync(p, `
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [, , projectDir, title, fileName] = process.argv;

// See the platform note at the top of the suite: this child is a fresh node
// process, so it must fake darwin itself before anything reads the platform.
Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

const TASKS_PATH = ${JSON.stringify(join(repoRoot, "src/store/tasks.ts"))};
const { startRun } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/startRun.ts"))}).href);
const { runNext } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/runNext.ts"))}).href);

const WORKFLOW = ${JSON.stringify(WORKFLOW)};

function findProjectMountHost(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v") {
      const [host, container] = (args[i + 1] ?? "").split(":");
      if (container?.startsWith("/project")) return host;
    }
  }
  return undefined;
}

const dockerExec = async ({ args, stdoutPath, stderrPath }) => {
  const worktreePath = findProjectMountHost(args);
  writeFileSync(stderrPath, "");
  if (fileName !== "none") {
    writeFileSync(join(worktreePath, fileName), "export const x = 1;\\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "task output"], { cwd: worktreePath, stdio: "ignore" });
  }
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify({
    status: "complete", tests_run: 1,
    ...(fileName !== "none" ? { files_modified: [fileName] } : {}),
  }));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
  return 0;
};

const { runId } = startRun({ workflow: WORKFLOW, title, inputs: {}, projectDir });
// FG-548: two processes finalizing runs concurrently can throw SQLITE_BUSY out
// of a DEFERRED write transaction's snapshot upgrade (busy_timeout does not
// apply there) — a pre-existing store seam this harness exposed, filed as its
// own ticket. Retry once, mirroring what forge's own reconcile/self-heal pass
// does after such a throw: the task work is durable, the second call lands on
// the completion check. Remove this shim when FG-548 closes.
let wave;
try {
  wave = await runNext({ runId, workflow: WORKFLOW, dockerExec });
} catch (e) {
  if (String(e).includes("SQLITE_BUSY") || String(e).includes("database is locked")) {
    await new Promise((r) => setTimeout(r, 150));
    wave = await runNext({ runId, workflow: WORKFLOW, dockerExec });
  } else {
    throw e;
  }
}
void wave; // waves from a retry are empty — durable task status below is the observable
const { tasksForRun } = await import(pathToFileURL(TASKS_PATH).href);
const build = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
console.log(JSON.stringify({ runId, buildStatus: build?.status ?? "missing", buildError: build?.error ?? null }));
`);
  return p;
}

type DriverOutcome = { runId: string; buildStatus: string; buildError: string | null };

function spawnDriver(driver: string, dbPath: string, projectDir: string, title: string, fileName: string): Promise<DriverOutcome> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", driver, projectDir, title, fileName], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORGE_DB_PATH: dbPath,
        FORGE_WORKTREES: "1",
        FORGE_WORKTREE_IGNORE_DIRTY: "1",
        ANTHROPIC_API_KEY: "sk-stub",
        NO_NOTIFY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`driver '${title}' exited ${code}: ${err}\n${out}`));
      try {
        const lastLine = out.trim().split("\n").filter(Boolean).pop()!;
        resolvePromise(JSON.parse(lastLine) as DriverOutcome);
      } catch (e) {
        reject(new Error(`driver '${title}' output unparseable: ${String(e)}\n${out}\n${err}`));
      }
    });
  });
}

test("FG-425 e2e (cross-process): two forge processes on ONE projectDir — gate windows NEVER overlap; both complete green", async () => {
  const repo = makeTmpDir();
  const scratch = makeTmpDir();
  const logPath = join(scratch, "gate.log");
  const dbPath = join(scratch, "forge-test.db");
  initGitRepoWithJournalingGate(repo, logPath, "P", 900);
  const driver = writeDriverScript(scratch);

  // Pre-migrate the shared file DB from one child so the two concurrent
  // drivers don't race the schema migration on a fresh file.
  await spawnDriver(driver, dbPath, makeTmpAsGitRepo(logPath), "fg425 migrate-warmup", "none");

  const [a, b] = await Promise.all([
    spawnDriver(driver, dbPath, repo, "fg425 xproc A", "a.ts"),
    spawnDriver(driver, dbPath, repo, "fg425 xproc B", "none"),
  ]);

  assert.equal(a.buildStatus, "complete", `run A must complete green: ${a.buildError}`);
  assert.equal(b.buildStatus, "complete", `run B must complete green — it WAITED for A's window instead of racing it: ${b.buildError}`);

  // Only the two same-project windows count (the warmup journaled to its own repo's log tag "P" too — see makeTmpAsGitRepo, which uses tag W).
  const windows = parseWindows(logPath).filter((w) => w.tag === "P");
  assert.equal(windows.length, 2, `expected two same-project gate executions, log: ${readFileSync(logPath, "utf8")}`);
  assert.equal(
    overlaps(windows[0]!, windows[1]!),
    false,
    `FG-425 REGRESSION: two processes were inside one project's merge→gate→finalize window at once: ${JSON.stringify(windows)}`,
  );
});

test("FG-425 e2e (cross-process): two forge processes on DIFFERENT projectDirs — gate windows OVERLAP (independent projects stay parallel)", async () => {
  const repoA = makeTmpDir();
  const repoB = makeTmpDir();
  const scratch = makeTmpDir();
  const logPath = join(scratch, "gate.log");
  const dbPath = join(scratch, "forge-test.db");
  initGitRepoWithJournalingGate(repoA, logPath, "A", 1500);
  initGitRepoWithJournalingGate(repoB, logPath, "B", 1500);
  const driver = writeDriverScript(scratch);

  await spawnDriver(driver, dbPath, makeTmpAsGitRepo(logPath), "fg425 migrate-warmup-2", "none");

  const [a, b] = await Promise.all([
    spawnDriver(driver, dbPath, repoA, "fg425 par A", "a.ts"),
    spawnDriver(driver, dbPath, repoB, "fg425 par B", "b.ts"),
  ]);

  assert.equal(a.buildStatus, "complete", `run A: ${a.buildError}`);
  assert.equal(b.buildStatus, "complete", `run B: ${b.buildError}`);

  const wa = parseWindows(logPath).find((w) => w.tag === "A");
  const wb = parseWindows(logPath).find((w) => w.tag === "B");
  assert.ok(wa && wb, `both projects' gates ran, log: ${readFileSync(logPath, "utf8")}`);
  assert.equal(overlaps(wa!, wb!), true, "independent projects must not serialize behind each other's gates");
});

/** A separate throwaway repo for the migration-warmup run (tag W so its gate
 *  journal lines never pollute the assertion tags). */
function makeTmpAsGitRepo(logPath: string): string {
  const dir = makeTmpDir();
  initGitRepoWithJournalingGate(dir, logPath, "W", 10);
  return dir;
}

// ── The finalize edge of the window (FG-425 review) ─────────────────────────
// The three fan-out merge/gate sites used to release the project lock after
// cleanup but BEFORE finalizing the parent task, so the protected window ended
// one step early: a same-project contender could enter it while the holding run
// had merged to HEAD but not yet claimed that HEAD by completing its parent.
// The single-step path never had the gap (its finalize is inside the closure).
//
// The proof holds the holder INSIDE finalizePrimary (the crash-point seam) for
// HOLD_MS and starts a real second process that tries to take the same
// project's window during that hold. With finalize inside the window the
// contender is excluded until the parent is complete; with finalize outside it
// walks straight in and observes a `running` parent.

const FANOUT_WORKFLOW: Workflow = {
  name: "fg425-gate-lock-fanout-test",
  description: "FG-425 finalize-inside-the-window regression: source → fanout build, no reds",
  inputs: [],
  steps: [
    { id: "source", agent: "planner", gate: "auto", manual: false, depends_on: [], runtime: "fg425-gate-lock-test", reds: [] },
    {
      id: "build",
      agent: "engineer",
      gate: "auto",
      manual: false,
      depends_on: ["source"],
      runtime: "fg425-gate-lock-test",
      reds: [],
      fanout: {
        from_upstream: { step: "source", array_key: "items", input_key: "item" },
        max_concurrency: 2,
        failure_mode: "continue",
      },
    },
  ],
};

const FINALIZE_HOLD_MS = 1500;

/** The holder: a real forge process running the fan-out workflow, which blocks
 *  synchronously inside the fan-out parent's finalizePrimary and journals the
 *  hold. Hit 1 of the crash point is the `source` primary; hit 2 is the fan-out
 *  parent (children complete via markTaskComplete and never reach it). */
function writeFanoutHolderScript(dir: string): string {
  const repoRoot = process.cwd();
  const p = join(dir, "fg425-finalize-holder.mjs");
  writeFileSync(p, `
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const [, , projectDir, title, finalizeLog, runIdFile] = process.argv;

Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

const { startRun } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/startRun.ts"))}).href);
const { runNext } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/runNext.ts"))}).href);
const { setCrashHookForTest } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/crash-points.ts"))}).href);
const { tasksForRun } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/store/tasks.ts"))}).href);

const WORKFLOW = ${JSON.stringify(FANOUT_WORKFLOW)};
const HOLD_MS = ${FINALIZE_HOLD_MS};

// A SYNCHRONOUS hold — finalizePrimary is sync, so this pins the process
// mid-finalize exactly as a slow status write would.
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let finalizeHits = 0;
setCrashHookForTest((point) => {
  if (point !== "finalizePrimary:before-status-write") return;
  finalizeHits++;
  if (finalizeHits !== 2) return;
  appendFileSync(finalizeLog, "F start " + Date.now() + "\\n");
  sleepSync(HOLD_MS);
  appendFileSync(finalizeLog, "F end " + Date.now() + "\\n");
});

function extractTaskId(args) {
  const i = args.indexOf("--name");
  return i >= 0 ? (args[i + 1] ?? "").replace(/^forge-/, "") : "";
}

function findProjectMountHost(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-v") {
      const [host, container] = (args[i + 1] ?? "").split(":");
      if (container?.startsWith("/project")) return host;
    }
  }
  return undefined;
}

const dockerExec = async ({ args, stdoutPath, stderrPath }) => {
  const taskId = extractTaskId(args);
  const worktreePath = findProjectMountHost(args);
  writeFileSync(stderrPath, "");
  let result;
  if (taskId.startsWith("task-source-")) {
    // The source primary commits nothing — its merge is "already up to date".
    result = { status: "complete", tests_run: 1, items: ["item-a", "item-b"] };
  } else {
    // Each child commits a distinct file so the integration merge is clean.
    const fileName = taskId + ".ts";
    writeFileSync(join(worktreePath, fileName), "export const x = 1;\\n");
    execFileSync("git", ["add", "."], { cwd: worktreePath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "child output"], { cwd: worktreePath, stdio: "ignore" });
    result = { status: "complete", tests_run: 1, files_modified: [fileName] };
  }
  const dir = dirname(stdoutPath);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "result.json"), JSON.stringify(result));
  writeFileSync(stdoutPath, "stub stdout");
  writeFileSync(join(dir, "container.stderr.log"), "");
  return 0;
};

const { runId } = startRun({ workflow: WORKFLOW, title, inputs: {}, projectDir });
writeFileSync(runIdFile, runId);

await runNext({ runId, workflow: WORKFLOW, dockerExec });  // wave 1: source
await runNext({ runId, workflow: WORKFLOW, dockerExec });  // wave 2: fanout children + parent

const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
console.log(JSON.stringify({ runId, buildStatus: parent?.status ?? "missing", buildError: parent?.error ?? null }));
`);
  return p;
}

/** The contender: a second real process that waits until the holder is INSIDE
 *  its finalize, then tries to take the same project's integration window and
 *  records the holder's parent status at the moment it gets in. */
function writeContenderScript(dir: string): string {
  const repoRoot = process.cwd();
  const p = join(dir, "fg425-contender.mjs");
  writeFileSync(p, `
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const [, , projectDir, finalizeLog, runIdFile, contenderLog] = process.argv;

Object.defineProperty(process, "platform", { value: "darwin", configurable: true });

const { withProjectIntegrationLock } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/v2/project-integration-lock.ts"))}).href);
const { tasksForRun } = await import(pathToFileURL(${JSON.stringify(join(repoRoot, "src/store/tasks.ts"))}).href);

function read(file) {
  try { return readFileSync(file, "utf8"); } catch { return ""; }
}

const deadline = Date.now() + 60_000;
while (!read(finalizeLog).includes("F start")) {
  if (Date.now() > deadline) throw new Error("contender: holder never reached its finalize");
  await new Promise((r) => setTimeout(r, 10));
}

const runId = read(runIdFile).trim();
appendFileSync(contenderLog, "C attempt " + Date.now() + "\\n");
await withProjectIntegrationLock(projectDir, "contender-run", () => {
  const parent = tasksForRun(runId).find((t) => t.phase === "build" && t.parentId === undefined);
  appendFileSync(contenderLog, "C enter " + Date.now() + " " + (parent?.status ?? "missing") + "\\n");
}, { pollMs: 25 });

console.log(JSON.stringify({ ok: true }));
`);
  return p;
}

function spawnScript(script: string, dbPath: string, argv: string[], label: string): Promise<Record<string, unknown>> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, ...argv], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        FORGE_DB_PATH: dbPath,
        FORGE_WORKTREES: "1",
        FORGE_WORKTREE_IGNORE_DIRTY: "1",
        ANTHROPIC_API_KEY: "sk-stub",
        NO_NOTIFY: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += String(d); });
    child.stderr.on("data", (d) => { err += String(d); });
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`${label} exited ${code}: ${err}\n${out}`));
      try {
        resolvePromise(JSON.parse(out.trim().split("\n").filter(Boolean).pop()!) as Record<string, unknown>);
      } catch (e) {
        reject(new Error(`${label} output unparseable: ${String(e)}\n${out}\n${err}`));
      }
    });
  });
}

test("FG-425 e2e (cross-process): a same-project contender is excluded until the fan-out parent is FINALIZED, not merely merged", async () => {
  const repo = makeTmpDir();
  const scratch = makeTmpDir();
  const gateLog = join(scratch, "gate.log");
  const finalizeLog = join(scratch, "finalize.log");
  const contenderLog = join(scratch, "contender.log");
  const runIdFile = join(scratch, "holder-runid.txt");
  const dbPath = join(scratch, "forge-test.db");
  initGitRepoWithJournalingGate(repo, gateLog, "P", 50);

  const holderScript = writeFanoutHolderScript(scratch);
  const contenderScript = writeContenderScript(scratch);

  // Same schema-migration warmup as the tests above (own repo, tag W).
  await spawnDriver(writeDriverScript(scratch), dbPath, makeTmpAsGitRepo(gateLog), "fg425 migrate-warmup-3", "none");

  // Contender first: it boots and parks on the finalize journal, so node/tsx
  // startup is not part of the race it has to win.
  const contenderDone = spawnScript(contenderScript, dbPath, [repo, finalizeLog, runIdFile, contenderLog], "contender");
  const holderDone = spawnScript(holderScript, dbPath, [repo, "fg425 finalize-holder", finalizeLog, runIdFile], "holder");
  const [holder] = await Promise.all([holderDone, contenderDone]);

  assert.equal(holder["buildStatus"], "complete", `fan-out parent must complete green: ${String(holder["buildError"])}`);

  const fin = readFileSync(finalizeLog, "utf8");
  const con = readFileSync(contenderLog, "utf8");
  const fStart = Number(/F start (\d+)/.exec(fin)?.[1]);
  const fEnd = Number(/F end (\d+)/.exec(fin)?.[1]);
  const cAttempt = Number(/C attempt (\d+)/.exec(con)?.[1]);
  const enter = /C enter (\d+) (\w+)/.exec(con);
  assert.ok(fStart && fEnd && cAttempt && enter, `expected both journals populated — finalize: ${fin} contender: ${con}`);
  const cEnter = Number(enter![1]);

  // Guard against a vacuous pass: the contender must genuinely have been
  // contending WHILE the parent was mid-finalize.
  assert.ok(
    cAttempt < fEnd,
    `inconclusive, not a pass: the contender only attempted the window after the finalize hold ended (attempt ${cAttempt}, hold ended ${fEnd})`,
  );
  assert.ok(
    cEnter >= fEnd,
    `FG-425 REGRESSION: a same-project contender entered the integration window while the fan-out parent was still being finalized ` +
      `(entered ${cEnter}, finalize ran ${fStart}→${fEnd}) — the merge landed on HEAD but the holding run had not yet claimed it`,
  );
  assert.equal(
    enter![2],
    "complete",
    "a contender inside the window must never observe a merged-but-unfinalized parent",
  );
});
