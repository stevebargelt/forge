// FG-744 (fork C): the recheck's trusted tier execution must ACTUALLY run the higher-tier test
// and capture its real TAP — the whole point of fork C is that forge runs the tier itself, so
// this proves the constructed runner executes a real file and produces runner output the
// evidence machinery reads, rather than trusting a self-reported string.
//
// Tier: integration — it spawns a real `node --test` subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tierTestCommand } from "../cli/commands/review-wiring.js";
import { testExecution } from "./review-evidence.js";
import { ingestRecheck } from "./review-recheck.js";
import type { ReviewFinding } from "../store/reviews.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SHARED_BUILD_DIR = resolve(REPO_ROOT, ".forge-integration-build");

/** An opaque snapshot of the shard's shared build dir, so a test can prove its
 *  nested integration-tier run neither created, wiped, nor rebuilt it. */
function sharedBuildDirState(): string {
  if (!existsSync(SHARED_BUILD_DIR)) return "absent";
  const s = statSync(SHARED_BUILD_DIR);
  return `${s.mtimeMs}:${s.ino}`;
}
const REVIEW = "review-fg744-integration";
const CANDIDATE = "candidate-fg744";
const ASSERTION = "fg744 trusted tier probe executed";

const FINDING: ReviewFinding = {
  id: `${REVIEW}/RF-1`,
  reviewId: REVIEW,
  ordinal: 1,
  findingRef: "RF-1",
  summary: "a trusted tier must prove the cited assertion",
  reachability: "demonstrated",
  sources: [{ redRole: "red-backend" }],
  disposition: "fix_now",
  createdAt: "2026-08-21T00:00:00Z",
  updatedAt: "2026-08-21T00:00:00Z",
};

function runIntegrationTier(probe: string): string {
  const { cmd, args } = tierTestCommand("integration", [probe]);
  const env = { ...process.env };
  delete env["NODE_TEST_CONTEXT"];
  // Isolate the NESTED integration-tier run's build tree from the shard's shared
  // `.forge-integration-build`. Without this the nested preload rmSync-wipes +
  // rebuilds the single REPO_ROOT build dir concurrently with the sibling
  // subprocesses of this shard, yanking `<dir>/cli/index.js` out from under them
  // mid-spawn (FG-744 CI integration_7 hazard). The per-invocation build MUST stay
  // a SIBLING of src/ at REPO_ROOT depth so the mirror's fixed-depth runtime walks
  // (asset-root, git-root, seeds, docker) still land on the repo root by
  // construction — a tmpdir would break them. `.forge-integration-build.*` is
  // gitignored; the finally block removes this per-invocation dir.
  const buildDir = mkdtempSync(resolve(REPO_ROOT, ".forge-integration-build."));
  env["FORGE_INTEGRATION_BUILD_DIR"] = buildDir;
  try {
    return execFileSync(cmd, args, {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
  } catch (e) {
    const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  } finally {
    rmSync(buildDir, { recursive: true, force: true });
  }
}

function recheckFrom(output: string, probe: string) {
  // The coordinator binds `assertionFile` only when the file's isolated run actually contains the
  // cited assertion — mirror that here so the recheck sees a run bound to the assertion's own file.
  const contains = testExecution(output, ASSERTION) !== "absent";
  return ingestRecheck(
    {
      review_id: REVIEW,
      candidate_sha: CANDIDATE,
      rechecked: [{ finding_id: `${REVIEW}/RF-1`, result: "resolved", evidence_kind: "regression_test", evidence: {} }],
      new_findings: [],
    },
    {
      reviewId: REVIEW,
      candidateSha: CANDIDATE,
      expected: [FINDING],
      fixerAssertions: { [`${REVIEW}/RF-1`]: ASSERTION },
      trustedTierRuns: {
        [`${REVIEW}/RF-1`]: {
          tiers: ["integration"],
          testFiles: [probe],
          candidateSha: CANDIDATE,
          ...(contains ? { assertionFile: probe, runnerOutput: output } : {}),
        },
      },
    },
  );
}

test("FG-744: forge's integration-tier runner really executes a scoped cited assertion and its TAP reads as executed", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg744-probe-"));
  // The suffix is the production classifier's input: Stage 8 sees this as an integration
  // file and must select the integration runner, not the fast or worktree runner.
  const probe = join(dir, "trusted-tier-probe.integration.test.ts");
  // Only node built-ins — the file is spawned from REPO_ROOT so the tier's `./src/*` preloads
  // resolve, but the probe itself needs no project-relative import.
  writeFileSync(
    probe,
    [
      `import { test } from "node:test";`,
      `import assert from "node:assert/strict";`,
      `test("${ASSERTION}", () => { assert.equal(1 + 1, 2); });`,
      "",
    ].join("\n"),
  );

  const sharedBefore = sharedBuildDirState();
  try {
    const { args } = tierTestCommand("integration", [probe]);
    assert.ok(args.includes("./src/integration-build-preload.ts"), "the integration-tier preload is retained");
    const output = runIntegrationTier(probe);
    // The nested run isolates its tree via FORGE_INTEGRATION_BUILD_DIR, so it must
    // NOT have created, wiped, or rebuilt the shard's shared build dir — that wipe
    // was the CI integration_7 hazard this fix removes.
    assert.equal(sharedBuildDirState(), sharedBefore, "nested run must not touch the shared .forge-integration-build");
    // The exact per-test identity the recheck binds resolution through — proven EXECUTED in
    // forge's own runner output, not merely "the suite exited green".
    assert.equal(testExecution(output, ASSERTION), "executed");
    const result = recheckFrom(output, probe);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.applications[0]?.resolution, "resolved");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("FG-744: real integration-tier skipped, failed, and absent assertions never become resolved", () => {
  const dir = mkdtempSync(join(tmpdir(), "fg744-negative-probe-"));
  const cases = [
    { name: "skipped", source: `test("${ASSERTION}", { skip: "unavailable" }, () => {});`, expected: "inconclusive" },
    { name: "failed", source: `test("${ASSERTION}", () => { assert.fail("still broken"); });`, expected: "still_present" },
    { name: "absent", source: `test("a different assertion", () => { assert.equal(true, true); });`, expected: "inconclusive" },
  ] as const;

  try {
    for (const scenario of cases) {
      const probe = join(dir, `${scenario.name}.integration.test.ts`);
      writeFileSync(probe, [`import { test } from "node:test";`, `import assert from "node:assert/strict";`, scenario.source, ""].join("\n"));
      const result = recheckFrom(runIntegrationTier(probe), probe);
      assert.equal(result.ok, true, scenario.name);
      if (!result.ok) continue;
      assert.equal(result.applications[0]?.resolution, scenario.expected, scenario.name);
      assert.notEqual(result.applications[0]?.resolution, "resolved", scenario.name);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
