import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { taskDir } from "../../util/paths.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { logEvent } from "../../store/events.js";
import type { Event } from "../../store/events.js";
import {
  performShow,
  getFailureKindFromEvents,
  getOrphanEvidenceFromEvents,
  getFanoutWaveEvidenceFromEvents,
  orphanRecoveryMessage,
  fanoutWaveRecoveryMessage,
  classifyResultFile,
  computeElapsed,
  formatTimeAgo,
  tailLines,
  humanizeLogTail,
  getManifestIdleTimeoutMs,
  computeIdleCountdown,
  formatIdleCountdown,
  liveIdleCountdownForTask,
  listPresentArtifacts,
  deriveNextCommandForTask,
  deriveNextCommandForRun,
  groupFailedByKind,
  getBlockerTasks,
  showReconcileStep,
} from "./show.js";
import { getTask } from "../../store/tasks.js";
import { eventsForTask } from "../../store/events.js";
import type { Run, Task } from "../../types/index.js";

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let tmpDir: string;

const RUN: Run = {
  id: "run-show-test",
  workflow: "feature",
  title: "show test run",
  status: "active",
  createdAt: "2026-05-29T10:00:00Z",
};

function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    runId: RUN.id,
    phase: overrides.phase ?? "engineer",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "pending",
    taskPackage: {
      taskId: id,
      runId: RUN.id,
      phase: overrides.phase ?? "engineer",
      role: overrides.agentRole ?? "engineer",
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-05-29T10:00:00Z",
    startedAt: overrides.startedAt,
    completedAt: overrides.completedAt,
    error: overrides.error,
  };
}

function makeEvent(type: string, payload?: unknown): Event {
  return {
    id: 1,
    runId: RUN.id,
    taskId: "task-x",
    eventType: type as Event["eventType"],
    payload: payload ?? null,
    createdAt: "2026-05-29T10:00:00Z",
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  tmpDir = mkdtempSync(join(tmpdir(), "forge-show-test-"));
  insertRun(RUN);
  insertTask(makeTask("task-show-1"));
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

test("performShow with task id returns kind=task with task and events", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.equal(result.task.id, "task-show-1");
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0]!.eventType, "task.started");
  }
});

test("performShow with run id returns kind=run with run and events", () => {
  logEvent("run.created", { runId: RUN.id });
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.run.id, RUN.id);
    assert.equal(result.run.workflow, "feature");
    assert.equal(result.events.length, 2);
  }
});

test("performShow with unknown id returns kind=not-found", () => {
  const result = performShow("no-such-id-xyz");
  assert.equal(result.kind, "not-found");
  if (result.kind === "not-found") {
    assert.equal(result.id, "no-such-id-xyz");
  }
});

test("performShow task result includes verdicts array (empty when none)", () => {
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.deepEqual(result.verdicts, []);
  }
});

test("performShow run result has events with taskId populated when present", () => {
  logEvent("task.started", { runId: RUN.id, taskId: "task-show-1" });
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.events[0]!.taskId, "task-show-1");
  }
});

test("performShow task result events are empty when none logged", () => {
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.deepEqual(result.events, []);
  }
});

test("performShow run result events are empty when none logged", () => {
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.deepEqual(result.events, []);
  }
});

test("performShow: task id takes priority over run id when both could match", () => {
  // Task is looked up first; if a task exists for the id, kind=task is returned
  const result = performShow("task-show-1");
  assert.equal(result.kind, "task");
});

test("performShow: run result includes tasks array", () => {
  insertTask(makeTask("task-show-2"));
  const result = performShow(RUN.id);
  assert.equal(result.kind, "run");
  if (result.kind === "run") {
    assert.equal(result.tasks.length, 2);
  }
});

// ─── getFailureKindFromEvents ────────────────────────────────────────────────

test("getFailureKindFromEvents: returns failure_kind from task.failed payload", () => {
  const events: Event[] = [
    makeEvent("task.started"),
    makeEvent("task.failed", { failure_kind: "idle_timeout", error: "no output" }),
  ];
  assert.equal(getFailureKindFromEvents(events), "idle_timeout");
});

test("getFailureKindFromEvents: returns undefined when no task.failed event", () => {
  const events: Event[] = [makeEvent("task.started"), makeEvent("task.completed")];
  assert.equal(getFailureKindFromEvents(events), undefined);
});

test("getFailureKindFromEvents: returns 'unknown' when payload has no failure_kind (FG-412)", () => {
  const events: Event[] = [makeEvent("task.failed", { error: "something" })];
  assert.equal(getFailureKindFromEvents(events), "unknown");
});

test("getFailureKindFromEvents: returns 'unknown' when payload is null (FG-412)", () => {
  const events: Event[] = [makeEvent("task.failed", null)];
  assert.equal(getFailureKindFromEvents(events), "unknown");
});

test("getFailureKindFromEvents: returns container_crash from payload", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "container_crash", error: "exit 137" }),
  ];
  assert.equal(getFailureKindFromEvents(events), "container_crash");
});

test("getFailureKindFromEvents: picks the LATEST task.failed after a retry, not the stale first", () => {
  const events: Event[] = [
    makeEvent("task.started"),
    makeEvent("task.failed", { failure_kind: "idle_timeout" }),
    makeEvent("task.retried"),
    makeEvent("task.started"),
    makeEvent("task.failed", { failure_kind: "container_crash" }),
  ];
  assert.equal(getFailureKindFromEvents(events), "container_crash");
});

test("getFailureKindFromEvents: returns undefined when a later task.completed supersedes an earlier failure", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "model_error" }),
    makeEvent("task.retried"),
    makeEvent("task.completed"),
  ];
  assert.equal(getFailureKindFromEvents(events), undefined);
});

test("getFailureKindFromEvents: failure_kind round-trip via DB events", () => {
  insertTask(makeTask("task-fk-roundtrip", { status: "failed" }));
  logEvent("task.failed", {
    runId: RUN.id,
    taskId: "task-fk-roundtrip",
    payload: { failure_kind: "gate_rejected", error: "rejected" },
  });
  const result = performShow("task-fk-roundtrip");
  assert.equal(result.kind, "task");
  if (result.kind === "task") {
    assert.equal(getFailureKindFromEvents(result.events), "gate_rejected");
  }
});

