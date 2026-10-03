// FG-826: the real-boot inventory is one list in two places (this workspace's helper and the
// container-aware forge-test wrapper). Both must name exactly the suites that actually spawn a
// real dashboard process, and every one of those suites must go through the shared harness.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { REAL_BOOT_SUITES } from "./real-boot.js";

const dashboardRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function integrationSuites(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return integrationSuites(path);
    return entry.name.endsWith(".integration.test.ts") ? [relative(dashboardRoot, path)] : [];
  });
}

const spawnsServerEntry = (source: string) => /["']src\/server\.ts["']/.test(source);

test("FG-826: REAL_BOOT_SUITES names exactly the integration suites that boot src/server.ts", () => {
  const actual = integrationSuites(join(dashboardRoot, "src"))
    .filter((file) => spawnsServerEntry(readFileSync(join(dashboardRoot, file), "utf8")))
    .sort();
  assert.deepEqual(actual, [...REAL_BOOT_SUITES].sort());
});

test("FG-826: forge-test's container refusal lists the same real-boot suites", () => {
  const wrapper = readFileSync(join(dashboardRoot, "..", "docker", "forge-test.sh"), "utf8");
  const block = wrapper.match(/^DASHBOARD_REAL_BOOT_SUITES=\(\n([\s\S]*?)\n\)/m)?.[1];
  assert.ok(block, "docker/forge-test.sh must declare DASHBOARD_REAL_BOOT_SUITES");
  const listed = block.split("\n").map((line) => line.trim()).filter(Boolean).sort();
  assert.deepEqual(listed, REAL_BOOT_SUITES.map((suite) => `dashboard/${suite}`).sort());
});

test("FG-826: every real-boot suite probes, bounds, and reaps through the shared harness", () => {
  for (const suite of REAL_BOOT_SUITES) {
    const source = readFileSync(join(dashboardRoot, suite), "utf8");
    assert.match(source, /probeRealBootPreconditions\(/, `${suite}: no precondition probe before the boot`);
    assert.match(source, /awaitBootOrFail\(/, `${suite}: no bounded startup wait`);
    assert.match(source, /spawnRealBoot\(/, `${suite}: boots outside spawnRealBoot (no process group, no cleanup registration)`);
    assert.doesNotMatch(source, /\bspawn\(/, `${suite}: a raw spawn() escapes the harness`);
    assert.match(source, /after\((?:stopAllRealBoots|async \(\) => \{\s*await stopAllRealBoots\(\))/, `${suite}: no after() that reaps its children`);
    assert.match(source, /timeout: REAL_BOOT_TEST_TIMEOUT_MS/, `${suite}: a real-boot test without the per-test bound`);
  }
});
