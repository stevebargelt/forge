import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import { detectRetryOrphan, detectInconsistentRunState, detectOrphanedWorkMayPersist, detectStuckRun, detectContainerReapFailed, runOpsCheck } from "./detect.js";
import { makeIncident } from "./incident.js";
import { renderHuman } from "../cli/commands/ops.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
});
afterEach(() => {
  if (prev) setDbForTest(prev);
});

function mkRun(id: string, status: RunStatus, projectDir?: string): Run {
  return { id, workflow: "feature", title: id, status, createdAt: "2026-06-02T12:00:00Z", projectDir };
}

function mkTask(id: string, runId: string, status: TaskStatus): Task {
  return {
    id, runId, phase: "engineer", agentRole: "engineer", status,
    taskPackage: { taskId: id, runId, phase: "engineer", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-06-02T12:00:00Z",
  };
}

// ── detectRetryOrphan ───────────────────────────────────────────────────────

test("detectRetryOrphan: flags a pending task under a terminal run", () => {
  insertRun(mkRun("run-a", "complete"));
  insertTask(mkTask("task-a", "run-a", "pending"));

  const incidents = detectRetryOrphan(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "retry_orphan");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.taskId, "task-a");
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge ops repair task-a");
});

test("detectRetryOrphan: also flags abandoned runs; ignores active runs and non-pending tasks", () => {
  insertRun(mkRun("run-abandoned", "abandoned"));
  insertTask(mkTask("task-ab", "run-abandoned", "pending"));
  // pending under an ACTIVE run is normal (about to dispatch) → not an orphan.
  insertRun(mkRun("run-active", "active"));
  insertTask(mkTask("task-live", "run-active", "pending"));
  // complete task under a terminal run is fine.
  insertRun(mkRun("run-done", "complete"));
  insertTask(mkTask("task-done", "run-done", "complete"));

  const incidents = detectRetryOrphan(db);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.runId, "run-abandoned");
});

test("detectRetryOrphan: flags a pending task under a FAILED run; the run's own expected failed task is NOT an orphan (FG-585)", () => {
  insertRun(mkRun("run-failed", "failed"));
  insertTask(mkTask("task-orphan", "run-failed", "pending"));
  // the run's OWN expected failure — the phase that made the run `failed`. It is
  // NOT an orphan/incident; a failed run is expected to contain a failed task.
  insertTask(mkTask("task-expected-fail", "run-failed", "failed"));

  const incidents = detectRetryOrphan(db);
  assert.equal(incidents.length, 1, "only the stranded pending task, not the expected failure");
  assert.equal(incidents[0]!.taskId, "task-orphan");
});

// ── detectInconsistentRunState ──────────────────────────────────────────────

test("detectInconsistentRunState: flags a running task under a terminal run", () => {
  insertRun(mkRun("run-b", "complete"));
  insertTask(mkTask("task-b", "run-b", "running"));

  const incidents = detectInconsistentRunState(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "inconsistent_run_state");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.recommendedAction.type, "repair_unavailable");
  assert.equal(i.recommendedAction.command, null);
});

test("detectInconsistentRunState: running under an active run is normal", () => {
  insertRun(mkRun("run-c", "active"));
  insertTask(mkTask("task-c", "run-c", "running"));
  assert.equal(detectInconsistentRunState(db).length, 0);
});

test("detectInconsistentRunState: flags a stuck `running` task under a FAILED run, but NOT the run's own expected failed task (FG-585)", () => {
  insertRun(mkRun("run-failed-inc", "failed"));
  insertTask(mkTask("task-stuck", "run-failed-inc", "running"));
  // expected failure of the failed run — a `failed` task, not `running`.
  insertTask(mkTask("task-expected-fail", "run-failed-inc", "failed"));

  const incidents = detectInconsistentRunState(db);
  assert.equal(incidents.length, 1, "only the genuinely-stuck running task is inconsistent");
  assert.equal(incidents[0]!.taskId, "task-stuck");
  assert.equal(incidents[0]!.kind, "inconsistent_run_state");
});

test("detectInconsistentRunState: a FAILED run whose only failure is its own expected failed phase is NOT flagged (FG-585)", () => {
  insertRun(mkRun("run-failed-clean", "failed"));
  insertTask(mkTask("task-expected-only", "run-failed-clean", "failed"));
  insertTask(mkTask("task-completed", "run-failed-clean", "complete"));

  assert.equal(detectInconsistentRunState(db).length, 0, "no running task → no inconsistency incident");
  assert.equal(detectRetryOrphan(db).length, 0, "no pending task → no orphan incident");
});

