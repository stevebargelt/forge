// FG-744 (fork C): the trusted tier runner the recheck executes must be the SAME `node --test`
// invocation the tier itself uses — pinned against the live tier definitions so it cannot drift.
// If it drifted, forge's "trusted local execution" would run the assertion under a different
// runner than the tier's own, and a green here would not mean green in CI.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tierTestCommand } from "../cli/commands/review-wiring.js";

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
