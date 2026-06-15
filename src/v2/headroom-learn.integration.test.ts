// Integration tests for FG-320: headroom learn integration.
// Tests exercise real SQLite interactions via in-memory DB and the learn CLI
// command's existence and help text.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../store/db.js";
import { insertRun } from "../store/runs.js";
import { insertTask, markTaskFailed } from "../store/tasks.js";
import {
  detectFailedRuns,
  extractFailureLogs,
  parseSeedCorrections,
  runHeadroomLearn,
} from "./headroom-learn.js";
import type { Run, Task } from "../types/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, "..", "cli", "index.ts");
const tsx = resolve(here, "..", "..", "node_modules", ".bin", "tsx");

// ---- DB test harness ----

let db: DatabaseInstance;
let prev: DatabaseInstance | null;

const BASE_RUN: Run = {
  id: "run-learn-test",
  workflow: "feature",
  title: "test run",
  status: "active",
  createdAt: "2026-06-15T00:00:00Z",
  projectDir: "/project/test-app",
};

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    id: overrides.id,
    runId: overrides.runId ?? BASE_RUN.id,
    phase: overrides.phase ?? "implement",
    agentRole: overrides.agentRole ?? "engineer",
    status: overrides.status ?? "pending",
    taskPackage: {
      taskId: overrides.id,
      runId: overrides.runId ?? BASE_RUN.id,
      phase: overrides.phase ?? "implement",
      role: overrides.agentRole ?? "engineer",
      inputs: {},
      composedSystemPrompt: "",
    },
    createdAt: overrides.createdAt ?? "2026-06-15T00:00:00Z",
    completedAt: overrides.completedAt,
    error: overrides.error,
  };
}

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(BASE_RUN);
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
});

// ---- detectFailedRuns: SQLite integration ----

test("detectFailedRuns: finds failed tasks in SQLite", () => {
  insertTask(makeTask({ id: "task-failed-1", agentRole: "engineer" }));
  insertTask(makeTask({ id: "task-failed-2", agentRole: "tech-lead" }));
  insertTask(makeTask({ id: "task-ok", agentRole: "engineer" }));

  markTaskFailed("task-failed-1", "container exited 1");
  markTaskFailed("task-failed-2", "timeout");

  const rows = detectFailedRuns({});

  assert.equal(rows.length, 2);
  const ids = rows.map((r) => r.task.id).sort();
  assert.deepEqual(ids, ["task-failed-1", "task-failed-2"]);
});

test("detectFailedRuns: returns empty array when no failed tasks", () => {
  insertTask(makeTask({ id: "task-running" }));
  const rows = detectFailedRuns({});
  assert.equal(rows.length, 0);
});

test("detectFailedRuns: respects agentRole filter", () => {
  insertTask(makeTask({ id: "eng-1", agentRole: "engineer" }));
  insertTask(makeTask({ id: "tl-1", agentRole: "tech-lead" }));
  markTaskFailed("eng-1", "failed");
  markTaskFailed("tl-1", "failed");

  const rows = detectFailedRuns({ agentRole: "engineer" });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.agentRole, "engineer");
});

test("detectFailedRuns: respects limit", () => {
  for (let i = 0; i < 5; i++) {
    insertTask(makeTask({ id: `task-lim-${i}` }));
    markTaskFailed(`task-lim-${i}`, "error");
  }

  const rows = detectFailedRuns({ limit: 3 });
  assert.equal(rows.length, 3);
});

test("detectFailedRuns: includes projectDir from the run", () => {
  insertTask(makeTask({ id: "task-proj" }));
  markTaskFailed("task-proj", "crash");

  const rows = detectFailedRuns({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.projectDir, "/project/test-app");
});

test("detectFailedRuns: includes error message from task", () => {
  insertTask(makeTask({ id: "task-err" }));
  markTaskFailed("task-err", "out of memory");

  const rows = detectFailedRuns({});
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.error, "out of memory");
});

// ---- extractFailureLogs: reads files from task dir ----

