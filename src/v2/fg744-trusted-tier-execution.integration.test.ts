// FG-744 (fork C): the recheck's trusted tier execution must ACTUALLY run the higher-tier test
// and capture its real TAP — the whole point of fork C is that forge runs the tier itself, so
// this proves the constructed runner executes a real file and produces runner output the
// evidence machinery reads, rather than trusting a self-reported string.
//
// Tier: integration — it spawns a real `node --test` subprocess.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tierTestCommand } from "../cli/commands/review-wiring.js";
import { testExecution } from "./review-evidence.js";
import { ingestRecheck } from "./review-recheck.js";
import type { ReviewFinding } from "../store/reviews.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
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

  try {
    const { args } = tierTestCommand("integration", [probe]);
    assert.ok(args.includes("./src/integration-build-preload.ts"), "the integration-tier preload is retained");
    const output = runIntegrationTier(probe);
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
