import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun, failRun, completeRun, updateRunStatus } from "../../store/runs.js";
import { insertTask, getTask, markTaskComplete, tasksForRun } from "../../store/tasks.js";
import { eventsForTask, eventsForRun, logEvent } from "../../store/events.js";
import { taskDir } from "../../util/paths.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { computeReadyQueue } from "../../v2/ready-queue.js";
import type { Workflow } from "../../v2/schema.js";
import { RE_DRIVABLE_FAILURE_KINDS, retryPolicy } from "../../v2/retry-policy.js";
import { performInspect, performContinue, performReDrive, performRecover } from "./recover.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const RUN: Run = { id: "run-recover", workflow: "invoke", title: "recover test", status: "active", createdAt: "2026-06-01T00:00:00Z" };

function mkTask(id: string, o: Partial<Task> = {}): Task {
  return {
    id,
    runId: o.runId ?? RUN.id,
    phase: o.phase ?? "task",
    agentRole: o.agentRole ?? "engineer",
    status: o.status ?? "running",
    taskPackage: { taskId: id, runId: o.runId ?? RUN.id, phase: o.phase ?? "task", role: o.agentRole ?? "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-01T00:00:00Z",
    startedAt: "2026-06-01T00:00:01Z",
    ...o,
  };
}

function insertContainerized(t: Task) {
  insertTask(t);
  logEvent("container.started", { runId: t.runId, taskId: t.id, payload: { containerName: `forge-${t.id}` } });
}

function makeDirtyGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-recover-worktree-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(join(dir, "changed-file.txt"), "uncommitted work\n");
  return dir;
}

function makeCleanGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-recover-worktree-clean-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

function piCleanEndStdout(text: string): string {
  return (
    JSON.stringify({ type: "agent_start" }) + "\n" +
    JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", stopReason: "end_turn", content: text }] }) + "\n"
  );
}

function codexCleanStreamStdout(terminalObject: unknown): string {
  return (
    JSON.stringify({ type: "turn.started" }) + "\n" +
    JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: JSON.stringify(terminalObject) } }) + "\n" +
    JSON.stringify({ type: "turn.completed", usage: {} }) + "\n"
  );
}

function writeCodexManifest(dir: string): void {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ runtime: { name: "codex-stub", kind: "codex", logFormat: "codex-jsonl", promptStrategy: "message-arg", authStrategy: "env-provider-api-key" } }),
  );
}

function writePiManifest(dir: string): void {
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({ runtime: { name: "pi-stub", kind: "pi", logFormat: "pi-jsonl", promptStrategy: "message-arg", authStrategy: "env-provider-api-key" } }),
  );
}

const tmpDirs: string[] = [];
function trackedDirtyGitRepo(): string {
  const d = makeDirtyGitRepo();
  tmpDirs.push(d);
  return d;
}

function trackedCleanGitRepo(): string {
  const d = makeCleanGitRepo();
  tmpDirs.push(d);
  return d;
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function getEvents(taskId: string) {
  return eventsForTask(taskId);
}

// ── inspect (default, read-only) ────────────────────────────────────────────

test("recover inspect: orphaned_work_may_persist task surfaces evidence, changed files, and a recommendation — read-only", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-inspect-dirty";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
  // No result.json, no stdout — reconcileRun settles this into orphaned_work_may_persist.
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed", "sanity: reconcile produced the fixture we want to inspect");

  const before = getTask(taskId)!;
  const beforeEvents = getEvents(taskId).length;

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.failureKind, "orphaned_work_may_persist");
  assert.deepEqual(outcome.task.changedFiles, ["?? changed-file.txt"]);
  assert.equal(outcome.task.source, "worktree");
  assert.equal(outcome.task.hasValidResult, false);
  assert.equal(outcome.task.hasStdoutRecoverableResult, false);
  assert.match(outcome.task.recommendation, /forge recover t-inspect-dirty --continue/);
  assert.ok(outcome.task.storedEvidence, "stored evidence from reconcile time is surfaced");

  // Read-only: no state change from inspecting.
  assert.deepEqual(getTask(taskId), before);
  assert.equal(getEvents(taskId).length, beforeEvents);
});

// FG-455 p4 review finding 2: oom_killed carries the same worktree-evidence
// shape as orphaned_work_may_persist and is now in CONTINUABLE_KINDS — it must
// be surfaced and recommended for --continue too, not omitted.
test("recover inspect: oom_killed task surfaces evidence, changed files, and a --continue recommendation — read-only", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-inspect-oom";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
  // containerExitInfo says oomKilled -> reconcileRun settles this into oom_killed.
  reconcileRun(RUN.id, () => false, undefined, () => ({ oomKilled: true, exitCode: 137 }));
  assert.equal(getTask(taskId)!.status, "failed", "sanity: reconcile produced the fixture we want to inspect");

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.failureKind, "oom_killed");
  assert.deepEqual(outcome.task.changedFiles, ["?? changed-file.txt"]);
  assert.equal(outcome.task.source, "worktree");
  assert.match(outcome.task.recommendation, /forge recover t-inspect-oom --continue/, "performContinue now accepts oom_killed — recommendationFor must not still refuse it");
  assert.ok(outcome.task.storedEvidence, "stored evidence from reconcile time is surfaced");
});

test("recover inspect: run id includes an oom_killed task among recoverable tasks", () => {
  const gitDir = trackedDirtyGitRepo();
  insertContainerized(mkTask("t-run-oom", { status: "running", worktreePath: gitDir }));
  reconcileRun(RUN.id, () => false, undefined, () => ({ oomKilled: true, exitCode: 137 }));

  const outcome = performInspect(RUN.id);
  assert.equal(outcome.kind, "inspect-run");
  if (outcome.kind !== "inspect-run") return;
  assert.ok(outcome.tasks.some((t) => t.taskId === "t-run-oom"), "oom_killed must not be filtered out of the run-level recoverable list");
});

// FG-455 p4 re-review: a clean-worktree oom_killed task (no result, no
// stdout-recoverable, no changed files) fell through to the generic "no
// persisted work found — safe to re-dispatch" bare `forge retry` fallback,
// but retry-policy.ts refuses a bare retry for oom_killed (retryable:false) —
// recommendationFor's final fallback must consult retryPolicy() too.
test("recover inspect: clean-worktree oom_killed task recommends --force, not the bare 'safe to re-dispatch' retry", () => {
  const gitDir = trackedCleanGitRepo();
  const taskId = "t-inspect-oom-clean";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
  reconcileRun(RUN.id, () => false, undefined, () => ({ oomKilled: true, exitCode: 137 }));
  assert.equal(getTask(taskId)!.status, "failed", "sanity: reconcile produced the fixture we want to inspect");

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.failureKind, "oom_killed");
  assert.deepEqual(outcome.task.changedFiles, [], "clean worktree: no changed files");
  assert.equal(outcome.task.hasValidResult, false);
  assert.equal(outcome.task.hasStdoutRecoverableResult, false);
  assert.match(outcome.task.recommendation, /--force/);
  assert.doesNotMatch(outcome.task.recommendation, /safe to re-dispatch from scratch/, "must not recommend the bare unguarded retry for a non-retryable kind");
});

// FG-455 p4 review finding 2: recommendationFor must not suggest a --continue
// performContinue will refuse — gate the recommendation by failure_kind, not
// just by whether evidence happens to be present.
test("recover inspect: a non-continuable failure_kind (e.g. container_crash) with a dirty worktree does NOT recommend --continue", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-inspect-noncontinuable";
  insertTask(mkTask(taskId, { status: "failed", worktreePath: gitDir }));
  logEvent("task.failed", { runId: RUN.id, taskId, payload: { failure_kind: "container_crash", error: "boom" } });

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.failureKind, "container_crash");
  assert.deepEqual(outcome.task.changedFiles, ["?? changed-file.txt"], "evidence is still gathered live");
  assert.doesNotMatch(
    outcome.task.recommendation,
    /^forge recover \S+ --continue/,
    "performContinue refuses container_crash — must not be the recommended command",
  );
  assert.equal(
    outcome.task.recommendation,
    `forge retry ${taskId}  (failure_kind=container_crash isn't continuable via --continue, but is retryable without --force; evidence found — inspect the diff first if unsure)`,
    "container_crash is retry-policy retryable without --force — recommending --force here is over-conservative",
  );
});

// FG-455 p4 review finding 3: recommendationFor over-recommended --force for
// ANY non-continuable kind with evidence, even kinds retry-policy.ts marks
// retryable without --force (container_crash, idle_timeout). Only a kind
// retry-policy.ts marks non-retryable should still get --force.
test("recover inspect: a non-continuable, non-retryable failure_kind (e.g. red_blocked) with evidence recommends --force", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-inspect-nonretryable";
  insertTask(mkTask(taskId, { status: "failed", worktreePath: gitDir }));
  logEvent("task.failed", { runId: RUN.id, taskId, payload: { failure_kind: "red_blocked", error: "blocked" } });

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.failureKind, "red_blocked");
  assert.match(outcome.task.recommendation, /^forge retry \S+ --force/, "red_blocked is not retry-policy retryable — --force is the correct recommendation");
});

