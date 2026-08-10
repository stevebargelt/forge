// FG-474 regression guard: `.github/workflows/ci.yml` is the required merge-gate
// check. It must actually run the deterministic suite the orchestrator now
// defers to (CLAUDE.md's "Merge authorization") instead of a host re-run — if a
// future edit drops a step, mistargets the trigger, or unpins Node, the gate
// stops proving what the docs claim it proves, silently.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { REQUIRED_CI_CHECK_CONTEXT, REQUIRED_CI_GATE_COMMAND, projectCiRunsCommand } from "../store/host-verifications.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const WORKFLOW_PATH = join(root, ".github", "workflows", "ci.yml");

type Step = { name?: string; uses?: string; run?: string; with?: Record<string, unknown> };
type Job = {
  "runs-on"?: string;
  "continue-on-error"?: boolean;
  "timeout-minutes"?: number;
  needs?: string[];
  if?: string;
  steps?: Step[];
};
type Workflow = {
  name?: string;
  on?: { push?: unknown; pull_request?: { branches?: string[] } };
  jobs?: Record<string, Job>;
};

function loadWorkflow(): Workflow {
  return parseYaml(readFileSync(WORKFLOW_PATH, "utf8")) as Workflow;
}

test("FG-474: ci.yml parses as valid YAML", () => {
  assert.doesNotThrow(() => loadWorkflow());
});

test("FG-474: ci.yml preserves the exact required-check contexts CI / test and CI / test-extended", () => {
  const wf = loadWorkflow();
  assert.equal(wf.name, "CI", "the workflow name is the required-check context prefix");
  assert.ok(wf.jobs?.test, 'the required-check context "CI / test" must retain its job id');
  assert.ok(
    wf.jobs?.["test-extended"],
    'the required-check context "CI / test-extended" must retain its job id'
  );
});

test("FG-474: ci.yml triggers on push and on pull_request into main", () => {
  const wf = loadWorkflow();
  assert.ok(wf.on?.push !== undefined, "must trigger on push (feature-branch visibility)");
  assert.ok(
    wf.on?.pull_request?.branches?.includes("main"),
    "must trigger on pull_request into main (the PR check the merge gate reads)"
  );
});

test("FG-474: ci.yml's `test` job runs the full deterministic gate", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.test;
  assert.ok(job, "workflow must define the required `test` job");
  const steps = job!.steps ?? [];
  const runCommands = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
  const usesRefs = steps.map((s) => s.uses).filter((u): u is string => typeof u === "string");

  assert.ok(usesRefs.some((u) => u.startsWith("actions/checkout")), "must check out the repo");
  assert.ok(
    usesRefs.some((u) => u.startsWith("actions/setup-node")),
    "must set up Node via actions/setup-node"
  );
  assert.ok(
    runCommands.some((r) => r.includes("npm ci")),
    "must install dependencies with npm ci"
  );
  assert.ok(
    runCommands.some((r) => r.includes("better-sqlite3")),
    "must rebuild/verify the better-sqlite3 native module so its ABI matches the pinned Node version"
  );
  assert.ok(
    runCommands.some((r) => r.includes("npm run typecheck")),
    "must run typecheck — CLAUDE.md's merge gate names typecheck explicitly"
  );
  assert.ok(
    runCommands.some((r) => r.includes("npm run test:all")),
    "must run the shipped-claim aggregate (root + dashboard workspace), not just the root suite"
  );
});

// task-red-wide-16933b: this is a structural self-check of FORGE'S OWN ci.yml
// ONLY. It does NOT establish the general command-pairing guarantee — forge is
// host-global and the pairing gate (host-verifications.ts's
// findCoveringGateEvidence, via projectCiRunsCommand) is verified per-project,
// at lookup time, against whatever project is actually being gated. This test
// merely proves forge's own ci.yml passes that same per-project check.
test("FG-474: ci.yml's test job actually runs REQUIRED_CI_GATE_COMMAND — proves forge's OWN ci.yml passes the general per-project pairing check (see projectCiRunsCommand), not a general guarantee about other projects", () => {
  const wf = loadWorkflow();
  const steps = wf.jobs?.test?.steps ?? [];
  const runCommands = steps.map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    runCommands.some((r) => r.includes(REQUIRED_CI_GATE_COMMAND)),
    `ci.yml must run REQUIRED_CI_GATE_COMMAND ("${REQUIRED_CI_GATE_COMMAND}") — a green "${REQUIRED_CI_CHECK_CONTEXT}" check on FORGE's own repo only ever proves this command ran here; other projects are verified independently via projectCiRunsCommand against their own workflow content`
  );
});