test("fanout_wave_orphaned round-trip via DB events: failure kind, childSummary, and next command all agree", () => {
  insertTask(makeTask("task-fanout-parent", { status: "failed" }));
  logEvent("task.failed", {
    runId: RUN.id,
    taskId: "task-fanout-parent",
    payload: { failure_kind: "fanout_wave_orphaned", error: "boom", childSummary: { total: 3, complete: 1 } },
  });
  const result = performShow("task-fanout-parent");
  assert.equal(result.kind, "task");
  if (result.kind !== "task") return;
  const failureKind = getFailureKindFromEvents(result.events);
  assert.equal(failureKind, "fanout_wave_orphaned");
  // Same values feed both the --json diagnostic and the human "recovery:"/"Next:"
  // lines in show.ts — a single source of truth means the two surfaces can't diverge.
  const evidence = getFanoutWaveEvidenceFromEvents(result.events);
  assert.deepEqual(evidence, { total: 3, complete: 1 });
  const nextCommand = deriveNextCommandForTask(result.task.status, failureKind, result.task.id);
  assert.match(nextCommand, /forge recover task-fanout-parent --re-drive/);
  assert.match(fanoutWaveRecoveryMessage(result.task.id, evidence!), /1\/3/);
});

// ─── getOrphanEvidenceFromEvents / orphanRecoveryMessage (FG-455) ──────────

test("getOrphanEvidenceFromEvents: recovers the evidence recorded on the task.failed event", () => {
  const evidence = {
    containerName: "forge-task-x", containerLiveness: "gone" as const, resultState: "absent" as const,
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? f.txt"],
  };
  const events: Event[] = [makeEvent("task.failed", { failure_kind: "orphaned_work_may_persist", error: "x", evidence })];
  assert.deepEqual(getOrphanEvidenceFromEvents(events), evidence);
});

test("getOrphanEvidenceFromEvents: undefined for ordinary orphaned", () => {
  const events: Event[] = [makeEvent("task.failed", { failure_kind: "orphaned", error: "x" })];
  assert.equal(getOrphanEvidenceFromEvents(events), undefined);
});

test("orphanRecoveryMessage: names the task dir, worktree path, changed files, and --force guidance", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-recover-me", {
    containerName: "forge-task-recover-me", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/some/worktree", changedFiles: ["?? new.txt", "M changed.txt"],
  });
  assert.match(msg, /task-recover-me/);
  assert.match(msg, /\/tmp\/some\/worktree/);
  assert.match(msg, /new\.txt/);
  assert.match(msg, /changed\.txt/);
  assert.match(msg, /--force/);
});

test("orphanRecoveryMessage: handles a null worktree path (neither worktree_path nor run.projectDir recorded)", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-no-path", {
    containerName: "forge-task-no-path", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: null, changedFiles: [],
  });
  assert.match(msg, /none/i);
});

// ── orphanRecoveryMessage: FG-455 p4 review finding 1 — oom_killed wording ──

test("orphanRecoveryMessage: kind=oom_killed with oomKilled=true leads with a confirmed OOM, not the generic dirty-orphan wording", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-oom", {
    containerName: "forge-task-oom", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? new.txt"],
    exitCode: 137, oomKilled: true,
  }, "oom_killed");
  assert.match(msg, /container killed \(OOM\)/);
  assert.doesNotMatch(msg, /^work may have persisted/);
  // still includes the usual task dir / worktree / changed files / guidance
  assert.match(msg, /task-oom/);
  assert.match(msg, /\/tmp\/wt/);
  assert.match(msg, /new\.txt/);
  assert.match(msg, /--force/);
});

test("orphanRecoveryMessage: kind=oom_killed with exitCode=137 but oomKilled not confirmed → 'possibly OOM or an external kill'", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-oom-137", {
    containerName: "forge-task-oom-137", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: [],
    exitCode: 137,
  }, "oom_killed");
  assert.match(msg, /exit 137 — possibly OOM or an external kill/);
});

// ── orphanRecoveryMessage: FG-479 — orphaned_needs_finalize wording ──

test("orphanRecoveryMessage: kind=orphaned_needs_finalize leads with the unfinalized-pipeline-step cause and routes to retry --force (never recover --continue)", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-needs-finalize", {
    containerName: "forge-task-needs-finalize", containerLiveness: "gone", resultState: "valid",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? new.txt"],
  }, "orphaned_needs_finalize");
  assert.match(msg, /never finalized/);
  assert.match(msg, /cannot be trusted complete/);
  assert.doesNotMatch(msg, /^work may have persisted/);
  assert.match(msg, /forge retry task-needs-finalize --force/);
  assert.doesNotMatch(msg, /continue from it/, "recover --continue refuses this kind — the guidance must not suggest it");
});

test("orphanRecoveryMessage: kind defaults to orphaned_work_may_persist wording when omitted, even if evidence carries exitCode/oomKilled", () => {
  // FG-455 p4 review finding 1: the valid-result/orphaned branches now also
  // carry exitCode/oomKilled on baseEvidence — the OOM headline must be gated
  // on the failure KIND, not merely the presence of these fields.
  const msg = orphanRecoveryMessage(RUN.id, "task-plain-orphan", {
    containerName: "forge-task-plain-orphan", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? new.txt"],
    exitCode: 137, oomKilled: false,
  });
  assert.match(msg, /^work may have persisted/);
  assert.doesNotMatch(msg, /container killed/);
});

// ── orphanRecoveryMessage: FG-455 p4 re-review — oom_killed headline must not
// contradict the changed-files line for a CLEAN worktree ───────────────────

test("orphanRecoveryMessage: kind=oom_killed with no changed files does not claim changed files were found", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-oom-clean", {
    containerName: "forge-task-oom-clean", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: [],
    exitCode: 137, oomKilled: true,
  }, "oom_killed");
  assert.doesNotMatch(msg, /changed files were found/);
  assert.match(msg, /no changed files on the worktree/);
  assert.match(msg, /changed files:\s+\(none listed\)/);
});

test("orphanRecoveryMessage: kind=oom_killed with changed files present does claim changed files were found", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-oom-dirty", {
    containerName: "forge-task-oom-dirty", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? new.txt"],
    exitCode: 137, oomKilled: true,
  }, "oom_killed");
  assert.match(msg, /changed files were found/);
  assert.doesNotMatch(msg, /no changed files on the worktree/);
});