test("recover inspect: shared project_dir evidence source is called out explicitly", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-inspect-shared";
  const run: Run = { ...RUN, id: "run-shared", projectDir: gitDir };
  insertRun(run);
  insertContainerized(mkTask(taskId, { runId: run.id, status: "running" })); // no worktreePath -> falls back to run.projectDir
  reconcileRun(run.id, () => false);

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.equal(outcome.task.source, "project_dir_shared");
  assert.match(outcome.task.recommendation, /--force/);
});

test("recover inspect: run id lists recoverable tasks and fanout parents", () => {
  const gitDir = trackedDirtyGitRepo();
  insertContainerized(mkTask("t-run-dirty", { status: "running", worktreePath: gitDir }));
  insertTask(mkTask("parent-inspect", { status: "running", phase: "build" }));
  insertTask(mkTask("child-inspect-1", { parentId: "parent-inspect", phase: "build", status: "complete" }));
  insertTask(mkTask("child-inspect-2", { parentId: "parent-inspect", phase: "build", status: "failed" }));
  reconcileRun(RUN.id, () => false);

  const outcome = performInspect(RUN.id);
  assert.equal(outcome.kind, "inspect-run");
  if (outcome.kind !== "inspect-run") return;
  assert.ok(outcome.tasks.some((t) => t.taskId === "t-run-dirty"));
  assert.ok(outcome.fanoutParents.some((f) => f.parentId === "parent-inspect"));
  const parentView = outcome.fanoutParents.find((f) => f.parentId === "parent-inspect")!;
  assert.equal(parentView.failureKind, "fanout_wave_orphaned");
  assert.match(parentView.recommendation, /--re-drive/);
});

// FG-479 review finding 2: forge recover <runId> (bulk run-level inspection)
// must surface an orphaned_needs_finalize task too — single-task `forge
// recover <taskId>` already does (buildTaskView has no kind filter), but the
// run-level listing filtered to CONTINUABLE_KINDS silently dropped it.
test("recover inspect: run id lists an orphaned_needs_finalize task even though it's not a CONTINUABLE_KIND", () => {
  const taskId = "t-run-needs-finalize";
  insertTask(mkTask(taskId, { status: "failed" }));
  logEvent("task.failed", {
    runId: RUN.id,
    taskId,
    payload: { failure_kind: "orphaned_needs_finalize", error: "orphaned_needs_finalize: ..." },
  });

  const outcome = performInspect(RUN.id);
  assert.equal(outcome.kind, "inspect-run");
  if (outcome.kind !== "inspect-run") return;
  assert.ok(outcome.tasks.some((t) => t.taskId === taskId), "orphaned_needs_finalize task must be listed for the run, not silently omitted");
});

test("recover inspect: unknown id", () => {
  const outcome = performInspect("no-such-id");
  assert.equal(outcome.kind, "unknown");
});

// ── --continue ───────────────────────────────────────────────────────────────

test("recover --continue: adopts an existing valid result.json and completes the task", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-result";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed");

  // Operator reviewed the diff and hand-wrote a result.json.
  mkdirSync(taskDir(RUN.id, taskId), { recursive: true });
  writeFileSync(join(taskDir(RUN.id, taskId), "result.json"), JSON.stringify({ status: "complete", summary: "verified and salvaged" }));

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continued");
  if (outcome.kind !== "continued") return;
  assert.equal(outcome.adoptedFrom, "result_json");
  const t = getTask(taskId)!;
  assert.equal(t.status, "complete");
  assert.deepEqual(t.result, { status: "complete", summary: "verified and salvaged" });
  const types = getEvents(taskId).map((e) => e.eventType);
  assert.ok(types.includes("task.completed"));
  assert.ok(types.includes("task.reconciled"));
  const reconciled = getEvents(taskId).find((e) => e.eventType === "task.reconciled" && (e.payload as Record<string, unknown>).via === "forge recover --continue");
  assert.ok(reconciled, "logs a task.reconciled with via: forge recover --continue");
});

test("recover --continue: adopts a stdout-recoverable result (stdout became readable after reconcile ran)", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-stdout";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir, agentRole: "research-specialist" }));
  reconcileRun(RUN.id, () => false); // at reconcile time, no manifest/stdout yet -> orphaned_work_may_persist
  assert.equal(getTask(taskId)!.status, "failed");

  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout("Recovered narrative output."));

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continued");
  if (outcome.kind !== "continued") return;
  assert.equal(outcome.adoptedFrom, "stdout_inferred");
  assert.deepEqual(getTask(taskId)!.result, { contract: "inferred", summary: "Recovered narrative output.", status: "complete" });
});

// FG-540 final pass: the malformed-file refusal gates ALL stdout recovery —
// including FG-337 narrative inference — never just the structured half. A
// present-but-corrupt result.json is evidence and is never replaced.
test("recover --continue: a non-empty MALFORMED result.json refuses narrative stdout inference too — the file is never overwritten", () => {
  const taskId = "t-continue-malformed-narrative";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: trackedCleanGitRepo(), agentRole: "research-specialist" }));
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed");

  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writePiManifest(dir);
  writeFileSync(join(dir, "container.stdout.log"), piCleanEndStdout("Recovered narrative output."));
  writeFileSync(join(dir, "result.json"), "{truncated-non-json");

  const outcome = performContinue(taskId);
  assert.notEqual(outcome.kind, "continued", "a malformed result.json must not be laundered into an adopted narrative");
  assert.equal(getTask(taskId)!.status, "failed", "the task stays failed");
  assert.equal(readFileSync(join(dir, "result.json"), "utf8"), "{truncated-non-json", "the malformed file is preserved as evidence");
});

// FG-540: recover reads stdout through the SAME shared extraction rule as
// invoke/runNext/reconcile — a codex stream that cleanly completed with a
// terminal JSON result object is recoverable HERE too, or the operator surface
// and reconcile would disagree about whether the task has a recoverable result.
test("recover --continue: adopts the structured result from a cleanly-completed codex stream (FG-540)", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-codex-stream";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir, agentRole: "red-wide" }));
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed");

  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeCodexManifest(dir);
  writeFileSync(join(dir, "container.stdout.log"), codexCleanStreamStdout({ verdict: "pass", findings: [] }));

  // The inspect view agrees with reconcile that there is something to recover —
  // red-wide is not a narrative role, so FG-337 synthesis alone recovers nothing.
  const inspected = performInspect(taskId);
  assert.equal(inspected.kind, "inspect-task");
  if (inspected.kind !== "inspect-task") return;
  assert.equal(inspected.task.hasStdoutRecoverableResult, true);

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continued");
  if (outcome.kind !== "continued") return;
  assert.equal(outcome.adoptedFrom, "stream_recovered");
  assert.deepEqual(getTask(taskId)!.result, { verdict: "pass", findings: [] });
  assert.ok(
    getEvents(taskId).some((e) => e.eventType === "task.result_recovered_from_stream"),
    "the recovery is recorded with the same provenance event as every other recovery site",
  );
});

test("recover --continue: a stream_recovered result whose result.json write FAILS is refused — task stays failed, no completion/reconciled/provenance events", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-codex-write-throws";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir, agentRole: "red-wide" }));
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed");

  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeCodexManifest(dir);
  writeFileSync(join(dir, "container.stdout.log"), codexCleanStreamStdout({ verdict: "pass", findings: [] }));
  // result.json is a DIRECTORY — persisting the structured result throws
  // EISDIR before markTaskRecovered ever runs (d82e136 rule: a structured
  // recovery may not complete a task it could not persist).
  mkdirSync(join(dir, "result.json"), { recursive: true });

  const outcome = performContinue(taskId, { force: true });
  assert.equal(outcome.kind, "continue-refused");
  if (outcome.kind !== "continue-refused") return;
  assert.match(outcome.reason, /could not persist/);

  const t = getTask(taskId)!;
  assert.equal(t.status, "failed", "the task stays failed — no completion without persistence");
  const types = getEvents(taskId).map((e) => e.eventType);
  assert.ok(!types.includes("task.completed"));
  assert.ok(!types.includes("task.result_recovered_from_stream"));
  assert.ok(
    !types.some((ty) => ty === "task.reconciled" && true) ||
      !getEvents(taskId).some((e) => e.eventType === "task.reconciled" && (e.payload as Record<string, unknown>).via === "forge recover --continue"),
    "no operator-recovered reconciliation event",
  );
});

