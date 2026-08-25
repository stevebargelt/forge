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

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  "timeout-minutes"?: number;
};
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

// FG-495 regression guard (updated: sharded extended gate; FG-624: duration-
// aware; FG-704: 8 bulk shards + a dedicated serial lane; FG-762: browser tier
// required again): the slow
// integration/worktree coverage moved out of the fast `test` gate must still run
// somewhere routine and visible. It now runs as THIRTEEN concurrent jobs — eight
// root integration BULK shards (`integration_1`..`integration_8`, partitioned by
// BATCHED-execution cost via scripts/run-integration-tests.sh over
// discovered−fg576), the `integration_serial` lane (FG-681/FG-704: fg576 alone
// under --test-concurrency=1), a `worktree` job, a `dashboard_integration` job,
// (FG-693) an `fg693_alias_identity` job — with the required `test-extended` job
// reduced to a fail-closed aggregate over all thirteen. FG-762 restores
// `dashboard_browser` as a required dependency because FG-759 proved this real-
// browser tier catches regressions the other tiers miss. Its preflight, cache, and
// bounded-retry protections remain independent runner-infrastructure fixes. If a
// future edit drops a shard or the browser tier, mistargets a shard selector,
// or lets the aggregate go green on a failed dependency, the trust-sensitive
// coverage (FG-419/FG-440/FG-474 gate-enforcement tests, among others) would
// stop gating merges without anyone deciding that on purpose.

const INTEGRATION_SHARD_JOBS = [
  "integration_1",
  "integration_2",
  "integration_3",
  "integration_4",
  "integration_5",
  "integration_6",
  "integration_7",
  "integration_8",
] as const;
// FG-681/FG-704: the dedicated serial lane. fg576's AC9 correlation suite runs
// ALONE under --test-concurrency=1, in its own job, taking no k/N selector — it
// is excluded from the eight bulk shards so its real 30s production window never
// shares a job. It sits in the TEN-minute tier alongside the bulk shards (the
// ceiling is the hang backstop, deliberately not lowered — FG-704 non-goal).
const SERIAL_JOB = "integration_serial" as const;
const SMALL_TIER_JOBS = ["worktree", "dashboard_integration"] as const;
// FG-739: the dashboard browser tier carries its OWN ceiling, not the small-tier
// 6. Its wall-clock is dominated by provisioning chromium off Playwright's
// Chrome-for-Testing CDN, which intermittently hangs (~6-7m observed) — the old 6
// cancelled the job, turning the fail-closed aggregate red with the browser tests
// themselves passing 109/109. The install is now cached across runs, and bounded +
// retried rather than left to the job ceiling; the raised ceiling costs no
// wall-clock on a healthy run (cache hit ⇒ near-instant) and only bounds a job that
// is genuinely hung across every retry.
const BROWSER_JOB = "dashboard_browser" as const;
const BROWSER_JOB_TIMEOUT = 20;
// FG-693: the synthetic symlink-alias job. It re-runs the whole FG-693 identity
// suite with TMPDIR pointed at a symlink, so this Linux CI executes the
// filesystem-alias class instead of being green on it by accident of platform —
// the asymmetry that let FG-575, FG-576 and FG-253 each ship green and each
// leave the invariant open. It sits in the TEN-minute tier rather than the eight:
// the suite carries its own AC8 falsification harness, which copies the tree and
// spawns a nested test run per migrated consumer, so its cost is a multiple of
// the suite's own and it has the same headroom problem the shards documented.
const ALIAS_IDENTITY_JOB = "fg693_alias_identity" as const;
const TEN_MINUTE_JOBS = [...INTEGRATION_SHARD_JOBS, SERIAL_JOB, ALIAS_IDENTITY_JOB] as const;
const EXTENDED_GATE_JOBS = [...TEN_MINUTE_JOBS, ...SMALL_TIER_JOBS] as const;

