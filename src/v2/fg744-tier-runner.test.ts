// FG-744 (fork C): the trusted tier runner the recheck executes must be the SAME `node --test`
// invocation the tier itself uses — pinned against the live tier definitions so it cannot drift.
// If it drifted, forge's "trusted local execution" would run the assertion under a different
// runner than the tier's own, and a green here would not mean green in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeAcceptanceTests, tierTestCommand } from "../cli/commands/review-wiring.js";
import { assessAcceptanceClaims } from "./review-evidence.js";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const FILE = "src/v2/example.integration.test.ts";

test("FG-744: the integration tier runner matches run-integration-tests.sh's bulk runner, plus the scoped file", () => {
  const sh = readFileSync(join(REPO_ROOT, "scripts", "run-integration-tests.sh"), "utf8");
  const bulkRunner = sh.match(
    /^\s*(node --import tsx --import \.\/src\/integration-build-preload\.ts --import \.\/src\/test-setup\.ts --test) "\$\{BULK_FILES\[@\]\}"$/m,
  )?.[1];
  assert.ok(bulkRunner, "run-integration-tests.sh must retain its explicit bulk runner");

  const { cmd, args } = tierTestCommand("integration", [FILE]);
  assert.equal(`${cmd} ${args.join(" ")}`, `${bulkRunner} ${FILE}`);
  // Dropping the DB preload would point the suite at the real ~/.forge/forge.db.
  assert.ok(args.includes("./src/test-setup.ts"));
  assert.ok(args.includes("./src/integration-build-preload.ts"));
});

test("FG-744: the worktree tier runner matches the test:worktree script, plus the scoped file", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  const worktreeRunner = pkg.scripts["test:worktree"]?.split("$(find")[0]?.trim();
  assert.ok(worktreeRunner, "package.json must define test:worktree");

  const { cmd, args } = tierTestCommand("worktree", [FILE]);
  assert.equal(`${cmd} ${args.join(" ")}`, `${worktreeRunner} ${FILE}`);
  // The worktree tier does NOT carry the integration build preload.
  assert.ok(!args.includes("./src/integration-build-preload.ts"));
});

test("FG-813: the unit lane runner matches the test:unit script, plus the scoped file", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  const unitRunner = pkg.scripts["test:unit"]?.split("$(find")[0]?.trim();
  assert.ok(unitRunner, "package.json must define test:unit");
  const { cmd, args, cwd } = tierTestCommand("unit", ["src/v2/x.test.ts"]);
  assert.equal(`${cmd} ${args.join(" ")}`, `${unitRunner} src/v2/x.test.ts`);
  assert.equal(cwd, ".");
});

test("FG-788 AC1: the dashboard lanes run the dashboard workspace's own `tsx --test` runner from cwd=dashboard, file relative to it", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "dashboard", "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  // `tsx --test` IS node with the tsx loader; the lane spells it that way so it needs no bin shim.
  for (const [script, lane, file] of [
    ["test", "dashboard_unit", "dashboard/src/remote/sync.test.ts"],
    ["test:integration", "dashboard_integration", "dashboard/src/x.integration.test.ts"],
    ["test:browser", "dashboard_browser", "dashboard/browser-tests/fg781-remote-board.test.ts"],
  ] as const) {
    assert.match(pkg.scripts[script] ?? "", /^tsx --test /, `dashboard ${script} must still be a tsx --test runner`);
    const { cmd, args, cwd } = tierTestCommand(lane, [file]);
    assert.equal(cwd, "dashboard");
    assert.deepEqual([cmd, ...args], ["node", "--import", "tsx", "--test", file.replace(/^dashboard\//, "")]);
  }
});

test("FG-813 / FG-788: Stage 9 re-binds a met regression-test claim to forge's own run of its file, in that file's lane", () => {
  const title = "defaults to the review activity; fast-orchestrator stays mapped";
  const ran: string[] = [];
  const claims = executeAcceptanceTests(
    [
      // Claimed output is stale/empty; forge's own dashboard-lane run is what binds.
      { ref: "AC-1", verdict: "met", evidence: { kind: "regression_test", test_name: title, test_file: "dashboard/src/a.test.ts", runner_output: "" } },
      // Forge's run shows it RED — the claim does not survive on its own say-so.
      { ref: "AC-2", verdict: "met", evidence: { kind: "regression_test", test_name: "b", test_file: "src/b.integration.test.ts", runner_output: "ok 1 - b" } },
      // A lane that could not run leaves the claim exactly as supplied.
      { ref: "AC-3", verdict: "met", evidence: { kind: "regression_test", test_name: "c", test_file: "dashboard/browser-tests/c.test.ts", runner_output: "ok 1 - c" } },
      { ref: "AC-4", verdict: "unmet" },
    ],
    (lane, file) => {
      ran.push(`${lane}:${file}`);
      if (lane === "dashboard_unit") return { runnerOutput: `✔ ${title} (1ms)` };
      if (lane === "integration") return { runnerOutput: "not ok 1 - b" };
      return { notExecuted: "chrome precondition" };
    },
  );
  assert.deepEqual(ran, [
    "dashboard_unit:dashboard/src/a.test.ts",
    "integration:src/b.integration.test.ts",
    "dashboard_browser:dashboard/browser-tests/c.test.ts",
  ]);
  const verdicts = assessAcceptanceClaims(claims, "cand1").map((a) => a.verdict);
  assert.deepEqual(verdicts, ["met", "unproven", "met", "unmet"]);
});
