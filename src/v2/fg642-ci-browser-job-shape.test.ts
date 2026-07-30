// FG-642 verify phase: two additive CI-shape properties the guard in
// ci-workflow.test.ts leaves open, found by mutating ci.yml and watching what
// stayed green.
//
//   1. `test-extended` `needs:` a job that does not EXIST. Renaming or removing
//      `dashboard_browser` while leaving it in `needs` keeps the needs-set assertion
//      green (the sets still match) — GitHub then rejects the whole workflow as
//      invalid, so the required contexts never report and nothing runs. Asserting the
//      needs set against the DEFINED jobs catches that at unit-tier speed instead of
//      on a push that produces no CI at all.
//   2. Step ORDER inside dashboard_browser. The existing job assertions are set
//      membership over `run` commands, so a workflow that installed chromium and
//      exported FORGE_CHROME_BIN *after* running the tier would satisfy every one of
//      them while the tier itself hit the precondition and went red.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

type Step = { name?: string; uses?: string; run?: string };
type Job = { needs?: string[]; steps?: Step[] };
type Workflow = { jobs?: Record<string, Job> };

const WORKFLOW_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".github", "workflows", "ci.yml");

function loadWorkflow(): Workflow {
  return parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

test("FG-642 (CI shape): every job test-extended needs is actually defined in ci.yml", () => {
  const wf = loadWorkflow();
  const defined = Object.keys(wf.jobs ?? {});
  const needs = wf.jobs?.["test-extended"]?.needs ?? [];
  assert.ok(needs.length > 0, "test-extended must depend on the sharded extended-gate jobs");
  const missing = needs.filter((dep) => !defined.includes(dep));
  assert.deepEqual(
    missing,
    [],
    `test-extended needs ${missing.join(", ")}, which ci.yml does not define — GitHub rejects the workflow outright, so the required checks never report and NO tier runs`
  );
});

test("FG-642 (CI shape): dashboard_browser provisions and names the browser BEFORE it runs the tier", () => {
  const job = loadWorkflow().jobs?.dashboard_browser;
  assert.ok(job, "ci.yml must define the dashboard_browser job (FG-642)");

  const runs = (job!.steps ?? []).map((s) => s.run ?? "");
  const indexOfStep = (needle: string): number => runs.findIndex((r) => r.includes(needle));

  const install = indexOfStep("playwright-core install");
  const name = indexOfStep("FORGE_CHROME_BIN");
  const tier = indexOfStep("test:browser");
  assert.ok(install >= 0, "the job must install chromium");
  assert.ok(name >= 0, "the job must hand the installed binary to the tier via FORGE_CHROME_BIN");
  assert.ok(tier >= 0, "the job must run the tier");

  assert.ok(install < tier, `chromium must be installed (step ${install}) before the tier runs (step ${tier})`);
  assert.ok(
    name < tier,
    `FORGE_CHROME_BIN must be exported (step ${name}) before the tier runs (step ${tier}) — since FG-642 an unprovisioned runner FAILS the precondition instead of skipping, so a late export is a guaranteed red rather than coverage`
  );
});