test("extractFailureLogs: returns error from row when no files on disk", () => {
  insertTask(makeTask({ id: "task-nofiles" }));
  markTaskFailed("task-nofiles", "container crashed");

  const rows = detectFailedRuns({});
  assert.equal(rows.length, 1);
  const logs = extractFailureLogs(rows[0]!);

  assert.equal(logs.taskId, "task-nofiles");
  assert.equal(logs.agentRole, "engineer");
  assert.equal(logs.error, "container crashed");
  assert.equal(logs.resultJson, null);
  assert.equal(logs.stderr, null);
});

test("extractFailureLogs: reads result.json from task dir when present", () => {
  // Use the FORGE_HOME already established by test-setup.ts (module-level constant in paths.ts).
  const forgeHome = process.env.FORGE_HOME!;
  const runId = "run-rj";
  const taskId = "task-rj";
  const taskDirPath = join(forgeHome, "runs", runId, taskId);
  mkdirSync(taskDirPath, { recursive: true });
  writeFileSync(join(taskDirPath, "result.json"), JSON.stringify({ status: "failed", error: "bad output" }));

  try {
    const run: Run = { id: runId, workflow: "feature", title: "t", status: "active", createdAt: "2026-06-15T00:00:00Z", projectDir: forgeHome };
    // Use the outer db (set by beforeEach) — insert additional run/task into it
    insertRun(run);
    insertTask(makeTask({ id: taskId, runId, agentRole: "engineer" }));
    markTaskFailed(taskId, "bad output");

    const rows = detectFailedRuns({});
    const row = rows.find((r) => r.task.id === taskId);
    assert.ok(row, "expected to find the failed task row");
    const logs = extractFailureLogs(row!);

    assert.deepEqual(logs.resultJson, { status: "failed", error: "bad output" });
    assert.equal(logs.stderr, null);
  } finally {
    rmSync(taskDirPath, { recursive: true, force: true });
  }
});

test("extractFailureLogs: reads stderr.log from task dir when present", () => {
  const forgeHome = process.env.FORGE_HOME!;
  const runId = "run-sl";
  const taskId = "task-sl";
  const taskDirPath = join(forgeHome, "runs", runId, taskId);
  mkdirSync(taskDirPath, { recursive: true });
  writeFileSync(join(taskDirPath, "stderr.log"), "Error: something went very wrong\nstacktrace here");

  try {
    const run: Run = { id: runId, workflow: "feature", title: "t", status: "active", createdAt: "2026-06-15T00:00:00Z", projectDir: forgeHome };
    insertRun(run);
    insertTask(makeTask({ id: taskId, runId, agentRole: "engineer" }));
    markTaskFailed(taskId, "stderr error");

    const rows = detectFailedRuns({});
    const row = rows.find((r) => r.task.id === taskId);
    assert.ok(row, "expected to find the failed task row");
    const logs = extractFailureLogs(row!);

    assert.ok(logs.stderr?.includes("Error: something went very wrong"));
  } finally {
    rmSync(taskDirPath, { recursive: true, force: true });
  }
});

// ---- parseSeedCorrections: integration-level edge cases ----

test("parseSeedCorrections: handles multi-project output with mixed patterns", () => {
  const output = `
Analyzing project at /project/app

============================================================
[claude] project
============================================================
  Would write CLAUDE.md
  Writing seeds/agents/engineer.md
  Would update .claude/CLAUDE.md
  Some other line without a pattern
  Would write docs/headroom-learn.md
`;
  const corrections = parseSeedCorrections(output);
  assert.equal(corrections.length, 4);
  const files = corrections.map((c) => c.file);
  assert.ok(files.includes("CLAUDE.md"));
  assert.ok(files.includes("seeds/agents/engineer.md"));
  assert.ok(files.includes(".claude/CLAUDE.md"));
  assert.ok(files.includes("docs/headroom-learn.md"));
});

test("parseSeedCorrections: each correction has a non-empty summary", () => {
  const output = `  Writing CLAUDE.md\n  Would update seeds/agents/tech-lead.md`;
  const corrections = parseSeedCorrections(output);
  for (const c of corrections) {
    assert.ok(c.summary.length > 0, `summary should not be empty for file: ${c.file}`);
    assert.ok(c.file.endsWith(".md"), `file should be a .md path: ${c.file}`);
  }
});

