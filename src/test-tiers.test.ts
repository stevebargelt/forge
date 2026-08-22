import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL(".", import.meta.url));
// FG-495 review: dashboard is part of the canonical gate (`npm run test:all`
// runs `npm test -w dashboard`), so the content guard below must scan it too
// — a dashboard test spawning a subprocess or sleeping on a real clock is
// just as much a fast-tier violation as one under src/.
const DASHBOARD_SRC_ROOT = fileURLToPath(new URL("../dashboard/src/", import.meta.url));

function gatherTestFiles(dir: string, root: string = dir): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherTestFiles(fullPath, root));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".test.ts") &&
      entry.name !== "test-setup.ts" &&
      entry.name !== "test-tiers.test.ts"
    ) {
      results.push(relative(root, fullPath));
    }
  }
  return results;
}

// Heuristic: a unit-tier file is a violator when it (a) has a non-type
// import from node:child_process AND (b) calls
// execSync/spawnSync/spawn/execFile/execFileSync as a standalone function, OR
// (c) contains a promisified setTimeout sleep (`new Promise((r) =>
// setTimeout(r, ...))`) regardless of child_process usage. Known safe
// patterns that must NOT trip this guard:
//   - `typeof import("node:child_process").execFile` — inline type ref, no
//     top-level import statement (docker-exec.test.ts).
//   - `"npm run e2e:auth"` strings in YAML fixtures — no child_process import
//     at all (project-auth.test.ts).
//   - `db.exec(` / `legacy.exec(` — SQLite method calls, dot-prefixed; the
//     guard only flags standalone function identifiers (runs/tasks tests).
//   - `mock.timers.enable(...)` + `mock.timers.tick(...)` — node:test's fake
//     timers never touch a real clock, so files using them (idle-watchdog)
//     don't match the promisified-sleep pattern in the first place.
// Limits: commented-out spawn() calls would trigger a false positive; dynamic
// spawn via a variable (const cmd = "sleep"; spawn(cmd)) would escape detection;
// a sleep hidden behind a helper function (not the inline `new Promise(...)`
// idiom) would also escape detection.
// FG-495: execFileSync was a real gap — the pattern list omitted it, so 8
// unit-tier files spawned real `git` subprocesses undetected, and 2 more slept
// on a real clock via the promisified-setTimeout idiom below (c). All 10 were
// reclassified to integration/worktree; see docs/test-suite-timing-fg495.md.
function isUnitTierSubprocessViolator(filePath: string): { violation: boolean; reason: string } {
  const content = readFileSync(filePath, "utf8");

  // Non-type import from node:child_process or child_process.
  // `import type { ... }` is excluded by the negative lookahead.
  const hasChildProcessImport = /^import\s+(?!type[\s{]).*from\s+["'](?:node:)?child_process["']/m.test(content);

  if (hasChildProcessImport) {
    // Detect standalone function calls (not method calls preceded by a dot).
    // \b ensures we don't match partial identifiers. execFileSync is checked
    // before execFile so the more specific pattern reports first.
    const callPatterns = [
      /\bexecSync\s*\(/,
      /\bspawnSync\s*\(/,
      /\bspawn\s*\(/,
      /\bexecFileSync\s*\(/,
      /\bexecFile\s*\(/,
      /\bexec\s*\(/,
    ];
    for (const pat of callPatterns) {
      if (pat.test(content)) {
        return { violation: true, reason: `imports child_process and calls ${pat.source}` };
      }
    }
  }

  // Detect literal sleep spawn regardless of import (belt-and-suspenders).
  if (/\bspawn\s*\(\s*["']sleep["']/.test(content)) {
    return { violation: true, reason: "spawns sleep" };
  }

  // Detect a real (non-fake-timer) sleep: `new Promise((r) => setTimeout(r, N))`
  // or equivalent. node:test's `mock.timers` stubs setTimeout so it never
  // reaches this idiom, hence no allowlist needed for fake-timer files.
  if (/new Promise\(\s*\([^)]*\)\s*=>\s*setTimeout\(/.test(content)) {
    return { violation: true, reason: "promisified setTimeout sleep" };
  }

  return { violation: false, reason: "" };
}

test("unit-tier files must not spawn subprocesses or run git/sleep", () => {
  const all = [
    ...gatherTestFiles(SRC_ROOT).map((rel) => ({ root: SRC_ROOT, rel, label: rel })),
    ...gatherTestFiles(DASHBOARD_SRC_ROOT).map((rel) => ({
      root: DASHBOARD_SRC_ROOT,
      rel,
      label: join("dashboard/src", rel),
    })),
  ];
  const unitFiles = all.filter(
    ({ label }) => !label.endsWith(".integration.test.ts") && !label.endsWith(".worktree.test.ts"),
  );
  const violations: string[] = [];
  for (const { root, rel, label } of unitFiles) {
    const full = join(root, rel);
    const { violation, reason } = isUnitTierSubprocessViolator(full);
    if (violation) violations.push(`${label}: ${reason}`);
  }
  assert.deepEqual(
    violations,
    [],
    `Unit-tier files that violate subprocess/git/sleep purity:\n${violations.join("\n")}`,
  );
});

test("test tiers are pairwise disjoint and their union equals the full suite", () => {
  const all = gatherTestFiles(SRC_ROOT);

  const worktree = new Set(all.filter((f) => f.endsWith(".worktree.test.ts")));
  const integration = new Set(all.filter((f) => f.endsWith(".integration.test.ts")));
  const unit = new Set(
    all.filter((f) => !f.endsWith(".integration.test.ts") && !f.endsWith(".worktree.test.ts"))
  );

  for (const f of worktree) {
    assert.ok(!integration.has(f), `${f} is in both worktree and integration tiers`);
    assert.ok(!unit.has(f), `${f} is in both worktree and unit tiers`);
  }
  for (const f of integration) {
    assert.ok(!unit.has(f), `${f} is in both integration and unit tiers`);
  }

  const union = new Set([...worktree, ...integration, ...unit]);
  assert.equal(union.size, all.length, `union has ${union.size} files but full suite has ${all.length}`);
  for (const f of all) {
    assert.ok(union.has(f), `${f} is not in any tier`);
  }
});

// FG-495 review: the dashboard workspace's own "test" script (not this file's
// unit-tier definition) is the tier boundary for dashboard — it must exclude
// *.integration.test.ts the same way the root "test:unit" script does, and a
// "test:integration" script must exist to run only those files. A string-level
// check of dashboard/package.json is the right level here: the actual
// partition of dashboard/src files is already covered by the content-guard
// test above, which excludes any label ending in ".integration.test.ts"
// (dashboard or root) from the unit-tier purity scan.
test("FG-495: dashboard/package.json's test script excludes *.integration.test.ts and a test:integration script exists", () => {
  const dashboardPkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../dashboard/package.json", import.meta.url)), "utf8"),
  );
  const testScript = dashboardPkg.scripts?.test ?? "";
  assert.ok(
    testScript.includes("-not -name '*.integration.test.ts'"),
    `dashboard's "test" script must exclude *.integration.test.ts so it stays fast-tier only, got: ${testScript}`,
  );
  const testIntegrationScript = dashboardPkg.scripts?.["test:integration"] ?? "";
  assert.ok(
    testIntegrationScript.includes("*.integration.test.ts"),
    `dashboard must define a "test:integration" script that runs *.integration.test.ts files, got: ${testIntegrationScript}`,
  );
});

// FG-752: a red dashboard `tsc --noEmit` once shipped to main because the
// required `test` job's typecheck step ran only the ROOT `tsc --noEmit` — it
// never typechecked the dashboard workspace, and the dashboard_browser tier
// runs those files through tsx (which strips types), not tsc. This asserts the
// gate command the required job runs (`npm run typecheck`) also drives the
// dashboard workspace's tsc, so removing that coverage fails here — and this
// file is a root unit-tier test, so it executes inside the required `test` job.
test("FG-752: root typecheck script covers the dashboard workspace tsc", () => {
  const rootPkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
  );
  const typecheckScript = rootPkg.scripts?.typecheck ?? "";
  assert.ok(
    /typecheck\s+-w\s+dashboard/.test(typecheckScript),
    `root "typecheck" script must run the dashboard workspace tsc (npm run typecheck -w dashboard) so a red dashboard typecheck blocks the required merge gate, got: ${typecheckScript}`,
  );

  const dashboardPkg = JSON.parse(
    readFileSync(fileURLToPath(new URL("../dashboard/package.json", import.meta.url)), "utf8"),
  );
  const dashboardTypecheck = dashboardPkg.scripts?.typecheck ?? "";
  assert.ok(
    dashboardTypecheck.includes("tsc") && dashboardTypecheck.includes("--noEmit"),
    `dashboard's "typecheck" script must run tsc --noEmit, got: ${dashboardTypecheck}`,
  );
});