test("FG-474 (task-red-wide-16933b): forge's own ci.yml passes the general-purpose per-project pairing check (projectCiRunsCommand) used by findCoveringGateEvidence for ANY managed project", () => {
  assert.equal(
    projectCiRunsCommand(root, REQUIRED_CI_CHECK_CONTEXT, REQUIRED_CI_GATE_COMMAND),
    true,
    "projectCiRunsCommand(forge's own repo root, ...) must find the exact-matching run step — proving the general lookup mechanism works against forge's own workflow, not just this file's bespoke YAML assertions"
  );
});

test("FG-474: ci.yml pins Node via the repo's .nvmrc rather than a hardcoded/latest version", () => {
  const wf = loadWorkflow();
  const steps = wf.jobs?.test?.steps ?? [];
  const setupNode = steps.find((s) => s.uses?.startsWith("actions/setup-node"));
  assert.ok(setupNode, "must have an actions/setup-node step");
  assert.equal(
    setupNode!.with?.["node-version-file"],
    ".nvmrc",
    "must read node-version-file from .nvmrc so CI can't drift from the ABI the native module was built for"
  );
});

test("FG-474: .nvmrc pins the Node major version the better-sqlite3 ABI note references", () => {
  const nvmrc = readFileSync(join(root, ".nvmrc"), "utf8").trim();
  assert.equal(nvmrc, "24", ".nvmrc must stay pinned to 24 — the ABI mismatch this workflow guards against was observed against this exact version");
});

// FG-495 regression guard (updated: sharded extended gate; FG-624: 5-way and
// duration-aware): the slow integration/worktree coverage moved out of the
// fast `test` gate must still run somewhere routine and visible. It now runs
// as EIGHT concurrent jobs — five root integration shards
// (`integration_1`..`integration_5`, partitioned by measured per-file duration
// via scripts/run-integration-tests.sh), a `worktree` job, a
// `dashboard_integration` job, and (FG-642) a `dashboard_browser` job — with the
// required `test-extended` job reduced to a fail-closed aggregate over all eight. If a future edit drops a shard, mistargets a shard
// selector, or lets the aggregate go green on a failed dependency, the
// trust-sensitive coverage (FG-419/FG-440/FG-474 gate-enforcement tests, among
// others) would stop gating merges without anyone deciding that on purpose.

const INTEGRATION_SHARD_JOBS = [
  "integration_1",
  "integration_2",
  "integration_3",
  "integration_4",
  "integration_5",
] as const;
const SMALL_TIER_JOBS = ["worktree", "dashboard_integration", "dashboard_browser"] as const;
const EXTENDED_GATE_JOBS = [...INTEGRATION_SHARD_JOBS, ...SMALL_TIER_JOBS] as const;