// ── orphanRecoveryMessage: FG-461 attached-exit kinds get their own headline ──

test("orphanRecoveryMessage: kind=container_crash leads with the crash + exit code, not the generic wording", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-crash", {
    containerName: "forge-task-crash", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? new.txt"],
    exitCode: 1, oomKilled: false,
  }, "container_crash");
  assert.match(msg, /container crashed \(exit 1\)/);
  assert.doesNotMatch(msg, /^work may have persisted/);
  assert.match(msg, /changed files were found/);
  // FG-461 fix: container_crash is retryable:true (retry-policy.ts) and NOT in
  // recover.ts's CONTINUABLE_KINDS — a bare `forge retry`, not --continue or
  // --force, is what the tool actually accepts.
  assert.match(msg, /forge retry task-crash/);
  assert.match(msg, /retryable without --force/);
  assert.doesNotMatch(msg, /continue from it or retry with --force/);
});

test("orphanRecoveryMessage: kind=idle_timeout leads with the idle-timeout kill", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-idle", {
    containerName: "forge-task-idle", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/tmp/wt", changedFiles: ["?? new.txt"],
    oomKilled: false,
  }, "idle_timeout");
  assert.match(msg, /idle-timed-out/);
  assert.doesNotMatch(msg, /^work may have persisted/);
  assert.match(msg, /changed files were found/);
  // FG-461 fix: idle_timeout is likewise retryable:true and not continuable.
  assert.match(msg, /forge retry task-idle/);
  assert.match(msg, /retryable without --force/);
  assert.doesNotMatch(msg, /continue from it or retry with --force/);
});

// ── orphanRecoveryMessage: FG-455 finding 2 source disclosure ───────────────

test("orphanRecoveryMessage: source=project_dir_shared discloses the shared-projectDir ambiguity", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-shared", {
    containerName: "forge-task-shared", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/proj", changedFiles: ["M foo.ts"],
    source: "project_dir_shared",
  });
  assert.match(msg, /SHARED project directory/i);
  assert.match(msg, /unrelated uncommitted changes/i);
  assert.match(msg, /evidence to inspect, not proof of task work/i);
});

test("orphanRecoveryMessage: source=worktree is stated as task-exclusive, no ambiguity disclosure", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-exclusive", {
    containerName: "forge-task-exclusive", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/proj/.worktrees/task-exclusive", changedFiles: ["M foo.ts"],
    source: "worktree",
  });
  assert.match(msg, /dedicated worktree \(task-exclusive\)/i);
  assert.doesNotMatch(msg, /unrelated uncommitted changes/i);
});

test("orphanRecoveryMessage: omits the source line when evidence predates the `source` field (legacy events)", () => {
  const msg = orphanRecoveryMessage(RUN.id, "task-legacy", {
    containerName: "forge-task-legacy", containerLiveness: "gone", resultState: "absent",
    recoverableStdoutResult: false, worktreePathChecked: "/proj", changedFiles: ["M foo.ts"],
  });
  assert.doesNotMatch(msg, /source:/i);
});

// ─── getFanoutWaveEvidenceFromEvents / fanoutWaveRecoveryMessage (FG-455 p2/p3 review finding 2) ──

test("getFanoutWaveEvidenceFromEvents: recovers the childSummary recorded on the task.failed event", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "fanout_wave_orphaned", error: "x", childSummary: { total: 4, complete: 1 } }),
  ];
  assert.deepEqual(getFanoutWaveEvidenceFromEvents(events), { total: 4, complete: 1 });
});

test("getFanoutWaveEvidenceFromEvents: undefined for a different failure kind", () => {
  const events: Event[] = [makeEvent("task.failed", { failure_kind: "orphaned_work_may_persist", error: "x" })];
  assert.equal(getFanoutWaveEvidenceFromEvents(events), undefined);
});

test("getFanoutWaveEvidenceFromEvents: undefined when a later task.completed supersedes (recovered)", () => {
  const events: Event[] = [
    makeEvent("task.failed", { failure_kind: "fanout_wave_orphaned", childSummary: { total: 2, complete: 1 } }),
    makeEvent("task.completed"),
  ];
  assert.equal(getFanoutWaveEvidenceFromEvents(events), undefined);
});

test("fanoutWaveRecoveryMessage: names the child completion counts and the --re-drive guidance", () => {
  const msg = fanoutWaveRecoveryMessage("parent-abc", { total: 3, complete: 2 });
  assert.match(msg, /2\/3/);
  assert.match(msg, /forge recover parent-abc --re-drive/);
});

// ─── classifyResultFile ──────────────────────────────────────────────────────

test("classifyResultFile: missing when file does not exist", () => {
  assert.equal(classifyResultFile(join(tmpDir, "no-such-file.json")), "missing");
});

test("classifyResultFile: empty when file exists but is blank", () => {
  const p = join(tmpDir, "empty.json");
  writeFileSync(p, "");
  assert.equal(classifyResultFile(p), "empty");
});

test("classifyResultFile: empty when file contains only whitespace", () => {
  const p = join(tmpDir, "whitespace.json");
  writeFileSync(p, "   \n  ");
  assert.equal(classifyResultFile(p), "empty");
});

test("classifyResultFile: malformed when file contains invalid JSON", () => {
  const p = join(tmpDir, "bad.json");
  writeFileSync(p, "not valid json {{{");
  assert.equal(classifyResultFile(p), "malformed");
});

test("classifyResultFile: valid when file contains valid JSON object", () => {
  const p = join(tmpDir, "good.json");
  writeFileSync(p, JSON.stringify({ status: "complete" }));
  assert.equal(classifyResultFile(p), "valid");
});

test("classifyResultFile: valid when file contains valid JSON array", () => {
  const p = join(tmpDir, "arr.json");
  writeFileSync(p, "[]");
  assert.equal(classifyResultFile(p), "valid");
});

// ─── computeElapsed ─────────────────────────────────────────────────────────

test("computeElapsed: returns — when no startedAt", () => {
  assert.equal(computeElapsed(undefined, undefined, 1000), "—");
});

test("computeElapsed: uses completedAt when provided", () => {
  const start = "2026-05-29T10:00:00Z";
  const end = "2026-05-29T10:05:00Z";
  assert.equal(computeElapsed(start, end), "5m");
});