test("recover --continue: a codex stream whose turn never completed recovers nothing (fail-closed)", () => {
  const taskId = "t-continue-codex-unfinished";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: trackedCleanGitRepo(), agentRole: "red-wide" }));
  reconcileRun(RUN.id, () => false);

  const dir = taskDir(RUN.id, taskId);
  mkdirSync(dir, { recursive: true });
  writeCodexManifest(dir);
  const truncated = codexCleanStreamStdout({ verdict: "pass", findings: [] }).split("\n").slice(0, -2).join("\n");
  writeFileSync(join(dir, "container.stdout.log"), truncated);

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continue-refused");
  assert.equal(getTask(taskId)!.status, "failed");
});

test("recover --continue: changed files with no computed result still adopts the diff (worktree source, no --force needed)", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-diff";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
  reconcileRun(RUN.id, () => false);

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continued");
  if (outcome.kind !== "continued") return;
  assert.equal(outcome.adoptedFrom, "diff_adopted");
  const result = getTask(taskId)!.result as Record<string, unknown>;
  assert.equal(result.contract, "adopted_diff");
  assert.deepEqual(result.changedFiles, ["?? changed-file.txt"]);
});

test("recover --continue: refuses when there is no result AND no changed files — writes nothing", () => {
  const taskId = "t-continue-nothing";
  insertContainerized(mkTask(taskId, { status: "running" })); // no worktreePath, run has no projectDir -> no path to check
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed");
  const failureKindBefore = getTask(taskId)!.error;
  const eventsBefore = getEvents(taskId).length;

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continue-refused");
  assert.equal(getTask(taskId)!.status, "failed", "refusal must not change task status");
  assert.equal(getTask(taskId)!.error, failureKindBefore, "refusal must not touch the task row");
  assert.equal(getEvents(taskId).length, eventsBefore, "refusal must log nothing");
});

test("recover --continue: refuses a project_dir_shared diff without --force, allows it with --force", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-shared";
  const run: Run = { ...RUN, id: "run-shared-continue", projectDir: gitDir };
  insertRun(run);
  insertContainerized(mkTask(taskId, { runId: run.id, status: "running" })); // no dedicated worktree -> shared
  reconcileRun(run.id, () => false);
  assert.equal(getTask(taskId)!.status, "failed");

  const eventsBefore = getEvents(taskId).length;
  const refused = performContinue(taskId);
  assert.equal(refused.kind, "continue-refused");
  assert.equal(getTask(taskId)!.status, "failed", "no write on refusal");
  assert.equal(getEvents(taskId).length, eventsBefore, "no event on refusal");

  const forced = performContinue(taskId, { force: true });
  assert.equal(forced.kind, "continued");
  assert.equal(getTask(taskId)!.status, "complete");
});

test("recover --continue: adopts an oom_killed task's diff (oom_killed is now a CONTINUABLE_KIND)", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-oom";
  insertContainerized(mkTask(taskId, { status: "running", worktreePath: gitDir }));
  reconcileRun(RUN.id, () => false, undefined, () => ({ oomKilled: true, exitCode: 137 }));
  assert.equal(getTask(taskId)!.status, "failed");

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continued");
  if (outcome.kind !== "continued") return;
  assert.equal(outcome.adoptedFrom, "diff_adopted");
  const result = getTask(taskId)!.result as Record<string, unknown>;
  assert.equal(result.contract, "adopted_diff");
  assert.deepEqual(result.changedFiles, ["?? changed-file.txt"]);
});

test("recover --continue: refuses a task not in a recoverable state (e.g. gate_rejected)", () => {
  const taskId = "t-continue-gate";
  insertTask(mkTask(taskId, { status: "failed" }));
  logEvent("task.failed", { runId: RUN.id, taskId, payload: { failure_kind: "gate_rejected", error: "rejected" } });

  const outcome = performContinue(taskId);
  assert.equal(outcome.kind, "continue-refused");
  assert.equal(getTask(taskId)!.status, "failed");
});

test("recover --continue: refuses a fanout parent (fanout_wave_orphaned is a --re-drive case, not --continue)", () => {
  insertTask(mkTask("parent-continue-refuse", { status: "running", phase: "build" }));
  insertContainerized(mkTask("child-continue-refuse", { parentId: "parent-continue-refuse", phase: "build", status: "running" }));
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask("parent-continue-refuse")!.status, "failed");

  const outcome = performContinue("parent-continue-refuse");
  assert.equal(outcome.kind, "continue-refused");
});

// ── FG-481: pipeline-run tasks are never continuable ────────────────────────
//
// A task whose run's workflow isn't "invoke" must be refused by --continue
// unconditionally — regardless of failure_kind (even a CONTINUABLE_KIND) and
// regardless of --force. Adopting here would complete the step without the
// host-side finalize (worktree merge -> integration gate -> reds -> gates)
// ever running, recreating the exact bypass FG-479 closed on the silent
// reconcile path.

const PIPELINE_RUN: Run = { id: "run-pipeline-continue", workflow: "build", title: "pipeline recover test", status: "active", createdAt: "2026-06-01T00:00:00Z" };

for (const failureKind of ["orphaned", "orphaned_work_may_persist", "oom_killed"]) {
  test(`recover --continue: refuses a pipeline-run task in CONTINUABLE_KIND '${failureKind}' — and --force does not override`, () => {
    insertRun(PIPELINE_RUN);
    const gitDir = trackedDirtyGitRepo();
    const taskId = `t-continue-pipeline-${failureKind}`;
    insertTask(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "failed", worktreePath: gitDir }));
    logEvent("task.failed", { runId: PIPELINE_RUN.id, taskId, payload: { failure_kind: failureKind, error: "boom" } });

    const before = getTask(taskId)!;
    const eventsBefore = getEvents(taskId).length;

    const refused = performContinue(taskId);
    assert.equal(refused.kind, "continue-refused");
    if (refused.kind === "continue-refused") {
      assert.match(refused.reason, /pipeline/i, "reason names the pipeline rationale");
      assert.match(refused.reason, /finalize|merge|integration gate|reds|gates/i, "reason names the host-side finalize rationale");
      assert.match(refused.reason, /forge retry/, "reason points at forge retry");
      assert.match(refused.reason, /--force/, "reason points at --force as the re-drive path");
    }
    assert.deepEqual(getTask(taskId), before, "no write on refusal");
    assert.equal(getEvents(taskId).length, eventsBefore, "no event on refusal");

    const forcedRefused = performContinue(taskId, { force: true });
    assert.equal(forcedRefused.kind, "continue-refused", "--force must not override the pipeline refusal");
    assert.deepEqual(getTask(taskId), before, "no write on refusal even with --force");
    assert.equal(getEvents(taskId).length, eventsBefore, "no event on refusal even with --force");
  });
}

// ── FG-486: invoke_chain runs are NOT pipeline runs — --continue adopts ─────
//
// Campaign quick lanes create workflow "invoke_chain" runs whose tasks are
// dispatched via plain v2/invoke.ts — no worktree merge, no integration gate,
// no reds. There is no finalize to bypass, so --continue must treat them
// exactly like invoke runs (the FG-481 refusal wrongly swept them up).

const INVOKE_CHAIN_RUN: Run = { id: "run-invoke-chain-continue", workflow: "invoke_chain", title: "quick lane recover test", status: "active", createdAt: "2026-06-01T00:00:00Z" };

for (const failureKind of ["orphaned", "orphaned_work_may_persist", "oom_killed"]) {
  test(`FG-486: recover --continue ADOPTS an invoke_chain-run task in CONTINUABLE_KIND '${failureKind}' (same semantics as invoke)`, () => {
    insertRun(INVOKE_CHAIN_RUN);
    const gitDir = trackedDirtyGitRepo();
    const taskId = `t-continue-chain-${failureKind}`;
    insertTask(mkTask(taskId, { runId: INVOKE_CHAIN_RUN.id, status: "failed", worktreePath: gitDir }));
    logEvent("task.failed", { runId: INVOKE_CHAIN_RUN.id, taskId, payload: { failure_kind: failureKind, error: "boom" } });

    const outcome = performContinue(taskId);
    assert.equal(outcome.kind, "continued", `invoke_chain '${failureKind}' must be adoptable — there is no finalize to bypass`);
    if (outcome.kind !== "continued") return;
    assert.equal(outcome.adoptedFrom, "diff_adopted");
    assert.equal(getTask(taskId)!.status, "complete");
  });
}

test("FG-486: recover inspect recommends --continue for an invoke_chain-run task with recoverable work", () => {
  insertRun(INVOKE_CHAIN_RUN);
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-chain-recommend";
  insertTask(mkTask(taskId, { runId: INVOKE_CHAIN_RUN.id, status: "failed", worktreePath: gitDir }));
  logEvent("task.failed", { runId: INVOKE_CHAIN_RUN.id, taskId, payload: { failure_kind: "orphaned_work_may_persist", error: "boom" } });

  const outcome = performInspect(taskId);
  assert.equal(outcome.kind, "inspect-task");
  if (outcome.kind !== "inspect-task") return;
  assert.match(outcome.task.recommendation, new RegExp(`forge recover ${taskId} --continue`), "invoke_chain must be recommended --continue again");
});