test("FG-495 (sharded, FG-624 5-way): ci.yml has five integration shard jobs each running the shard script with its own k/5 selector", () => {
  const wf = loadWorkflow();
  const selectors: string[] = [];
  for (const name of INTEGRATION_SHARD_JOBS) {
    const job = wf.jobs?.[name];
    assert.ok(job, `ci.yml must define the ${name} integration shard job`);
    const runCommands = (job!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
    const shardRun = runCommands.find((r) => r.includes("run-integration-tests.sh"));
    assert.ok(
      shardRun,
      `${name} must run scripts/run-integration-tests.sh (the single-source-of-truth shard script)`
    );
    const m = shardRun!.match(/run-integration-tests\.sh\s+([0-9]+\/[0-9]+)/);
    assert.ok(m, `${name} must pass a k/N shard selector to run-integration-tests.sh`);
    selectors.push(m![1]!);
  }
  assert.deepEqual(
    [...selectors].sort(),
    ["1/5", "2/5", "3/5", "4/5", "5/5"],
    "the five shard jobs must cover exactly 1/5..5/5 — each appearing exactly once. The selectors are what make the partition a cover: src/test-shards.ts plans N shards and each job takes one, so a duplicated or missing k means files run twice or not at all"
  );
});

test("FG-647: no CI job provisions a second interpreter — every job runs on the .nvmrc Node alone", () => {
  // The inverse of the guard this replaces. FG-647 deleted the environment-dependent
  // F31 arm, so a shard that downloads another Node is now cost and network with no
  // test behind it — and re-adding one is how the deleted arm would come back.
  const wf = loadWorkflow();
  for (const [name, job] of Object.entries(wf.jobs ?? {})) {
    const runCommands = (job.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
    for (const r of runCommands) {
      assert.doesNotMatch(
        r,
        /FORGE_TEST_MISMATCHED_NODE|nodejs\.org\/dist/,
        `${name} provisions a second interpreter. FG-647 removed that arm; the ABI preflight coverage is deterministic under the .nvmrc Node`
      );
    }
  }
});

test("FG-495 (sharded): ci.yml has a worktree job that runs npm run test:worktree", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.worktree;
  assert.ok(job, "ci.yml must define a worktree job for the root worktree tier");
  const runCommands = (job!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    runCommands.some((r) => r.includes("npm run test:worktree")),
    "worktree job must run npm run test:worktree"
  );
});

test("FG-495 (sharded): ci.yml has a dashboard_integration job that runs test:integration -w dashboard", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.dashboard_integration;
  assert.ok(job, "ci.yml must define a dashboard_integration job for the dashboard workspace's integration tier");
  const runCommands = (job!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    runCommands.some((r) => r.includes("test:integration") && r.includes("-w dashboard")),
    "dashboard_integration job must run npm run test:integration -w dashboard"
  );
});

test("FG-642: ci.yml has a dashboard_browser job that provisions a browser and runs test:browser -w dashboard", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.dashboard_browser;
  assert.ok(job, "ci.yml must define a dashboard_browser job — the dashboard's real-Chrome tier ran in CI nowhere before FG-642 and skipped itself to green everywhere else");
  const runCommands = (job!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    runCommands.some((r) => r.includes("test:browser") && r.includes("-w dashboard")),
    "dashboard_browser job must run npm run test:browser -w dashboard"
  );
  // Since FG-642 a Chrome-less run FAILS on the resolver's precondition rather
  // than skipping, so the browser has to be provisioned and named to the tier —
  // otherwise this job is a guaranteed red instead of coverage.
  assert.ok(
    runCommands.some((r) => r.includes("playwright-core install") && r.includes("chromium")),
    "dashboard_browser job must install chromium through the pinned playwright-core the tier itself drives"
  );
  assert.ok(
    runCommands.some((r) => r.includes("FORGE_CHROME_BIN")),
    "dashboard_browser job must hand the installed binary to the tier via FORGE_CHROME_BIN — Playwright's cache is not one of src/util/chrome-bin.ts's system locations"
  );
});

test("FG-495 (sharded): the test-extended aggregate needs all eight extended-gate jobs, uses if: always(), and fails closed on any non-success", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.["test-extended"];
  assert.ok(job, "ci.yml must define the test-extended aggregate job (the required branch-protection context)");

  const needs = job!.needs ?? [];
  assert.deepEqual(
    [...needs].sort(),
    [...EXTENDED_GATE_JOBS].sort(),
    "test-extended must `needs` exactly the eight sharded/tiered extended-gate jobs — a shard added to ci.yml but left out of `needs` runs without gating anything"
  );

  assert.equal(
    job!.if,
    "always()",
    "test-extended must use `if: always()` so it still evaluates (fail-closed) when a dependency failed rather than being skipped"
  );

  // The aggregate step must inspect every dependency's result and fail on any
  // non-success — this is the fail-closed proof (operator proof #5/#6): a
  // failed/cancelled/skipped dep cannot yield green.
  const aggregateBody = (job!.steps ?? [])
    .map((s) => s.run)
    .filter((r): r is string => typeof r === "string")
    .join("\n");
  for (const dep of EXTENDED_GATE_JOBS) {
    assert.ok(
      aggregateBody.includes(`needs.${dep}.result`),
      `aggregate step must inspect needs.${dep}.result`
    );
  }
  assert.ok(
    /!=\s*"?success"?/.test(aggregateBody) && /exit\s+1/.test(aggregateBody),
    "aggregate step must exit non-zero when any dependency result is not 'success'"
  );
});

