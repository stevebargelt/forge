import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_ROOT = fileURLToPath(new URL(".", import.meta.url));

function gatherTestFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...gatherTestFiles(fullPath));
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".test.ts") &&
      entry.name !== "test-setup.ts" &&
      entry.name !== "test-tiers.test.ts"
    ) {
      results.push(relative(SRC_ROOT, fullPath));
    }
  }
  return results;
}

// Heuristic: a unit-tier file is a violator when it (a) has a non-type
// import from node:child_process AND (b) calls execSync/spawnSync/spawn/execFile
// as a standalone function. Known safe patterns that must NOT trip this guard:
//   - `typeof import("node:child_process").execFile` — inline type ref, no
//     top-level import statement (docker-exec.test.ts).
//   - `"npm run e2e:auth"` strings in YAML fixtures — no child_process import
//     at all (project-auth.test.ts).
//   - `db.exec(` / `legacy.exec(` — SQLite method calls, dot-prefixed; the
//     guard only flags standalone function identifiers (runs/tasks tests).
// Limits: commented-out spawn() calls would trigger a false positive; dynamic
// spawn via a variable (const cmd = "sleep"; spawn(cmd)) would escape detection.
function isUnitTierSubprocessViolator(filePath: string): { violation: boolean; reason: string } {
  const content = readFileSync(filePath, "utf8");

  // Non-type import from node:child_process or child_process.
  // `import type { ... }` is excluded by the negative lookahead.
  const hasChildProcessImport = /^import\s+(?!type[\s{]).*from\s+["'](?:node:)?child_process["']/m.test(content);

  if (hasChildProcessImport) {
    // Detect standalone function calls (not method calls preceded by a dot).
    // \b ensures we don't match partial identifiers.
    const callPatterns = [
      /\bexecSync\s*\(/,
      /\bspawnSync\s*\(/,
      /\bspawn\s*\(/,
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

  return { violation: false, reason: "" };
}

test("unit-tier files must not spawn subprocesses or run git/sleep", () => {
  const all = gatherTestFiles(SRC_ROOT);
  const unitFiles = all.filter(
    (f) => !f.endsWith(".integration.test.ts") && !f.endsWith(".worktree.test.ts"),
  );
  const violations: string[] = [];
  for (const rel of unitFiles) {
    const full = join(SRC_ROOT, rel);
    const { violation, reason } = isUnitTierSubprocessViolator(full);
    if (violation) violations.push(`${rel}: ${reason}`);
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
