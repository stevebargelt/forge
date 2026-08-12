import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask } from "../store/tasks.js";
import { logEvent } from "../store/events.js";
import type { Run, Task, TaskStatus, RunStatus } from "../types/index.js";
import { detectRetryOrphan, detectInconsistentRunState, detectOrphanedWorkMayPersist, detectStuckRun, detectContainerReapFailed, detectResurrectedGateDecision, runOpsCheck } from "./detect.js";
import { makeIncident } from "./incident.js";
import { computeAdjudicationIdentity } from "./adjudication.js";
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

test("detectOrphanedWorkMayPersist: complete and abandoned parents retire historical persisted-work incidents", () => {
  for (const status of ["complete", "abandoned"] as const) {
    const runId = `run-owmp-${status}`;
    const taskId = `task-owmp-${status}`;
    insertRun(mkRun(runId, status));
    insertTask(mkTask(taskId, runId, "failed"));
    logEvent("task.failed", {
      runId,
      taskId,
      payload: {
        failure_kind: "orphaned_work_may_persist",
        error: "historical work may have persisted",
        evidence: {
          containerName: `forge-${taskId}`,
          containerLiveness: "gone",
          resultState: "absent",
          recoverableStdoutResult: false,
          worktreePathChecked: "/historical/worktree",
          changedFiles: ["M historical.ts"],
          source: "worktree",
        },
      },
    });
  }

  assert.deepEqual(
    detectOrphanedWorkMayPersist(db),
    [],
    "complete and abandoned runs retain audit evidence without permanent HIGH incidents",
  );
});

test("detectOrphanedWorkMayPersist: a failed parent does not hide the failure that may have caused it", () => {
  insertRun(mkRun("run-owmp-failed", "failed"));
  insertTask(mkTask("task-owmp-failed", "run-owmp-failed", "failed"));
  logEvent("task.failed", {
    runId: "run-owmp-failed",
    taskId: "task-owmp-failed",
    payload: {
      failure_kind: "orphaned_work_may_persist",
      error: "work may have persisted",
      evidence: {
        containerName: "forge-task-owmp-failed",
        containerLiveness: "gone",
        resultState: "absent",
        recoverableStdoutResult: false,
        worktreePathChecked: "/failed/worktree",
        changedFiles: ["M unresolved.ts"],
        source: "worktree",
      },
    },
  });

  assert.equal(detectOrphanedWorkMayPersist(db).length, 1);
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

// ── FG-703: operator-authorized adjudication suppression ────────────────────
//
// detectOrphanedWorkMayPersist drops an incident iff the task's LATEST
// ops.adjudicated record names EXACTLY the identity of the incident computed
// from the current latest task.failed payload. Suppression is gated on that
// identity record, never on run status — so FG-549's active/failed-parent
// behavior is untouched, and a materially-changed failure reappears as new.

/** Record an ops.adjudicated event carrying the identity the detector will
 *  recompute from the SAME (runId, taskId, failureKind, evidence) — the one
 *  canonical function, never re-derived on either side. */
function adjudicate(runId: string, taskId: string, failureKind: string, evidence: Record<string, unknown> | undefined): void {
  const identity = computeAdjudicationIdentity({ runId, taskId, failureKind, evidence: evidence as never });
  logEvent("ops.adjudicated", {
    runId,
    taskId,
    payload: { identity, outcome: "no_unique_work", rationale: "no unique work — audited", actor: "steve" },
  });
}

const worktreeEvidence = (changedFiles: string[], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  containerName: "forge-adj",
  containerLiveness: "gone",
  resultState: "absent",
  recoverableStdoutResult: false,
  worktreePathChecked: "/wt",
  changedFiles,
  source: "worktree",
  ...over,
});

test("FG-703 (a): a matching ops.adjudicated record suppresses an orphaned_work_may_persist incident under an ACTIVE run", () => {
  insertRun(mkRun("run-adj-a", "active"));
  insertTask(mkTask("task-adj-a", "run-adj-a", "failed"));
  const evidence = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-adj-a", taskId: "task-adj-a", payload: { failure_kind: "orphaned_work_may_persist", error: "...", evidence } });

  assert.equal(detectOrphanedWorkMayPersist(db).length, 1, "precondition: raises before adjudication");
  adjudicate("run-adj-a", "task-adj-a", "orphaned_work_may_persist", evidence);
  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "a matching adjudication for THIS identity suppresses the incident");
});