test("computeElapsed: injectable now for determinism", () => {
  const startMs = 1000;
  const nowMs = startMs + 10 * 60 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "10m");
});

test("computeElapsed: formats seconds for short elapsed", () => {
  const startMs = 1000;
  const nowMs = startMs + 45 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "45s");
});

test("computeElapsed: formats hours correctly", () => {
  const startMs = 1000;
  const nowMs = startMs + 90 * 60 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "1h 30m");
});

test("computeElapsed: exact hour with no trailing minutes", () => {
  const startMs = 1000;
  const nowMs = startMs + 60 * 60 * 1000;
  assert.equal(computeElapsed(new Date(startMs).toISOString(), undefined, nowMs), "1h");
});

// ─── formatTimeAgo ───────────────────────────────────────────────────────────

test("formatTimeAgo: seconds ago for < 60s", () => {
  const now = 60000;
  assert.equal(formatTimeAgo(now - 30000, now), "30s ago");
});

test("formatTimeAgo: minutes ago for < 60m", () => {
  const now = 120 * 60 * 1000;
  assert.equal(formatTimeAgo(now - 11 * 60 * 1000, now), "11m ago");
});

test("formatTimeAgo: hours ago for >= 60m", () => {
  const now = 200 * 60 * 1000;
  assert.equal(formatTimeAgo(now - 75 * 60 * 1000, now), "1h 15m ago");
});

test("formatTimeAgo: exact hour with no trailing minutes", () => {
  const now = 200 * 60 * 1000;
  assert.equal(formatTimeAgo(now - 60 * 60 * 1000, now), "1h ago");
});

// ─── listPresentArtifacts ────────────────────────────────────────────────────

test("listPresentArtifacts: returns only files that exist", () => {
  writeFileSync(join(tmpDir, "result.json"), "{}");
  writeFileSync(join(tmpDir, "container.stdout.log"), "hello\n");
  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"));
  assert.ok(artifacts.includes("container.stdout.log"));
  assert.ok(!artifacts.includes("CLAUDE.md"));
  assert.ok(!artifacts.includes("container.stderr.log"));
});

test("listPresentArtifacts: empty when no known files present", () => {
  assert.deepEqual(listPresentArtifacts(tmpDir), []);
});

test("listPresentArtifacts: returns all five known files when all present", () => {
  for (const f of ["CLAUDE.md", "package.md", "result.json", "container.stdout.log", "container.stderr.log"]) {
    writeFileSync(join(tmpDir, f), "");
  }
  assert.equal(listPresentArtifacts(tmpDir).length, 5);
});

test("listPresentArtifacts: reads from manifest.json when present (authoritative)", () => {
  const manifest = {
    taskId: "t-manifest",
    runId: "r-manifest",
    files: { prompt: "CLAUDE.md", package: "package.md", result: "result.json", stdout: "container.stdout.log", stderr: "container.stderr.log" },
    container: { name: "forge-t-manifest" },
    auth: { profileRequested: false, stateMounted: false },
  };
  writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify(manifest));
  // Only create two of the five files
  writeFileSync(join(tmpDir, "result.json"), "{}");
  writeFileSync(join(tmpDir, "CLAUDE.md"), "prompt");

  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"), "result.json must be listed when present");
  assert.ok(artifacts.includes("CLAUDE.md"), "CLAUDE.md must be listed when present");
  assert.ok(!artifacts.includes("container.stdout.log"), "missing file must not appear");
});

test("listPresentArtifacts: falls back to direct read when manifest.json absent", () => {
  writeFileSync(join(tmpDir, "result.json"), "{}");
  writeFileSync(join(tmpDir, "package.md"), "");
  // No manifest.json
  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"));
  assert.ok(artifacts.includes("package.md"));
  assert.ok(!artifacts.includes("CLAUDE.md"));
});

test("listPresentArtifacts: falls back gracefully when manifest.json is malformed", () => {
  writeFileSync(join(tmpDir, "manifest.json"), "not json {{{");
  writeFileSync(join(tmpDir, "result.json"), "{}");
  const artifacts = listPresentArtifacts(tmpDir);
  assert.ok(artifacts.includes("result.json"), "fallback must still return present files");
});

// ─── tailLines ───────────────────────────────────────────────────────────────

test("tailLines: returns last N lines", () => {
  const p = join(tmpDir, "log.txt");
  writeFileSync(p, "a\nb\nc\nd\ne\nf\n");
  assert.deepEqual(tailLines(p, 3), ["d", "e", "f"]);
});

test("tailLines: returns all lines if fewer than N", () => {
  const p = join(tmpDir, "short.txt");
  writeFileSync(p, "x\ny\n");
  assert.deepEqual(tailLines(p, 5), ["x", "y"]);
});

test("tailLines: returns [] when file does not exist", () => {
  assert.deepEqual(tailLines(join(tmpDir, "nope.txt"), 5), []);
});

// ─── computeIdleCountdown / formatIdleCountdown (WALK-1) ─────────────────────

const T0 = 1_700_000_000_000; // fixed "now" base for deterministic math

test("computeIdleCountdown: fresh output — most of the budget remains", () => {
  const c = computeIdleCountdown(T0 - 10_000, 900_000, T0); // 10s idle, 15m timeout
  assert.equal(c.hasOutput, true);
  assert.equal(c.idleMs, 10_000);
  assert.equal(c.remainingMs, 890_000);
  assert.equal(c.expired, false);
});

test("computeIdleCountdown: idle past the timeout — expired, remaining clamped to 0", () => {
  const c = computeIdleCountdown(T0 - 1_000_000, 900_000, T0); // 16m40s idle > 15m
  assert.equal(c.expired, true);
  assert.equal(c.remainingMs, 0);
});

test("computeIdleCountdown: exactly at the timeout boundary counts as expired", () => {
  const c = computeIdleCountdown(T0 - 900_000, 900_000, T0);
  assert.equal(c.expired, true);
  assert.equal(c.remainingMs, 0);
});

test("computeIdleCountdown: no output and no spawn baseline → unmeasured, full budget", () => {
  const c = computeIdleCountdown(undefined, 900_000, T0);
  assert.equal(c.hasOutput, false);
  assert.equal(c.measured, false);
  assert.equal(c.idleMs, 0);
  assert.equal(c.remainingMs, 900_000);
  assert.equal(c.expired, false);
});