// FG-486 review finding: the invoke_chain "adopts like invoke" claim above
// only exercised the dedicated-worktree path. An invoke_chain task with NO
// dedicated worktree (quick lanes can share the run's projectDir) must still
// hit the same project_dir_shared --force gate as an invoke-run task —
// taskHasPipelineFinalize only controls the pipeline-refusal branch, not the
// shared-dir ambiguity check that runs after it.
test("FG-486: recover --continue on an invoke_chain-run task refuses a project_dir_shared diff without --force, allows it with --force", () => {
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-continue-chain-shared";
  const run: Run = { ...INVOKE_CHAIN_RUN, id: "run-invoke-chain-shared-continue", projectDir: gitDir };
  insertRun(run);
  insertTask(mkTask(taskId, { runId: run.id, status: "failed" })); // no dedicated worktree -> shared
  logEvent("task.failed", { runId: run.id, taskId, payload: { failure_kind: "orphaned_work_may_persist", error: "boom" } });

  const eventsBefore = getEvents(taskId).length;
  const refused = performContinue(taskId);
  assert.equal(refused.kind, "continue-refused");
  if (refused.kind === "continue-refused") {
    assert.match(refused.reason, /project_dir_shared/, "reason names the shared-dir rationale");
  }
  assert.equal(getTask(taskId)!.status, "failed", "no write on refusal");
  assert.equal(getEvents(taskId).length, eventsBefore, "no event on refusal");

  const forced = performContinue(taskId, { force: true });
  assert.equal(forced.kind, "continued");
  assert.equal(getTask(taskId)!.status, "complete");
});

// retry-policy.ts (untouched by FG-481) governs whether the retry fallback
// needs --force: "orphaned" alone is retryable without it (no persisted-work
// signal), while "orphaned_work_may_persist" / "oom_killed" require --force
// since a blind retry could clobber recoverable work. All three are still
// CONTINUABLE_KINDS that must never be recommended via --continue on a
// pipeline run.
const PIPELINE_RETRY_REQUIRES_FORCE: Record<string, boolean> = {
  orphaned: false,
  orphaned_work_may_persist: true,
  oom_killed: true,
};

for (const failureKind of ["orphaned", "orphaned_work_may_persist", "oom_killed"]) {
  test(`recover inspect: a pipeline-run task in CONTINUABLE_KIND '${failureKind}' is NOT recommended --continue`, () => {
    insertRun(PIPELINE_RUN);
    const gitDir = trackedDirtyGitRepo();
    const taskId = `t-inspect-pipeline-noncontinuable-${failureKind}`;
    insertTask(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "failed", worktreePath: gitDir }));
    logEvent("task.failed", { runId: PIPELINE_RUN.id, taskId, payload: { failure_kind: failureKind, error: "boom" } });

    const outcome = performInspect(taskId);
    assert.equal(outcome.kind, "inspect-task");
    if (outcome.kind !== "inspect-task") return;
    assert.equal(outcome.task.failureKind, failureKind);
    assert.doesNotMatch(
      outcome.task.recommendation,
      /^forge recover \S+ --continue/,
      "performContinue refuses a pipeline-run task — must not be the recommended command",
    );
    const expectForce = PIPELINE_RETRY_REQUIRES_FORCE[failureKind];
    assert.match(outcome.task.recommendation, /^forge retry \S+/, "pipeline task falls back to a retry recommendation");
    if (expectForce) {
      assert.match(outcome.task.recommendation, /^forge retry \S+ --force/, "non-retryable-without-force kind requires --force");
    } else {
      assert.doesNotMatch(outcome.task.recommendation, /^forge retry \S+ --force/, "'orphaned' is retryable without --force per retry-policy.ts");
    }
  });
}

test("recover inspect: forge recover <runId> and <taskId> still surface a pipeline task in a CONTINUABLE_KIND (FG-479 surfacing unchanged)", () => {
  insertRun(PIPELINE_RUN);
  const gitDir = trackedDirtyGitRepo();
  const taskId = "t-inspect-pipeline-surfaced";
  insertTask(mkTask(taskId, { runId: PIPELINE_RUN.id, status: "failed", worktreePath: gitDir }));
  logEvent("task.failed", { runId: PIPELINE_RUN.id, taskId, payload: { failure_kind: "oom_killed", error: "boom" } });

  const singleTask = performInspect(taskId);
  assert.equal(singleTask.kind, "inspect-task", "single-task view still surfaces the pipeline task");

  const runView = performInspect(PIPELINE_RUN.id);
  assert.equal(runView.kind, "inspect-run");
  if (runView.kind !== "inspect-run") return;
  assert.ok(runView.tasks.some((t) => t.taskId === taskId), "run-level listing still surfaces the pipeline task");
});

// ── --re-drive ───────────────────────────────────────────────────────────────

test("recover --re-drive: mints a fresh pending primary for a failed fanout parent, leaves audit trail, no double-dispatch", () => {
  insertTask(mkTask("parent-redrive", { status: "running", phase: "build" }));
  insertTask(mkTask("child-redrive-1", { parentId: "parent-redrive", phase: "build", status: "complete" }));
  insertContainerized(mkTask("child-redrive-2", { parentId: "parent-redrive", phase: "build", status: "running" }));
  reconcileRun(RUN.id, () => false); // settles parent to failed/fanout_wave_orphaned (child-2's container gone)
  assert.equal(getTask("parent-redrive")!.status, "failed");
  assert.equal(getTask("child-redrive-2")!.status, "failed");

  const outcome = performReDrive("parent-redrive");
  assert.equal(outcome.kind, "re-drive-done");
  if (outcome.kind !== "re-drive-done") return;

  // FG-688: the unordered lane still mints, so dispatchTaskId === newTaskId here.
  // (`newTaskId` is optional on the outcome now — the ordered lane mints nothing —
  // so this reads the always-present field. Behaviour asserted is unchanged.)
  assert.equal(outcome.lane, "unordered_fresh_primary");
  assert.equal(outcome.newTaskId, outcome.dispatchTaskId);
  const newTask = getTask(outcome.dispatchTaskId)!;
  assert.equal(newTask.status, "pending");
  assert.equal(newTask.parentId, undefined);
  assert.equal(newTask.phase, "build");

  // Old parent + children are untouched audit records.
  assert.equal(getTask("parent-redrive")!.status, "failed");
  assert.equal(getTask("child-redrive-1")!.status, "complete");
  assert.equal(getTask("child-redrive-2")!.status, "failed");

  // Exactly one NEW parentId-undefined primary for this phase — no stray duplicate.
  const primariesInPhase = [getTask("parent-redrive")!, newTask].filter((t) => t.parentId === undefined && t.phase === "build");
  assert.equal(primariesInPhase.length, 2, "the old (terminal) parent and the one new pending primary — nothing else");

  // Cooperates with dispatchFanoutStep's ready-queue precondition: the step is
  // ready to dispatch exactly once (a pending primary, deps trivially met).
  const wf: Workflow = { name: "wf", description: "wf", review_mode: "legacy_verdict", inputs: [], steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }] };
  const allTasks = [getTask("parent-redrive")!, getTask("child-redrive-1")!, getTask("child-redrive-2")!, newTask];
  const ready = computeReadyQueue(wf, allTasks);
  assert.equal(ready.length, 1, "the build step is ready exactly once");
  assert.equal(ready[0]!.id, "build");
});

test("recover --re-drive: resolves from a fanout CHILD id to its parent", () => {
  insertTask(mkTask("parent-redrive-viachild", { status: "failed", phase: "build" }));
  logEvent("task.failed", { runId: RUN.id, taskId: "parent-redrive-viachild", payload: { failure_kind: "fanout_wave_orphaned", error: "boom" } });
  insertTask(mkTask("child-redrive-viachild", { parentId: "parent-redrive-viachild", phase: "build", status: "failed" }));

  const outcome = performReDrive("child-redrive-viachild");
  assert.equal(outcome.kind, "re-drive-done");
  if (outcome.kind !== "re-drive-done") return;
  assert.equal(outcome.parentId, "parent-redrive-viachild");
});

test("recover --re-drive: refuses a still-running wave (a child container may still be live)", () => {
  insertTask(mkTask("parent-redrive-live", { status: "running", phase: "build" }));
  insertContainerized(mkTask("child-redrive-live", { parentId: "parent-redrive-live", phase: "build", status: "running" }));

  const outcome = performReDrive("parent-redrive-live", { containerAlive: () => true });
  assert.equal(outcome.kind, "re-drive-refused");
  assert.equal(getTask("parent-redrive-live")!.status, "running");
});

test("recover --re-drive: refuses an already-complete parent", () => {
  insertTask(mkTask("parent-redrive-done", { status: "running", phase: "build" }));
  insertTask(mkTask("child-redrive-done", { parentId: "parent-redrive-done", phase: "build", status: "complete" }));
  markTaskComplete("parent-redrive-done", { status: "complete" });

  const outcome = performReDrive("parent-redrive-done");
  assert.equal(outcome.kind, "re-drive-refused");
});