test("FG-703 (b): the SAME task with NO adjudication still raises the incident", () => {
  insertRun(mkRun("run-adj-b", "active"));
  insertTask(mkTask("task-adj-b", "run-adj-b", "failed"));
  const evidence = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-adj-b", taskId: "task-adj-b", payload: { failure_kind: "orphaned_work_may_persist", error: "...", evidence } });

  assert.equal(detectOrphanedWorkMayPersist(db).length, 1, "no adjudication record → incident is unresolved and visible");
});

test("FG-703 (c1): a materially-changed task.failed (resultState absent→valid) reappears — recorded identity no longer matches", () => {
  insertRun(mkRun("run-adj-c1", "active"));
  insertTask(mkTask("task-adj-c1", "run-adj-c1", "failed"));
  const ev1 = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-adj-c1", taskId: "task-adj-c1", payload: { failure_kind: "orphaned_work_may_persist", error: "first", evidence: ev1 } });
  adjudicate("run-adj-c1", "task-adj-c1", "orphaned_work_may_persist", ev1);
  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "suppressed against the adjudicated identity");

  // The WORK materially changed — a fresh task.failed with resultState valid.
  const ev2 = worktreeEvidence(["?? f.txt"], { resultState: "valid" });
  logEvent("task.failed", { runId: "run-adj-c1", taskId: "task-adj-c1", payload: { failure_kind: "orphaned_work_may_persist", error: "second", evidence: ev2 } });
  assert.equal(detectOrphanedWorkMayPersist(db).length, 1, "materially-changed work → identity drift → reappears as unresolved");
});

test("FG-703 (c2): a materially-changed WORKTREE changed-file SET reappears — the set is identity-bearing when source is worktree", () => {
  insertRun(mkRun("run-adj-c2", "active"));
  insertTask(mkTask("task-adj-c2", "run-adj-c2", "failed"));
  const ev1 = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-adj-c2", taskId: "task-adj-c2", payload: { failure_kind: "orphaned_work_may_persist", error: "first", evidence: ev1 } });
  adjudicate("run-adj-c2", "task-adj-c2", "orphaned_work_may_persist", ev1);
  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "suppressed against the adjudicated identity");

  const ev2 = worktreeEvidence(["?? g.txt", "M other.ts"]); // a genuinely different worktree file set
  logEvent("task.failed", { runId: "run-adj-c2", taskId: "task-adj-c2", payload: { failure_kind: "orphaned_work_may_persist", error: "second", evidence: ev2 } });
  assert.equal(detectOrphanedWorkMayPersist(db).length, 1, "a different worktree file set → identity drift → reappears");
});

test("FG-703 (c3): mere REORDERING of the same worktree file set stays suppressed — identity is a SET, not a sequence", () => {
  insertRun(mkRun("run-adj-c3", "active"));
  insertTask(mkTask("task-adj-c3", "run-adj-c3", "failed"));
  const ev1 = worktreeEvidence(["M a.ts", "?? b.txt"]);
  logEvent("task.failed", { runId: "run-adj-c3", taskId: "task-adj-c3", payload: { failure_kind: "orphaned_work_may_persist", error: "first", evidence: ev1 } });
  adjudicate("run-adj-c3", "task-adj-c3", "orphaned_work_may_persist", ev1);

  const ev2 = worktreeEvidence(["?? b.txt", "M a.ts"]); // same set, different order
  logEvent("task.failed", { runId: "run-adj-c3", taskId: "task-adj-c3", payload: { failure_kind: "orphaned_work_may_persist", error: "second", evidence: ev2 } });
  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "same file SET (reordered) → identity stable → stays suppressed");
});