// The core no-output-hung-agent fix: a running task that NEVER emits stdout must
// still count idle from spawn and expire — not sit at a full budget forever.
test("computeIdleCountdown: no output but spawn baseline → idle measured from spawn, can expire", () => {
  const c = computeIdleCountdown(undefined, 900_000, T0, T0 - 1_000_000); // spawned 16m40s ago
  assert.equal(c.hasOutput, false, "still no stdout");
  assert.equal(c.measured, true, "measured from spawn baseline");
  assert.equal(c.idleMs, 1_000_000);
  assert.equal(c.remainingMs, 0);
  assert.equal(c.expired, true, "hung-from-spawn agent past its budget is expired");
});

test("computeIdleCountdown: stdout mtime takes precedence over spawn baseline", () => {
  const c = computeIdleCountdown(T0 - 10_000, 900_000, T0, T0 - 1_000_000);
  assert.equal(c.idleMs, 10_000, "measures from last output, not the older spawn time");
  assert.equal(c.hasOutput, true);
});

test("formatIdleCountdown: renders left/expired/no-output/awaiting variants distinctly", () => {
  assert.match(formatIdleCountdown(computeIdleCountdown(T0 - 10_000, 900_000, T0)), /left/);
  assert.match(formatIdleCountdown(computeIdleCountdown(T0 - 1_000_000, 900_000, T0)), /exhausted/);
  assert.match(formatIdleCountdown(computeIdleCountdown(undefined, 900_000, T0, T0 - 5_000)), /no output yet/);
  assert.match(formatIdleCountdown(computeIdleCountdown(undefined, 900_000, T0)), /awaiting start/);
});

test("liveIdleCountdownForTask: running task → countdown from its stdout mtime + manifest timeout", () => {
  const t = makeTask("task-live-run", { status: "running" });
  const dir = taskDir(t.runId, t.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ container: { name: "forge-x", idleTimeoutMs: 600_000 } }));
  writeFileSync(join(dir, "container.stdout.log"), "some output\n");
  const c = liveIdleCountdownForTask(t);
  assert.ok(c, "running task must yield a countdown");
  assert.equal(c!.hasOutput, true);
  // Budget reflects the manifest's recorded timeout, not the global default.
  assert.equal(c!.remainingMs + c!.idleMs, 600_000);
});

test("liveIdleCountdownForTask: terminal task → undefined (countdown is meaningless once done)", () => {
  const t = makeTask("task-live-done", { status: "complete" });
  assert.equal(liveIdleCountdownForTask(t), undefined);
});

// ─── getManifestIdleTimeoutMs ────────────────────────────────────────────────

test("getManifestIdleTimeoutMs: reads container.idleTimeoutMs from manifest.json", () => {
  writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify({ container: { name: "forge-x", idleTimeoutMs: 420000 } }));
  assert.equal(getManifestIdleTimeoutMs(tmpDir), 420000);
});

test("getManifestIdleTimeoutMs: returns undefined for a pre-#202 manifest without the field", () => {
  writeFileSync(join(tmpDir, "manifest.json"), JSON.stringify({ container: { name: "forge-x" } }));
  assert.equal(getManifestIdleTimeoutMs(tmpDir), undefined);
});

test("getManifestIdleTimeoutMs: returns undefined when no manifest exists", () => {
  assert.equal(getManifestIdleTimeoutMs(join(tmpDir, "no-such-dir")), undefined);
});

test("tailLines: returns the correct last N lines from a file larger than the read bound", () => {
  // Build a log well past the 64KB tail window so the bounded read is exercised.
  const p = join(tmpDir, "big.log");
  const filler = "x".repeat(2000); // ~2KB per line → ~200KB total
  const lines = Array.from({ length: 100 }, (_, i) => `line${i}-${filler}`);
  writeFileSync(p, lines.join("\n") + "\n");
  const tail = tailLines(p, 3);
  assert.deepEqual(
    tail.map((l) => l.split("-")[0]),
    ["line97", "line98", "line99"],
    "tails the true last lines even though the file exceeds the read window",
  );
  // Every returned line is whole — no truncated leading fragment leaks through.
  assert.ok(tail.every((l) => l.endsWith(filler)), "no partial line in the tail");
});

// ─── humanizeLogTail (#200) ──────────────────────────────────────────────────

// A realistic claude --output-format stream-json tail: system, an assistant
// text block, a tool_use (no readable text), then the final result event.
const STREAM_JSON_TAIL = [
  JSON.stringify({ type: "system", subtype: "init", session_id: "s1", tools: ["Read", "Edit"] }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Looking at the failing test now." }] } }),
  JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu_1", name: "Read", input: { file_path: "/x" } }] } }),
  JSON.stringify({ type: "result", subtype: "success", result: "Fixed the off-by-one in tailLines.", total_cost_usd: 0.01 }),
];

test("#200 humanizeLogTail: extracts readable text from a claude stream-json tail (no raw blobs)", () => {
  const out = humanizeLogTail(STREAM_JSON_TAIL);
  assert.deepEqual(out, ["Looking at the failing test now.", "Fixed the off-by-one in tailLines."]);
  // No giant JSON blob leaks through.
  assert.ok(out.every((l) => !l.includes("\"type\":")), "must not render raw JSON");
});

test("#200 humanizeLogTail: text deltas are extracted too", () => {
  const lines = [
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } }),
    JSON.stringify({ type: "content_block_delta", delta: { type: "text_delta", text: "world" } }),
  ];
  assert.deepEqual(humanizeLogTail(lines), ["Hello", "world"]);
});

test("#200 humanizeLogTail: plain CLI/test output is returned unchanged (last N verbatim)", () => {
  const plain = ["npm test", "# tests 42", "# pass 42", "# fail 0", "done", "extra"];
  // Identical to the pre-#200 raw tail: last 5 lines, verbatim.
  assert.deepEqual(humanizeLogTail(plain), plain.slice(-5));
  // Fewer-than-N plain lines are all returned, untouched.
  assert.deepEqual(humanizeLogTail(["only", "two"]), ["only", "two"]);
});

test("#200 humanizeLogTail: malformed / mixed JSONL falls back to raw (majority test fails)", () => {
  const mixed = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "ok" }] } }),
    "not json at all",
    "}{ broken",
    "plain line",
  ];
  // Only 1 of 4 lines is type-tagged JSON → not stream-json → verbatim tail.
  assert.deepEqual(humanizeLogTail(mixed), mixed.slice(-5));
});