// FG-495 disposition fix: test-extended is a REQUIRED merge check, same as
// `test` — the ticket's own AC ("do not weaken trust-sensitive coverage")
// forbids marking the entire job continue-on-error, since that would stop
// every integration/worktree test (including FG-419/FG-440/FG-474 trust-gate
// enforcement tests) from gating merges. Branch protection carries both
// "test" and "test-extended" as required contexts (applied host-side by the
// orchestrator); this guard just proves the workflow YAML doesn't undercut
// that by silently reintroducing continue-on-error on this job.
test("FG-495: the test-extended job is a required merge check — no continue-on-error key", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.["test-extended"];
  assert.ok(job, "ci.yml must define a test-extended job");
  assert.equal(
    job!["continue-on-error"],
    undefined,
    "test-extended must NOT have a continue-on-error key — it is a required merge check alongside `test`, not informational; a red run must block merge"
  );
});

// Extended-gate wall-clock ceiling: every one of the eight concurrent
// extended-gate jobs carries a `timeout-minutes` ceiling, so a suite that runs
// long is cancelled → its result is not `success` → the fail-closed aggregate
// goes red → merge is blocked. Because the eight run concurrently, bounding each
// bounds the whole extended gate.
//
// The five integration shards get 10 minutes; the three smaller tiers keep 6.
// The tier grew into the old shared 6: at cfbebcc5 `integration_1` finished the
// whole shard green in 5m57s and was killed at the ceiling anyway, turning the
// required check red with nothing failing. See the evidence recorded above the
// shard jobs in ci.yml.
test("extended-gate ceiling: each of the five integration shards has timeout-minutes: 10", () => {
  const wf = loadWorkflow();
  for (const name of INTEGRATION_SHARD_JOBS) {
    const job = wf.jobs?.[name];
    assert.ok(job, `ci.yml must define the ${name} extended-gate job`);
    assert.equal(
      job!["timeout-minutes"],
      10,
      `${name} must carry timeout-minutes: 10 — over-ceiling ⇒ job cancelled ⇒ aggregate fails ⇒ merge blocked, and a shard that ran every test green in 5m57s hit the old 6`
    );
  }
});

test("extended-gate ceiling: the two timeout tiers cover exactly every test-extended dependency", () => {
  const needs = loadWorkflow().jobs?.["test-extended"]?.needs ?? [];
  assert.deepEqual(
    [...EXTENDED_GATE_JOBS].sort(),
    [...needs].sort(),
    "every test-extended dependency must appear in exactly one timeout tier — a ninth extended job without a ceiling must fail this guard"
  );
});

test("extended-gate ceiling: the three smaller extended-gate tiers keep timeout-minutes: 6", () => {
  const wf = loadWorkflow();
  for (const name of SMALL_TIER_JOBS) {
    const job = wf.jobs?.[name];
    assert.ok(job, `ci.yml must define the ${name} extended-gate job`);
    assert.equal(
      job!["timeout-minutes"],
      6,
      `${name} must carry timeout-minutes: 6 — these tiers run in seconds to ~2min; the shards' 10 is not a licence to relax theirs`
    );
  }
});

test("extended-gate ceiling: the fast `test` job and the `test-extended` aggregate do NOT carry a job timeout", () => {
  const wf = loadWorkflow();
  assert.equal(
    wf.jobs?.test?.["timeout-minutes"],
    undefined,
    "the fast `test` gate is a separate gate — it must not carry the extended gate's ceiling"
  );
  assert.equal(
    wf.jobs?.["test-extended"]?.["timeout-minutes"],
    undefined,
    "the test-extended aggregate only runs a ~3s step — timing it is pointless and could mask a dependency timeout"
  );
});

test("FG-495: the fast `test` job's run command is unaffected by the test-extended job (still runs npm run test:all only)", () => {
  const wf = loadWorkflow();
  const testJob = wf.jobs?.["test"];
  assert.ok(testJob, "ci.yml must still define the required `test` job");
  const runCommands = (testJob!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
  assert.ok(
    !runCommands.some((r) => r.includes("test:extended")),
    "the required test job must not itself run the slow extended tier — that would defeat FG-495's speed fix"
  );
});
