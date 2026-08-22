// FG-348 RF-1: `forge explain task` must supply the SAME artifact-availability the
// dashboard query (dashboard/src/queries.ts taskExplain) does, so the shared
// buildTaskExplain produces byte-identical output on both surfaces (AC5). Before the
// fix the CLI omitted the `artifacts` argument entirely, so the builder fell back to a
// result-ONLY list and the CLI diverged from the dashboard, which probes result +
// stdout + stderr + manifest. This proves the CLI now probes all four per-file.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Database as DatabaseInstance } from "better-sqlite3";
import { makeInMemoryDb, setDbForTest } from "../../store/db.js";
import { insertRun } from "../../store/runs.js";
import { insertTask } from "../../store/tasks.js";
import { taskDir } from "../../util/paths.js";
import { explainTaskGraph } from "./explain.js";
import type { Run, Task } from "../../types/index.js";

const RUN: Run = {
  id: "run-fg348-artifacts",
  workflow: "feature",
  title: "fg348 artifact parity",
  status: "active",
  createdAt: "2026-08-22T00:00:00.000Z",
};

const TASK_ID = "task-fg348-artifacts";

function makeTask(): Task {
  return {
    id: TASK_ID,
    runId: RUN.id,
    phase: "build",
    agentRole: "engineer",
    status: "complete",
    result: { status: "complete", tests_run: 3 },
    taskPackage: {
      taskId: TASK_ID,
      runId: RUN.id,
      phase: "build",
      role: "engineer",
      inputs: { brief: "do the thing" },
      composedSystemPrompt: "",
    },
    createdAt: RUN.createdAt,
  };
}

let db: DatabaseInstance;
let prev: DatabaseInstance | null;
let dir: string;

beforeEach(() => {
  db = makeInMemoryDb();
  prev = setDbForTest(db);
  insertRun(RUN);
  insertTask(makeTask());
  dir = taskDir(RUN.id, TASK_ID);
  mkdirSync(dir, { recursive: true });
  // A present stdout + manifest, a DELIBERATELY ABSENT stderr — so the per-file
  // probe has to distinguish them rather than report a blanket availability.
  writeFileSync(join(dir, "container.stdout.log"), "{}\n");
  writeFileSync(
    join(dir, "manifest.json"),
    JSON.stringify({
      controlPlane: {
        workflow: { name: "feature", source: "host", path: "/seed/feature.yml" },
        mountMode: "rw",
        projectDir: "/project",
      },
    }),
  );
});

afterEach(() => {
  setDbForTest(prev as DatabaseInstance);
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

test("explain task supplies per-file artifact availability (result+stdout+stderr+manifest), not a result-only fallback", () => {
  const explain = explainTaskGraph(TASK_ID);
  const byKind = new Map(explain.artifacts?.map((a) => [a.kind, a]));

  assert.deepEqual(
    [...byKind.keys()].sort(),
    ["manifest", "result", "stderr", "stdout"],
    "all four artifact kinds the dashboard probes are present (not a result-only list)",
  );
  assert.equal(byKind.get("result")?.available, true, "result.json present in the row");
  assert.equal(byKind.get("stdout")?.available, true, "container.stdout.log written above");
  assert.equal(byKind.get("stderr")?.available, false, "container.stderr.log deliberately absent");
  assert.equal(byKind.get("manifest")?.available, true, "manifest.json written above");
});