test("#200 humanizeLogTail: stream-json with no readable text falls back to raw (never blank)", () => {
  const toolOnly = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } }),
  ];
  assert.deepEqual(humanizeLogTail(toolOnly), toolOnly.slice(-5));
});

test("#200 humanizeLogTail: extracted text is capped to maxLines and maxWidth", () => {
  const many = Array.from({ length: 10 }, (_, i) =>
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: `line ${i} ` + "z".repeat(500) }] } }),
  );
  const out = humanizeLogTail(many, 3, 40);
  assert.equal(out.length, 3, "capped to maxLines");
  assert.ok(out.every((l) => l.length <= 40), "each line capped to maxWidth");
  assert.ok(out.every((l) => l.endsWith("…")), "over-width lines are ellipsized");
  assert.equal(out[2], `line 9 ${"z".repeat(40 - "line 9 ".length - 1)}…`);
});

test("#200 humanizeLogTail: stream_event-wrapped text deltas are extracted (real log format)", () => {
  const lines = [
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hello " } } }),
    JSON.stringify({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "world" } } }),
    JSON.stringify({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 5 } } }),
  ];
  const out = humanizeLogTail(lines);
  assert.deepEqual(out, ["Hello", "world"]);
  assert.ok(out.every((l) => !l.includes("\"type\":")), "must not render raw JSON");
});

// Real codex-jsonl shape (captured from a codex exec --json run): top-level
// {type:"item.completed", item:{type, text|aggregated_output, ...}}; item.started
// carries empty text/output and must be ignored.
const CODEX_JSONL_TAIL = [
  JSON.stringify({ type: "thread.started", thread_id: "t1" }),
  JSON.stringify({ type: "turn.started" }),
  JSON.stringify({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "Checking project context first." } }),
  JSON.stringify({ type: "item.started", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "", status: "in_progress" } }),
  JSON.stringify({ type: "item.completed", item: { id: "i1", type: "command_execution", command: "ls", aggregated_output: "result.json\npackage.md", exit_code: 0, status: "completed" } }),
  JSON.stringify({ type: "item.completed", item: { id: "i2", type: "agent_message", text: "Done. Wrote /task/result.json." } }),
  JSON.stringify({ type: "turn.completed" }),
];

test("#200 humanizeLogTail: extracts codex-jsonl agent_message text + command output (the reviewer path)", () => {
  const out = humanizeLogTail(CODEX_JSONL_TAIL);
  // agent_message narration + the completed command's aggregated_output (split on
  // newlines), in order; item.started (empty) contributes nothing.
  assert.deepEqual(out, [
    "Checking project context first.",
    "result.json",
    "package.md",
    "Done. Wrote /task/result.json.",
  ]);
  assert.ok(out.every((l) => !l.includes("\"type\":")), "must not render raw codex JSON");
});

test("#200 humanizeLogTail: codex item.started (in-progress, empty) is ignored", () => {
  const startedOnly = [
    JSON.stringify({ type: "item.started", item: { type: "agent_message", text: "" } }),
    JSON.stringify({ type: "item.started", item: { type: "command_execution", aggregated_output: "", status: "in_progress" } }),
  ];
  // No extractable text → raw fallback (never blank).
  assert.deepEqual(humanizeLogTail(startedOnly), startedOnly.slice(-5));
});

test("#200 humanizeLogTail: empty input → []", () => {
  assert.deepEqual(humanizeLogTail([]), []);
});

// ─── deriveNextCommandForTask ────────────────────────────────────────────────

test("deriveNextCommandForTask: failed+idle_timeout → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "idle_timeout", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+container_crash → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "container_crash", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+result_missing → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "result_missing", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+result_malformed → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", "result_malformed", "task-abc"), /forge retry task-abc/);
});

test("deriveNextCommandForTask: failed+red_blocked → show red task + gate", () => {
  const cmd = deriveNextCommandForTask("failed", "red_blocked", "task-abc");
  assert.match(cmd, /forge show/);
  assert.match(cmd, /forge gate task-abc/);
});

test("deriveNextCommandForTask: failed+undefined failure_kind → forge retry", () => {
  assert.match(deriveNextCommandForTask("failed", undefined, "task-abc"), /forge retry task-abc/);
});

// FG-455: a dirty worktree may hold real, unreviewed work — point at inspection
// first, not a blind retry (retry-policy.ts already blocks it without --force).
test("deriveNextCommandForTask: failed+orphaned_work_may_persist → inspect before retry --force", () => {
  const cmd = deriveNextCommandForTask("failed", "orphaned_work_may_persist", "task-abc");
  assert.match(cmd, /forge show task-abc/);
  assert.match(cmd, /--force/);
  assert.doesNotMatch(cmd, /^forge retry task-abc$/, "must not be a bare blind retry");
});

// FG-455 p2/p3 review finding 2: a fanout parent's blind `forge retry` is
// unsafe (retry-policy.ts refuses it) — recommend `forge recover --re-drive`
// instead, not the generic fallthrough.
test("deriveNextCommandForTask: failed+fanout_wave_orphaned → forge recover --re-drive, not forge retry", () => {
  const cmd = deriveNextCommandForTask("failed", "fanout_wave_orphaned", "task-abc");
  assert.match(cmd, /forge recover task-abc --re-drive/);
  assert.doesNotMatch(cmd, /^forge retry task-abc$/, "must not be a bare blind retry");
});

// FG-479 review: retry-policy.ts refuses a bare `forge retry` for
// orphaned_needs_finalize (and recover --continue refuses it too) — the Next
// hint must point at inspect-then-force, never the generic bare-retry fallthrough.
test("deriveNextCommandForTask: failed+orphaned_needs_finalize → inspect before retry --force, not a bare retry", () => {
  const cmd = deriveNextCommandForTask("failed", "orphaned_needs_finalize", "task-abc");
  assert.match(cmd, /forge show task-abc/);
  assert.match(cmd, /forge retry task-abc --force/);
  assert.match(cmd, /finalize/);
  assert.doesNotMatch(cmd, /forge retry task-abc(?! --force)/, "must never recommend a bare forge retry without --force");
});