test("recover --re-drive: refuses a non-fanout task (no children)", () => {
  insertTask(mkTask("solo-task", { status: "failed", phase: "build" }));
  const outcome = performReDrive("solo-task");
  assert.equal(outcome.kind, "re-drive-refused");
});

test("recover --re-drive: refuses when a re-drive is already pending", () => {
  insertTask(mkTask("parent-redrive-dupe", { status: "failed", phase: "build" }));
  logEvent("task.failed", { runId: RUN.id, taskId: "parent-redrive-dupe", payload: { failure_kind: "fanout_wave_orphaned", error: "boom" } });
  insertTask(mkTask("child-redrive-dupe", { parentId: "parent-redrive-dupe", phase: "build", status: "failed" }));
  insertTask(mkTask("pending-redrive-dupe", { phase: "build", status: "pending" }));

  const outcome = performReDrive("parent-redrive-dupe");
  assert.equal(outcome.kind, "re-drive-refused");
  assert.equal(getTask("parent-redrive-dupe")!.status, "failed", "no second pending primary minted");
});

test("recover --re-drive: refuses a failed fanout parent whose failure kind isn't fanout_wave_orphaned", () => {
  insertTask(mkTask("parent-redrive-wrongkind", { status: "failed", phase: "build" }));
  logEvent("task.failed", { runId: RUN.id, taskId: "parent-redrive-wrongkind", payload: { failure_kind: "gate_rejected", error: "rejected" } });
  insertTask(mkTask("child-redrive-wrongkind", { parentId: "parent-redrive-wrongkind", phase: "build", status: "failed" }));

  const before = tasksForRun(RUN.id).length;
  const outcome = performReDrive("parent-redrive-wrongkind");
  assert.equal(outcome.kind, "re-drive-refused");
  if (outcome.kind === "re-drive-refused") assert.match(outcome.reason, /gate_rejected/);
  assert.equal(getTask("parent-redrive-wrongkind")!.status, "failed", "no mutation on refusal");
  assert.equal(tasksForRun(RUN.id).length, before, "no new pending primary minted");
});

// ── FG-688: --re-drive's adopt-preserving ORDERED lane ───────────────────────
//
// The fixture is the FG-576 shape: an ordered wave where one item failed, its
// transitive dependents never dispatched, and the independent items completed and
// were captured. The wave's ORDERED-ness is read off the same durable event
// runOrderedWave writes before dispatching any child — the one thing
// isOrderedFanoutWave consults — so these fixtures differ from the unordered ones
// by evidence, not by a test-only flag.

function buildFailedWave(
  parentId: string,
  failureKind: string,
  opts: { ordered?: boolean; phase?: string; parentCreatedAt?: string } = {},
): void {
  const phase = opts.phase ?? "build";
  insertTask(mkTask(parentId, { status: "failed", phase, createdAt: opts.parentCreatedAt ?? "2026-06-01T00:00:00Z" }));
  if (opts.ordered !== false) {
    logEvent("integration.worktree_created", { runId: RUN.id, taskId: parentId, payload: { ordered: true } });
  }
  logEvent("task.failed", {
    runId: RUN.id,
    taskId: parentId,
    payload: { failure_kind: failureKind, error: "item A failed; B and D never dispatched" },
  });
  // A (failed, must re-dispatch) and E/F (complete + captured, must be adopted).
  insertTask(mkTask(`${parentId}-a`, { parentId, phase, status: "failed" }));
  insertTask(mkTask(`${parentId}-e`, { parentId, phase, status: "complete" }));
  insertTask(mkTask(`${parentId}-f`, { parentId, phase, status: "complete" }));
}

function reactivationEvents(runId: string) {
  return eventsForRun(runId).filter((e) => e.eventType === "run.reactivated");
}

/** Settle the run the way an accepted ordered-wave failure does — the status write
 *  and its `run.failed` event in one transaction (finalizeRunIfSettled's shape,
 *  logSource "runNext-wave-complete"). failRun alone writes no event. */
function settleRunFailed(): void {
  const applied = failRun(RUN.id, {
    onApplied: () => logEvent("run.failed", { runId: RUN.id, payload: { via: "runNext-wave-complete" } }),
  });
  assert.equal(applied, true, "sanity: the wave failure settled the run too");
}

test("FG-688 --re-drive: an ORDERED prerequisite_blocked parent on a failed run is reopened IN PLACE — same row, no new primary, run reactivated", () => {
  buildFailedWave("parent-ordered-pb", "prerequisite_blocked");
  settleRunFailed();
  const runBefore = getRun(RUN.id)!;
  assert.ok(runBefore.completedAt, "sanity: a failed run carries completed_at");
  const taskCountBefore = tasksForRun(RUN.id).length;

  const outcome = performReDrive("parent-ordered-pb");
  assert.equal(outcome.kind, "re-drive-done");
  if (outcome.kind !== "re-drive-done") return;

  // The lane, and the row it reuses.
  assert.equal(outcome.lane, "ordered_reopened_in_place");
  assert.equal(outcome.parentId, "parent-ordered-pb");
  assert.equal(outcome.dispatchTaskId, "parent-ordered-pb", "the REUSED parent dispatches, not a fresh primary");
  assert.equal(outcome.newTaskId, undefined, "the ordered lane mints nothing, so it claims no newTaskId");
  assert.equal(outcome.authorizingFailureKind, "prerequisite_blocked");
  assert.equal(outcome.runReactivated, true);

  // The parent row itself came back to pending, keeping its children attached —
  // which is the whole point: runOrderedWave recomputes adoption from THIS
  // parent's children, so reusing the row is what keeps the captured work reachable.
  const parent = getTask("parent-ordered-pb")!;
  assert.equal(parent.status, "pending");
  assert.equal(parent.completedAt, undefined, "completed_at is cleared — the row is no longer settled");
  assert.equal(parent.parentId, undefined);
  assert.equal(tasksForRun(RUN.id).length, taskCountBefore, "NO new primary row was inserted");
  const children = tasksForRun(RUN.id).filter((t) => t.parentId === "parent-ordered-pb");
  assert.equal(children.length, 3, "the captured children stay attached to the reused parent");
  assert.equal(getTask("parent-ordered-pb-e")!.status, "complete", "captured work untouched");
  assert.equal(getTask("parent-ordered-pb-f")!.status, "complete", "captured work untouched");

  // The failure survives into the wave it authorized (markTaskRunning clears `error`).
  assert.deepEqual(parent.taskPackage.inputs["previous_failure"], {
    kind: "prerequisite_blocked",
    error: null,
    failedTaskId: "parent-ordered-pb",
  });

  // The run row came back with it — without this the reopened parent would never
  // dispatch, because both `forge next` entry points refuse a non-active run.
  const runAfter = getRun(RUN.id)!;
  assert.equal(runAfter.status, "active");
  assert.equal(runAfter.completedAt, undefined);

  // Reactivation NULLs completed_at, so this event is the ONLY durable record
  // that the run ever failed.
  const reactivated = reactivationEvents(RUN.id);
  assert.equal(reactivated.length, 1, "exactly one run.reactivated event");
  const payload = reactivated[0]!.payload as Record<string, unknown>;
  assert.equal(payload["source"], "recover --re-drive", "named distinctly from the retry/invoke sources");
  assert.equal(payload["from"], "failed");
  assert.equal(payload["completedAtCleared"], runBefore.completedAt);
  assert.equal(payload["authorizingTaskId"], "parent-ordered-pb");
  assert.equal(payload["failure_kind"], "prerequisite_blocked");

  // The earlier run.failed is never amended: run.failed -> run.reactivated reads back.
  assert.equal(eventsForRun(RUN.id).filter((e) => e.eventType === "run.failed").length, 1);

  // The reopened row is actually DISPATCHABLE — the precondition AC1 rests on.
  // computeReadyQueue admits the phase because a pending primary exists among its
  // attempts, and dispatchFanoutStep's existingParent lookup then finds this exact
  // row (phase + parentId undefined + pending) and reuses it, children attached.
  const wf: Workflow = { name: "wf", description: "wf", review_mode: "legacy_verdict", inputs: [], steps: [{ id: "build", agent: "engineer", gate: "auto", manual: false, depends_on: [], runtime: "claude", reds: [] }] };
  const ready = computeReadyQueue(wf, tasksForRun(RUN.id));
  assert.equal(ready.length, 1, "the build step is ready exactly once");
  assert.equal(ready[0]!.id, "build");

  // The task-level audit says the row really went back to pending.
  const reconciled = eventsForTask("parent-ordered-pb").filter((e) => e.eventType === "task.reconciled");
  assert.equal(reconciled.length, 1);
  const rp = reconciled[0]!.payload as Record<string, unknown>;
  assert.equal(rp["to"], "pending");
  assert.equal(rp["reason"], "ordered_wave_redriven_in_place");
  assert.equal(rp["failure_kind"], "prerequisite_blocked");
});

