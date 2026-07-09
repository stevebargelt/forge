// FG-492 integration tests: container causal-evidence surfaces exercised
// through the REAL CLI subprocess (commander parsing, process.exit code,
// stdout/stderr rendering, real on-disk sqlite db) — not the function level
// (already covered extensively by failure-kind.test.ts, show.test.ts,
// reconcile.integration.test.ts) and not an in-process `program.parseAsync`
// against a hand-built Command() (show.test.ts's "CLI:" tests). The FG-492
// ticket's own history is that `--diagnostic` was documented and unit-tested
// against its rendering helpers while the flag itself was never registered on
// the command — a gap only a real subprocess invocation catches. `forge
// status` has ZERO prior test coverage (no status.test.ts of any tier exists
// in this repo) despite gaining the same containerEvidence field/line in this
// diff, and `forge ops reap-containers`'s CLI wiring (option parsing,
// dry-run/json rendering) was previously exercised only at the
// performOpsReapContainers() function level, never through registerOps's
// actual `.action()` callback via a real invocation.
//
// Also enforces the ticket's central operator-text requirement end to end:
// output must say "container disappeared without terminal evidence" for a
// missing-evidence task, and must never say "harness killed" or "killed" as
// an asserted (unproven) cause anywhere in `forge show --diagnostic` / `forge
// status` output.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { SCHEMA_SQL } from "../../store/schema.js";
import { applyMigrations } from "../../store/db.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "index.ts");
const tsx = resolve(here, "..", "..", "..", "node_modules", ".bin", "tsx");

let forgeHome: string;
let dbPath: string;
let db: DatabaseInstance;
const tmpDirs: string[] = [];