// ── detectOrphanedWorkMayPersist (FG-455) ───────────────────────────────────

test("detectOrphanedWorkMayPersist: flags a failed task classified orphaned_work_may_persist", () => {
  insertRun(mkRun("run-owmp", "active"));
  insertTask(mkTask("task-owmp", "run-owmp", "failed"));
  const evidence = {
    containerName: "forge-task-owmp",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: ["?? new-file.txt"],
  };
  logEvent("task.failed", {
    runId: "run-owmp", taskId: "task-owmp",
    payload: { failure_kind: "orphaned_work_may_persist", error: "orphaned_work_may_persist: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "orphaned_work_may_persist");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.taskId, "task-owmp");
  assert.equal(i.recommendedAction.type, "investigate");
  assert.equal(i.recommendedAction.autonomy, "manual-only", "never auto-actionable — a human must inspect the diff first");
  assert.match(i.evidence.join(" "), /changed-file\.txt|1 changed file/);
});

test("detectOrphanedWorkMayPersist: ignores ordinary orphaned and non-failed tasks", () => {
  insertRun(mkRun("run-ord", "active"));
  insertTask(mkTask("task-ord", "run-ord", "failed"));
  logEvent("task.failed", { runId: "run-ord", taskId: "task-ord", payload: { failure_kind: "orphaned", error: "orphaned" } });
  insertTask(mkTask("task-running", "run-ord", "running"));

  assert.deepEqual(detectOrphanedWorkMayPersist(db), []);
});

test("detectOrphanedWorkMayPersist: discloses source=project_dir_shared in the rendered evidence", () => {
  insertRun(mkRun("run-shared", "active"));
  insertTask(mkTask("task-shared", "run-shared", "failed"));
  const evidence = {
    containerName: "forge-task-shared",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/some/project",
    changedFiles: ["M foo.ts"],
    source: "project_dir_shared",
  };
  logEvent("task.failed", {
    runId: "run-shared", taskId: "task-shared",
    payload: { failure_kind: "orphaned_work_may_persist", error: "...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.evidence.join(" "), /SHARED project directory/i);
});

test("detectOrphanedWorkMayPersist: only reads the LATEST task.failed event — a superseded earlier failure's evidence is ignored", () => {
  insertRun(mkRun("run-retry", "active"));
  insertTask(mkTask("task-retry", "run-retry", "failed"));
  // An earlier attempt failed as ordinary orphaned...
  logEvent("task.failed", { runId: "run-retry", taskId: "task-retry", payload: { failure_kind: "orphaned", error: "first" } });
  // ...retried, and the SECOND attempt is the one classified orphaned_work_may_persist.
  logEvent("task.retried", { runId: "run-retry", taskId: "task-retry" });
  const evidence = {
    containerName: "forge-task-retry", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/wt", changedFiles: ["?? f.txt"], source: "worktree",
  };
  logEvent("task.failed", { runId: "run-retry", taskId: "task-retry", payload: { failure_kind: "orphaned_work_may_persist", error: "second", evidence } });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.taskId, "task-retry");
});

test("detectOrphanedWorkMayPersist: project scoping", () => {
  insertRun(mkRun("run-owmp-a", "active", "/projects/alpha"));
  insertTask(mkTask("task-owmp-a", "run-owmp-a", "failed"));
  logEvent("task.failed", { runId: "run-owmp-a", taskId: "task-owmp-a", payload: { failure_kind: "orphaned_work_may_persist", error: "x" } });
  insertRun(mkRun("run-owmp-b", "active", "/projects/beta"));
  insertTask(mkTask("task-owmp-b", "run-owmp-b", "failed"));
  logEvent("task.failed", { runId: "run-owmp-b", taskId: "task-owmp-b", payload: { failure_kind: "orphaned_work_may_persist", error: "x" } });

  assert.equal(detectOrphanedWorkMayPersist(db, { projectDir: "/projects/alpha" }).length, 1);
  assert.equal(detectOrphanedWorkMayPersist(db).length, 2, "no projectDir → host-wide");
});

// FG-455 p4 review finding 1: an OOM-killed task with a dirty worktree was
// invisible to `forge ops check` — oom_killed must be admitted alongside
// orphaned_work_may_persist.
test("detectOrphanedWorkMayPersist: flags an oom_killed task with a dirty worktree, distinguishing the OOM cause", () => {
  insertRun(mkRun("run-oom", "active"));
  insertTask(mkTask("task-oom", "run-oom", "failed"));
  const evidence = {
    containerName: "forge-task-oom",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: ["?? new-file.txt"],
    oomKilled: true,
    exitCode: 137,
  };
  logEvent("task.failed", {
    runId: "run-oom", taskId: "task-oom",
    payload: { failure_kind: "oom_killed", error: "oom_killed: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "oom_killed");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.recommendedAction.autonomy, "manual-only");
  assert.match(i.evidence[0]!, /was killed \(OOM\)/);
  assert.match(i.evidence.join(" "), /new-file\.txt|1 changed file/);
});

test("detectOrphanedWorkMayPersist: oom_killed without a positive oomKilled flag describes exit 137 ambiguously", () => {
  insertRun(mkRun("run-oom137", "active"));
  insertTask(mkTask("task-oom137", "run-oom137", "failed"));
  const evidence = {
    containerName: "forge-task-oom137",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: ["?? new-file.txt"],
    exitCode: 137,
  };
  logEvent("task.failed", {
    runId: "run-oom137", taskId: "task-oom137",
    payload: { failure_kind: "oom_killed", error: "oom_killed: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.evidence[0]!, /exit 137 — possibly OOM or an external kill/);
});

test("detectOrphanedWorkMayPersist: a CLEAN-worktree oom_killed task produces no incident, matching orphaned_work_may_persist's clean case", () => {
  insertRun(mkRun("run-oom-clean", "active"));
  insertTask(mkTask("task-oom-clean", "run-oom-clean", "failed"));
  const evidence = {
    containerName: "forge-task-oom-clean",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: [],
    oomKilled: true,
  };
  logEvent("task.failed", {
    runId: "run-oom-clean", taskId: "task-oom-clean",
    payload: { failure_kind: "oom_killed", error: "oom_killed: ...", evidence },
  });

  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "clean worktree — no work at risk, no incident");
});

// FG-479 review finding 1: a pipeline task stuck fail-safe as orphaned_needs_finalize
// (container finished with a usable result, but the host-side finalize never ran)
// must raise an incident too, not just orphaned_work_may_persist/oom_killed.
test("detectOrphanedWorkMayPersist: flags an orphaned_needs_finalize task, distinguishing the unfinalized cause", () => {
  insertRun(mkRun("run-needs-finalize", "active"));
  insertTask(mkTask("task-needs-finalize", "run-needs-finalize", "failed"));
  const evidence = {
    containerName: "forge-task-needs-finalize",
    containerLiveness: "gone",
    resultState: "valid",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: ["?? new-file.txt"],
  };
  logEvent("task.failed", {
    runId: "run-needs-finalize", taskId: "task-needs-finalize",
    payload: { failure_kind: "orphaned_needs_finalize", error: "orphaned_needs_finalize: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "orphaned_needs_finalize");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.recommendedAction.autonomy, "manual-only");
  assert.match(i.evidence[0]!, /finished with a usable result/);
});

// FG-479: unlike oom_killed, a CLEAN worktree must NOT suppress the incident for
// this kind — the at-risk artifact is the preserved unfinalized result, not
// dirty files (a crash after the worktree merge leaves changedFiles empty while
// the integration gate and reds still never ran).
test("detectOrphanedWorkMayPersist: a CLEAN-worktree orphaned_needs_finalize task still raises an incident", () => {
  insertRun(mkRun("run-nf-clean", "active"));
  insertTask(mkTask("task-nf-clean", "run-nf-clean", "failed"));
  const evidence = {
    containerName: "forge-task-nf-clean",
    containerLiveness: "gone",
    resultState: "valid",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/some/worktree",
    changedFiles: [],
  };
  logEvent("task.failed", {
    runId: "run-nf-clean", taskId: "task-nf-clean",
    payload: { failure_kind: "orphaned_needs_finalize", error: "orphaned_needs_finalize: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1, "clean worktree must not hide an unfinalized result");
  assert.equal(incidents[0]!.kind, "orphaned_needs_finalize");
});

// ── detectStuckRun (FG-414) ─────────────────────────────────────────────────

test("detectStuckRun: flags an active run whose tasks are all terminal", () => {
  insertRun(mkRun("run-stuck", "active"));
  insertTask(mkTask("task-stuck-1", "run-stuck", "complete"));
  insertTask(mkTask("task-stuck-2", "run-stuck", "failed"));

  const incidents = detectStuckRun(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "stuck_run");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "high");
  assert.equal(i.runId, "run-stuck");
  assert.equal(i.taskId, null);
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge ops repair run-stuck");
  assert.match(i.recommendedAction.reason, /forge cancel run-stuck --abandon-run/);
});

test("detectStuckRun: does NOT flag a healthy in-progress run (has a non-terminal task)", () => {
  insertRun(mkRun("run-healthy", "active"));
  insertTask(mkTask("task-healthy-done", "run-healthy", "complete"));
  insertTask(mkTask("task-healthy-live", "run-healthy", "running"));

  assert.deepEqual(detectStuckRun(db), []);
});

test("detectStuckRun: ignores a terminal run whose tasks are all terminal (that's just done, not stuck)", () => {
  insertRun(mkRun("run-done", "complete"));
  insertTask(mkTask("task-done", "run-done", "complete"));

  assert.deepEqual(detectStuckRun(db), []);
});

test("detectStuckRun: ignores an active run with no tasks yet", () => {
  insertRun(mkRun("run-fresh", "active"));
  assert.deepEqual(detectStuckRun(db), []);
});

test("detectStuckRun: project scoping", () => {
  insertRun(mkRun("run-stuck-a", "active", "/projects/alpha"));
  insertTask(mkTask("task-stuck-a", "run-stuck-a", "failed"));
  insertRun(mkRun("run-stuck-b", "active", "/projects/beta"));
  insertTask(mkTask("task-stuck-b", "run-stuck-b", "complete"));

  assert.equal(detectStuckRun(db, { projectDir: "/projects/alpha" }).length, 1);
  assert.equal(detectStuckRun(db, { projectDir: "/projects/alpha" })[0]!.runId, "run-stuck-a");
  assert.equal(detectStuckRun(db).length, 2, "no projectDir → host-wide");
});

// ── detectContainerReapFailed (FG-503 finding 4: review) ────────────────────

test("detectContainerReapFailed: flags a task with a container.reap_failed event", () => {
  insertRun(mkRun("run-reap", "active"));
  insertTask(mkTask("task-reap", "run-reap", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap", taskId: "task-reap",
    payload: { containerName: "forge-task-reap", why: "docker rm -f -v failed after task completion; container may still be running/present with its anonymous shadow volume" },
  });

  const incidents = detectContainerReapFailed(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "container_reap_failed");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.severity, "low");
  assert.equal(i.taskId, "task-reap");
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge ops reap-containers");
  assert.match(i.evidence.join(" "), /forge-task-reap/);
});

test("detectContainerReapFailed: a task with no reap_failed event raises no incident", () => {
  insertRun(mkRun("run-noreap", "active"));
  insertTask(mkTask("task-noreap", "run-noreap", "complete"));
  assert.equal(detectContainerReapFailed(db).length, 0);
});

test("detectContainerReapFailed: only reads the LATEST reap_failed event per task", () => {
  insertRun(mkRun("run-reap2", "active"));
  insertTask(mkTask("task-reap2", "run-reap2", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap2", taskId: "task-reap2",
    payload: { containerName: "forge-task-reap2", why: "first failure" },
  });
  logEvent("container.reap_failed", {
    runId: "run-reap2", taskId: "task-reap2",
    payload: { containerName: "forge-task-reap2", why: "second failure" },
  });

  const incidents = detectContainerReapFailed(db);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.evidence.join(" "), /second failure/);
});

test("detectContainerReapFailed: project scoping", () => {
  insertRun(mkRun("run-reap-a", "active", "/projects/alpha"));
  insertTask(mkTask("task-reap-a", "run-reap-a", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap-a", taskId: "task-reap-a",
    payload: { containerName: "forge-task-reap-a", why: "docker error" },
  });
  insertRun(mkRun("run-reap-b", "active", "/projects/beta"));
  insertTask(mkTask("task-reap-b", "run-reap-b", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap-b", taskId: "task-reap-b",
    payload: { containerName: "forge-task-reap-b", why: "docker error" },
  });

  assert.equal(detectContainerReapFailed(db, { projectDir: "/projects/alpha" }).length, 1);
  assert.equal(detectContainerReapFailed(db, { projectDir: "/projects/alpha" })[0]!.runId, "run-reap-a");
  assert.equal(detectContainerReapFailed(db).length, 2, "no projectDir → host-wide");
});

// ── FG-504: a later container.reaped event supersedes container.reap_failed ─

test("detectContainerReapFailed (FG-504): a LATER container.reaped event for the same task clears the incident (sweep 'killed')", () => {
  insertRun(mkRun("run-reap-cleared", "active"));
  insertTask(mkTask("task-reap-cleared", "run-reap-cleared", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap-cleared", taskId: "task-reap-cleared",
    payload: { containerName: "forge-task-reap-cleared", why: "docker rm -f -v failed after task completion" },
  });
  logEvent("container.reaped", {
    runId: "run-reap-cleared", taskId: "task-reap-cleared",
    payload: { containerName: "forge-task-reap-cleared", outcome: "killed" },
  });

  assert.equal(detectContainerReapFailed(db).length, 0, "the recommended repair succeeded — the incident must clear");
});

test("detectContainerReapFailed (FG-504): a LATER container.reaped event clears the incident on 'not_found' too (already gone still confirms it)", () => {
  insertRun(mkRun("run-reap-notfound", "active"));
  insertTask(mkTask("task-reap-notfound", "run-reap-notfound", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap-notfound", taskId: "task-reap-notfound",
    payload: { containerName: "forge-task-reap-notfound", why: "docker rm -f -v failed after task completion" },
  });
  logEvent("container.reaped", {
    runId: "run-reap-notfound", taskId: "task-reap-notfound",
    payload: { containerName: "forge-task-reap-notfound", outcome: "not_found" },
  });

  assert.equal(detectContainerReapFailed(db).length, 0, "not_found is confirmed-gone too — clears the incident");
});

test("detectContainerReapFailed (FG-505): a LATER container.reaped event with a 'confirmed-absent-at-scan' outcome (absence-heal) also clears the incident", () => {
  insertRun(mkRun("run-reap-absence-healed", "active"));
  insertTask(mkTask("task-reap-absence-healed", "run-reap-absence-healed", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap-absence-healed", taskId: "task-reap-absence-healed",
    payload: { containerName: "forge-task-reap-absence-healed", why: "docker rm -f -v failed after task completion" },
  });
  logEvent("container.reaped", {
    runId: "run-reap-absence-healed", taskId: "task-reap-absence-healed",
    payload: { containerName: "forge-task-reap-absence-healed", outcome: "confirmed-absent-at-scan" },
  });

  assert.equal(
    detectContainerReapFailed(db).length,
    0,
    "the detector treats ANY later container.reaped as a resolution, regardless of the outcome payload value — absence-heal clears the incident the same as an active reap",
  );
});

test("detectContainerReapFailed (FG-504): a container.reaped event recorded BEFORE the reap_failed event does not suppress it (still stale/unresolved)", () => {
  insertRun(mkRun("run-reap-stale", "active"));
  insertTask(mkTask("task-reap-stale", "run-reap-stale", "complete"));
  logEvent("container.reaped", {
    runId: "run-reap-stale", taskId: "task-reap-stale",
    payload: { containerName: "forge-task-reap-stale", outcome: "killed" },
  });
  logEvent("container.reap_failed", {
    runId: "run-reap-stale", taskId: "task-reap-stale",
    payload: { containerName: "forge-task-reap-stale", why: "docker rm -f -v failed after task completion" },
  });

  const incidents = detectContainerReapFailed(db);
  assert.equal(incidents.length, 1, "the reap_failed happened AFTER the (unrelated, earlier) reaped event — still unresolved");
});

test("detectContainerReapFailed (FG-504): with no container.reaped event at all, the incident persists (a reap 'error' leaves nothing to supersede it)", () => {
  insertRun(mkRun("run-reap-persists", "active"));
  insertTask(mkTask("task-reap-persists", "run-reap-persists", "complete"));
  logEvent("container.reap_failed", {
    runId: "run-reap-persists", taskId: "task-reap-persists",
    payload: { containerName: "forge-task-reap-persists", why: "docker rm -f -v failed after task completion" },
  });

  assert.equal(detectContainerReapFailed(db).length, 1, "no resolution was ever recorded — the incident must keep firing");
});

// ── project scoping ─────────────────────────────────────────────────────────

test("project scoping: filters to projectDir; host-wide when omitted", () => {
  insertRun(mkRun("run-p1", "complete", "/projects/alpha"));
  insertTask(mkTask("task-p1", "run-p1", "pending"));
  insertRun(mkRun("run-p2", "complete", "/projects/beta"));
  insertTask(mkTask("task-p2", "run-p2", "pending"));

  assert.equal(detectRetryOrphan(db, { projectDir: "/projects/alpha" }).length, 1);
  assert.equal(detectRetryOrphan(db, { projectDir: "/projects/alpha" })[0]!.runId, "run-p1");
  assert.equal(detectRetryOrphan(db).length, 2, "no projectDir → host-wide");
});

// ── runOpsCheck composition ─────────────────────────────────────────────────

test("runOpsCheck: composes both detectors over the read-only handle", () => {
  insertRun(mkRun("run-d", "complete"));
  insertTask(mkTask("task-pending", "run-d", "pending"));
  insertTask(mkTask("task-running", "run-d", "running"));

  const kinds = runOpsCheck().map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["inconsistent_run_state", "retry_orphan"]);
});

test("runOpsCheck: clean state → no incidents", () => {
  insertRun(mkRun("run-clean", "complete"));
  insertTask(mkTask("task-clean", "run-clean", "complete"));
  assert.deepEqual(runOpsCheck(), []);
});

test("runOpsCheck: includes stuck_run alongside the terminal-run detectors", () => {
  insertRun(mkRun("run-d2", "complete"));
  insertTask(mkTask("task-pending2", "run-d2", "pending"));
  insertRun(mkRun("run-stuck2", "active"));
  insertTask(mkTask("task-stuck2", "run-stuck2", "failed"));

  const kinds = runOpsCheck().map((i) => i.kind).sort();
  assert.deepEqual(kinds, ["retry_orphan", "stuck_run"]);
});

// ── makeIncident invariant ──────────────────────────────────────────────────

test("makeIncident: rejects a non-db-confirmed incident carrying an auto-safe action", () => {
  assert.throws(
    () =>
      makeIncident({
        kind: "retry_orphan", severity: "high", confidence: "db-candidate", runId: "r", taskId: "t",
        evidence: [], recommendedAction: { type: "repair", autonomy: "auto-safe", command: "forge x", reason: "" },
      }),
    /only db-confirmed incidents may be auto-safe/
  );
});

test("makeIncident: rejects repair_unavailable that carries a command", () => {
  assert.throws(
    () =>
      makeIncident({
        kind: "retry_orphan", severity: "high", confidence: "db-confirmed", runId: "r", taskId: "t",
        evidence: [], recommendedAction: { type: "repair_unavailable", autonomy: "manual-only", command: "forge x", reason: "" },
      }),
    /repair_unavailable but carries a command/
  );
});

test("makeIncident: allows a db-confirmed auto-safe action", () => {
  const i = makeIncident({
    kind: "retry_orphan", severity: "low", confidence: "db-confirmed", runId: "r", taskId: "t",
    evidence: [], recommendedAction: { type: "repair", autonomy: "auto-safe", command: "forge x", reason: "ok" },
  });
  assert.equal(i.recommendedAction.autonomy, "auto-safe");
});

// ── read-only invariant (the load-bearing #250 safety claim) ─────────────────

test("runOpsCheck never mutates state — run/task statuses and event count unchanged", () => {
  // A DB with both incident conditions present, plus a healthy active run.
  insertRun(mkRun("run-term", "complete"));
  insertTask(mkTask("t-pending", "run-term", "pending"));   // retry_orphan
  insertTask(mkTask("t-running", "run-term", "running"));   // inconsistent_run_state
  insertRun(mkRun("run-live", "active"));
  insertTask(mkTask("t-live", "run-live", "running"));      // healthy, not flagged

  const snapshot = () => ({
    tasks: db.prepare("SELECT id, status FROM tasks ORDER BY id").all(),
    runs: db.prepare("SELECT id, status FROM runs ORDER BY id").all(),
    events: (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n,
  });

  const before = snapshot();
  const incidents = runOpsCheck();
  assert.equal(incidents.length, 2, "detected the two conditions (precondition for a meaningful no-mutation check)");

  const after = snapshot();
  assert.deepEqual(after.tasks, before.tasks, "task statuses must be unchanged");
  assert.deepEqual(after.runs, before.runs, "run statuses must be unchanged");
  assert.equal(after.events, before.events, "no events written");
});

// ── CLI rendering ────────────────────────────────────────────────────────────

test("renderHuman: clean state", () => {
  assert.equal(renderHuman([]), "No ops incidents.");
});

test("renderHuman: surfaces kind, location, autonomy, and the repair_unavailable action", () => {
  const out = renderHuman([
    makeIncident({
      kind: "retry_orphan", severity: "high", confidence: "db-confirmed",
      runId: "run-x", taskId: "task-y", evidence: ["run run-x is complete", "child task task-y is pending"],
      recommendedAction: { type: "repair_unavailable", autonomy: "manual-only", command: null, reason: "no DB-safe repair" },
    }),
  ]);
  assert.match(out, /retry_orphan/);
  assert.match(out, /db-confirmed/);
  assert.match(out, /run-x \/ task-y/);
  assert.match(out, /\(repair_unavailable\)/);   // command null → renders the action type
  assert.match(out, /manual-only/);
  assert.match(out, /no DB-safe repair/);
});

// ── FG-461: attached-exit container_crash / idle_timeout with recovery evidence ──

test("detectOrphanedWorkMayPersist: FG-461 flags a container_crash carrying evidence with changed files, describing the crash + exit code", () => {
  insertRun(mkRun("run-crash", "active"));
  insertTask(mkTask("task-crash", "run-crash", "failed"));
  const evidence = {
    containerName: "forge-task-crash",
    containerLiveness: "gone",
    resultState: "absent",
    recoverableStdoutResult: false,
    worktreePathChecked: "/tmp/wt",
    changedFiles: ["?? partial.txt"],
    source: "worktree",
    exitCode: 1,
    oomKilled: false,
  };
  logEvent("task.failed", {
    runId: "run-crash", taskId: "task-crash",
    payload: { failure_kind: "container_crash", error: "container_crash (exit 1)", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "orphaned_work_may_persist");
  assert.match(i.evidence[0]!, /crashed \(exit 1\)/);
  assert.match(i.evidence.join(" "), /1 changed file/);
});

test("detectOrphanedWorkMayPersist: FG-461 flags an idle_timeout carrying evidence", () => {
  insertRun(mkRun("run-idle", "active"));
  insertTask(mkTask("task-idle", "run-idle", "failed"));
  const evidence = {
    containerName: "forge-task-idle", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? partial.txt"],
    source: "worktree", oomKilled: false,
  };
  logEvent("task.failed", {
    runId: "run-idle", taskId: "task-idle",
    payload: { failure_kind: "idle_timeout", error: "idle_timeout ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  assert.match(incidents[0]!.evidence[0]!, /idle-timed-out/);
});

test("detectOrphanedWorkMayPersist: FG-461 a container_crash with NO evidence payload raises NO incident (no retroactive noise on historical crashes)", () => {
  insertRun(mkRun("run-crash-noev", "active"));
  insertTask(mkTask("task-crash-noev", "run-crash-noev", "failed"));
  // A pre-FG-461 (or read-only-dispatch) crash: no evidence recorded.
  logEvent("task.failed", {
    runId: "run-crash-noev", taskId: "task-crash-noev",
    payload: { failure_kind: "container_crash", error: "container_crash (exit 1)" },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 0, "an evidence-less attached-exit crash must not raise a work-may-persist incident");
});

test("detectOrphanedWorkMayPersist: FG-461 a container_crash with evidence but a CLEAN worktree raises NO incident", () => {
  insertRun(mkRun("run-crash-clean", "active"));
  insertTask(mkTask("task-crash-clean", "run-crash-clean", "failed"));
  const evidence = {
    containerName: "forge-task-crash-clean", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: [],
    source: "worktree", exitCode: 1, oomKilled: false,
  };
  logEvent("task.failed", {
    runId: "run-crash-clean", taskId: "task-crash-clean",
    payload: { failure_kind: "container_crash", error: "container_crash (exit 1)", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 0, "no changed files → no persisted work at risk → no incident");
});

// ── FG-492 finding 4: `forge ops check` distinguishes all four causal states ──
//
// The AC requires `forge show`, `forge status`, AND `forge ops check` to tell
// apart: (1) a confirmed exit with code/signal/OOM evidence; (2) a container
// missing with no terminal event; (3) a fanout parent's derived failure (never
// had a container); (4) a result missing after a clean exit. show/status
// already rendered all four; ops check had only a bare observed/not-observed
// boolean, and states 3/4 raised no incident at all. These pin the richer
// evidence lines and the two newly-admitted states.

test("FG-492 finding 4 (state 1): a confirmed exit renders full code/signal/OOM detail, not just a boolean", () => {
  insertRun(mkRun("run-state1", "active"));
  insertTask(mkTask("task-state1", "run-state1", "failed"));
  const evidence = {
    containerName: "forge-task-state1", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? f.txt"],
    source: "worktree", exitCode: 1, oomKilled: false, containerExitedEventObserved: true,
  };
  logEvent("task.failed", {
    runId: "run-state1", taskId: "task-state1",
    payload: { failure_kind: "container_crash", error: "container_crash (exit 1)", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const line = incidents[0]!.evidence.find((l) => l.includes("directly observed"));
  assert.ok(line, "expected a directly-observed evidence line");
  assert.match(line!, /exit code 1/);
  assert.match(line!, /OOMKilled=false/);
});

test("FG-492 finding 4 (state 2): a container missing with no terminal event is distinguished from a confirmed exit", () => {
  insertRun(mkRun("run-state2", "active"));
  insertTask(mkTask("task-state2", "run-state2", "failed"));
  const evidence = {
    containerName: "forge-task-state2", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? f.txt"],
    source: "worktree", containerExitedEventObserved: false,
  };
  logEvent("task.failed", {
    runId: "run-state2", taskId: "task-state2",
    payload: { failure_kind: "orphaned_work_may_persist", error: "orphaned_work_may_persist: ...", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  assert.match(
    incidents[0]!.evidence.join(" "),
    /container disappeared without a recorded terminal event — no container\.exited event was ever observed for this task/,
  );
});

test("FG-492 finding 4 (state 3): a fanout parent's derived failure raises an incident that never calls it a killed agent", () => {
  insertRun(mkRun("run-state3", "active"));
  insertTask(mkTask("task-state3", "run-state3", "failed"));
  logEvent("task.failed", {
    runId: "run-state3", taskId: "task-state3",
    payload: {
      failure_kind: "fanout_wave_orphaned",
      error: "fanout wave orphaned: 1/3 children complete, the rest failed or never finished",
      childSummary: { total: 3, complete: 1 },
    },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "orphaned_work_may_persist", "no new IncidentKind — bucketed like container_crash/idle_timeout");
  assert.match(i.evidence.join(" "), /fanout wave's parent, orphaned mid-wave/);
  assert.match(i.evidence.join(" "), /1\/3 children completed/);
  assert.match(i.evidence.join(" "), /never had its own agent container.*not a killed agent/);
  assert.match(i.evidence.join(" "), /n\/a — a fanout parent has no dedicated container or worktree/);
  assert.match(i.recommendedAction.reason, /forge recover task-state3 --re-drive/);
});

test("FG-492 finding 4 (state 4): a result missing after a confirmed clean exit is distinguished from a crash, when evidence is recorded", () => {
  insertRun(mkRun("run-state4", "active"));
  insertTask(mkTask("task-state4", "run-state4", "failed"));
  const evidence = {
    containerName: "forge-task-state4", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: [],
    source: "worktree", exitCode: 0, containerExitedEventObserved: true,
  };
  logEvent("task.failed", {
    runId: "run-state4", taskId: "task-state4",
    payload: { failure_kind: "result_missing", error: "no_result_json", evidence },
  });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.match(i.evidence[0]!, /container exited cleanly but no result\.json was ever produced/);
  assert.match(i.evidence[0]!, /not a killed agent/);
  assert.match(i.recommendedAction.reason, /forge retry task-state4/);
  assert.match(i.recommendedAction.reason, /without needing --force/, "a plain clean-exit result_missing never needs --force");
});

// FG-492 review findings 1+2: invoke.ts/runNext.ts's real failTask calls now
// attach evidence for result_missing (see invoke.integration.test.ts /
// runNext.integration.test.ts's "real failTask call" tests for the production-
// shape proof) — this fixture models an evidence-less edge case that can still
// occur: a pre-FG-492 event, or a read-only dispatch (a red/audit agent),
// where recoveryEvidenceFor() is skipped and no evidence is ever recorded.
test("FG-492 finding 4 (state 4 negative): result_missing with NO recorded evidence raises no incident — pre-FG-492 event or read-only dispatch, avoids retroactive noise", () => {
  insertRun(mkRun("run-state4-noev", "active"));
  insertTask(mkTask("task-state4-noev", "run-state4-noev", "failed"));
  logEvent("task.failed", {
    runId: "run-state4-noev", taskId: "task-state4-noev",
    payload: { failure_kind: "result_missing", error: "no_result_json" },
  });

  assert.deepEqual(detectOrphanedWorkMayPersist(db), []);
});
