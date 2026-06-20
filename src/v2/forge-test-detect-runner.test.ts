// FG-178 regression guard: detect_runner() in docker/forge-test.sh must select
// the right test runner from fixture package.json files.  Each test shells out
// to bash, sources the real detect_runner() function from the script, and
// verifies the output — so the tested code path is the live one, not a copy.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const forgeTestScript = join(root, "docker", "forge-test.sh");

function runDetectRunner(fixtureDir: string): string {
  const result = spawnSync(
    "bash",
    [
      "-c",
      // Source only the detect_runner() function block, then call it from the
      // fixture directory.  Process substitution avoids set -euo pipefail and
      // the exec statements at the top of forge-test.sh.
      `source <(sed -n '/^detect_runner()/,/^}/p' "${forgeTestScript}") && cd "${fixtureDir}" && detect_runner`,
    ],
    { encoding: "utf8" }
  );
  return result.stdout.trim() || "node:test";
}

function withFixture(pkg: object | null, fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "forge-runner-test-"));
  try {
    if (pkg !== null) {
      writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("FG-178: devDependencies jest -> jest", () => {
  withFixture({ devDependencies: { jest: "^29.0.0" } }, (dir) => {
    assert.equal(runDetectRunner(dir), "jest");
  });
});

test("FG-178: devDependencies vitest -> vitest", () => {
  withFixture({ devDependencies: { vitest: "^1.0.0" } }, (dir) => {
    assert.equal(runDetectRunner(dir), "vitest");
  });
});

test("FG-178: scripts.test containing 'jest' -> jest (scripts pattern takes priority)", () => {
  withFixture({ scripts: { test: "jest --coverage" } }, (dir) => {
    assert.equal(runDetectRunner(dir), "jest");
  });
});

test("FG-178: scripts.test pattern beats devDependencies (jest script wins over vitest dep)", () => {
  withFixture(
    { scripts: { test: "jest --runInBand" }, devDependencies: { vitest: "^1.0.0" } },
    (dir) => {
      assert.equal(runDetectRunner(dir), "jest");
    }
  );
});

test("FG-178: plain node:test project (no jest/vitest in scripts or deps) -> node:test", () => {
  withFixture({ name: "my-app", version: "1.0.0" }, (dir) => {
    assert.equal(runDetectRunner(dir), "node:test");
  });
});

test("FG-178: missing package.json -> node:test", () => {
  withFixture(null, (dir) => {
    assert.equal(runDetectRunner(dir), "node:test");
  });
});