test("FG-703 (d): suppression is gated on identity, NOT run status — a stale/non-matching adjudication never suppresses a fresh incident (FG-549 preserved)", () => {
  // Active parent, but the recorded adjudication names a DIFFERENT identity —
  // e.g. it was decided against an earlier, materially-different failure.
  insertRun(mkRun("run-adj-d", "active"));
  insertTask(mkTask("task-adj-d", "run-adj-d", "failed"));
  const current = worktreeEvidence(["?? current.txt"]);
  logEvent("task.failed", { runId: "run-adj-d", taskId: "task-adj-d", payload: { failure_kind: "orphaned_work_may_persist", error: "current", evidence: current } });
  // adjudicate a DIFFERENT (stale) identity, as if from a prior distinct incident.
  adjudicate("run-adj-d", "task-adj-d", "orphaned_work_may_persist", worktreeEvidence(["?? stale.txt"]));

  assert.equal(detectOrphanedWorkMayPersist(db).length, 1, "a stale adjudication for another identity must not let a genuinely new incident inherit it");
});

test("FG-703 (d2): a FAILED parent run with no adjudication still raises an UNADJUDICATED incident (FG-549 unchanged)", () => {
  insertRun(mkRun("run-adj-d2", "failed"));
  insertTask(mkTask("task-adj-d2", "run-adj-d2", "failed"));
  logEvent("task.failed", { runId: "run-adj-d2", taskId: "task-adj-d2", payload: { failure_kind: "orphaned_work_may_persist", error: "x", evidence: worktreeEvidence(["?? f.txt"]) } });

  assert.equal(detectOrphanedWorkMayPersist(db).length, 1, "a failed parent still raises — suppression never keys on run status");
});

test("FG-703 (e): shared-checkout churn (project_dir_shared changedFiles count/paths change) does NOT un-suppress", () => {
  insertRun(mkRun("run-adj-e", "active"));
  insertTask(mkTask("task-adj-e", "run-adj-e", "failed"));
  const ev1 = worktreeEvidence(["M a.ts", "M b.ts"], { source: "project_dir_shared", worktreePathChecked: "/shared/project" });
  logEvent("task.failed", { runId: "run-adj-e", taskId: "task-adj-e", payload: { failure_kind: "orphaned_work_may_persist", error: "first", evidence: ev1 } });
  adjudicate("run-adj-e", "task-adj-e", "orphaned_work_may_persist", ev1);
  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "suppressed at first");

  // The shared dirty checkout churns: a different count and different paths, but
  // the same SHARED source — a volatile fact that must NOT bind identity.
  const ev2 = worktreeEvidence(["M a.ts", "M b.ts", "?? c.ts", "?? d.ts"], { source: "project_dir_shared", worktreePathChecked: "/shared/project" });
  logEvent("task.failed", { runId: "run-adj-e", taskId: "task-adj-e", payload: { failure_kind: "orphaned_work_may_persist", error: "second", evidence: ev2 } });
  assert.deepEqual(detectOrphanedWorkMayPersist(db), [], "shared-checkout changed-file churn stays suppressed — it is volatile, not identity-bearing");
});

test("FG-703 (scope): an oom_killed incident is NOT suppressed even with a matching identity record — out of adjudication scope", () => {
  insertRun(mkRun("run-adj-scope", "active"));
  insertTask(mkTask("task-adj-scope", "run-adj-scope", "failed"));
  const evidence = worktreeEvidence(["?? f.txt"], { oomKilled: true, exitCode: 137 });
  logEvent("task.failed", { runId: "run-adj-scope", taskId: "task-adj-scope", payload: { failure_kind: "oom_killed", error: "oom", evidence } });
  // Even a record whose identity matches the oom_killed facts must not suppress —
  // only the orphaned_work_may_persist incident kind is adjudicable.
  adjudicate("run-adj-scope", "task-adj-scope", "oom_killed", evidence);

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1, "oom_killed is out of scope — never suppressed");
  assert.equal(incidents[0]!.kind, "oom_killed");
});

