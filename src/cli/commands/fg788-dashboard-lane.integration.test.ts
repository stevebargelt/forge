// FG-788 AC3: a cited dashboard/src test executed by forge's lane runner runs from cwd=dashboard,
// where the dashboard tsconfig's @forge/* aliases resolve, and is green — while the SAME file run
// from the repo root (what the rechecker did on review-2dd46c7d2e9d) dies on ERR_MODULE_NOT_FOUND.
// The second half is what makes the lane choice load-bearing rather than incidental.
//
// Tier: integration — it spawns real `node --test` subprocesses against the real workspace.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runLaneTestFiles } from "./review-wiring.js";
import { testExecution, testLaneForFile } from "../../v2/review-evidence.js";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
// Imports ./queries.js, which imports @forge/project-meta — the exact alias FG-788 tripped on.
const FILE = "dashboard/src/queries-presentation-registry.test.ts";
const NAME = "does not mutate the input records";

// A nested `node --test` that inherits this process's test context treats itself as a subtest and
// does not run the file; production never runs a lane under a node:test parent.
function withoutNodeTestContext<T>(fn: () => T): T {
  const saved = process.env["NODE_TEST_CONTEXT"];
  delete process.env["NODE_TEST_CONTEXT"];
  try {
    return fn();
  } finally {
    if (saved !== undefined) process.env["NODE_TEST_CONTEXT"] = saved;
  }
}

test("FG-788 AC1+AC3: a dashboard/src test runs green in the dashboard_unit lane (cwd=dashboard)", () => {
  const lane = testLaneForFile(FILE);
  assert.equal(lane, "dashboard_unit");
  const res = withoutNodeTestContext(() => runLaneTestFiles(REPO_ROOT, "dashboard_unit", [FILE]));
  assert.equal(res.blocked, undefined, res.blocked);
  assert.equal(res.notExecuted, undefined, res.notExecuted);
  assert.equal(testExecution(res.runnerOutput ?? "", [NAME]), "executed", res.runnerOutput);
});

test("FG-788 AC3: the SAME file run from the repo root fails on the @forge/* alias — the lane choice is load-bearing", () => {
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  let out: string;
  try {
    out = execFileSync("node", ["--import", "tsx", "--test", FILE], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    out = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  assert.match(out, /ERR_MODULE_NOT_FOUND|Cannot find (package|module) '@forge\//);
  assert.notEqual(testExecution(out, [NAME]), "executed", "a repo-root run never shows the cited test executing");
});

test("FG-788: the lane runner refuses a path that is not a test file of the named lane", () => {
  assert.match(runLaneTestFiles(REPO_ROOT, "unit", [FILE]).notExecuted ?? "", /not a test file of the unit lane/);
  assert.match(runLaneTestFiles(REPO_ROOT, "dashboard_unit", ["dashboard/src/../../src/x.test.ts"]).notExecuted ?? "", /not a test file/);
  assert.match(runLaneTestFiles(REPO_ROOT, "dashboard_unit", ["dashboard/src/no-such-file.test.ts"]).notExecuted ?? "", /does not exist/);
});