// FG-455 p4 review finding 5: exit 137 alone doesn't confirm OOM (an external
// kill can also send SIGKILL) — the hint must not over-claim "out-of-memory".
//
// FG-455 p4 re-review: retry-policy.ts classifies oom_killed as retryable:false,
// same as orphaned_work_may_persist — a bare `forge retry` is refused. The hint
// must point at inspect-then-force, mirroring the orphaned_work_may_persist arm.
test("deriveNextCommandForTask: failed+oom_killed → inspect before retry --force, not a bare retry", () => {
  const cmd = deriveNextCommandForTask("failed", "oom_killed", "task-abc");
  assert.match(cmd, /forge show task-abc/);
  assert.match(cmd, /forge retry task-abc --force/);
  assert.match(cmd, /exit 137, possibly OOM or external kill/);
  assert.doesNotMatch(cmd, /^forge retry task-abc$/, "must not be a bare blind retry");
  assert.doesNotMatch(cmd, /forge retry task-abc(?! --force)/, "must never recommend a bare forge retry without --force");
});

// FG-424: retry-policy.ts classifies integration_gate_crashed as retryable:false
// (a signal-killed gate run leaves the merged tree's toolchain/cache state
// untrustworthy) — a bare `forge retry` is refused. The hint must point at
// inspect-then-force, mirroring the oom_killed arm.
test("deriveNextCommandForTask: failed+integration_gate_crashed → inspect before retry --force, not a bare retry", () => {
  const cmd = deriveNextCommandForTask("failed", "integration_gate_crashed", "task-abc");
  assert.match(cmd, /forge show task-abc/);
  assert.match(cmd, /forge retry task-abc --force/);
  assert.doesNotMatch(cmd, /^forge retry task-abc$/, "must not be a bare blind retry");
  assert.doesNotMatch(cmd, /forge retry task-abc(?! --force)/, "must never recommend a bare forge retry without --force");
});

// FG-424: retry-policy.ts classifies integration_gate_timeout as retryable:true
// (a timeout is transient) — a bare `forge retry` is correct here.
test("deriveNextCommandForTask: failed+integration_gate_timeout → forge retry", () => {
  const cmd = deriveNextCommandForTask("failed", "integration_gate_timeout", "task-abc");
  assert.match(cmd, /^forge retry task-abc$/);
});

test("deriveNextCommandForTask: awaiting_gate → forge gate --advance | --reject", () => {
  const cmd = deriveNextCommandForTask("awaiting_gate", undefined, "task-abc");
  assert.match(cmd, /forge gate task-abc/);
  assert.match(cmd, /--advance/);
});

test("deriveNextCommandForTask: blocked_by_red → forge show red task + gate", () => {
  const cmd = deriveNextCommandForTask("blocked_by_red", undefined, "task-abc");
  assert.match(cmd, /forge show/);
  assert.match(cmd, /forge gate task-abc/);
});

test("deriveNextCommandForTask: complete → —", () => {
  assert.equal(deriveNextCommandForTask("complete", undefined, "task-abc"), "—");
});

// ─── deriveNextCommandForRun ─────────────────────────────────────────────────

test("deriveNextCommandForRun: awaiting_gate first priority", () => {
  const tasks: Task[] = [
    makeTask("t-gate", { status: "awaiting_gate" }),
    makeTask("t-fail", { status: "failed" }),
  ];
  assert.match(deriveNextCommandForRun(RUN.id, tasks), /forge gate t-gate/);
});

test("deriveNextCommandForRun: blocked_by_red is second priority", () => {
  const tasks: Task[] = [
    makeTask("t-red", { status: "blocked_by_red" }),
    makeTask("t-fail", { status: "failed" }),
  ];
  assert.match(deriveNextCommandForRun(RUN.id, tasks), /forge show t-red/);
});

test("deriveNextCommandForRun: failed task → forge retry", () => {
  const tasks: Task[] = [
    makeTask("t-fail", { status: "failed" }),
    makeTask("t-ok", { status: "complete" }),
  ];
  assert.match(deriveNextCommandForRun(RUN.id, tasks), /forge retry t-fail/);
});

test("deriveNextCommandForRun: only running → show run with count", () => {
  const tasks: Task[] = [makeTask("t-run", { status: "running" })];
  const cmd = deriveNextCommandForRun(RUN.id, tasks);
  assert.match(cmd, /forge show.*1 task/);
});

test("deriveNextCommandForRun: all complete → —", () => {
  assert.equal(deriveNextCommandForRun(RUN.id, [makeTask("t", { status: "complete" })]), "—");
});

test("deriveNextCommandForRun: empty tasks → —", () => {
  assert.equal(deriveNextCommandForRun(RUN.id, []), "—");
});

// ─── groupFailedByKind ───────────────────────────────────────────────────────

test("groupFailedByKind: groups failed tasks by failure_kind", () => {
  const eventsMap: Record<string, Event[]> = {
    "t-a": [makeEvent("task.failed", { failure_kind: "idle_timeout" })],
    "t-b": [makeEvent("task.failed", { failure_kind: "container_crash" })],
    "t-c": [makeEvent("task.failed", { failure_kind: "idle_timeout" })],
  };
  const tasks: Task[] = [
    makeTask("t-a", { status: "failed" }),
    makeTask("t-b", { status: "failed" }),
    makeTask("t-c", { status: "failed" }),
  ];
  const result = groupFailedByKind(tasks, (id) => eventsMap[id] ?? []);
  assert.deepEqual((result["idle_timeout"] ?? []).sort(), ["t-a", "t-c"]);
  assert.deepEqual(result["container_crash"], ["t-b"]);
});

test("groupFailedByKind: uses unknown when no failure_kind in events", () => {
  const tasks: Task[] = [makeTask("t-a", { status: "failed" })];
  assert.deepEqual(groupFailedByKind(tasks, () => []), { unknown: ["t-a"] });
});

test("groupFailedByKind: ignores non-failed tasks", () => {
  const tasks: Task[] = [
    makeTask("t-ok", { status: "complete" }),
    makeTask("t-run", { status: "running" }),
    makeTask("t-fail", { status: "failed" }),
  ];
  const result = groupFailedByKind(tasks, () => [makeEvent("task.failed", { failure_kind: "model_error" })]);
  assert.deepEqual(Object.values(result).flat(), ["t-fail"]);
});

test("groupFailedByKind: empty tasks → empty object", () => {
  assert.deepEqual(groupFailedByKind([], () => []), {});
});

