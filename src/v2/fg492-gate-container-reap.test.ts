// FG-492 final review round, finding 1:
//
// A task that pauses at a human/verdict gate keeps its container retained
// (awaiting_gate is not "complete", so runNext.ts's finalizeContainerRetention
// call at close time retains it — see runNext.ts's finalizePrimary). If that
// task LATER advances to complete via `forge gate ... --advance`, nothing
// used to reap it: the exec-time caller in runNext.ts already returned (the
// task wasn't complete yet), reconcile.ts's reap sweep only ever revisits
// tasks whose status is still `running` (this task left `running` the moment
// it became awaiting_gate), and `forge ops reap-containers` only scans FAILED
// tasks. The container leaked forever.
//
// Fix: gate.ts's "advance" branch now reaps the container itself, right after
// markTaskComplete, mirroring runNext.ts's own finalizeContainerRetention
// call sites. Proven here with a PATH-shadowed `docker` stub (same technique
// docker-exec.test.ts and worktree-lifecycle.worktree.test.ts use) so the
// assertion holds without a real docker daemon.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, getTask } from "../store/tasks.js";
import { logEvent, eventsForTask } from "../store/events.js";
import { gate } from "./gate.js";
import type { Run, Task } from "../types/index.js";

const WORKFLOW_NAME = "fg492-gate-reap-test";
const RUN: Run = {
  id: "run-fg492-gate-reap",
  workflow: WORKFLOW_NAME,
  title: "FG-492 gate reap test",
  status: "active",
  createdAt: "2026-07-09T00:00:00Z",
};

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let originalForgeHome: string | undefined;
let homeDir: string;

function ensureWorkflow(): void {
  const wfPath = join(homeDir, "workflows", `${WORKFLOW_NAME}.yml`);
  mkdirSync(join(homeDir, "workflows"), { recursive: true });
  writeFileSync(
    wfPath,
    `name: ${WORKFLOW_NAME}
description: test
inputs: []
steps:
  - id: step-human
    agent: engineer
    gate: human
  - id: step-manual
    manual: true
    gate: human
`,
  );
}