test("FG-703: a suppressed incident is excluded from the composed runOpsCheck list", () => {
  insertRun(mkRun("run-adj-compose", "active"));
  insertTask(mkTask("task-adj-compose", "run-adj-compose", "failed"));
  const evidence = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-adj-compose", taskId: "task-adj-compose", payload: { failure_kind: "orphaned_work_may_persist", error: "...", evidence } });
  adjudicate("run-adj-compose", "task-adj-compose", "orphaned_work_may_persist", evidence);

  assert.deepEqual(
    runOpsCheck().filter((i) => i.kind === "orphaned_work_may_persist"),
    [],
    "runOpsCheck's default (suppressing) path excludes the adjudicated incident",
  );
});

// ── FG-703: the identity surface an operator copies into --identity ─────────
//
// Every emitted orphaned_work_may_persist incident must carry the canonical
// identity — the exact `--identity` compare-and-set token the write path
// recomputes — and nothing else must. The value a check REPORTS has to be
// byte-identical to what computeAdjudicationIdentity (the write path's own
// function) produces, or the operator copies a value the write refuses as drift.

test("FG-703 (identity): an unadjudicated orphaned_work_may_persist incident carries a non-empty identity byte-identical to the write path's compute", () => {
  insertRun(mkRun("run-id", "active"));
  insertTask(mkTask("task-id", "run-id", "failed"));
  const evidence = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-id", taskId: "task-id", payload: { failure_kind: "orphaned_work_may_persist", error: "...", evidence } });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  const reported = incidents[0]!.identity;
  assert.ok(reported && /^[0-9a-f]{64}$/.test(reported), "the incident carries a non-empty sha256 identity");
  // The write path recomputes identity from the SAME structured facts; the value
  // the operator copies must be exactly what `forge ops adjudicate --identity`
  // will demand — a mismatch here is silent and total.
  const writePathIdentity = computeAdjudicationIdentity({ runId: "run-id", taskId: "task-id", failureKind: "orphaned_work_may_persist", evidence: evidence as never });
  assert.equal(reported, writePathIdentity, "reported identity == write-path identity (copyable, accepted, not refused as drift)");
});

test("FG-703 (identity): the production shape — a container_crash under a failed parent, source project_dir_shared — carries a copyable identity", () => {
  insertRun(mkRun("run-prod", "failed"));
  insertTask(mkTask("task-prod", "run-prod", "failed"));
  const evidence = worktreeEvidence(["M a.ts", "M b.ts"], {
    source: "project_dir_shared",
    worktreePathChecked: "/shared/project",
    containerExitedEventObserved: true,
    exitCode: 1,
    oomKilled: false,
  });
  logEvent("task.failed", { runId: "run-prod", taskId: "task-prod", payload: { failure_kind: "container_crash", error: "crash", evidence } });

  const incidents = detectOrphanedWorkMayPersist(db);
  assert.equal(incidents.length, 1);
  assert.equal(incidents[0]!.kind, "orphaned_work_may_persist", "container_crash presents as an orphaned_work_may_persist incident");
  assert.equal(
    incidents[0]!.identity,
    computeAdjudicationIdentity({ runId: "run-prod", taskId: "task-prod", failureKind: "container_crash", evidence: evidence as never }),
    "the reported identity matches the write path for the exact production incident shape",
  );
});

test("FG-703 (identity): incident kinds with no adjudication path carry NO identity", () => {
  // A retry_orphan (pending task under a terminal run) — no adjudication path.
  insertRun(mkRun("run-noid", "complete"));
  insertTask(mkTask("task-noid", "run-noid", "pending"));
  const orphan = detectRetryOrphan(db);
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0]!.identity, undefined, "retry_orphan has no adjudication path — no identity");

  // An oom_killed incident — an adjudicable-looking sibling kind, but out of scope.
  insertRun(mkRun("run-oomid", "active"));
  insertTask(mkTask("task-oomid", "run-oomid", "failed"));
  logEvent("task.failed", { runId: "run-oomid", taskId: "task-oomid", payload: { failure_kind: "oom_killed", error: "oom", evidence: worktreeEvidence(["?? f.txt"], { oomKilled: true, exitCode: 137 }) } });
  const oom = detectOrphanedWorkMayPersist(db).filter((i) => i.kind === "oom_killed");
  assert.equal(oom.length, 1);
  assert.equal(oom[0]!.identity, undefined, "oom_killed is not adjudicable — no identity");
});