test("FG-688 --re-drive: the UNORDERED fanout_wave_orphaned lane still mints a fresh primary, and now ALSO reactivates the failed run", () => {
  buildFailedWave("parent-unordered", "fanout_wave_orphaned", { ordered: false });
  settleRunFailed();

  const outcome = performReDrive("parent-unordered");
  assert.equal(outcome.kind, "re-drive-done");
  if (outcome.kind !== "re-drive-done") return;

  assert.equal(outcome.lane, "unordered_fresh_primary");
  assert.ok(outcome.newTaskId, "the unordered lane mints");
  assert.equal(outcome.dispatchTaskId, outcome.newTaskId);
  assert.notEqual(outcome.newTaskId, "parent-unordered", "a FRESH primary, not the reused row");

  // Old parent stays terminal as an audit record — byte-for-byte the pre-FG-688 shape.
  assert.equal(getTask("parent-unordered")!.status, "failed");
  const minted = getTask(outcome.dispatchTaskId)!;
  assert.equal(minted.status, "pending");
  assert.equal(minted.parentId, undefined);
  assert.equal(minted.phase, "build");

  // The one addition: the run comes back so the minted primary can dispatch.
  assert.equal(outcome.runReactivated, true);
  assert.equal(getRun(RUN.id)!.status, "active");
  assert.equal(reactivationEvents(RUN.id).length, 1);
});

test("FG-688 --re-drive: refuses a kind outside the enumeration, and FAILS CLOSED on an unrecognized kind string", () => {
  for (const kind of ["plan_dependency_invalid", "integration_failed", "kind_from_a_future_build"]) {
    const parentId = `parent-ordered-${kind}`;
    buildFailedWave(parentId, kind, { phase: `build-${kind}` });
    settleRunFailed();

    const before = getTask(parentId)!;
    const runBefore = getRun(RUN.id)!;
    const eventCount = eventsForRun(RUN.id).length;

    const outcome = performReDrive(parentId);
    assert.equal(outcome.kind, "re-drive-refused", `${kind} must be refused`);
    if (outcome.kind === "re-drive-refused") assert.match(outcome.reason, new RegExp(kind));

    assert.deepEqual(getTask(parentId), before, `${kind}: parent row untouched`);
    assert.deepEqual(getRun(RUN.id), runBefore, `${kind}: run row untouched — the run is NOT reactivated by a refused verb`);
    assert.equal(eventsForRun(RUN.id).length, eventCount, `${kind}: no events written`);
    updateRunStatus(RUN.id, "active"); // reset for the next iteration
  }
});

test("FG-688 --re-drive: refuses a SUPERSEDED parent — AC3's verb-level half — writing nothing", () => {
  buildFailedWave("parent-ordered-superseded", "prerequisite_blocked");
  // A later parent-less primary in the SAME phase: exactly what `forge gate
  // request-changes` mints. It owns the phase now, so the old parent is a dead
  // lineage and reopening it would put two live parents in one phase.
  insertTask(mkTask("parent-ordered-live", { status: "running", phase: "build", createdAt: "2026-06-02T00:00:00Z" }));
  settleRunFailed();

  const oldBefore = getTask("parent-ordered-superseded")!;
  const liveBefore = getTask("parent-ordered-live")!;
  const runBefore = getRun(RUN.id)!;
  const taskCount = tasksForRun(RUN.id).length;
  const eventCount = eventsForRun(RUN.id).length;

  const outcome = performReDrive("parent-ordered-superseded");
  assert.equal(outcome.kind, "re-drive-refused");
  if (outcome.kind === "re-drive-refused") {
    assert.match(outcome.reason, /SUPERSEDED by parent-ordered-live/);
    assert.match(outcome.reason, /forge next/, "points at the live wave");
  }

  // Whole rows, not selected fields — a future partial write cannot slip through.
  assert.deepEqual(getTask("parent-ordered-superseded"), oldBefore);
  assert.deepEqual(getTask("parent-ordered-live"), liveBefore);
  assert.deepEqual(getRun(RUN.id), runBefore);
  assert.equal(tasksForRun(RUN.id).length, taskCount);
  assert.equal(eventsForRun(RUN.id).length, eventCount);
});

// ── FG-688 RF-1: a refusal may not reconcile on its way to refusing ──────────
//
// performReDrive used to call reconcileRun on ANY running parent before reading
// the status it refuses on. For the shape below — an ordered wave stranded by a
// crash — that reconcile is precisely reconcile's ordered_fanout_resumable arm:
// it moved the row running -> pending and wrote a task.reconciled event, after
// which the verb refused the pending row it had just created. The command
// reported `re-drive-refused` having written both a task row and an event, which
// is the invariant this section pins: refusal writes NOTHING.

function orderedRunningWave(parentId: string, childStatuses: Task["status"][]): void {
  insertTask(mkTask(parentId, { status: "running", phase: "build" }));
  logEvent("integration.worktree_created", { runId: RUN.id, taskId: parentId, payload: { ordered: true } });
  childStatuses.forEach((status, i) => {
    insertTask(mkTask(`${parentId}-c${i}`, { parentId, phase: "build", status }));
  });
}

test("FG-688 RF-1 --re-drive: a crash-stranded ORDERED wave is refused WITHOUT being reconciled — nothing written, and the refusal names `forge next`", () => {
  orderedRunningWave("parent-ordered-stranded", ["complete", "failed"]);

  const parentBefore = getTask("parent-ordered-stranded")!;
  const runBefore = getRun(RUN.id)!;
  const eventCount = eventsForRun(RUN.id).length;

  const outcome = performReDrive("parent-ordered-stranded", { containerAlive: () => false });
  assert.equal(outcome.kind, "re-drive-refused");
  if (outcome.kind === "re-drive-refused") {
    assert.match(outcome.reason, new RegExp(`forge next ${RUN.id}`), "names the verb that resumes this wave");
    assert.match(outcome.reason, /ordered_fanout_resumable/, "says what happens to the row instead of a bare status");
  }

  // Whole rows: the reconcile that used to run here is what this asserts absent.
  assert.deepEqual(getTask("parent-ordered-stranded"), parentBefore, "the parent row was NOT moved to pending by a refusing verb");
  assert.deepEqual(getRun(RUN.id), runBefore);
  assert.equal(eventsForRun(RUN.id).length, eventCount, "no event — not even the task.reconciled the old order wrote");

  // And the transition itself is not lost: it is reconcile's to make, and `forge
  // next` still makes it, which is exactly what the refusal points at.
  reconcileRun(RUN.id, () => false);
  assert.equal(getTask("parent-ordered-stranded")!.status, "pending");
});

test("FG-688 RF-1 --re-drive: a still-live ORDERED wave keeps its wait-or-cancel advice, decided without any container probe", () => {
  orderedRunningWave("parent-ordered-inflight", ["complete", "running"]);

  const outcome = performReDrive("parent-ordered-inflight", {
    containerAlive: () => {
      throw new Error("a running ORDERED wave is refused from durable state — no container probe");
    },
  });
  assert.equal(outcome.kind, "re-drive-refused");
  if (outcome.kind === "re-drive-refused") {
    assert.match(outcome.reason, /forge cancel parent-ordered-inflight/, "the live-wave advice is preserved");
  }
  assert.equal(getTask("parent-ordered-inflight")!.status, "running");
});

test("FG-688 RF-1 --re-drive: a durable-state clause refuses a RUNNING parent before the reconcile sweep runs at all", () => {
  // Unordered, so the old order would have reconciled — settling the dead child
  // and writing its events — and only then refused on the run's status.
  insertTask(mkTask("parent-unordered-abandoned", { status: "running", phase: "build" }));
  insertContainerized(mkTask("child-unordered-abandoned", { parentId: "parent-unordered-abandoned", phase: "build", status: "running" }));
  updateRunStatus(RUN.id, "abandoned");

  const parentBefore = getTask("parent-unordered-abandoned")!;
  const childBefore = getTask("child-unordered-abandoned")!;
  const eventCount = eventsForRun(RUN.id).length;

  const outcome = performReDrive("parent-unordered-abandoned", { containerAlive: () => false });
  assert.equal(outcome.kind, "re-drive-refused");
  if (outcome.kind === "re-drive-refused") assert.match(outcome.reason, /abandoned/);

  assert.deepEqual(getTask("parent-unordered-abandoned"), parentBefore);
  assert.deepEqual(getTask("child-unordered-abandoned"), childBefore, "the sweep never ran — the dead child was not settled either");
  assert.equal(eventsForRun(RUN.id).length, eventCount);
});

