import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
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