test("FG-703 (identity): renderHuman prints the identity for an adjudicable incident, copyable into --identity", () => {
  insertRun(mkRun("run-render", "active"));
  insertTask(mkTask("task-render", "run-render", "failed"));
  const evidence = worktreeEvidence(["?? f.txt"]);
  logEvent("task.failed", { runId: "run-render", taskId: "task-render", payload: { failure_kind: "orphaned_work_may_persist", error: "...", evidence } });

  const incidents = detectOrphanedWorkMayPersist(db);
  const rendered = renderHuman(incidents);
  const identity = incidents[0]!.identity!;
  assert.match(rendered, new RegExp(`identity: ${identity}`), "the human render shows the exact identity");
  assert.match(rendered, new RegExp(`forge ops adjudicate task-render --identity ${identity}`), "the render spells out the copyable adjudicate command");
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

// ── detectResurrectedGateDecision (FG-676) ──────────────────────────────────
//
// The shape: the row says awaiting_gate while its own event stream says a human
// already decided it (gate reject / request-changes → gate_rejected). Fixtures
// replay the production event order — gate.decided, then task.failed, then the
// resurrecting task.awaiting_gate — so the "walks past a non-terminal event"
// property is exercised, not assumed.

function replayGateRejection(runId: string, taskId: string, error: string): void {
  logEvent("gate.decided", { runId, taskId, payload: { decision: "request-changes", rationale: error } });
  logEvent("task.failed", { runId, taskId, payload: { failure_kind: "gate_rejected", error } });
}

test("detectResurrectedGateDecision: flags an awaiting_gate row whose newest terminal event is a gate rejection", () => {
  insertRun(mkRun("run-res", "active"));
  insertTask(mkTask("task-res", "run-res", "awaiting_gate"));
  replayGateRejection("run-res", "task-res", "request-changes; superseded");
  // the resurrection itself: a non-terminal event written AFTER the decision
  logEvent("task.awaiting_gate", { runId: "run-res", taskId: "task-res", payload: {} });

  const incidents = detectResurrectedGateDecision(db);
  assert.equal(incidents.length, 1);
  const i = incidents[0]!;
  assert.equal(i.kind, "resurrected_gate_decision");
  assert.equal(i.severity, "high");
  assert.equal(i.confidence, "db-confirmed");
  assert.equal(i.runId, "run-res");
  assert.equal(i.taskId, "task-res");
  assert.equal(i.recommendedAction.type, "repair");
  assert.equal(i.recommendedAction.autonomy, "ask");
  assert.equal(i.recommendedAction.command, "forge ops repair task-res");
  assert.match(i.evidence.join(" "), /awaiting_gate.*failure_kind gate_rejected/);
  assert.match(i.evidence.join(" "), /request-changes; superseded/);
  assert.match(i.recommendedAction.reason, /will not clear on the next wave/);
});

test("detectResurrectedGateDecision: one incident per resurrected task, across runs", () => {
  insertRun(mkRun("run-res-a", "active"));
  insertTask(mkTask("task-res-a1", "run-res-a", "awaiting_gate"));
  insertTask(mkTask("task-res-a2", "run-res-a", "awaiting_gate"));
  replayGateRejection("run-res-a", "task-res-a1", "rejected 1");
  replayGateRejection("run-res-a", "task-res-a2", "rejected 2");
  insertRun(mkRun("run-res-b", "complete"));
  insertTask(mkTask("task-res-b1", "run-res-b", "awaiting_gate"));
  replayGateRejection("run-res-b", "task-res-b1", "rejected 3");

  const incidents = detectResurrectedGateDecision(db);
  assert.equal(incidents.length, 3);
  assert.deepEqual(
    incidents.map((i) => i.taskId).sort(),
    ["task-res-a1", "task-res-a2", "task-res-b1"],
  );
});

test("detectResurrectedGateDecision: a legitimately awaiting_gate task raises nothing", () => {
  insertRun(mkRun("run-legit", "active"));
  insertTask(mkTask("task-legit", "run-legit", "awaiting_gate"));
  logEvent("task.awaiting_gate", { runId: "run-legit", taskId: "task-legit", payload: {} });

  assert.deepEqual(detectResurrectedGateDecision(db), [], "no prior gate rejection — this row is simply waiting on a human");
});

test("detectResurrectedGateDecision: a gate-rejected task that STAYED failed is healthy — the fixed world raises nothing", () => {
  insertRun(mkRun("run-fixed", "active"));
  insertTask(mkTask("task-fixed", "run-fixed", "failed"));
  replayGateRejection("run-fixed", "task-fixed", "request-changes; superseded");

  assert.deepEqual(detectResurrectedGateDecision(db), []);
});

test("detectResurrectedGateDecision: a later task.completed means recovered — no incident", () => {
  insertRun(mkRun("run-recovered", "active"));
  insertTask(mkTask("task-recovered", "run-recovered", "awaiting_gate"));
  replayGateRejection("run-recovered", "task-recovered", "rejected then recovered");
  logEvent("task.completed", { runId: "run-recovered", taskId: "task-recovered", payload: {} });
  logEvent("task.awaiting_gate", { runId: "run-recovered", taskId: "task-recovered", payload: {} });

  assert.deepEqual(detectResurrectedGateDecision(db), [], "newest terminal event wins — a recovery is not a resurrection");
});

test("detectResurrectedGateDecision: a non-gate failure kind under awaiting_gate is a different contradiction — not claimed here", () => {
  insertRun(mkRun("run-otherkind", "active"));
  insertTask(mkTask("task-otherkind", "run-otherkind", "awaiting_gate"));
  logEvent("task.failed", {
    runId: "run-otherkind", taskId: "task-otherkind",
    payload: { failure_kind: "container_crash", error: "exit 1" },
  });

  assert.deepEqual(detectResurrectedGateDecision(db), [], "this repair has no authority over a non-decided terminal state");
});

test("detectResurrectedGateDecision: honors projectDir scoping", () => {
  insertRun(mkRun("run-scoped-in", "active", "/proj/a"));
  insertTask(mkTask("task-scoped-in", "run-scoped-in", "awaiting_gate"));
  replayGateRejection("run-scoped-in", "task-scoped-in", "rejected in scope");
  insertRun(mkRun("run-scoped-out", "active", "/proj/b"));
  insertTask(mkTask("task-scoped-out", "run-scoped-out", "awaiting_gate"));
  replayGateRejection("run-scoped-out", "task-scoped-out", "rejected out of scope");

  const scoped = detectResurrectedGateDecision(db, { projectDir: "/proj/a" });
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0]!.taskId, "task-scoped-in");
  assert.equal(detectResurrectedGateDecision(db).length, 2, "unscoped sees both");
});

test("resurrected_gate_decision flows through runOpsCheck and renders human-readably", () => {
  insertRun(mkRun("run-res-e2e", "active"));
  insertTask(mkTask("task-res-e2e", "run-res-e2e", "awaiting_gate"));
  replayGateRejection("run-res-e2e", "task-res-e2e", "request-changes; superseded");

  const incidents = runOpsCheck();
  const mine = incidents.filter((i) => i.kind === "resurrected_gate_decision");
  assert.equal(mine.length, 1, "registered in DETECTORS");
  const rendered = renderHuman(mine);
  assert.match(rendered, /\[high\] resurrected_gate_decision {2}\(db-confirmed\)/);
  assert.match(rendered, /forge ops repair task-res-e2e/);
});
