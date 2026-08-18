// End-to-end contracts for FG-704's shell runner operator surfaces. These use
// a temporary node executable so the real shell selection/capture/summary path
// runs quickly while node:test output and elapsed time stay deterministic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function runnerFixture(options: { date?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fg704-runner-"));
  const node = join(dir, "node");
  writeFileSync(
    node,
    `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (!args.includes("--test")) {
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const mode = process.env.FG704_TAP_MODE || "pass";
if (mode === "assertion") {
  console.log("ℹ pass 0");
  console.log("ℹ fail 1");
  process.exit(1);
}
if (mode === "truncated") {
  console.log("TAP version 13");
  console.log("# test process stopped before a summary");
  process.exit(137);
}
console.log("ℹ pass 3");
console.log("ℹ fail 0");
`,
  );
  chmodSync(node, 0o755);

  if (options.date) {
    const date = join(dir, "date");
    writeFileSync(
      date,
      `#!${process.execPath}
const { existsSync, writeFileSync } = require("node:fs");
const marker = process.env.FG704_DATE_MARKER;
const first = !existsSync(marker);
writeFileSync(marker, "used");
console.log(first ? "1000" : "241002");
`,
    );
    chmodSync(date, 0o755);
  }

  const run = (
    arg: string,
    summary: string,
    extra: Record<string, string> = {},
  ) =>
    spawnSync("bash", ["scripts/run-integration-tests.sh", arg], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH ?? ""}`,
        GITHUB_STEP_SUMMARY: summary,
        ...extra,
      },
    });
  return { dir, run };
}

function output(result: ReturnType<typeof spawnSync>): string {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

test("FG-704: bulk and serial jobs publish machine-readable and Checks summaries", () => {
  const fixture = runnerFixture();
  try {
    for (const [arg, label] of [
      ["1/6", "bulk 1/6"],
      ["serial", "serial"],
    ] as const) {
      const summary = join(fixture.dir, `${arg.replace("/", "-")}.md`);
      const result = fixture.run(arg, summary);
      assert.equal(result.status, 0, output(result));
      assert.match(
        output(result),
        new RegExp(`FORGE_INTEGRATION_JOB_SUMMARY label=${label}`),
      );
      for (const field of [
        "selected_files=",
        "projected_weight_ms=",
        "actual_duration_ms=",
        "manifest_coverage_pct=",
        "projected_vs_actual_skew_pct=",
      ]) {
        assert.match(
          output(result),
          new RegExp(field),
          `${label} summary omitted ${field}`,
        );
      }
      const table = readFileSync(summary, "utf8");
      for (const metric of [
        "selected files",
        "projected weight (manifest)",
        "actual test duration",
        "timing-manifest coverage",
        "projected-vs-actual skew",
      ]) {
        assert.ok(
          table.includes(`| ${metric} |`),
          `${label} Checks table omitted ${metric}`,
        );
      }
    }
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("FG-704: assertion failures and truncated node:test output have distinct job statuses", () => {
  const fixture = runnerFixture();
  try {
    const assertion = fixture.run("serial", join(fixture.dir, "assertion.md"), {
      FG704_TAP_MODE: "assertion",
    });
    assert.equal(assertion.status, 1, output(assertion));
    assert.match(
      output(assertion),
      /node_test_fail=1 status=assertion_failure exit=1/,
    );
    assert.doesNotMatch(output(assertion), /likely_cancelled/);

    const truncated = fixture.run("serial", join(fixture.dir, "truncated.md"), {
      FG704_TAP_MODE: "truncated",
    });
    assert.equal(truncated.status, 137, output(truncated));
    assert.match(
      output(truncated),
      /node_test_fail=NA status=no_node_test_summary_likely_cancelled exit=137/,
    );
    assert.doesNotMatch(output(truncated), /status=assertion_failure/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test("FG-704: an actionable four-minute warning appears before the ten-minute ceiling", () => {
  const fixture = runnerFixture({ date: true });
  try {
    const marker = join(fixture.dir, "date-called");
    const result = fixture.run("serial", join(fixture.dir, "warning.md"), {
      FG704_DATE_MARKER: marker,
    });
    assert.equal(result.status, 0, output(result));
    assert.match(
      output(result),
      /::warning title=Integration job serial crossed 4 minutes::/,
    );
    assert.match(output(result), /approaching the 10-minute kill ceiling/);
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true });
  }
});