test("FG-688 --re-drive: refuses on a COMPLETE run and on an ABANDONED run, writing nothing", () => {
  for (const [runStatus, parentId] of [
    ["complete", "parent-ordered-runcomplete"],
    ["abandoned", "parent-ordered-runabandoned"],
  ] as const) {
    const db2 = makeInMemoryDb();
    const prev2 = setDbForTest(db2);
    try {
      insertRun({ ...RUN });
      buildFailedWave(parentId, "prerequisite_blocked");
      if (runStatus === "complete") completeRun(RUN.id);
      else updateRunStatus(RUN.id, "abandoned");
      assert.equal(getRun(RUN.id)!.status, runStatus, "sanity");

      const parentBefore = getTask(parentId)!;
      const runBefore = getRun(RUN.id)!;
      const eventCount = eventsForRun(RUN.id).length;

      const outcome = performReDrive(parentId);
      assert.equal(outcome.kind, "re-drive-refused", `a ${runStatus} run must refuse`);
      if (outcome.kind === "re-drive-refused") assert.match(outcome.reason, new RegExp(runStatus));

      assert.deepEqual(getTask(parentId), parentBefore, `${runStatus}: parent row untouched`);
      assert.deepEqual(getRun(RUN.id), runBefore, `${runStatus}: run row untouched`);
      assert.equal(eventsForRun(RUN.id).length, eventCount, `${runStatus}: no events written`);
    } finally {
      setDbForTest(prev2 as DatabaseInstance);
      db2.close();
    }
  }
});

test("FG-688 --re-drive: an already-ACTIVE run re-drives successfully with NO run.reactivated event (idempotent, not an error)", () => {
  buildFailedWave("parent-ordered-runactive", "integration_gate_timeout");
  assert.equal(getRun(RUN.id)!.status, "active", "sanity: only one phase's wave failed, the run never settled");

  const outcome = performReDrive("parent-ordered-runactive");
  assert.equal(outcome.kind, "re-drive-done");
  if (outcome.kind !== "re-drive-done") return;
  assert.equal(outcome.lane, "ordered_reopened_in_place");
  assert.equal(outcome.runReactivated, false, "no run-level write was needed");

  assert.equal(getTask("parent-ordered-runactive")!.status, "pending");
  assert.equal(getRun(RUN.id)!.status, "active");
  assert.equal(reactivationEvents(RUN.id).length, 0, "no run.reactivated event over a run that never left active");
});

test("FG-688 --re-drive ATOMICITY: the run CAS losing its race rolls the parent reopen back — neither write lands", () => {
  buildFailedWave("parent-ordered-race", "prerequisite_blocked");
  settleRunFailed();

  // Simulate the race the transaction exists to survive: the run row is moved off
  // 'failed' by another writer AFTER this verb's eligibility read and INSIDE the
  // transaction — here, deterministically, by a trigger that fires on the parent
  // reopen itself. reactivateFailedRun's CAS then matches zero rows.
  //
  // This is the dangerous direction: parent-moved-but-run-not is a PERMANENT wedge
  // (the ready queue keeps the phase active, so the run can neither settle nor
  // dispatch), which is why the reopen must roll back with it.
  db.exec(`
    CREATE TRIGGER race_run_off_failed AFTER UPDATE OF status ON tasks
    WHEN NEW.id = 'parent-ordered-race' AND NEW.status = 'pending'
    BEGIN
      UPDATE runs SET status = 'complete' WHERE id = '${RUN.id}';
    END;
  `);

  const parentBefore = getTask("parent-ordered-race")!;
  const runBefore = getRun(RUN.id)!;
  const eventCount = eventsForRun(RUN.id).length;

  const outcome = performReDrive("parent-ordered-race");
  assert.equal(outcome.kind, "re-drive-refused");
  if (outcome.kind === "re-drive-refused") {
    // The in-transaction accept-set re-check is what caught it — not a pre-lock
    // read, which saw a 'failed' run and passed.
    assert.match(outcome.reason, /run run-recover is 'complete'/);
    assert.match(outcome.reason, /Nothing was written/);
  }

  assert.deepEqual(getTask("parent-ordered-race"), parentBefore, "the parent reopen rolled back — still failed");
  assert.deepEqual(getRun(RUN.id), runBefore, "the run row is still failed — the trigger's own write rolled back too");
  assert.equal(eventsForRun(RUN.id).length, eventCount, "no run.reactivated, no task.reconciled — a rolled-back verb emits nothing");
});

test("FG-688 --re-drive ATOMICITY: a competing primary minted AFTER the eligibility read is caught INSIDE the transaction — the verb refuses and writes nothing", () => {
  buildFailedWave("parent-ordered-supersede-race", "prerequisite_blocked");
  settleRunFailed();

  // The interleaving the in-transaction supersession CAS exists to survive.
  // performReDrive evaluates supersession BEFORE acquireRunLock; both verbs that
  // can mint a competing parent-less primary in the same phase — `forge retry
  // <parent> --force` (retry.ts, under withRunLock) and `forge gate
  // request-changes` (gate.ts, likewise) — take and RELEASE that same run lock, so
  // one can do it entirely inside the window between this verb's read and its own
  // acquireRunLock. Both other CASes would still apply: the parent row is 'failed'
  // and the run row is 'failed'.
  //
  // Simulated the way the run-CAS race above is — deterministically, by a trigger
  // that fires on the parent reopen itself, so the competing row exists only after
  // the pre-lock read has already passed. A re-drive that reads supersession only
  // outside the transaction reopens a dead lineage beside a live primary, which is
  // the cross-wave adoption hazard AC3 and FG-584's RF-3b parent-scoping close.
  db.exec(`
    CREATE TRIGGER race_mint_superseding_primary AFTER UPDATE OF status ON tasks
    WHEN NEW.id = 'parent-ordered-supersede-race' AND NEW.status = 'pending'
    BEGIN
      INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at)
      VALUES ('parent-raced-live', '${RUN.id}', 'build', 'engineer', 'pending', '{}', '2026-06-09T00:00:00Z');
    END;
  `);

  const parentBefore = getTask("parent-ordered-supersede-race")!;
  const runBefore = getRun(RUN.id)!;
  const taskCount = tasksForRun(RUN.id).length;
  const eventCount = eventsForRun(RUN.id).length;

  const outcome = performReDrive("parent-ordered-supersede-race");
  assert.equal(outcome.kind, "re-drive-refused", `a raced supersession must refuse; got ${JSON.stringify(outcome)}`);
  if (outcome.kind === "re-drive-refused") {
    assert.match(outcome.reason, /SUPERSEDED by parent-raced-live/, "the refusal names the primary that won the race");
    assert.match(outcome.reason, new RegExp(`forge next ${RUN.id}`), "…and the verb that WILL be accepted");
    assert.match(outcome.reason, /Nothing was written/);
  }

  // Whole rows, not selected fields — the standard the AC3 refusal cells use. The
  // trigger's own INSERT rolls back with the transaction, so the row count is the
  // pre-verb one: a refusal leaves the store byte-identical.
  assert.deepEqual(getTask("parent-ordered-supersede-race"), parentBefore, "the parent reopen rolled back — still failed");
  assert.deepEqual(getRun(RUN.id), runBefore, "the run row never left 'failed'");
  assert.equal(tasksForRun(RUN.id).length, taskCount, "no task row survived the rollback");
  assert.equal(getTask("parent-raced-live"), undefined, "…including the trigger's own competing primary");
  assert.equal(eventsForRun(RUN.id).length, eventCount, "no run.reactivated, no task.reconciled — a rolled-back verb emits nothing");
});

// ── FG-688: the inspector that misadvises ────────────────────────────────────
//
// The ticket's second half. `buildFanoutView` hardcoded `forge recover <id>
// --re-drive` for EVERY fanout parent while the mutation guard accepts only an
// enumerated set, so on a `prerequisite_blocked` parent — the exact case FG-688 is
// about — following forge's own printed advice produced a refusal (FG-576).
//
// The invariant these cells hold the surface to is general, not this ticket's
// kind: THE RECOMMENDATION CAN NEVER NAME A VERB THE MUTATION GUARD REJECTS.

/** Every FailureKind this build knows, taken from the compile-time-exhaustive
 *  re-drive enumeration — so a kind added later is automatically in this table
 *  and cannot slip past the invariant. */
const ALL_FAILURE_KINDS = Object.keys(RE_DRIVABLE_FAILURE_KINDS);

