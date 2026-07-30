import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun, getRun } from "../../store/runs.js";
import { insertTask, getTask, markTaskComplete, tasksForRun } from "../../store/tasks.js";
import { eventsForTask, logEvent } from "../../store/events.js";
import { taskDir } from "../../util/paths.js";
import { reconcileRun } from "../../v2/reconcile.js";
import { computeReadyQueue } from "../../v2/ready-queue.js";
import type { Workflow } from "../../v2/schema.js";
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

  const newTask = getTask(outcome.newTaskId)!;
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

// ── performRecover dispatcher ────────────────────────────────────────────────

test("performRecover: defaults to inspect, routes --continue and --re-drive, rejects both together", () => {
  insertTask(mkTask("dispatch-task", { status: "failed" }));
  logEvent("task.failed", { runId: RUN.id, taskId: "dispatch-task", payload: { failure_kind: "orphaned", error: "boom" } });

  const inspected = performRecover("dispatch-task", {});
  assert.equal(inspected.kind, "inspect-task");

  const badUsage = performRecover("dispatch-task", { continueTask: true, reDrive: true });
  assert.equal(badUsage.kind, "bad-usage");
});