beforeEach(() => {
  forgeHome = mkdtempSync(join(tmpdir(), "forge-fg492-home-"));
  dbPath = join(forgeHome, "forge.db");
  db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA_SQL);
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(forgeHome, { recursive: true, force: true });
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function runForge(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  return spawnSync(tsx, [entry, ...args], {
    encoding: "utf8",
    cwd: opts.cwd,
    env: { ...process.env, FORGE_HOME: forgeHome, NO_NOTIFY: "true", ...(opts.env ?? {}) },
  });
}

// FG-503: `forge ops reap-containers` is now disk-truth-driven — it really
// calls `docker ps -a` / `docker inspect` / `docker rm -f -v`. These tests
// shadow PATH with a fake `docker` script (same PATH-stub technique
// runNext.integration.test.ts uses for `docker rm`) so candidacy is driven
// deterministically without a real docker daemon. `ps` returns a fixed
// Name\tState listing; `inspect` returns an empty State (no finishedAt — the
// age check falls back to the task's own completedAt, already covered at the
// unit level in ops.test.ts); `rm`'s exit code is controllable per test.
type FakeContainer = { name: string; running?: boolean };

function withFakeDocker(
  containers: FakeContainer[],
  opts: { rmExitCode?: number; psExitCode?: number } = {},
): { callLogPath: string; env: NodeJS.ProcessEnv } {
  const binDir = mkdtempSync(join(tmpdir(), "forge-fg503-docker-stub-"));
  const callLogPath = join(binDir, "docker-calls.log");
  const containersPath = join(binDir, "containers.txt");
  writeFileSync(
    containersPath,
    containers.map((c) => `${c.name}\t${c.running ? "running" : "exited"}`).join("\n") + (containers.length ? "\n" : ""),
  );
  writeFileSync(callLogPath, "");
  const psExitCode = opts.psExitCode ?? 0;
  const psBody = psExitCode !== 0 ? `exit ${psExitCode}` : `cat "${containersPath}"\n    exit 0`;
  const script = `#!/bin/sh
echo "$@" >> "${callLogPath}"
case "$1" in
  ps)
    ${psBody}
    ;;
  inspect)
    echo '[{"State":{}}]'
    exit 0
    ;;
  rm)
    exit ${opts.rmExitCode ?? 0}
    ;;
  *)
    exit 0
    ;;
esac
`;
  writeFileSync(join(binDir, "docker"), script);
  chmodSync(join(binDir, "docker"), 0o755);
  tmpDirs.push(binDir);
  return { callLogPath, env: { PATH: `${binDir}:${process.env.PATH ?? ""}` } };
}

function insertRunRow(o: { id: string; workflow: string; title: string; status?: string; createdAt?: string; projectDir?: string }): void {
  db.prepare(
    `INSERT INTO runs (id, workflow, title, status, created_at, project_dir) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(o.id, o.workflow, o.title, o.status ?? "active", o.createdAt ?? "2026-07-01T00:00:00Z", o.projectDir ?? null);
}

function insertTaskRow(o: {
  id: string;
  runId: string;
  phase?: string;
  agentRole?: string;
  status?: string;
  createdAt?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}): void {
  const taskPackage = {
    taskId: o.id,
    runId: o.runId,
    phase: o.phase ?? "build",
    role: o.agentRole ?? "engineer",
    inputs: {},
    composedSystemPrompt: "",
  };
  db.prepare(
    `INSERT INTO tasks (id, run_id, phase, agent_role, status, task_package, created_at, started_at, completed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id,
    o.runId,
    o.phase ?? "build",
    o.agentRole ?? "engineer",
    o.status ?? "failed",
    JSON.stringify(taskPackage),
    o.createdAt ?? "2026-07-01T00:00:01Z",
    o.startedAt ?? "2026-07-01T00:00:02Z",
    o.completedAt ?? null,
  );
}

function insertEvent(o: { runId: string; taskId: string; eventType: string; payload: Record<string, unknown>; createdAt?: string }): void {
  db.prepare(
    `INSERT INTO events (run_id, task_id, event_type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(o.runId, o.taskId, o.eventType, JSON.stringify(o.payload), o.createdAt ?? "2026-07-01T00:00:03Z");
}

function makeProjectDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "forge-fg492-project-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  tmpDirs.push(dir);
  return dir;
}

const FORBIDDEN_CAUSAL_CLAIMS = /harness killed|process(es)? (was |were )?killed/i;

// ── forge show <id> --diagnostic ────────────────────────────────────────────

test("integ forge show --diagnostic: confirmed container exit renders code/signal/OOM, real CLI subprocess", () => {
  const runId = "run-fg492-confirmed";
  const taskId = "t-fg492-confirmed";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 confirmed exit" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "container.exited",
    payload: {
      containerName: `forge-${taskId}`,
      exitCode: 137,
      containerEvidence: {
        containerName: `forge-${taskId}`,
        containerExitedEventObserved: true,
        dockerExitCode: 137,
        signal: "SIGKILL",
        oomKilled: true,
      },
    },
  });
  insertEvent({ runId, taskId, eventType: "task.failed", payload: { failure_kind: "oom_killed", error: "oom_killed" } });

  const result = runForge(["show", taskId, "--diagnostic"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /confirmed container exit/);
  assert.match(result.stdout, /exit code 137/);
  assert.match(result.stdout, /signal SIGKILL/);
  assert.match(result.stdout, /OOMKilled=true/);
  assert.doesNotMatch(result.stdout, FORBIDDEN_CAUSAL_CLAIMS, "must not assert an unproven kill cause");
});

test("integ forge show --diagnostic: disappeared container names the gap explicitly, never asserts 'killed'", () => {
  const runId = "run-fg492-disappeared";
  const taskId = "t-fg492-disappeared";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 disappeared" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "task.failed",
    payload: {
      failure_kind: "orphaned",
      error: "orphaned: container gone with no result",
      containerEvidence: { containerName: `forge-${taskId}`, containerExitedEventObserved: false },
    },
  });

  const result = runForge(["show", taskId, "--diagnostic"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /container disappeared without terminal evidence/);
  assert.match(result.stdout, /missing:.*container\.exited event was ever recorded/);
  assert.doesNotMatch(result.stdout, FORBIDDEN_CAUSAL_CLAIMS, "absent evidence must not be reported as a confirmed kill");
});

test("integ forge show --diagnostic --json: emits a focused causal-evidence block, not the whole task/events dump", () => {
  const runId = "run-fg492-json";
  const taskId = "t-fg492-json";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 json" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "container.exited",
    payload: {
      containerName: `forge-${taskId}`,
      exitCode: 1,
      containerEvidence: { containerName: `forge-${taskId}`, containerExitedEventObserved: true, dockerExitCode: 1 },
    },
  });
  insertEvent({ runId, taskId, eventType: "task.failed", payload: { failure_kind: "container_crash", error: "container_crash (exit 1)" } });

  const result = runForge(["show", taskId, "--diagnostic", "--json"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  assert.equal(parsed.taskId, taskId);
  assert.equal(parsed.isFanoutParent, false);
  const evidence = parsed.containerEvidence as Record<string, unknown>;
  assert.equal(evidence.dockerExitCode, 1);
  assert.match(parsed.containerEvidenceSummary as string, /confirmed container exit/);
  assert.ok(Array.isArray(parsed.missingContainerEvidence));
  assert.equal(parsed.task, undefined, "focused diagnostic must not include the full task blob");
  assert.equal(parsed.events, undefined, "focused diagnostic must not include the full events blob");
});

test("integ forge show --diagnostic: fanout parent derived failure is n/a, never labeled a killed agent", () => {
  const runId = "run-fg492-fanout";
  const taskId = "t-fg492-fanout-parent";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 fanout parent" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "task.failed",
    payload: {
      failure_kind: "fanout_wave_orphaned",
      error: "fanout wave orphaned: 1/3 children complete",
      childSummary: { total: 3, complete: 1 },
    },
  });

  const result = runForge(["show", taskId, "--diagnostic"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /n\/a.*no agent container/i);
  // The text explicitly disclaims the cause ("...not from a killed agent") —
  // it must never ASSERT the fanout parent itself as a killed agent.
  assert.match(result.stdout, /not from a killed agent/i);
  assert.doesNotMatch(result.stdout, FORBIDDEN_CAUSAL_CLAIMS);

  const jsonResult = runForge(["show", taskId, "--diagnostic", "--json"]);
  const parsed = JSON.parse(jsonResult.stdout) as Record<string, unknown>;
  assert.equal(parsed.isFanoutParent, true);
});

test("integ forge show --diagnostic: result missing after a clean exit is distinct from a disappeared container", () => {
  const runId = "run-fg492-clean-no-result";
  const taskId = "t-fg492-clean-no-result";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 clean exit, no result" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "container.exited",
    payload: {
      containerName: `forge-${taskId}`,
      exitCode: 0,
      containerEvidence: { containerName: `forge-${taskId}`, containerExitedEventObserved: true, dockerExitCode: 0 },
    },
  });
  insertEvent({ runId, taskId, eventType: "task.failed", payload: { failure_kind: "result_missing", error: "result_missing after clean exit" } });

  const result = runForge(["show", taskId, "--diagnostic"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /confirmed container exit/);
  assert.match(result.stdout, /exit code 0/);
  assert.doesNotMatch(result.stdout, /disappeared without terminal evidence/, "a confirmed clean exit must not be conflated with a disappearance");
});

// ── forge status: zero prior coverage of any tier before this file ─────────

test("integ forge status <runId>: plain output prints the container-evidence line for a failed task and never asserts a kill cause", () => {
  const runId = "run-fg492-status-plain";
  const taskId = "t-fg492-status-plain";
  insertRunRow({ id: runId, workflow: "invoke", title: "fg492 status plain" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "task.failed",
    payload: {
      failure_kind: "orphaned",
      error: "orphaned: container gone with no result",
      containerEvidence: { containerName: `forge-${taskId}`, containerExitedEventObserved: false },
    },
  });

  const result = runForge(["status", runId, "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /container evidence: container disappeared without terminal evidence/);
  assert.doesNotMatch(result.stdout, FORBIDDEN_CAUSAL_CLAIMS);
});

test("integ forge status <runId> --json: containerEvidence field carries evidence + message, mirrors forge show", () => {
  const runId = "run-fg492-status-json";
  const taskId = "t-fg492-status-json";
  insertRunRow({ id: runId, workflow: "invoke", title: "fg492 status json" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "container.exited",
    payload: {
      containerName: `forge-${taskId}`,
      exitCode: 137,
      containerEvidence: {
        containerName: `forge-${taskId}`,
        containerExitedEventObserved: true,
        dockerExitCode: 137,
        signal: "SIGKILL",
        oomKilled: true,
      },
    },
  });
  insertEvent({ runId, taskId, eventType: "task.failed", payload: { failure_kind: "oom_killed", error: "oom_killed" } });

  const result = runForge(["status", runId, "--json", "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { tasks: Array<{ id: string; containerEvidence: { evidence: Record<string, unknown>; message: string } | null }> };
  const task = parsed.tasks.find((t) => t.id === taskId);
  assert.ok(task, "task must be present in status --json output");
  assert.ok(task!.containerEvidence, "containerEvidence must be populated for a failed task with recorded evidence");
  assert.equal(task!.containerEvidence!.evidence.dockerExitCode, 137);
  assert.match(task!.containerEvidence!.message, /confirmed container exit/);
});

test("integ forge status <runId> --json: a failed task with no recorded evidence carries containerEvidence: null (never fabricated)", () => {
  const runId = "run-fg492-status-null";
  const taskId = "t-fg492-status-null";
  insertRunRow({ id: runId, workflow: "invoke", title: "fg492 status no evidence" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({ runId, taskId, eventType: "task.failed", payload: { failure_kind: "unknown", error: "boom" } });

  const result = runForge(["status", runId, "--json", "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as { tasks: Array<{ id: string; containerEvidence: unknown }> };
  const task = parsed.tasks.find((t) => t.id === taskId);
  assert.equal(task?.containerEvidence, null);
});

// FG-492 review finding 4: `forge show` already distinguishes a fanout parent's
// derived failure (fanout_wave_orphaned — no orphanEvidence key, no container
// of its own) via getFanoutWaveEvidenceFromEvents; `status` had zero coverage
// of this state at any tier before this pair of tests.
test("integ forge status <runId>: plain output distinguishes a fanout-parent derived failure, never a bare unexplained ☠", () => {
  const runId = "run-fg492-status-fanout";
  const taskId = "t-fg492-status-fanout-parent";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 status fanout parent" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "task.failed",
    payload: {
      failure_kind: "fanout_wave_orphaned",
      error: "fanout wave orphaned: 1/3 children complete, the rest failed or never finished",
      childSummary: { total: 3, complete: 1 },
    },
  });

  const result = runForge(["status", runId, "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /fanout wave orphaned — 1\/3 children completed/);
  assert.match(result.stdout, /forge recover t-fg492-status-fanout-parent --re-drive/);
  assert.doesNotMatch(result.stdout, FORBIDDEN_CAUSAL_CLAIMS, "a fanout parent never had its own agent container — must not read as a killed agent");
});

test("integ forge status <runId> --json: fanoutWaveRecovery carries childSummary + message for a fanout-parent derived failure, mirrors forge show", () => {
  const runId = "run-fg492-status-fanout-json";
  const taskId = "t-fg492-status-fanout-json";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 status fanout parent json" });
  insertTaskRow({ id: taskId, runId, status: "failed" });
  insertEvent({
    runId,
    taskId,
    eventType: "task.failed",
    payload: {
      failure_kind: "fanout_wave_orphaned",
      error: "fanout wave orphaned: 2/4 children complete, the rest failed or never finished",
      childSummary: { total: 4, complete: 2 },
    },
  });

  const result = runForge(["status", runId, "--json", "--read-only"]);
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout) as {
    tasks: Array<{ id: string; containerEvidence: unknown; orphanRecovery: unknown; fanoutWaveRecovery: { childSummary: { total: number; complete: number }; message: string } | null }>;
  };
  const task = parsed.tasks.find((t) => t.id === taskId);
  assert.ok(task, "task must be present in status --json output");
  assert.equal(task!.containerEvidence, null, "a fanout parent never had its own container — no containerEvidence to fabricate");
  assert.equal(task!.orphanRecovery, null, "fanout evidence lives under childSummary, not the orphanEvidence `evidence` key");
  assert.ok(task!.fanoutWaveRecovery, "fanoutWaveRecovery must be populated for a fanout-parent derived failure");
  assert.deepEqual(task!.fanoutWaveRecovery!.childSummary, { total: 4, complete: 2 });
  assert.match(task!.fanoutWaveRecovery!.message, /fanout wave orphaned — 2\/4 children completed/);
});

// ── forge ops reap-containers: real CLI option wiring (previously only ─────
// exercised at the performOpsReapContainers() function level in ops.test.ts)
//
// FG-503: candidacy is now disk-truth-driven (`docker ps -a`, faked via
// withFakeDocker above), reconciled against task rows — no event of any kind
// is required for a container to be a candidate.

test("integ forge ops reap-containers --dry-run --json: scans a failed task's container, reaps none, never touches a running task", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg492-reap";
  const failedTaskId = "t-fg492-reap-failed";
  const runningTaskId = "t-fg492-reap-running";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 reap", projectDir });
  insertTaskRow({ id: failedTaskId, runId, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  insertTaskRow({ id: runningTaskId, runId, status: "running", completedAt: null });
  const docker = withFakeDocker([{ name: `forge-${failedTaskId}` }, { name: `forge-${runningTaskId}`, running: true }]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { dryRun: boolean; scanned: number; reaped: string[]; retained: string[]; errors: string[] };
  assert.equal(outcome.dryRun, true);
  assert.equal(outcome.scanned, 1, "only the stopped, terminal-task container is a candidate, never the running one");
  assert.deepEqual(outcome.reaped, [`forge-${failedTaskId}`]);
  assert.ok(!outcome.reaped.includes(`forge-${runningTaskId}`));
});

test("integ forge ops reap-containers: a failed task with no container on disk (fanout parent / host-side dispatch) is never a candidate", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg492-reap-nocontainer";
  const taskId = "t-fg492-reap-fanout-parent";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 reap no container", projectDir });
  insertTaskRow({ id: taskId, runId, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  // No container in the docker ps -a listing — this task structurally never
  // launched one (fanout parent / host-side dispatch).
  const docker = withFakeDocker([]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { scanned: number; reaped: string[] };
  assert.equal(outcome.scanned, 0, "a task with no container on disk is never a candidate");
  assert.deepEqual(outcome.reaped, []);
});

test("integ forge ops reap-containers --dry-run (plain): reports would-reap phrasing and writes nothing", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg492-reap-plain";
  const taskId = "t-fg492-reap-plain";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 reap plain", projectDir });
  insertTaskRow({ id: taskId, runId, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  const docker = withFakeDocker([{ name: `forge-${taskId}` }]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /\(dry-run\) would reap 1\/1 retained container\(s\)/);
  assert.match(result.stdout, /No writes\./);
});

test("integ forge ops reap-containers --older-than-minutes: real CLI numeric option parsing retains a recent failure and reaps an old one", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg492-reap-age";
  const oldTaskId = "t-fg492-reap-old";
  const recentTaskId = "t-fg492-reap-recent";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 reap age", projectDir });
  insertTaskRow({ id: oldTaskId, runId, status: "failed", completedAt: "2020-01-01T00:00:00Z" });
  insertTaskRow({ id: recentTaskId, runId, status: "failed", completedAt: new Date().toISOString() });
  // The fake `docker inspect` returns no finishedAt, so the age check falls
  // back to each task's own completedAt.
  const docker = withFakeDocker([{ name: `forge-${oldTaskId}` }, { name: `forge-${recentTaskId}` }]);

  const result = runForge(
    ["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json", "--older-than-minutes", "60"],
    { env: docker.env },
  );
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { reaped: string[]; retained: string[] };
  assert.deepEqual(outcome.reaped, [`forge-${oldTaskId}`]);
  assert.deepEqual(outcome.retained, [`forge-${recentTaskId}`]);
});

test("integ forge ops reap-containers: a live reap ('docker rm') failure reports 'error' (not confirmed gone), never a crash", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg492-reap-live";
  const taskId = "t-fg492-reap-live";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 reap live", projectDir });
  insertTaskRow({ id: taskId, runId, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  const docker = withFakeDocker([{ name: `forge-${taskId}` }], { rmExitCode: 1 });

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0 even when the reap itself can't confirm removal\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { dryRun: boolean; scanned: number; reaped: string[]; errors: string[] };
  assert.equal(outcome.dryRun, false);
  assert.equal(outcome.scanned, 1);
  assert.deepEqual(outcome.errors, [`forge-${taskId}`]);
  assert.deepEqual(outcome.reaped, []);
});

test("integ forge ops reap-containers: 'docker ps -a' itself failing is reported as dockerUnavailable, never thrown", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg492-reap-ps-down";
  const taskId = "t-fg492-reap-ps-down";
  insertRunRow({ id: runId, workflow: "build", title: "fg492 reap ps down", projectDir });
  insertTaskRow({ id: taskId, runId, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  const docker = withFakeDocker([{ name: `forge-${taskId}` }], { psExitCode: 1 });

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0 even when docker itself is unreachable\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { scanned: number; reaped: string[]; dockerUnavailable: boolean };
  assert.equal(outcome.dockerUnavailable, true);
  assert.equal(outcome.scanned, 0, "docker couldn't be reached — nothing was found because nothing could be looked at");
  assert.deepEqual(outcome.reaped, []);
});

test("integ forge ops reap-containers --all --json: cross-project scan does not throw and includes tasks outside --project scope", () => {
  const projectDirA = makeProjectDir();
  const projectDirB = makeProjectDir();
  const runA = "run-fg492-reap-all-a";
  const runB = "run-fg492-reap-all-b";
  insertRunRow({ id: runA, workflow: "build", title: "fg492 reap all a", projectDir: projectDirA });
  insertRunRow({ id: runB, workflow: "build", title: "fg492 reap all b", projectDir: projectDirB });
  insertTaskRow({ id: "t-fg492-reap-all-a", runId: runA, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  insertTaskRow({ id: "t-fg492-reap-all-b", runId: runB, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  const docker = withFakeDocker([{ name: "forge-t-fg492-reap-all-a" }, { name: "forge-t-fg492-reap-all-b" }]);

  const scopedResult = runForge(["ops", "reap-containers", "--project", projectDirA, "--dry-run", "--json"], { env: docker.env });
  const scoped = JSON.parse(scopedResult.stdout) as { scanned: number };
  assert.equal(scoped.scanned, 1, "--project scopes to a single project's runs, even though docker ps -a saw both containers");

  const allResult = runForge(["ops", "reap-containers", "--all", "--dry-run", "--json"], { env: docker.env });
  assert.equal(allResult.status, 0, `expected exit 0\nstdout: ${allResult.stdout}\nstderr: ${allResult.stderr}`);
  const all = JSON.parse(allResult.stdout) as { scanned: number };
  assert.ok(all.scanned >= 2, "--all must see candidates across every project, not just the scoped one");
});

// ── FG-503: real CLI surface of the completed-task-leak scan ───────────────
// (previously the completed_leak branch of performOpsReapContainers was only
// exercised at the function level in ops.test.ts — never through registerOps's
// actual `.action()` callback, real Commander option parsing, or the real
// JSON/plain rendering the operator actually sees.)

test("integ forge ops reap-containers (FG-503 AC2) --dry-run --json: a crash-window leak — completed task, no events beyond container.started, container still on disk — surfaces via completedTaskLeaks", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg503-reap-leak";
  const leakedTaskId = "t-fg503-reap-leak";
  insertRunRow({ id: runId, workflow: "build", title: "fg503 completed-task leak", projectDir });
  insertTaskRow({ id: leakedTaskId, runId, status: "complete", completedAt: "2026-07-01T00:10:00Z" });
  insertEvent({ runId, taskId: leakedTaskId, eventType: "container.started", payload: {} });
  // Deliberately NO container.reap_failed event — the forge process died
  // between markTaskComplete and the reap call, before any event could be
  // written. Disk truth (the container still existing) is what makes this
  // a candidate now, not an event that was never recorded.
  const docker = withFakeDocker([{ name: `forge-${leakedTaskId}` }]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { scanned: number; reaped: string[]; completedTaskLeaks: string[] };
  assert.equal(outcome.scanned, 1, "a completed task's still-existing container is a candidate, not just failed tasks");
  assert.deepEqual(outcome.reaped, [`forge-${leakedTaskId}`]);
  assert.deepEqual(outcome.completedTaskLeaks, [`forge-${leakedTaskId}`], "surfaced distinctly through the real --json field, not folded into the ordinary reap count");
});

test("integ forge ops reap-containers --dry-run (plain): a completed-task leak is reported as leaked from a SUCCESSFUL task, real CLI subprocess", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg503-reap-leak-plain";
  const leakedTaskId = "t-fg503-reap-leak-plain";
  insertRunRow({ id: runId, workflow: "build", title: "fg503 completed-task leak plain", projectDir });
  insertTaskRow({ id: leakedTaskId, runId, status: "complete", completedAt: "2026-07-01T00:10:00Z" });
  const docker = withFakeDocker([{ name: `forge-${leakedTaskId}` }]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stdout, /\(dry-run\) would reap 1\/1 retained container\(s\)/);
  assert.match(
    result.stdout,
    new RegExp(`leaked from a SUCCESSFUL task \\(explicit cleanup failed, now swept\\): forge-${leakedTaskId}`),
    "the operator-visible text FG-503 exists to add — a leak on an otherwise-successful task must never read as an ordinary failed-task reap",
  );
});

test("integ forge ops reap-containers: a completed task that reaped cleanly (no container left on disk) is never scanned again, real CLI subprocess", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg503-reap-clean";
  const cleanTaskId = "t-fg503-reap-clean";
  insertRunRow({ id: runId, workflow: "build", title: "fg503 completed clean", projectDir });
  insertTaskRow({ id: cleanTaskId, runId, status: "complete", completedAt: "2026-07-01T00:10:00Z" });
  // No container in the docker ps -a listing — the ordinary silent happy path.
  const docker = withFakeDocker([]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { scanned: number; reaped: string[]; completedTaskLeaks: string[] };
  assert.equal(outcome.scanned, 0, "a cleanly-reaped completed task must never become a scan candidate, real CLI end to end");
  assert.deepEqual(outcome.reaped, []);
  assert.deepEqual(outcome.completedTaskLeaks, []);
});

test("integ forge ops reap-containers: a running task's container is never swept, even past the age threshold", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg503-reap-running-guard";
  const runningTaskId = "t-fg503-reap-running-guard";
  insertRunRow({ id: runId, workflow: "build", title: "fg503 running guard", projectDir });
  insertTaskRow({ id: runningTaskId, runId, status: "running", completedAt: null });
  // The container shows up STOPPED on disk (e.g. a docker-level race between
  // exit and this scan), but the task itself is still 'running' — must still
  // be left alone.
  const docker = withFakeDocker([{ name: `forge-${runningTaskId}` }]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json", "--older-than-minutes", "0"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { scanned: number; reaped: string[] };
  assert.equal(outcome.scanned, 0, "a running task's container must never be a candidate, regardless of the container's own disk state");
  assert.deepEqual(outcome.reaped, []);
});

test("integ forge ops reap-containers --json: a failed-task retention candidate and a completed-task leak candidate compose in the same real scan without cross-contamination", () => {
  const projectDir = makeProjectDir();
  const runId = "run-fg503-reap-mixed";
  const failedTaskId = "t-fg503-reap-mixed-failed";
  const leakedTaskId = "t-fg503-reap-mixed-leak";
  insertRunRow({ id: runId, workflow: "build", title: "fg503 mixed scan", projectDir });
  insertTaskRow({ id: failedTaskId, runId, status: "failed", completedAt: "2026-07-01T00:10:00Z" });
  insertTaskRow({ id: leakedTaskId, runId, status: "complete", completedAt: "2026-07-01T00:10:00Z" });
  const docker = withFakeDocker([{ name: `forge-${failedTaskId}` }, { name: `forge-${leakedTaskId}` }]);

  const result = runForge(["ops", "reap-containers", "--project", projectDir, "--dry-run", "--json"], { env: docker.env });
  assert.equal(result.status, 0, `expected exit 0\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  const outcome = JSON.parse(result.stdout) as { scanned: number; reaped: string[]; completedTaskLeaks: string[] };
  assert.equal(outcome.scanned, 2, "both the failed-retained and completed-leak candidates land in the same scan");
  assert.deepEqual(outcome.reaped.sort(), [`forge-${failedTaskId}`, `forge-${leakedTaskId}`].sort());
  assert.deepEqual(outcome.completedTaskLeaks, [`forge-${leakedTaskId}`], "only the completed-task leak is tagged — the ordinary failed-task candidate must not bleed into this field");
});