test("FG-495 (sharded, FG-704 8-way): ci.yml has eight integration BULK shard jobs each running the shard script with its own k/8 selector", () => {
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
    ["1/8", "2/8", "3/8", "4/8", "5/8", "6/8", "7/8", "8/8"],
    "the eight bulk shard jobs must cover exactly 1/8..8/8 — each appearing exactly once. The selectors are what make the partition a cover: src/test-shards.ts plans N shards and each job takes one, so a duplicated or missing k means files run twice or not at all"
  );
});

test("FG-681/FG-704: ci.yml has a dedicated serial lane job that runs fg576 alone via the shell's `serial` mode, with NO k/N selector", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.[SERIAL_JOB];
  assert.ok(job, `ci.yml must define the ${SERIAL_JOB} dedicated serial-lane job — fg576's AC9 window must run alone, not merely in a smaller bucket`);
  const runCommands = (job!.steps ?? []).map((s) => s.run).filter((r): r is string => typeof r === "string");
  const serialRun = runCommands.find((r) => r.includes("run-integration-tests.sh"));
  assert.ok(serialRun, `${SERIAL_JOB} must run scripts/run-integration-tests.sh`);
  // The `serial` mode (no k/N) is what run-integration-tests.sh binds to fg576
  // alone under --test-concurrency=1; the shell-level contract (only fg576, and
  // node's serial concurrency) is proven in src/test-shards.integration.test.ts.
  assert.match(
    serialRun!,
    /run-integration-tests\.sh\s+serial(\s|$)/,
    `${SERIAL_JOB} must invoke the dedicated 'serial' mode — the lane that runs fg576 alone under --test-concurrency=1`
  );
  assert.doesNotMatch(
    serialRun!,
    /run-integration-tests\.sh\s+[0-9]+\/[0-9]+/,
    `${SERIAL_JOB} must NOT pass a k/N shard selector — the serial lane takes no selector; passing one would route it through the bin-packer instead of the alone-under-concurrency-1 lane`
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

test("FG-760 infra retained by FG-762: the required browser job preflights a real Chromium launch with the shared no-sandbox contract", () => {
  const steps = loadWorkflow().jobs?.[BROWSER_JOB]?.steps ?? [];
  const preflight = steps.find((step) => step.name === "Preflight — chromium must actually launch");
  assert.ok(preflight, "dashboard_browser must fail fast before the browser suite when Chromium cannot launch");
  assert.equal(preflight["timeout-minutes"], 2, "the Chromium launch preflight needs its own bounded timeout");
  const script = preflight.run ?? "";
  assert.match(script, /chromium\.launch\(/, "the preflight must actually launch Chromium, not merely locate its binary");
  assert.match(script, /args:\s*\["--no-sandbox"\]/, "the preflight must use the same required --no-sandbox flag as browser tests");
  assert.match(script, /page\.goto\("about:blank"\)/, "a successful preflight must prove the launched browser can create and navigate a page");
  assert.match(script, /LAUNCH\/runner-env INFRA failure/, "a failed preflight must identify the failure as retriable runner infrastructure");
});

test("FG-762: test-extended requires the twelve non-browser tiers AND dashboard_browser (the real-browser gate is required again, not advisory)", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.["test-extended"];
  assert.ok(job, "ci.yml must define the test-extended aggregate job (the required branch-protection context)");

  const needs = job!.needs ?? [];
  assert.deepEqual(
    [...needs].sort(),
    [...EXTENDED_GATE_JOBS, BROWSER_JOB].sort(),
    "test-extended must `needs` exactly the twelve sharded/tiered non-browser jobs plus dashboard_browser — any tier added to ci.yml but left out of `needs` runs without gating anything"
  );
  assert.equal(needs.length, 13, "the required extended aggregate has twelve non-browser tiers plus the required dashboard_browser gate");
  assert.ok(wf.jobs?.[BROWSER_JOB], "dashboard_browser must remain a visible required CI check");
  assert.ok(
    needs.includes(BROWSER_JOB),
    "FG-762: dashboard_browser must remain in test-extended needs; dropping it re-downgrades the only real-browser gate"
  );

  assert.equal(
    job!.if,
    "always()",
    "test-extended must use `if: always()` so it still evaluates (fail-closed) when a dependency failed rather than being skipped"
  );

  // FG-704: the gate is DERIVED from `${{ toJSON(needs) }}` handed to the step
  // via env, not a hand-maintained `needs.X.result` string. That is what makes
  // "a job in `needs` cannot be omitted from the gating loop" structurally true
  // rather than a discipline — the loop iterates the whole needs context. So the
  // per-dependency `needs.X.result` enumeration is replaced by proving the
  // derivation shape, and the `needs` deepEqual above is what pins the set to 13.
  const steps = job!.steps ?? [];
  const envValues = steps.flatMap((s) => Object.values(s.env ?? {}));
  assert.ok(
    envValues.some((v) => typeof v === "string" && /toJSON\(\s*needs\s*\)/.test(v)),
    "the aggregate must derive from `${{ toJSON(needs) }}` (handed in via env) so every job in `needs` is automatically gated — the forgotten-job hazard the architect called out"
  );

  const aggregateBody = steps
    .map((s) => s.run)
    .filter((r): r is string => typeof r === "string")
    .join("\n");
  assert.ok(
    /toJSON\(\s*needs\s*\)/.test(aggregateBody) || /NEEDS_JSON/.test(aggregateBody),
    "the aggregate step body must consume the toJSON(needs) blob (e.g. via $NEEDS_JSON)"
  );
  assert.ok(
    /!==?\s*["']?success["']?/.test(aggregateBody) && /exit\s+1/.test(aggregateBody),
    "aggregate step must exit non-zero when any dependency result is not 'success' — fail-closed (operator proof #5/#6): a failed/cancelled/skipped dep cannot yield green"
  );
  assert.ok(
    /Object\.entries\(needs\)\.filter\(\s*\(\s*\[\s*,\s*v\s*\]\s*\)\s*=>\s*v\.result\s*!==\s*["']success["']\s*\)/.test(aggregateBody),
    "the aggregate must filter Object.entries(needs) for every non-success result, so no required dependency can be omitted from the fail-closed decision"
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

// Extended-gate wall-clock ceiling: every one of the thirteen concurrent
// extended-gate jobs carries a `timeout-minutes` ceiling, so a suite that runs
// long is cancelled → its result is not `success` → the fail-closed aggregate
// goes red → merge is blocked. Because the thirteen run concurrently, bounding
// each bounds the whole extended gate.
//
// The eight integration bulk shards, the FG-681/FG-704 serial lane, and the
// FG-693 alias job get 10 minutes; the three smaller tiers keep 6.
// The tier grew into the old shared 6: at cfbebcc5 `integration_1` finished the
// whole shard green in 5m57s and was killed at the ceiling anyway, turning the
// required check red with nothing failing. See the evidence recorded above the
// shard jobs in ci.yml.
test("extended-gate ceiling: each of the ten-minute jobs (eight bulk shards + the serial lane + the FG-693 alias job) has timeout-minutes: 10", () => {
  const wf = loadWorkflow();
  for (const name of TEN_MINUTE_JOBS) {
    const job = wf.jobs?.[name];
    assert.ok(job, `ci.yml must define the ${name} extended-gate job`);
    assert.equal(
      job!["timeout-minutes"],
      10,
      `${name} must carry timeout-minutes: 10 — over-ceiling ⇒ job cancelled ⇒ aggregate fails ⇒ merge blocked, and a shard that ran every test green in 5m57s hit the old 6`
    );
  }
});

test("extended-gate ceiling: the timeout tiers cover exactly every test-extended dependency", () => {
  const needs = loadWorkflow().jobs?.["test-extended"]?.needs ?? [];
  assert.deepEqual(
    [...EXTENDED_GATE_JOBS, BROWSER_JOB].sort(),
    [...needs].sort(),
    "every test-extended dependency must appear in exactly one timeout tier, including dashboard_browser's own 20-minute tier — an extended job without a ceiling must fail this guard"
  );
});

test("extended-gate ceiling: the two smaller extended-gate tiers keep timeout-minutes: 6", () => {
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

// FG-739: the browser tier is exempt from the small-tier 6 — its wall-clock is
// dominated by the (cached, bounded, retried) chromium provisioning off a CDN that
// intermittently hangs, and the old 6 cancelled the job with the browser tests
// themselves green. Its raised ceiling only bounds a job hung across every retry.
test("extended-gate ceiling: the dashboard_browser tier carries its own raised ceiling", () => {
  const wf = loadWorkflow();
  const job = wf.jobs?.[BROWSER_JOB];
  assert.ok(job, `ci.yml must define the ${BROWSER_JOB} extended-gate job`);
  assert.equal(
    job!["timeout-minutes"],
    BROWSER_JOB_TIMEOUT,
    `${BROWSER_JOB} must carry timeout-minutes: ${BROWSER_JOB_TIMEOUT} — the old small-tier 6 cancelled the job while chromium's Chrome-for-Testing CDN download hung (~6-7m), turning the fail-closed aggregate red with the browser tests passing 109/109 (FG-739)`
  );
});

test("FG-739: dashboard_browser caches Playwright browsers using the resolved playwright-core version", () => {
  const wf = loadWorkflow();
  const steps = wf.jobs?.[BROWSER_JOB]?.steps ?? [];
  const resolveVersion = steps.find((step) => step.name === "Resolve Playwright version");
  assert.ok(resolveVersion, "dashboard_browser must resolve the installed Playwright version before caching browsers");
  assert.equal(resolveVersion.id, "pw", "the Playwright version step must expose its output as steps.pw");
  assert.match(
    resolveVersion.run ?? "",
    /echo\s+["']version=.*>>\s*["']?\$GITHUB_OUTPUT/,
    "the Playwright version step must write a version output to $GITHUB_OUTPUT"
  );

  const browserCache = steps.find((step) => step.name === "Cache Playwright browsers");
  assert.ok(browserCache, "dashboard_browser must cache Playwright's downloaded browser binaries");
  assert.match(browserCache.uses ?? "", /^actions\/cache@/, "the browser cache step must use actions/cache");
  assert.equal(browserCache.with?.path, "~/.cache/ms-playwright", "the cache must cover Playwright's browser directory");
  assert.equal(
    browserCache.with?.key,
    "${{ runner.os }}-playwright-${{ steps.pw.outputs.version }}",
    "the cache key must vary by runner OS and the version resolved by steps.pw"
  );
  assert.equal(
    browserCache.with?.["restore-keys"],
    "${{ runner.os }}-playwright-\n",
    "a Playwright-version cache miss must restore the latest same-OS browser cache before installing Chromium"
  );
});

test("FG-739: dashboard_browser installs chromium through a bounded retry loop", () => {
  const wf = loadWorkflow();
  const install = wf.jobs?.[BROWSER_JOB]?.steps?.find((step) => step.name === "Install chromium");
  assert.ok(install, "dashboard_browser must retain its Install chromium step");
  const script = install.run ?? "";
  assert.match(
    script,
    /for\s+attempt\s+in\s+(?:\d+\s+)+\d+\s*;\s*do/,
    "chromium installation must loop over at least two attempts rather than make a one-shot install"
  );
  assert.match(
    script,
    /timeout\s+-k\s+\S+\s+\S+\s+npx\s+playwright-core\s+install\b/,
    "each chromium install attempt must be capped by `timeout` with a kill-after (-k) bound — a bare `timeout <cap>` only SIGTERMs, so a SIGTERM-ignoring installer overruns unboundedly (FG-739 RF-1)"
  );
  assert.match(script, /sleep\s+/, "failed chromium install attempts must back off before retrying");
});

test("FG-739: exhausted chromium installs fail loudly as infrastructure failures within a step timeout", () => {
  const wf = loadWorkflow();
  const install = wf.jobs?.[BROWSER_JOB]?.steps?.find((step) => step.name === "Install chromium");
  assert.ok(install, "dashboard_browser must retain its Install chromium step");
  assert.ok(
    typeof install["timeout-minutes"] === "number" && install["timeout-minutes"] > 0,
    "Install chromium must have its own positive timeout-minutes, independent of the job ceiling"
  );
  assert.match(
    install.run ?? "",
    /::error::[\s\S]*(?:install|infra)|(?:install|infra)[\s\S]*::error::/i,
    "retry exhaustion must emit a ::error:: identifying chromium installation or infrastructure failure"
  );
  assert.match(install.run ?? "", /exit\s+1\b/, "retry exhaustion must exit non-zero rather than let browser tests mask it");
});

// FG-739 RF-1: the loud exit 1 must ALWAYS win before the step (and job) timeout.
// A bare `timeout 5m` only SIGTERMs; an installer that ignores SIGTERM overruns
// unboundedly, so the enclosing step/job timeout can cancel the step as a bare
// cancellation — reading as a test failure — before the ::error:: + exit 1 fires.
// Each attempt must carry a `-k` kill-after bound, and the deterministic worst-case
// wall-clock of the whole retry loop must sit strictly (with margin) under the step
// timeout. This assertion computes that budget from the script itself.
test("FG-739 RF-1: chromium retry loop is hard-bounded below its step timeout so the loud failure always wins", () => {
  const wf = loadWorkflow();
  const install = wf.jobs?.[BROWSER_JOB]?.steps?.find((step) => step.name === "Install chromium");
  assert.ok(install, "dashboard_browser must retain its Install chromium step");
  const script = install.run ?? "";
  const stepTimeoutS = (install["timeout-minutes"] ?? 0) * 60;
  assert.ok(stepTimeoutS > 0, "Install chromium must carry a positive step timeout-minutes");

  const dur = (tok: string): number => {
    const m = tok.match(/^(\d+)(s|m)?$/);
    assert.ok(m && m[1], `unparseable duration token: ${tok}`);
    return Number(m[1]) * (m[2] === "m" ? 60 : 1);
  };

  // -k <grace> <cap>: hard-kill grace + per-attempt cap.
  const cap = script.match(/timeout\s+-k\s+(\S+)\s+(\S+)\s+npx\s+playwright-core\s+install\b/);
  assert.ok(cap && cap[1] && cap[2], "each attempt must run under `timeout -k <grace> <cap>` so SIGTERM-ignoring installs are hard-killed");
  const perAttemptS = dur(cap[1]) + dur(cap[2]);

  const attemptTokens = script.match(/for\s+attempt\s+in\s+((?:\d+\s+)*\d+)\s*;/);
  assert.ok(attemptTokens && attemptTokens[1], "the loop must iterate a literal list of attempt numbers");
  const attempts = attemptTokens[1].trim().split(/\s+/).length;
  assert.ok(attempts >= 2, "must retry at least twice");

  // Worst-case backoff: `sleep $((attempt * <base>))`. Conservatively assume the
  // backoff runs after every attempt (it is guarded to skip the last, so this is an
  // upper bound); sum attempt*base for attempt in 1..attempts.
  const base = Number((script.match(/sleep\s+\$\(\(\s*attempt\s*\*\s*(\d+)/) ?? [])[1] ?? 0);
  assert.ok(base > 0, "backoff must scale with the attempt number");
  let backoffS = 0;
  for (let a = 1; a <= attempts; a++) backoffS += a * base;

  const worstCaseS = attempts * perAttemptS + backoffS;
  assert.ok(
    worstCaseS < stepTimeoutS,
    `worst-case retry-loop wall-clock (${worstCaseS}s) must stay under the step timeout (${stepTimeoutS}s) so the loud exit 1 always fires before a bare step cancellation (FG-739 RF-1)`
  );
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