test("FG-688 inspector: the recommendation NEVER names a verb --re-drive would reject — every failure kind, ordered and unordered", () => {
  assert.ok(ALL_FAILURE_KINDS.length > 20, "sanity: the table really is the whole FailureKind union");

  for (const ordered of [true, false]) {
    for (const kind of ALL_FAILURE_KINDS) {
      // One phase per case: supersession is per-phase, so distinct phases keep the
      // cases independent (and keep a minted primary from superseding the next).
      const phase = `build-${ordered ? "o" : "u"}-${kind}`;
      const parentId = `parent-${phase}`;
      buildFailedWave(parentId, kind, { ordered, phase });

      const inspected = performInspect(parentId);
      assert.equal(inspected.kind, "inspect-fanout-parent", `${phase}: a fanout parent inspects as one`);
      if (inspected.kind !== "inspect-fanout-parent") continue;
      const view = inspected.parent;
      // The invariant is about the VERB recommended, so it is read off the
      // discrete commands — a refusal's note may legitimately mention `--re-drive`
      // while explaining why it is not being offered.
      const recommendsReDrive = view.recommendationCommands.some((c) => c.includes("--re-drive"));
      assert.equal(
        view.recommendation.startsWith(view.recommendationCommands.join(" && ")),
        true,
        `${phase}: the rendered line and the discrete commands are the same advice`,
      );

      // The disposition is the SAME predicate the guard enforces, so it must
      // agree with it — asserted below against the guard's own answer.
      assert.equal(recommendsReDrive, view.reDrive.eligible, `${phase}: the printed verb matches the disposition`);
      assert.ok(view.reDrive.why.length > 0, `${phase}: --json consumers get a WHY, not just a verb`);
      assert.equal(view.reDrive.ordered, ordered, `${phase}: the durable wave shape is surfaced`);
      assert.equal(view.recommendationCommands.length >= 1, true, `${phase}: discrete commands too`);

      const outcome = performReDrive(parentId);

      // Forward: a recommended --re-drive is never refused.
      if (recommendsReDrive) {
        assert.notEqual(outcome.kind, "re-drive-refused", `${phase}: recommended --re-drive must not be refused`);
      }
      // Converse: every kind the guard refuses gets a NON-re-drive recommendation,
      // and that recommendation names a real forward verb.
      if (outcome.kind === "re-drive-refused") {
        assert.equal(recommendsReDrive, false, `${phase}: a refused kind must not be recommended --re-drive`);
        assert.match(view.recommendation, /^forge (retry|next|show) /, `${phase}: the fallback names an accepted verb`);
      }
    }
  }
});

test("FG-688 inspector: a re-drive-refused kind falls back to the retryPolicy-derived retry line, --force iff the policy needs it", () => {
  // A refused kind that IS plainly retryable, and one that is not — the fallback
  // is derived from retryPolicy rather than special-cased, so both come out right.
  buildFailedWave("parent-fb-retryable", "idle_timeout", { phase: "build-fb-retryable" });
  buildFailedWave("parent-fb-forced", "integration_failed", { phase: "build-fb-forced" });

  assert.equal(retryPolicy("idle_timeout").retryable, true, "sanity");
  assert.equal(retryPolicy("integration_failed").retryable, false, "sanity");

  const retryable = performInspect("parent-fb-retryable");
  assert.equal(retryable.kind, "inspect-fanout-parent");
  if (retryable.kind !== "inspect-fanout-parent") return;
  assert.deepEqual(retryable.parent.recommendationCommands, ["forge retry parent-fb-retryable"]);
  assert.equal(retryable.parent.reDrive.disposition, "failure_kind_refused");

  const forced = performInspect("parent-fb-forced");
  assert.equal(forced.kind, "inspect-fanout-parent");
  if (forced.kind !== "inspect-fanout-parent") return;
  assert.deepEqual(forced.parent.recommendationCommands, ["forge retry parent-fb-forced --force"]);
  assert.match(forced.parent.recommendation, /integration_failed/);
});

test("FG-688 inspector: the FG-576 reproduction — a prerequisite_blocked ordered parent's --json recommendation is --re-drive, AND that command succeeds", () => {
  buildFailedWave("parent-fg576", "prerequisite_blocked");
  settleRunFailed();

  // Verbatim the operator's path: `forge recover <parent> --json`.
  const inspected = performRecover("parent-fg576", { json: true });
  assert.equal(inspected.kind, "inspect-fanout-parent");
  if (inspected.kind !== "inspect-fanout-parent") return;
  assert.deepEqual(inspected.parent.recommendationCommands, ["forge recover parent-fg576 --re-drive"]);
  assert.equal(inspected.parent.failureKind, "prerequisite_blocked");
  assert.equal(inspected.parent.reDrive.eligible, true);
  assert.equal(inspected.parent.reDrive.disposition, "eligible");
  assert.equal(inspected.parent.reDrive.ordered, true);

  // Before FG-688 this is where the operator hit a refusal.
  const outcome = performRecover("parent-fg576", { reDrive: true });
  assert.equal(outcome.kind, "re-drive-done");
  if (outcome.kind !== "re-drive-done") return;
  assert.equal(outcome.lane, "ordered_reopened_in_place");
  assert.equal(outcome.dispatchTaskId, "parent-fg576");
});

test("FG-688 inspector: a SUPERSEDED parent is pointed at `forge next <runId>`, never at --re-drive", () => {
  buildFailedWave("parent-superseded-advice", "prerequisite_blocked");
  insertTask(mkTask("parent-live-advice", { status: "running", phase: "build", createdAt: "2026-06-02T00:00:00Z" }));
  settleRunFailed();

  const inspected = performInspect("parent-superseded-advice");
  assert.equal(inspected.kind, "inspect-fanout-parent");
  if (inspected.kind !== "inspect-fanout-parent") return;
  assert.deepEqual(inspected.parent.recommendationCommands, [`forge next ${RUN.id}`]);
  assert.equal(inspected.parent.reDrive.eligible, false);
  assert.equal(inspected.parent.reDrive.disposition, "superseded");
  assert.equal(inspected.parent.reDrive.supersededBy, "parent-live-advice");
  assert.match(inspected.parent.recommendation, /parent-live-advice/, "names the live primary");

  // And the guard agrees — the point of routing both through one predicate.
  assert.equal(performReDrive("parent-superseded-advice").kind, "re-drive-refused");
});

test("FG-688 inspector: a run whose status no recovery verb reopens gets a read-only recommendation, not --re-drive", () => {
  buildFailedWave("parent-run-abandoned-advice", "prerequisite_blocked");
  updateRunStatus(RUN.id, "abandoned");

  const inspected = performInspect("parent-run-abandoned-advice");
  assert.equal(inspected.kind, "inspect-fanout-parent");
  if (inspected.kind !== "inspect-fanout-parent") return;
  assert.equal(inspected.parent.reDrive.disposition, "run_not_reopenable");
  // The recommended VERB is read-only; the note may still name `--re-drive` while
  // explaining why an abandoned run is not reopened by it.
  assert.deepEqual(inspected.parent.recommendationCommands, ["forge show parent-run-abandoned-advice"]);
  assert.match(inspected.parent.recommendation, /abandoned/);
  assert.equal(performReDrive("parent-run-abandoned-advice").kind, "re-drive-refused");
});

test("FG-688 inspector: a run-level `forge recover <runId>` lists an eligible ORDERED parent — and stays docker-free", () => {
  buildFailedWave("parent-runlevel-ordered", "prerequisite_blocked");
  settleRunFailed();

  // Any container probe here is the bug: a run-level inspect must never reach
  // docker. Only FAILED tasks are listed, and the fanout view reads durable state.
  const outcome = performInspect(RUN.id, () => {
    throw new Error("run-level inspect must not probe a container");
  });
  assert.equal(outcome.kind, "inspect-run");
  if (outcome.kind !== "inspect-run") return;

  const view = outcome.fanoutParents.find((f) => f.parentId === "parent-runlevel-ordered");
  assert.ok(view, "the ordered parent FG-688 makes recoverable is listed, not reported as 'no recoverable tasks'");
  assert.equal(view!.failureKind, "prerequisite_blocked");
  assert.deepEqual(view!.recommendationCommands, ["forge recover parent-runlevel-ordered --re-drive"]);
  assert.equal(view!.reDrive.eligible, true);
});

test("FG-688 inspector: a run-level listing still omits a fanout parent whose kind the guard refuses", () => {
  buildFailedWave("parent-runlevel-refused", "gate_rejected");

  const outcome = performInspect(RUN.id);
  assert.equal(outcome.kind, "inspect-run");
  if (outcome.kind !== "inspect-run") return;
  assert.equal(
    outcome.fanoutParents.some((f) => f.parentId === "parent-runlevel-refused"),
    false,
    "the widened listing is the shared enumeration, not 'every failed parent'",
  );
});

// ── performRecover dispatcher ────────────────────────────────────────────────

test("performRecover: defaults to inspect, routes --continue and --re-drive, rejects both together", () => {
  insertTask(mkTask("dispatch-task", { status: "failed" }));
  logEvent("task.failed", { runId: RUN.id, taskId: "dispatch-task", payload: { failure_kind: "orphaned", error: "boom" } });

  const inspected = performRecover("dispatch-task", {});
  assert.equal(inspected.kind, "inspect-task");

  const badUsage = performRecover("dispatch-task", { continueTask: true, reDrive: true });
  assert.equal(badUsage.kind, "bad-usage");
});