// ─── getBlockerTasks ─────────────────────────────────────────────────────────

test("getBlockerTasks: returns awaiting_gate, blocked_by_red", () => {
  const tasks: Task[] = [
    makeTask("t1", { status: "awaiting_gate" }),
    makeTask("t3", { status: "blocked_by_red" }),
    makeTask("t4", { status: "running" }),
    makeTask("t5", { status: "failed" }),
    makeTask("t6", { status: "complete" }),
  ];
  const ids = getBlockerTasks(tasks).map((t) => t.id).sort();
  assert.deepEqual(ids, ["t1", "t3"]);
});

test("getBlockerTasks: empty when no blockers", () => {
  assert.deepEqual(getBlockerTasks([makeTask("t1", { status: "running" })]), []);
});

// ── #298: forge show is read-only by default; reconcile must be explicit ──────
// Regression: in Pixtron, `forge show task-engineer-b26b0f --json` reconciled the
// task to complete at the inspection timestamp — a read action mutated state.

function setupStaleRunning(taskId: string, withResult: boolean): void {
  // Distinct phase per task so reconcileRun's orphaned-duplicate-primary sweep
  // (same-phase primaries) doesn't cross-talk between fixtures.
  insertTask(makeTask(taskId, { status: "running", phase: taskId, startedAt: "2026-05-29T10:00:00Z" }));
  logEvent("container.started", { runId: RUN.id, taskId }); // proves it was containerized
  if (withResult) {
    const dir = taskDir(RUN.id, taskId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "result.json"), JSON.stringify({ status: "complete" }));
  }
}

test("#298: plain forge show is read-only — surfaces the candidate, emits no task.reconciled (Pixtron regression)", () => {
  setupStaleRunning("task-engineer-b26b0f", true); // the actual incident id
  const { reconciled, candidateReason } = showReconcileStep("task-engineer-b26b0f", {}, { probe: () => "gone" });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, "container_gone_result_present");
  // No mutation: still running, no reconcile event written by the read path.
  assert.equal(getTask("task-engineer-b26b0f")!.status, "running");
  assert.equal(eventsForTask("task-engineer-b26b0f").filter((e) => e.eventType === "task.reconciled").length, 0);
});

test("#298: plain show surfaces container_gone_no_result when no result.json exists", () => {
  setupStaleRunning("task-orphan-298", false);
  const { candidateReason } = showReconcileStep("task-orphan-298", {}, { probe: () => "gone" });
  assert.equal(candidateReason, "container_gone_no_result");
  assert.equal(getTask("task-orphan-298")!.status, "running");
});

test("#298: --reconcile is the explicit mutating path — finalizes + emits task.reconciled", () => {
  setupStaleRunning("task-reconcile-298", true);
  const { reconciled } = showReconcileStep("task-reconcile-298", { reconcile: true }, { containerAlive: () => false });
  assert.equal(reconciled, true);
  // FG-479: RUN is a feature (pipeline) run, so a container-gone-with-result
  // task finalizes fail-safe (orphaned_needs_finalize), never straight to
  // complete — that would skip reds/gates/merge-back.
  assert.equal(getTask("task-reconcile-298")!.status, "failed");
  assert.match(getTask("task-reconcile-298")!.error ?? "", /orphaned_needs_finalize/);
  assert.equal(eventsForTask("task-reconcile-298").filter((e) => e.eventType === "task.reconciled").length, 1);
});

test("#298: a healthy running task (container alive) is not a candidate and is not mutated", () => {
  setupStaleRunning("task-live-298", true);
  const { reconciled, candidateReason } = showReconcileStep("task-live-298", {}, { probe: () => "alive" });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, null);
  assert.equal(getTask("task-live-298")!.status, "running");
  assert.equal(eventsForTask("task-live-298").filter((e) => e.eventType === "task.reconciled").length, 0);
});

test("#298: a completed task is never probed or reconciled by plain show", () => {
  insertTask(makeTask("task-done-298", { status: "complete", completedAt: "2026-05-29T11:00:00Z" }));
  let probed = false;
  const { reconciled, candidateReason } = showReconcileStep("task-done-298", {}, { probe: () => { probed = true; return "gone"; } });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, null);
  assert.equal(probed, false, "a non-running task must not be docker-probed");
});

// #298 run-path: forge show <runId> must surface candidates for the run's running
// tasks, not list them as ordinary "Running tasks".
test("#298: forge show <run> surfaces reconcile candidates for the run's running tasks (read-only)", () => {
  setupStaleRunning("task-run-stale-1", true);
  const { reconciled, candidateReason, runCandidates } = showReconcileStep(RUN.id, {}, { probe: () => "gone" });
  assert.equal(reconciled, false);
  assert.equal(candidateReason, null, "run target has no single task-level reason");
  assert.deepEqual(runCandidates, [{ taskId: "task-run-stale-1", reason: "container_gone_result_present" }]);
  // no mutation on the read path
  assert.equal(getTask("task-run-stale-1")!.status, "running");
  assert.equal(eventsForTask("task-run-stale-1").filter((e) => e.eventType === "task.reconciled").length, 0);
});

test("#298: forge show <run> excludes healthy running tasks from candidates", () => {
  setupStaleRunning("task-run-gone", true);
  setupStaleRunning("task-run-alive", true);
  // Probe: only task-run-gone's container is gone.
  const probe = (name: string): "alive" | "gone" => (name === "forge-task-run-gone" ? "gone" : "alive");
  const { runCandidates } = showReconcileStep(RUN.id, {}, { probe });
  assert.deepEqual(runCandidates, [{ taskId: "task-run-gone", reason: "container_gone_result_present" }]);
});

test("#298: forge show <run> --reconcile finalizes the run's stale tasks", () => {
  setupStaleRunning("task-run-stale-2", true);
  const { reconciled } = showReconcileStep(RUN.id, { reconcile: true }, { containerAlive: () => false });
  assert.equal(reconciled, true);
  // FG-479: pipeline run — fail-safe finalize, not complete (see above).
  assert.equal(getTask("task-run-stale-2")!.status, "failed");
  assert.match(getTask("task-run-stale-2")!.error ?? "", /orphaned_needs_finalize/);
  assert.equal(eventsForTask("task-run-stale-2").filter((e) => e.eventType === "task.reconciled").length, 1);
});