// A containerized primary task (emits container.started — the signal both
// reconcile.ts and gate.ts's reap check gate on).
function containerizedTask(id: string, phase: string, status: Task["status"]): Task {
  const t: Task = {
    id,
    runId: RUN.id,
    phase,
    agentRole: "engineer",
    status,
    taskPackage: { taskId: id, runId: RUN.id, phase, role: "engineer", inputs: {}, composedSystemPrompt: "PROMPT" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(t);
  logEvent("container.started", { runId: RUN.id, taskId: id, payload: { containerName: `forge-${id}` } });
  return t;
}

function makeDockerStub(): { binDir: string; logPath: string } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-gate-docker-stub-"));
  const logPath = join(binDir, "docker-calls.log");
  writeFileSync(join(binDir, "docker"), `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
  chmodSync(join(binDir, "docker"), 0o755);
  writeFileSync(logPath, "");
  return { binDir, logPath };
}

let origPath: string | undefined;
let binDir: string;
let logPath: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  originalForgeHome = process.env.FORGE_HOME;
  homeDir = mkdtempSync(join(tmpdir(), "forge-v2-gate-reap-"));
  process.env.FORGE_HOME = homeDir;
  ensureWorkflow();
  insertRun(RUN);

  ({ binDir, logPath } = makeDockerStub());
  origPath = process.env.PATH;
  process.env.PATH = `${binDir}:${origPath ?? ""}`;
});

afterEach(() => {
  process.env.PATH = origPath;
  rmSync(binDir, { recursive: true, force: true });

  setDbForTest(prev as DatabaseInstance);
  db.close();
  if (originalForgeHome === undefined) delete process.env.FORGE_HOME;
  else process.env.FORGE_HOME = originalForgeHome;
  rmSync(homeDir, { recursive: true, force: true });
});

test("FG-492 final round: an awaiting_gate task with a retained container advances to complete -> container reaped", async () => {
  const t = containerizedTask("task-gate-advance", "step-human", "awaiting_gate");

  const result = await gate(t.id, "advance", undefined, {});
  assert.equal(result.task.status, "complete");

  const calls = readFileSync(logPath, "utf8").trim();
  assert.equal(calls, `rm -f -v forge-${t.id}`, "advancing to complete must best-effort reap the container gate.ts's own dispatch retained");
});

test("FG-492 final round: a blocked_by_red task force-advanced to complete also reaps its retained container", async () => {
  const t = containerizedTask("task-gate-forced", "step-human", "blocked_by_red");

  const result = await gate(t.id, "advance", "overriding the block", { force: true });
  assert.equal(result.task.status, "complete");

  const calls = readFileSync(logPath, "utf8").trim();
  assert.equal(calls, `rm -f -v forge-${t.id}`, "a forced advance to complete is just as terminal — its container must be reaped too");
});

test("FG-492 final round: a rejected gate leaves the task failed — its container stays retained (not reaped)", async () => {
  const t = containerizedTask("task-gate-reject", "step-human", "awaiting_gate");

  const result = await gate(t.id, "reject", "not good enough", {});
  assert.equal(result.task.status, "failed");

  const calls = readFileSync(logPath, "utf8").trim();
  assert.equal(calls, "", "a failed/blocked outcome must never reap — the container is exactly the evidence worth keeping");
});

test("FG-492 final round: a manual step's task has no container of its own — advancing it never shells out to docker", async () => {
  // Manual steps never spawn a container (runNext.ts's dispatchManualStep) —
  // no container.started event, unlike containerizedTask above.
  const t: Task = {
    id: "task-gate-manual",
    runId: RUN.id,
    phase: "step-manual",
    agentRole: "engineer",
    status: "awaiting_gate",
    taskPackage: { taskId: "task-gate-manual", runId: RUN.id, phase: "step-manual", role: "engineer", inputs: {}, composedSystemPrompt: "" },
    createdAt: "2026-07-09T00:00:00Z",
  };
  insertTask(t);

  const result = await gate(t.id, "advance", undefined, {});
  assert.equal(result.task.status, "complete");

  const calls = readFileSync(logPath, "utf8").trim();
  assert.equal(calls, "", "a task with no container.started event has nothing to reap — must not invoke docker at all");
});

// ── FG-503: reap_failed on a SUCCESSFUL task is durably recorded ────────────

test("FG-503: docker rm fails on gate advance-to-complete → task still completes AND a container.reap_failed event is recorded", async () => {
  const t = containerizedTask("task-gate-reap-failed", "step-human", "awaiting_gate");

  // Shadow the beforeEach's passing stub with a failing one for this test only.
  const failingBinDir = mkdtempSync(join(tmpdir(), "forge-gate-docker-fail-stub-"));
  const failingLogPath = join(failingBinDir, "docker-calls.log");
  writeFileSync(join(failingBinDir, "docker"), `#!/bin/sh\necho "$@" >> "${failingLogPath}"\nexit 1\n`);
  chmodSync(join(failingBinDir, "docker"), 0o755);
  writeFileSync(failingLogPath, "");
  const savedPath = process.env.PATH;
  process.env.PATH = `${failingBinDir}:${origPath ?? ""}`;
  try {
    const result = await gate(t.id, "advance", undefined, {});
    assert.equal(result.task.status, "complete", "a reap failure must never block the gate advance");

    const calls = readFileSync(failingLogPath, "utf8").trim();
    assert.equal(calls, `rm -f -v forge-${t.id}`, "the reap was attempted");

    const events = eventsForTask(t.id);
    const reapFailedEvents = events.filter((e) => e.eventType === "container.reap_failed");
    assert.equal(reapFailedEvents.length, 1, "the failed reap must be durably recorded exactly once");
    const payload = reapFailedEvents[0]!.payload as { containerName: string; why: string };
    assert.equal(payload.containerName, `forge-${t.id}`);
    // FG-503 cross-path consistency: same {containerName, why} payload shape
    // as invoke.ts and runNext.ts's own reap-failure logging (their "why"
    // wording differs in its tail — "after gate advance-to-complete" here vs.
    // "after task completion" there — but the key set and leading phrase must
    // match). See the matching assertion in invoke.integration.test.ts and
    // runNext.integration.test.ts.
    assert.deepEqual(Object.keys(payload).sort(), ["containerName", "why"], "payload shape must match the other two reap paths (invoke.ts, runNext.ts)");
    assert.match(payload.why, /^docker rm -f -v failed/, "why must follow the shared wording convention across all three reap paths");
  } finally {
    process.env.PATH = savedPath;
    rmSync(failingBinDir, { recursive: true, force: true });
  }
});

test("FG-503: happy-path gate advance-to-complete (reap succeeds) emits no container.reap_failed event", async () => {
  const t = containerizedTask("task-gate-reap-happy", "step-human", "awaiting_gate");

  const result = await gate(t.id, "advance", undefined, {});
  assert.equal(result.task.status, "complete");

  const calls = readFileSync(logPath, "utf8").trim();
  assert.equal(calls, `rm -f -v forge-${t.id}`);

  const events = eventsForTask(t.id);
  assert.equal(events.filter((e) => e.eventType === "container.reap_failed").length, 0, "the happy path must stay silent — no new event on a successful reap");
});
