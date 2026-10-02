// FG-858 regression guards for image-level harnesses. Docker cannot run in the
// unit tier, so parse executable (comment-stripped, continuation-folded) scripts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const launchHarness = readFileSync(join(root, "docker", "verify-launch-tier-in-image.sh"), "utf8");
const nativeHarness = readFileSync(join(root, "docker", "verify-native-prebuild-in-image.sh"), "utf8");
const integrationRunner = readFileSync(join(root, "scripts", "run-integration-tests.sh"), "utf8");

function executableLines(source: string): string[] {
  return source
    .split(/\r?\n/)
    .filter((line) => !/^\s*#/.test(line))
    .join("\n")
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function bulkLaneArgv(source: string): string {
  const line = executableLines(source).find((candidate) =>
    /^node\s+.*\s--test\s+"\$\{BULK_FILES\[@\]\}"$/.test(candidate)
  );
  assert.ok(line, "scripts/run-integration-tests.sh must retain a bare bulk-lane node --test invocation");
  return line.replace(/^node\s+/, "").replace(/\s+--test\s+"\$\{BULK_FILES\[@\]\}"$/, "");
}

test("FG-858: launch image invocation derives its preloads from the canonical bulk lane and checks build-dir writability first", () => {
  const expectedArgv = bulkLaneArgv(integrationRunner);
  const lines = executableLines(launchHarness);
  const invocation = lines.find((line) =>
    /\bnode\s+.*\s--test\s+--test-reporter=tap\s+"\$\{TESTS\[@\]\}"\s+\|/.test(line)
  );
  assert.ok(invocation, "the launch harness must run its test files through node's TAP reporter");

  const actualArgv = invocation
    .replace(/^.*?\bnode\s+/, "")
    .replace(/\s+--test\s+--test-reporter=tap\s+"\$\{TESTS\[@\]\}"\s+\|.*$/, "");
  assert.equal(
    actualArgv,
    expectedArgv,
    "the launch harness must use the canonical bulk lane's preload argv in the same order; only its reporter and file list may differ"
  );

  const writableCheck = lines.findIndex((line) =>
    /docker exec -u agent -w "\$DEST" "\$cid" sh -c 'mkdir -p \.forge-integration-build && test -w \.forge-integration-build'/.test(line)
  );
  assert.ok(writableCheck >= 0, "the agent user's .forge-integration-build writability must be checked before the preload runs");
  assert.ok(writableCheck < lines.indexOf(invocation), "the build-dir writability check must precede the node invocation");
});

test("FG-858: both image harness copies suppress AppleDouble files", () => {
  for (const [name, source] of [
    ["launch tier", launchHarness],
    ["native prebuild", nativeHarness],
  ] as const) {
    const copy = executableLines(source).find((line) =>
      /\bCOPYFILE_DISABLE=1\s+tar\s+-cf\s+-\s+-C\s+"\$REPO_ROOT"/.test(line)
    );
    assert.ok(copy, `${name} harness must run its repository tar with COPYFILE_DISABLE=1`);
    assert.match(copy, /--exclude='\._\*'/, `${name} harness must exclude macOS AppleDouble files (._*) from the copied tree`);
    assert.match(copy, /--exclude='\.DS_Store'/, `${name} harness must exclude .DS_Store from the copied tree`);
  }
});

test("FG-858: TAP-log parsing treats logs as binary-safe in both image harnesses", () => {
  for (const [name, source] of [
    ["launch tier", launchHarness],
    ["native prebuild", nativeHarness],
  ] as const) {
    const tapGreps = executableLines(source).filter((line) => /\bgrep\b/.test(line) && /"\$(?:tap_log|TAP_LOG)"/.test(line));
    assert.ok(tapGreps.length > 0, `${name} harness must parse its TAP log`);
    for (const grep of tapGreps) {
      assert.match(grep, /\bgrep\s+-a(?:\S*)?\b/, `${name} harness TAP-log grep must pass -a: ${grep}`);
    }
  }
});