// ---- runHeadroomLearn: mock invocation (headroom not installed in test env) ----

test("runHeadroomLearn: returns non-zero exitCode when headroom binary is absent", () => {
  // headroom is not installed in the test container; spawnSync with a missing
  // binary returns status=null (ENOENT). The function normalizes that to 1.
  const result = runHeadroomLearn({ projectDir: "/tmp/no-such-project" });
  // The binary isn't available — exitCode must be non-zero (1 per normalization)
  assert.ok(result.exitCode !== 0, "expected non-zero exit when headroom is absent");
  // stdout/stderr should be strings (never null)
  assert.equal(typeof result.stdout, "string");
  assert.equal(typeof result.stderr, "string");
});

// ---- forge learn CLI: command registered and shows help ----

test("forge learn CLI: command exists and --help shows correct description", () => {
  const result = spawnSync(tsx, [entry, "learn", "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: mkdtempSync(join(tmpdir(), "forge-learn-cli-")),
      NO_NOTIFY: "true",
    },
  });

  // Commander exits 0 for --help
  assert.equal(result.status, 0, `expected exit 0 for --help, got ${result.status}. stderr: ${result.stderr}`);

  const output = result.stdout + result.stderr;
  assert.ok(
    output.includes("learn"),
    `expected 'learn' in help output; got: ${output.slice(0, 500)}`
  );
  assert.ok(
    output.includes("headroom") || output.includes("failed runs"),
    `expected headroom/failed-runs description in help; got: ${output.slice(0, 500)}`
  );
});

test("forge learn CLI: --help shows key options", () => {
  const result = spawnSync(tsx, [entry, "learn", "--help"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: mkdtempSync(join(tmpdir(), "forge-learn-opts-")),
      NO_NOTIFY: "true",
    },
  });

  assert.equal(result.status, 0);
  const output = result.stdout + result.stderr;
  assert.ok(output.includes("--apply"), `expected --apply option; got: ${output.slice(0, 500)}`);
  assert.ok(output.includes("--since"), `expected --since option; got: ${output.slice(0, 500)}`);
  assert.ok(output.includes("--limit"), `expected --limit option; got: ${output.slice(0, 500)}`);
});

test("forge learn CLI: exits 0 with --json when no failed runs exist", () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "forge-learn-nofail-"));

  const result = spawnSync(tsx, [entry, "learn", "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      FORGE_HOME: fakeHome,
      NO_NOTIFY: "true",
    },
  });

  // Should exit 0 even with empty DB
  assert.equal(result.status, 0, `expected exit 0; got ${result.status}. stderr: ${result.stderr}`);

  // Output should be valid JSON with failedRunsFound=0
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    assert.fail(`expected JSON output; got: ${result.stdout}`);
  }
  assert.equal((parsed as Record<string, unknown>)["failedRunsFound"], 0);

  rmSync(fakeHome, { recursive: true, force: true });
});

// ---- detectFailedRuns: sinceMs filter ----

test("detectFailedRuns: sinceMs filter excludes tasks completed before window", () => {
  // Insert a task manually with a known completed_at in the past
  const taskId = "task-old";
  insertTask(makeTask({ id: taskId }));
  // Mark it failed; it sets completed_at to now. Then we filter from now+1ms.
  markTaskFailed(taskId, "old failure");

  // sinceMs in the far future — nothing should match
  const futureMs = Date.now() + 1_000_000_000;
  const rows = detectFailedRuns({ sinceMs: futureMs });
  assert.equal(rows.length, 0);
});

test("detectFailedRuns: sinceMs=0 includes all failed tasks", () => {
  insertTask(makeTask({ id: "task-all-1" }));
  insertTask(makeTask({ id: "task-all-2" }));
  markTaskFailed("task-all-1", "error");
  markTaskFailed("task-all-2", "error");

  const rows = detectFailedRuns({ sinceMs: 0 });
  assert.ok(rows.length >= 2);
});
